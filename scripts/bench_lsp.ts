// scripts/bench_lsp.ts
//
// Wall-clock benchmark for the Blot language server (work package P7).
//
// Drives the real coordinator in-process over a memory transport with the
// default inline service (the configuration editors get) and times
// formatting requests against small and medium documents. Formatting is
// the only request measured: it is syntax-only and deterministic, while
// semantic requests depend on compiler-cache warmth.
//
// Cold versus warm: the first case in the process loads the Baba parser
// and compiler artifacts, so its first sample includes that
// initialization. Every later sample is warm. Compare samples within one
// run, not across processes.
//
// Usage:
//   deno run --allow-read --allow-write scripts/bench_lsp.ts
//   deno run --allow-read --allow-write scripts/bench_lsp.ts --only format-small --samples 5
//   deno run --allow-read --allow-write scripts/bench_lsp.ts --out /tmp/lsp-bench.json
//   deno run --allow-read scripts/bench_lsp.ts --list

import { runCoordinatorServer } from "../src/lsp/server.ts";
import {
  decodeCaptured,
  memoryTransport,
  settleMicrotasks,
} from "../src/lsp/testing.ts";

interface BenchOptions {
  only: string | null;
  samples: number | null;
  out: string | null;
  list: boolean;
}

function defaultOptions(): BenchOptions {
  return { only: null, samples: null, out: null, list: false };
}

function parseOptions(args: readonly string[]): BenchOptions {
  const options = defaultOptions();
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--list") {
      options.list = true;
      index += 1;
      continue;
    }
    if (arg === "--only") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--only requires a case name");
      options.only = value;
      index += 2;
      continue;
    }
    if (arg === "--samples") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--samples requires a count");
      const count = Number(value);
      if (!Number.isInteger(count) || count < 1) {
        throw new Error("--samples requires a positive integer, got " + value);
      }
      options.samples = count;
      index += 2;
      continue;
    }
    if (arg === "--out") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--out requires a path");
      options.out = value;
      index += 2;
      continue;
    }
    throw new Error("Unknown benchmark option: " + arg);
  }
  return options;
}

interface BenchCase {
  readonly name: string;
  readonly samples: number;
  build(): string;
}

function smallSource(): string {
  return "let   x=1\nreturn x\n";
}

function mediumSource(): string {
  const lines: string[] = [];
  for (let index = 0; index < 30; index += 1) {
    lines.push(`let   value${index}   =   [${index},   ${index + 1}]`);
  }
  lines.push("return   value0");
  return lines.join("\n") + "\n";
}

function defineCases(): BenchCase[] {
  return [
    {
      name: "format-small",
      samples: 5,
      build(): string {
        return smallSource();
      },
    },
    {
      name: "format-medium",
      samples: 5,
      build(): string {
        return mediumSource();
      },
    },
  ];
}

interface SampleRecord {
  readonly index: number;
  readonly ms: number;
  readonly edits: number;
}

interface CaseReport {
  readonly name: string;
  readonly sourceBytes: number;
  readonly medianMs: number;
  readonly samples: readonly SampleRecord[];
}

interface BenchReport {
  readonly meta: {
    readonly tool: string;
    readonly deno: string;
    readonly os: string;
    readonly startedAt: string;
    readonly argv: readonly string[];
  };
  readonly cases: readonly CaseReport[];
}

async function timeFormatting(
  source: string,
  samples: number,
): Promise<readonly SampleRecord[]> {
  const transport = memoryTransport();
  const done = runCoordinatorServer(transport.input, transport.output, {});
  const collected: SampleRecord[] = [];
  try {
    transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    transport.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    transport.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: "untitled:bench.blot",
          version: 1,
          text: source,
        },
      },
    });
    for (let index = 0; index < samples; index += 1) {
      const id = 100 + index;
      const start = performance.now();
      transport.send({
        jsonrpc: "2.0",
        id,
        method: "textDocument/formatting",
        params: {
          textDocument: { uri: "untitled:bench.blot" },
          options: {},
        },
      });
      const edits = await waitForEdits(transport, id);
      collected.push({ index, ms: performance.now() - start, edits });
    }
    transport.send({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null });
    transport.send({ jsonrpc: "2.0", method: "exit", params: null });
    transport.closeInput();
    await done;
  } catch (error) {
    transport.send({ jsonrpc: "2.0", method: "exit", params: null });
    transport.closeInput();
    await done;
    throw error;
  }
  return collected;
}

async function waitForEdits(
  transport: ReturnType<typeof memoryTransport>,
  id: number,
): Promise<number> {
  const deadline = Date.now() + 60_000;
  while (true) {
    await settleMicrotasks(20);
    const messages = await decodeCaptured(transport.chunks());
    for (const message of messages) {
      const record = message as Record<string, unknown>;
      if (record.id !== id) continue;
      if (record.error !== undefined) {
        throw new Error(
          `benchmark formatting failed: ${JSON.stringify(record.error)}`,
        );
      }
      const edits = record.result as readonly unknown[];
      if (!Array.isArray(edits)) throw new Error("formatting is not an array");
      return edits.length;
    }
    if (Date.now() >= deadline) {
      throw new Error(`benchmark formatting ${id} never settled`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) throw new Error("no samples to summarize");
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1];
  if (lower === undefined) throw new Error("no samples to summarize");
  return (lower + upper) / 2;
}

async function main(): Promise<void> {
  const options = parseOptions(Deno.args);
  const cases = defineCases();
  if (options.list) {
    for (const candidate of cases) console.log(candidate.name);
    return;
  }
  let selected = cases;
  if (options.only !== null) {
    const only = options.only;
    selected = cases.filter((candidate) => candidate.name === only);
    if (selected.length === 0) throw new Error("Unknown case: " + only);
  }
  const startedAt = new Date().toISOString();
  const reports: CaseReport[] = [];
  for (const candidate of selected) {
    let count = candidate.samples;
    if (options.samples !== null) count = options.samples;
    const source = candidate.build();
    const samples = await timeFormatting(source, count);
    const measured = samples.map((sample) => sample.ms);
    reports.push({
      name: candidate.name,
      sourceBytes: new TextEncoder().encode(source).byteLength,
      medianMs: median(measured),
      samples,
    });
    console.log(
      `${candidate.name}: median ${
        median(measured).toFixed(1)
      }ms over ${count} samples`,
    );
  }
  const report: BenchReport = {
    meta: {
      tool: "bench_lsp",
      deno: Deno.version.deno,
      os: Deno.build.os,
      startedAt,
      argv: Deno.args,
    },
    cases: reports,
  };
  if (options.out !== null) {
    await Deno.writeTextFile(
      options.out,
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(`wrote ${options.out}`);
  }
}

await main();
