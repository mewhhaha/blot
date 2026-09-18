// PUBLIC SYNTHETIC expanded-language scaling, not a gdev performance result.
// No skipped warmup, discarded sample, or whole-artifact cache shortcut.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

if (process.argv.length !== 3) {
  throw new Error(
    "usage: node experiments/staged-core/measure-expansion.mjs NATIVE_BINARY",
  );
}
const binary = resolve(process.argv[2]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const binarySha256 = hash(readFileSync(binary));
const here = dirname(fileURLToPath(import.meta.url));
const example = readFileSync(join(here, "collections.blot"), "utf8");
const prefix = example.slice(0, example.lastIndexOf("\nreturn { .run ="));
assert(prefix.length < example.length && prefix.includes("const work ="));
const temporary = mkdtempSync(join(tmpdir(), "staged-expanded-"));
function program(count) {
  let text = prefix + "\n";
  for (let i = 0; i < count; i++) {
    text +=
      `const f${i} = fn (x: Int) -> Int => work (@staged.add (x, ${i}))\n`;
  }
  text += "return {\n";
  for (let i = 0; i < count; i++) text += `.f${i} = f${i};\n`;
  return text + "}\n";
}
function invoke(args) {
  const start = performance.now();
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const wallMs = performance.now() - start;
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
  const records = result.stdout.trim().split("\n").map(JSON.parse);
  // Preserve every timing and work counter without repeating large interfaces.
  return {
    wallMs,
    records: records.map((r) => ({
      mode: r.mode,
      phasesMs: r.phasesMs,
      compilationMs: r.compilationMs,
      initializationMs: r.initializationMs,
      wasmBytes: r.wasmBytes,
      work: r.artifact.work,
      abi: r.artifact.abi,
    })),
  };
}
async function load(path) {
  const bytes = readFileSync(path);
  assert(WebAssembly.validate(bytes));
  const { instance } = await WebAssembly.instantiate(bytes);
  return {
    exports: instance.exports,
    sha256: hash(bytes),
    bytes: bytes.length,
  };
}
try {
  // Rotate size order between rounds; each invocation is a fresh native process.
  const orders = [[128, 512, 2048], [512, 2048, 128], [2048, 128, 512], [
    2048,
    512,
    128,
  ]];
  for (let round = 0; round < orders.length; round++) {
    for (const count of orders[round]) {
      const original = program(count);
      const changedIndex = count / 2;
      const changed = original.replace(
        `@staged.add (x, ${changedIndex}))`,
        "@staged.add (x, 99999))",
      );
      assert.notEqual(changed, original);
      const input = join(temporary, "original.blot");
      const edit = join(temporary, "edited.blot");
      const output = join(temporary, "original.wasm");
      writeFileSync(input, original);
      writeFileSync(edit, changed);
      const warm = invoke([input, output, edit]);
      const fresh = invoke([edit, `${output}.fresh`]);
      const a = await load(output);
      const b = await load(`${output}.edited.wasm`);
      const c = await load(`${output}.fresh`);
      assert.equal(b.sha256, c.sha256);
      assert.deepEqual(
        readFileSync(`${output}.edited.wasm`),
        readFileSync(`${output}.fresh`),
      );
      for (let i = 0; i < count; i++) {
        for (const x of [-17n, 0n, 41n]) {
          let offset = BigInt(i);
          if (i === changedIndex) offset = 99999n;
          assert.equal(a.exports[`f${i}`](x), 2n * (x + BigInt(i)) + 60n);
          assert.equal(b.exports[`f${i}`](x), 2n * (x + offset) + 60n);
          assert.equal(c.exports[`f${i}`](x), b.exports[`f${i}`](x));
        }
      }
      const cold = warm.records[0];
      const edited = warm.records[1];
      assert.equal(edited.work.checked_definitions, 1);
      assert.equal(edited.work.reused_definitions, count + 8);
      assert.equal(edited.work.emitted_functions, 1);
      assert.equal(edited.work.static_calls, 0);
      console.log(
        JSON.stringify({
          scope: "public-expanded-synthetic-native-not-gdev",
          binarySha256,
          count,
          round,
          editKind: "numeric-payload-and-token-width-change",
          sourceBytes: Buffer.byteLength(original),
          editedSourceBytes: Buffer.byteLength(changed),
          sourceSha256: hash(original),
          changedSourceSha256: hash(changed),
          processWallMs: warm.wallMs,
          cold,
          edited,
          freshChanged: fresh.records[0],
          originalWasm: { sha256: a.sha256, bytes: a.bytes },
          editedWasm: { sha256: b.sha256, bytes: b.bytes },
          freshWasm: { sha256: c.sha256, bytes: c.bytes },
          everyExportCompared: true,
          wasmValidated: true,
        }),
      );
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
