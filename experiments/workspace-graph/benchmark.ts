import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compiler } from "../../src/compiler.ts";
import { load } from "../../src/load.ts";
import { runArtifact } from "../../src/node/run.ts";
import { cachedDiamond, writeDiamond } from "./fixtures.ts";

let depths = [4, 8, 12, 16];
let samples = 3;
for (const argument of process.argv.slice(2)) {
  if (argument === "--") continue;
  if (argument.startsWith("--depths=")) {
    depths = argument.slice("--depths=".length).split(",").map(Number);
  } else if (argument.startsWith("--samples=")) {
    samples = Number(argument.slice("--samples=".length));
  } else {
    throw new Error(`unknown argument ${JSON.stringify(argument)}`);
  }
}
if (
  depths.length === 0 ||
  depths.some((depth) =>
    !Number.isSafeInteger(depth) || depth < 1 || depth > 32
  )
) {
  throw new RangeError("--depths must contain integers from 1 through 32");
}
if (!Number.isSafeInteger(samples) || samples < 1 || samples % 2 === 0) {
  throw new RangeError("--samples must be a positive odd integer");
}

const manifest = JSON.parse(
  await readFile(
    new URL("../../generated/compiler/compiler-artifact.json", import.meta.url),
    "utf8",
  ),
);
const results = [];
for (const depth of depths) {
  const directory = await mkdtemp(join(tmpdir(), "blot-diamond-bench-"));
  try {
    // Correctness qualification is outside the host-only traversal clock.
    const source = await writeDiamond(directory, depth);
    const compiler = await Compiler.create();
    let observation: string;
    let principalType: string;
    try {
      const checked = await compiler.check(source.root);
      principalType = checked.type;
      assert.equal(principalType, "Int");
      assert.equal(checked.effects, "");
      const artifact = await compiler.compile(source.root);
      observation = await runArtifact(artifact);
      assert.equal(observation, source.expected.toString());
    } finally {
      compiler.destroy();
    }
    const measurements = [];
    for (let sample = 0; sample < samples; sample += 1) {
      let dependencyVisits = 0;
      const cached = cachedDiamond(depth, () => dependencyVisits += 1);
      const root = cached.cache.get(cached.root);
      const start = performance.now();
      const loaded = await load(cached.root, cached.cache);
      const milliseconds = performance.now() - start;
      assert.strictEqual(loaded, root);
      measurements.push({ milliseconds, dependencyVisits });
    }
    results.push({
      depth,
      modules: source.moduleCount,
      principalType,
      observation,
      measurements,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify(
  {
    schema: "blot-workspace-graph-benchmark-v1",
    boundary:
      "retained host dependency traversal; excludes filesystem, parsing, checking and emission",
    node: process.version,
    compilerSourceCommit: manifest.sourceCommit,
    compilerSha256: manifest.sha256,
    samples,
    results,
  },
  null,
  2,
));
