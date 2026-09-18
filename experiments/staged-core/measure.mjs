// Fresh native-process measurements of PUBLIC SYNTHETIC programs only.
// Compiler intervals include source processing and final Wasm validation; host
// invocation/IO and Node execution checks are separate. This is not gdev latency.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

if (process.argv.length !== 3) {
  throw new Error(
    "usage: node experiments/staged-core/measure.mjs NATIVE_BINARY",
  );
}
const binary = resolve(process.argv[2]);
const compilerSha256 = createHash("sha256").update(readFileSync(binary)).digest(
  "hex",
);
const temporary = mkdtempSync(join(tmpdir(), "blot-staged-measure-"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function source(count) {
  let text = "const id = fn x => x\n";
  for (let i = 0; i < count; i++) {
    text += `const f${i} = fn x => id (@staged.add (x, ${i}))\n`;
  }
  text += "return {\n";
  for (let i = 0; i < count; i++) text += `.f${i} = f${i};\n`;
  return text + "}\n";
}
function invoke(args) {
  const start = performance.now();
  const child = spawnSync(binary, args, { encoding: "utf8", timeout: 30_000 });
  const processWallMs = performance.now() - start;
  assert.equal(child.error, undefined, String(child.error));
  assert.equal(child.status, 0, child.stderr);
  return {
    records: child.stdout.trim().split("\n").map(JSON.parse),
    processWallMs,
  };
}
async function load(path) {
  const bytes = readFileSync(path);
  assert(WebAssembly.validate(bytes));
  const { instance } = await WebAssembly.instantiate(bytes);
  return {
    exports: instance.exports,
    sha256: digest(bytes),
    bytes: bytes.length,
  };
}
try {
  for (const count of [16, 64, 128]) {
    const original = source(count);
    const index = count / 2;
    const changed = original.replace(`(x, ${index})`, "(x, 9999)");
    assert.notEqual(original, changed);
    const input = join(temporary, "main.blot");
    const edit = join(temporary, "edited.blot");
    const output = join(temporary, "main.wasm");
    writeFileSync(input, original);
    writeFileSync(edit, changed);
    for (let sample = 0; sample < 4; sample++) {
      const warm = invoke([input, output, edit]);
      const fresh = invoke([edit, `${output}.fresh`]);
      const before = await load(output);
      const after = await load(`${output}.edited.wasm`);
      const independent = await load(`${output}.fresh`);
      for (let i = 0; i < count; i++) {
        for (const n of [-41n, 0n, 99999n]) {
          let expected = n + BigInt(i);
          if (i === index) expected = n + 9999n;
          assert.equal(before.exports[`f${i}`](n), n + BigInt(i));
          assert.equal(after.exports[`f${i}`](n), expected);
          assert.equal(independent.exports[`f${i}`](n), expected);
        }
      }
      const cold = warm.records[0];
      const edited = warm.records[1];
      assert.equal(cold.artifact.work.checked_definitions, count + 1);
      assert.equal(cold.artifact.work.emitted_functions, count + 2);
      assert.equal(edited.artifact.work.checked_definitions, 1);
      assert.equal(edited.artifact.work.reused_definitions, count);
      assert.equal(edited.artifact.work.emitted_functions, 1);
      assert.equal(edited.artifact.work.static_calls, 0);
      console.log(JSON.stringify({
        scope: "public-synthetic-native-prototype-not-gdev",
        compilerSha256,
        count,
        sample,
        sourceBytes: Buffer.byteLength(original),
        sourceSha256: digest(original),
        editedSha256: digest(changed),
        processWallMs: warm.processWallMs,
        cold,
        edited,
        freshEdited: fresh.records[0],
        originalWasm: { sha256: before.sha256, bytes: before.bytes },
        editedWasm: { sha256: after.sha256, bytes: after.bytes },
        freshWasm: { sha256: independent.sha256, bytes: independent.bytes },
        executionCompared: true,
        wasmValidated: true,
      }));
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
