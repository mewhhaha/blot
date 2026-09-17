// Dependency-free, fresh-process comparison of the Rust/Wasm semantic pipeline.
// Run from any directory:
// node compare.mjs --baseline=/path/base.wasm --candidate=/path/new.wasm --samples=5
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);
const fixtureRoot = new URL("../cold-semantic/", import.meta.url);
const options = new Map();
for (const argument of process.argv.slice(2)) {
  const match = /^--([a-z-]+)=(.+)$/.exec(argument);
  if (!match) throw new Error(`Expected --name=value, received ${argument}`);
  if (
    !new Set([
      "baseline",
      "candidate",
      "samples",
      "sample",
      "fixture",
      "prelude",
      "telemetry",
    ]).has(match[1])
  ) {
    throw new Error(`Unknown option ${match[1]}`);
  }
  options.set(match[1], match[2]);
}
function option(name, fallback) {
  if (options.has(name)) return options.get(name);
  return fallback;
}
const preludeMode = option("prelude", "snapshot");
assert(
  ["snapshot", "source"].includes(preludeMode),
  "--prelude is snapshot or source",
);
const telemetryMode = option("telemetry", "on");
assert(["on", "off"].includes(telemetryMode), "--telemetry is on or off");
let requestedFactMask = 0;
if (telemetryMode === "on") requestedFactMask = 0x80000000;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function sample(wasmPath, fixture) {
  assert(["prefix", "full"].includes(fixture), "--fixture is prefix or full");
  const bytes = readFileSync(wasmPath);
  const created = performance.now();
  const { instance } = await WebAssembly.instantiate(bytes, {
    blot: { blot_now_ms: () => performance.now() },
  });
  const exports = instance.exports;
  const creationMs = performance.now() - created;
  const session = exports.create_compiler_session();
  const decoder = new TextDecoder();
  const resultBytes = (length) =>
    new Uint8Array(
      exports.memory.buffer,
      exports.lower_result_pointer(),
      length,
    ).slice();
  const result = (length) => {
    const value = JSON.parse(decoder.decode(resultBytes(length)));
    assert.equal(value.ok, true, JSON.stringify(value));
    return value;
  };
  function words(text, action) {
    const pointer = exports.allocate_words(text.length);
    const memory = new Int32Array(exports.memory.buffer, pointer, text.length);
    for (let index = 0; index < text.length; index++) {
      memory[index] = text.charCodeAt(index);
    }
    try {
      return action(pointer, text.length);
    } finally {
      exports.deallocate_words(pointer, text.length);
    }
  }
  function buffer(bytes, action) {
    const pointer = exports.allocate_bytes(bytes.length);
    new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
    try {
      return action(pointer, bytes.length);
    } finally {
      exports.deallocate_bytes(pointer, bytes.length);
    }
  }
  function source(path, text, imports) {
    words(path, (pathPointer, pathLength) => {
      words(
        text,
        (textPointer, textLength) =>
          result(exports.add_compiler_session_source(
            session,
            pathPointer,
            pathLength,
            textPointer,
            textLength,
          )),
      );
      words(JSON.stringify({ imports, includes: {} }), (pointer, length) => {
        result(
          exports.configure_compiler_session_module(
            session,
            pathPointer,
            pathLength,
            pointer,
            length,
          ),
        );
      });
    });
  }
  // V2 envelopes are BLT3/schema/status/byteLength/payload (little endian).
  function envelope(length) {
    const bytes = Buffer.from(resultBytes(length));
    assert.equal(bytes.readUInt32LE(0), 0x33544c42);
    assert.equal(bytes.readUInt32LE(4), 3);
    assert.equal(bytes.readUInt32LE(8), 1, decoder.decode(bytes.subarray(16)));
    assert.equal(bytes.readUInt32LE(12), bytes.length - 16);
    return bytes.subarray(16);
  }
  const started = performance.now();
  const prelude = readFileSync(
    new URL("src/prelude/prelude.blot", root),
    "utf8",
  );
  const snapshot = readFileSync(
    new URL("generated/compiler/prelude.snapshot", root),
  );
  const framework = readFileSync(
    new URL("framework.blot", fixtureRoot),
    "utf8",
  );
  const main = readFileSync(new URL(`${fixture}.blot`, fixtureRoot), "utf8");
  try {
    if (preludeMode === "snapshot") {
      words(
        "prelude.blot",
        (path, pathLength) =>
          buffer(snapshot, (pointer, length) => {
            result(
              exports.install_compiler_session_trusted_module_snapshot(
                session,
                path,
                pathLength,
                pointer,
                length,
              ),
            );
          }),
      );
    } else {
      source("prelude.blot", prelude, {});
    }
    source("framework.blot", framework, { "blot:prelude": "prelude.blot" });
    source("main.blot", main, {
      "blot:prelude": "prelude.blot",
      "./framework.blot": "framework.blot",
    });
    const path = Buffer.from("main.blot");
    const frame = Buffer.alloc(16 + path.length);
    frame.writeUInt32LE(0x33544c42, 0);
    frame.writeUInt32LE(3, 4);
    frame.writeUInt32LE(1, 8);
    frame.writeUInt32LE(path.length, 12);
    path.copy(frame, 16);
    const registered = buffer(
      frame,
      (pointer, length) =>
        envelope(
          exports.register_compiler_session_paths(session, pointer, length),
        ),
    );
    assert.equal(registered.readUInt32LE(0), 1);
    const moduleId = registered.readUInt32LE(4);
    const preparationMs = performance.now() - started;
    const analyzed = performance.now();
    const analysis = JSON.parse(
      decoder.decode(
        envelope(
          exports.analyze_compiler_session_module_v2(
            session,
            moduleId,
            requestedFactMask,
          ),
        ),
      ),
    );
    const analysisMs = performance.now() - analyzed;
    assert.equal(analysis.ok, true, JSON.stringify(analysis));
    assert.equal(analysis.type, "{ .run = Int -> Int }");
    assert.equal(analysis.effects, "");
    assert.equal(analysis.targetPreflight.supported, true);
    return {
      schema: 2,
      fixture,
      telemetryMode,
      prelude: preludeMode,
      wasmSha256: digest(bytes),
      inputs: {
        prelude: digest(prelude),
        snapshot: digest(snapshot),
        framework: digest(framework),
        main: digest(main),
      },
      node: process.version,
      cpu: cpus()[0].model,
      platform: platform(),
      arch: arch(),
      creationMs,
      preparationMs,
      analysisMs,
      type: analysis.type,
      effects: analysis.effects,
      interfaceKey: analysis.interfaceKey,
      targetPreflight: analysis.targetPreflight,
      telemetry: analysis.phaseTelemetry,
      memoryBytes: exports.memory.buffer.byteLength,
    };
  } finally {
    assert.equal(exports.destroy_compiler_session(session), 0);
  }
}

