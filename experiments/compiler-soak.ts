import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { Compiler } from "../src/compiler.ts";

const editCount = 10_000;
const windowSize = 1_000;

interface WindowResult {
  readonly firstEdit: number;
  readonly lastEdit: number;
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly rssBytes: number;
}

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)];
}

async function main(): Promise<void> {
  let path = "examples/minimal.blot";
  if (process.argv[2] !== undefined) path = process.argv[2];
  let output = "experiments/compiler-soak.latest.json";
  if (process.argv[3] !== undefined) output = process.argv[3];
  const original = await readFile(path, "utf8");
  const compiler = await Compiler.create();
  const windows: WindowResult[] = [];
  const durations: number[] = [];
  let expected: string | null = null;
  try {
    for (let edit = 0; edit < editCount; edit += 1) {
      let width = "";
      if (edit % 2 !== 0) width = " ";
      const source = `${original}\n// resident soak ${edit}${width}\n`;
      const before = performance.now();
      const checked = await compiler.checkSource(path, source);
      durations.push(performance.now() - before);
      const observation = JSON.stringify(checked);
      if (expected === null) {
        expected = observation;
      } else {
        assert.equal(observation, expected);
      }
      if ((edit + 1) % windowSize === 0) {
        windows.push({
          firstEdit: edit + 2 - windowSize,
          lastEdit: edit + 1,
          p50Milliseconds: percentile(durations, 0.5),
          p95Milliseconds: percentile(durations, 0.95),
          rssBytes: process.memoryUsage().rss,
        });
        durations.length = 0;
      }
    }
    const fresh = await Compiler.create();
    try {
      assert.equal(JSON.stringify(await fresh.check(path)), expected);
    } finally {
      fresh.destroy();
    }
  } finally {
    compiler.destroy();
  }
  await writeFile(
    output,
    `${JSON.stringify({ schema: 1, editCount, windows }, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof Error) console.error(error.message);
  else console.error(String(error));
  process.exitCode = 1;
});
