import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Compiler } from "../../src/compiler/session.ts";
import { SealedCheckSession } from "./session.ts";

interface Fixture {
  readonly root: string;
  readonly leaf: string;
}

const depth = integerArg("--depth", 30);
const rounds = integerArg("--rounds", 5);
const baselineTimes: number[] = [];
const sealedTimes: number[] = [];
const sealedRechecks: number[] = [];

for (let round = 0; round < rounds; round += 1) {
  const baseline = await makeChain(depth, round % 2 === 0 ? 1 : 2);
  const compiler = await Compiler.create();
  await compiler.check(baseline.root);
  await writeLeaf(baseline.leaf, round % 2 === 0 ? 2 : 1);
  baselineTimes.push(await timed(async () => {
    await compiler.check(baseline.root);
  }));
  compiler.destroy();

  const sealed = await makeChain(depth, round % 2 === 0 ? 1 : 2);
  const session = new SealedCheckSession();
  await session.check(sealed.root);
  await writeLeaf(sealed.leaf, round % 2 === 0 ? 2 : 1);
  let rechecked = 0;
  sealedTimes.push(await timed(async () => {
    rechecked = (await session.check(sealed.root)).rechecked.length;
  }));
  sealedRechecks.push(rechecked);
}

const baselineMedian = median(baselineTimes);
const sealedMedian = median(sealedTimes);
const result = {
  depth,
  rounds,
  edit: "dead private binding changes, public/live module boundary unchanged",
  baseline: {
    medianMs: baselineMedian,
    samplesMs: baselineTimes,
    dependencyClosure: depth,
  },
  sealed: {
    medianMs: sealedMedian,
    samplesMs: sealedTimes,
    recheckedModules: sealedRechecks,
  },
  speedup: baselineMedian / sealedMedian,
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
      `const dependency = @import "./module-${index - 1}.blot" ()\n` +
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