if (options.has("sample")) {
  console.log(
    JSON.stringify(
      await sample(options.get("sample"), option("fixture", "full")),
    ),
  );
} else {
  assert(
    options.has("baseline") && options.has("candidate"),
    "Provide --baseline and --candidate compiler Wasm files",
  );
  const count = Number(option("samples", "5"));
  assert(
    Number.isSafeInteger(count) && count > 0,
    "--samples must be a positive integer",
  );
  const expectedSemantics = new Map();
  for (let iteration = 0; iteration < count; iteration++) {
    let artifacts = ["baseline", "candidate"];
    if (iteration % 2) artifacts = artifacts.reverse();
    for (const fixture of ["prefix", "full"]) {
      for (const artifact of artifacts) {
        const child = spawnSync(process.execPath, [
          fileURLToPath(import.meta.url),
          `--sample=${options.get(artifact)}`,
          `--fixture=${fixture}`,
          `--prelude=${preludeMode}`,
          `--telemetry=${telemetryMode}`,
        ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        assert.equal(
          child.status,
          0,
          child.stderr || child.stdout || String(child.error),
        );
        const observed = JSON.parse(child.stdout);
        const semantics = {
          inputs: observed.inputs,
          type: observed.type,
          effects: observed.effects,
          interfaceKey: observed.interfaceKey,
          targetPreflight: observed.targetPreflight,
        };
        if (expectedSemantics.has(fixture)) {
          assert.deepEqual(
            semantics,
            expectedSemantics.get(fixture),
            `${fixture}: artifacts must agree on inputs and semantic results`,
          );
        } else {
          expectedSemantics.set(fixture, semantics);
        }
        console.log(JSON.stringify({ artifact, iteration, ...observed }));
      }
    }
  }
}
