import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compiler } from "../../src/compiler.ts";
import { runArtifact } from "../../src/node/run.ts";

// Opt-in semantic acceptance probe, not a test that blesses the known wrong
// result. Until coherent selection is implemented, this assertion fails.
const directory = await mkdtemp(join(tmpdir(), "blot-coherence-"));
const compiler = await Compiler.create();
const header = `open import "blot:prelude"
const Reverse = @type.int <+ { .eq = fn a => fn b => False; }
`;
try {
  const constantPath = join(directory, "constant.blot");
  const runtimePath = join(directory, "runtime.blot");
  await writeFile(constantPath, header + "return 1 == 1\n");
  await writeFile(
    runtimePath,
    header + `let same :: Int -> Int
let same = fn value => case value == value of
  #True => 1
  #False => 0
return same
`,
  );
  const constant = await runArtifact(await compiler.compile(constantPath));
  const artifact = await compiler.compile(runtimePath);
  const { instance } = await WebAssembly.instantiate(
    Uint8Array.from(artifact.wasm),
  );
  const same = instance.exports["blot:default"];
  if (typeof same !== "function") throw new Error("missing runtime export");
  const runtime = same(1n);
  console.log({ constant, runtime: String(runtime) });
  assert.equal(constant === "true", runtime === 1n);
} finally {
  compiler.destroy();
  await rm(directory, { recursive: true });
}
