import { performance } from "node:perf_hooks";
import { checkSource } from "../../src/check/mod.ts";

const callers = integerArg("--callers", 100);
const rounds = integerArg("--rounds", 7);
const direct = program(callers, false);
const summarized = program(callers, true);
const directTimes: number[] = [];
const summarizedTimes: number[] = [];

await checkSource("/tmp/blot-summary-warm-direct.blot", direct);
await checkSource("/tmp/blot-summary-warm-wrapper.blot", summarized);

for (let round = 0; round < rounds; round += 1) {
  if (round % 2 === 0) {
    directTimes.push(await timed(direct, `direct-${round}`));
    summarizedTimes.push(await timed(summarized, `summary-${round}`));
  } else {
    summarizedTimes.push(await timed(summarized, `summary-${round}`));
    directTimes.push(await timed(direct, `direct-${round}`));
  }
}

const directMedian = median(directTimes);
const summarizedMedian = median(summarizedTimes);
console.log(JSON.stringify(
  {
    callers,
    rounds,
    direct: { medianMs: directMedian, samplesMs: directTimes },
    verifiedWrapper: {
      medianMs: summarizedMedian,
      samplesMs: summarizedTimes,
    },
    relativeCost: summarizedMedian / directMedian,
  },
  null,
  2,
));

function program(count: number, wrapper: boolean): string {
  let source = `open import "blot:prelude"\n`;
  if (wrapper) source += `const count = fn values => Array.length values\n`;
  for (let index = 0; index < count; index += 1) {
    let length = "@array.len values";
    if (wrapper) length = "count values";
    source += `sig at${index} = [Int] -> Int -> Int\n` +
      `let at${index} = fn values => fn index => case index >= 0 && index < ${length} of\n` +
      `  #True => @array.get values index\n` +
      `  #False => 0\n`;
  }
  return source + "export 0\n";
}

async function timed(source: string, name: string): Promise<number> {
  const start = performance.now();
  await checkSource(`/tmp/blot-summary-${name}.blot`, source);
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
  let value = Number.NaN;
  if (raw !== undefined) value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} requires a positive integer`);
  }
  return value;
}
