import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Compiler } from "../../src/compiler/session.ts";
import { refreshProgram } from "../../src/compiler/frontend.ts";
import { checkProgram } from "../../src/compiler/typecheck.ts";

interface Fixture {
  readonly root: string;
  readonly leaf: string;
}

const depth = integerArg("--depth", 30);
const rounds = integerArg("--rounds", 5);
const baselineTimes: number[] = [];
const incrementalTimes: number[] = [];

for (let round = 0; round < rounds; round += 1) {
  const before = round % 2 === 0 ? 1 : 100;
  const after = before === 1 ? 100 : 1;
  const baseline = await makeChain(depth, before);
  await checkProgram(baseline.root);
  await writeLeaf(baseline.leaf, after);
  baselineTimes.push(
    await timed(async () => {
      await refreshProgram(baseline.root);
      await checkProgram(baseline.root);
    }),
  );

  const incremental = await makeChain(depth, before);
  const compiler = await Compiler.create();
  await compiler.check(incremental.root);
  await writeLeaf(incremental.leaf, after);
  incrementalTimes.push(
    await timed(async () => {
      await compiler.check(incremental.root);
    }),
  );
  compiler.destroy();
}

const baselineMedian = median(baselineTimes);
const incrementalMedian = median(incrementalTimes);
const result = {
  depth,
  rounds,
  edit:
    "width-changing dead private literal changes, checked boundary unchanged",
  baseline: {
    medianMs: baselineMedian,
    samplesMs: baselineTimes,
    dependencyClosure: depth,
  },
  incremental: {
    medianMs: incrementalMedian,
    samplesMs: incrementalTimes,
    dependencyClosure: 1,
  },
  speedup: baselineMedian / incrementalMedian,
};

console.log(JSON.stringify(result, null, 2));

async function makeChain(depth: number, hidden: number): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "blot-seal-bench-"));
  const leaf = join(directory, "module-0.blot");
  await writeLeaf(leaf, hidden);
  let root = leaf;
  for (let index = 1; index < depth; index += 1) {
    root = join(directory, `module-${index}.blot`);
    await writeFile(
      root,
      `const dependency = import "./module-${index - 1}.blot"\n` +
        `return { .answer = dependency.answer; }\n`,
    );
  }
  return { root, leaf };
}

async function writeLeaf(path: string, hidden: number): Promise<void> {
  await writeFile(
    path,
    `const hidden = ${hidden}\nreturn { .answer = 42; }\n`,
  );
}

async function timed(run: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await run();
  return performance.now() - start;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function integerArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const raw = process.argv[index + 1];
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} requires a positive integer`);
  }
  return value;
}
