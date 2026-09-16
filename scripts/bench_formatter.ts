// scripts/bench_formatter.ts
//
// Wall-clock benchmark for the Blot formatter (work package P0b).
//
// Synthesizes overlong-array sources at 0/1/5/20/60/150/500/1000 constructs
// plus tuple, statement-value, lambda, lambda-paren, mixed/nested,
// comment-heavy, and already-formatted variants, then times formatSource on
// each. Uses only the existing public frontend APIs (formatSource for timing,
// parseConcrete for preflight validation) plus performance.now.
//
// Cold versus warm: the first timed sample of the first executed case runs
// with no prior frontend call in the process, so it includes Baba runtime and
// Wasm initialization. Every later sample is warm. Run a single case in a
// fresh process (--only <name> --samples 1) for a per-case cold number.
//
// Heavy cases: arrays-500 and arrays-1000 run last in supervised child
// processes with a per-case timeout (default 120s). A timeout is recorded
// as data, not a failure. Supervision is structural, not incidental: the
// formatter is CPU-bound without macrotask yields, so an in-process timer
// can never preempt it (the event loop starves until the sample finishes);
// only a child process can be killed. Pass --supervise to run every case in
// a fresh child process (per-case cold numbers). --in-process is internal:
// supervised children use it to run their case in-process.
//
// --allow-all is required for full metadata: this Deno refuses /proc
// reads (CPU and memory description) under granular flags and degrades
// those fields to "unknown". Timing is unaffected either way.
//
// Usage:
//   deno run --allow-all scripts/bench_formatter.ts
//   deno run --allow-all scripts/bench_formatter.ts --only arrays-20 --samples 5
//   deno run --allow-all scripts/bench_formatter.ts --timeout-ms 30000 --out /tmp/bench.json
//   deno run --allow-all scripts/bench_formatter.ts --supervise --only arrays-500
//   deno run --allow-read scripts/bench_formatter.ts --list
//
// The parent wires a deno task name later; this file is intentionally
// self-contained so it runs before that merge.

import { fromFileUrl } from "@std/path";
import { type FormatResult, formatSource } from "../src/tooling/formatter.ts";
import {
  type ConcreteParseResult,
  parseConcrete,
} from "../src/syntax/parse.ts";
import {
  resetFrontendMetrics,
  snapshotFrontendMetrics,
} from "../src/syntax/frontend_metrics.ts";

// P1 wired the HOOK(P1) marker to the merged frontend invocation counters:
// countedFormat and countedParse reset the counters on entry and accumulate
// the parseConcrete delta, so per-sample `internalParses` records the
// formatter's internal re-parses (it re-parses on every layout step) while
// top-level benchmark calls keep their own totals. Timeout samples still
// report null because no measurement exists for them.

interface FrontendInvocationSample {
  readonly topLevelFormats: number;
  readonly topLevelParses: number;
  readonly internalParses: number | null;
}

interface FrontendTotals {
  formats: number;
  parses: number;
  internalParses: number;
}

const frontendTotals: FrontendTotals = {
  formats: 0,
  parses: 0,
  internalParses: 0,
};

async function countedFormat(source: string): Promise<FormatResult> {
  frontendTotals.formats += 1;
  resetFrontendMetrics();
  const result = await formatSource(source);
  frontendTotals.internalParses += snapshotFrontendMetrics().parseConcrete;
  return result;
}

async function countedParse(source: string): Promise<ConcreteParseResult> {
  frontendTotals.parses += 1;
  resetFrontendMetrics();
  const result = await parseConcrete(source);
  frontendTotals.internalParses += snapshotFrontendMetrics().parseConcrete;
  return result;
}

function invocationDelta(before: FrontendTotals): FrontendInvocationSample {
  return {
    topLevelFormats: frontendTotals.formats - before.formats,
    topLevelParses: frontendTotals.parses - before.parses,
    internalParses: frontendTotals.internalParses - before.internalParses,
  };
}

function snapshotTotals(): FrontendTotals {
  return {
    formats: frontendTotals.formats,
    parses: frontendTotals.parses,
    internalParses: frontendTotals.internalParses,
  };
}

interface BenchOptions {
  only: string | null;
  samples: number | null;
  timeoutMs: number;
  out: string | null;
  list: boolean;
  supervise: boolean;
  inProcess: boolean;
}

function defaultOptions(): BenchOptions {
  return {
    only: null,
    samples: null,
    timeoutMs: 120000,
    out: null,
    list: false,
    supervise: false,
    inProcess: false,
  };
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
    if (arg === "--timeout-ms") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--timeout-ms requires a value");
      const ms = Number(value);
      if (!Number.isInteger(ms) || ms < 1) {
        throw new Error(
          "--timeout-ms requires a positive integer, got " + value,
        );
      }
      options.timeoutMs = ms;
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
    if (arg === "--supervise") {
      options.supervise = true;
      index += 1;
      continue;
    }
    if (arg === "--in-process") {
      options.inProcess = true;
      index += 1;
      continue;
    }
    throw new Error("Unknown benchmark option: " + arg);
  }
  return options;
}

interface BenchCase {
  readonly name: string;
  readonly kind: string;
  readonly constructCount: number | null;
  readonly samples: number;
  readonly timeout: boolean;
  readonly checkIdempotent: boolean;
  readonly expectOverlong: boolean;
  build(): string;
}

interface BuiltCase extends BenchCase {
  source: string;
}

function overlongArraySource(count: number): string {
  if (count === 0) {
    return "let single = 1\nreturn single\n";
  }
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const elements: string[] = [];
    for (let element = 0; element < 12; element += 1) {
      elements.push(String(100000 + index * 12 + element));
    }
    lines.push("let a" + index + " = [" + elements.join(", ") + "]");
  }
  lines.push("return a" + (count - 1));
  return lines.join("\n") + "\n";
}

function tupleSource(): string {
  const lines: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    lines.push(
      "let pair" + index + " = (firstComponent" + index +
        "a, firstComponent" + index + "b, firstComponent" + index +
        "c, firstComponent" + index + "d)",
    );
  }
  lines.push("return (pair0, pair1, pair2, pair3, pair4, pair5)");
  return lines.join("\n") + "\n";
}

function statementValueSource(): string {
  const lines: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    lines.push("let answer" + index + " = " + "v".repeat(90));
  }
  lines.push("return " + "r".repeat(100));
  return lines.join("\n") + "\n";
}

function lambdaSource(): string {
  const lines: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    lines.push("const choose" + index + " = fn value => " + "x".repeat(90));
  }
  lines.push("return choose0");
  return lines.join("\n") + "\n";
}

function lambdaParenSource(): string {
  return `let load = fn count => do:
  use store <- fold (
  upto (0, count),
  @array.empty,
  (fn (store, id) => do:
    return append (store, id)
  )
  )
  return store
return load
`;
}

function mixedNestedSource(): string {
  const lines = ["let empty = []", "let singleton = [only]"];
  for (let index = 0; index < 6; index += 1) {
    lines.push(
      "let values" + index + " = [firstComponent" + index +
        ", [secondComponent" + index + ", thirdComponent" + index +
        "], ...remainingComponents" + index + ", fourthComponent" + index +
        ", fifthComponent" + index + "]",
    );
  }
  lines.push("return (empty, singleton, values0)");
  return lines.join("\n") + "\n";
}

function commentHeavySource(): string {
  const lines: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    lines.push("let values" + index + " = [");
    lines.push(" // the first component must remain first (" + index + ")");
    lines.push(" firstComponent" + index + ",");
    lines.push(" secondComponent" + index);
    lines.push("]");
  }
  lines.push("return values7");
  return lines.join("\n") + "\n";
}

function arrayCase(count: number): BenchCase {
  let samples = 3;
  let timeout = false;
  let checkIdempotent = true;
  if (count === 150) {
    samples = 2;
    checkIdempotent = false;
  }
  if (count === 500 || count === 1000) {
    samples = 1;
    timeout = true;
    checkIdempotent = false;
  }
  return {
    name: "arrays-" + count,
    kind: "overlong-arrays",
    constructCount: count,
    samples,
    timeout,
    checkIdempotent,
    expectOverlong: count > 0,
    build(): string {
      return overlongArraySource(count);
    },
  };
}

function defineCases(): BenchCase[] {
  return [
    arrayCase(0),
    arrayCase(1),
    arrayCase(5),
    arrayCase(20),
    {
      name: "tuple",
      kind: "overlong-tuples",
      constructCount: 6,
      samples: 3,
      timeout: false,
      checkIdempotent: true,
      expectOverlong: true,
      build(): string {
        return tupleSource();
      },
    },
    {
      name: "statement-value",
      kind: "overlong-statement-values",
      constructCount: 7,
      samples: 3,
      timeout: false,
      checkIdempotent: true,
      expectOverlong: true,
      build(): string {
        return statementValueSource();
      },
    },
    {
      name: "lambda",
      kind: "overlong-lambdas",
      constructCount: 6,
      samples: 3,
      timeout: false,
      checkIdempotent: true,
      expectOverlong: true,
      build(): string {
        return lambdaSource();
      },
    },
    {
      name: "lambda-paren",
      kind: "redundant-lambda-parens",
      constructCount: 1,
      samples: 3,
      timeout: false,
      checkIdempotent: true,
      expectOverlong: false,
      build(): string {
        return lambdaParenSource();
      },
    },
    {
      name: "mixed-nested",
      kind: "mixed-nested",
      constructCount: 8,
      samples: 3,
      timeout: false,
      checkIdempotent: true,
      expectOverlong: true,
      build(): string {
        return mixedNestedSource();
      },
    },
    {
      name: "comment-heavy",
      kind: "comment-heavy",
      constructCount: 8,
      samples: 3,
      timeout: false,
      checkIdempotent: true,
      expectOverlong: false,
      build(): string {
        return commentHeavySource();
      },
    },
    arrayCase(60),
    arrayCase(150),
    arrayCase(500),
    arrayCase(1000),
  ];
}

const ALREADY_FORMATTED_NAME = "already-formatted-20";

interface SampleRecord {
  readonly index: number;
  readonly ms: number | null;
  readonly cold: boolean;
  readonly timeout: boolean;
  readonly frontendInvocations: FrontendInvocationSample;
}

interface CaseReport {
  readonly name: string;
  readonly kind: string;
  readonly constructCount: number | null;
  readonly sourceBytes: number;
  readonly sourceLines: number;
  readonly formattedBytes: number | null;
  readonly idempotent: boolean | null;
  readonly fixtureMs: number | null;
  readonly fixtureInvocations: FrontendInvocationSample | null;
  readonly samples: readonly SampleRecord[];
}

interface BenchMeta {
  readonly tool: string;
  readonly deno: string;
  readonly v8: string;
  readonly typescript: string;
  readonly os: string;
  readonly cpu: string;
  readonly memory: string;
  readonly gitCommit: string;
  readonly startedAt: string;
  readonly argv: readonly string[];
  readonly options: {
    readonly only: string | null;
    readonly samples: number | null;
    readonly timeoutMs: number;
    readonly supervise: boolean;
    readonly inProcess: boolean;
  };
}

interface BenchReport {
  readonly meta: BenchMeta;
  readonly cases: readonly CaseReport[];
}

interface SampleOutcome {
  readonly ms: number | null;
  readonly timeout: boolean;
  readonly invocations: FrontendInvocationSample;
  readonly formatted: string | null;
}

async function runSample(source: string): Promise<SampleOutcome> {
  const before = snapshotTotals();
  const start = performance.now();
  const result = await countedFormat(source);
  const ms = performance.now() - start;
  if (!result.ok) {
    throw new Error(
      "benchmark source did not format: " + JSON.stringify(result.diagnostics),
    );
  }
  return {
    ms,
    timeout: false,
    invocations: invocationDelta(before),
    formatted: result.source,
  };
}

interface SupervisedOutcome {
  readonly samples: readonly SampleRecord[];
  readonly formattedBytes: number | null;
  readonly idempotent: boolean | null;
  readonly timedOut: boolean;
}

function supervisedCase(options: BenchOptions, candidate: BuiltCase): boolean {
  if (options.inProcess) return false;
  if (options.supervise) return true;
  return candidate.timeout;
}

function timeoutSamples(count: number): SampleRecord[] {
  const samples: SampleRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    samples.push({
      index,
      ms: null,
      cold: index === 0,
      timeout: true,
      frontendInvocations: {
        topLevelFormats: 0,
        topLevelParses: 0,
        internalParses: null,
      },
    });
  }
  return samples;
}

async function readChildCase(
  childOut: string,
  caseName: string,
): Promise<CaseReport | null> {
  let parsed: BenchReport;
  try {
    parsed = JSON.parse(await Deno.readTextFile(childOut)) as BenchReport;
  } catch {
    return null;
  }
  for (const item of parsed.cases) {
    if (item.name === caseName) return item;
  }
  return null;
}

function childCaseComplete(item: CaseReport, count: number): boolean {
  if (item.samples.length !== count) return false;
  for (const sample of item.samples) {
    if (sample.timeout || sample.ms === null) return false;
  }
  return true;
}

function printChildOutput(caseName: string, output: Deno.CommandOutput): void {
  const lines: string[] = [];
  for (const line of new TextDecoder().decode(output.stdout).split("\n")) {
    if (line !== "") lines.push(line);
  }
  if (lines.length === 0) return;
  console.log("[" + caseName + " child]");
  for (const line of lines) console.log(line);
}

async function runSupervised(
  caseName: string,
  count: number,
  timeoutMs: number | null,
): Promise<SupervisedOutcome> {
  const childOut = "/tmp/blot-bench-child-" + caseName + "-" + Deno.pid +
    ".json";
  const script = fromFileUrl(import.meta.url);
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      script,
      "--only",
      caseName,
      "--samples",
      String(count),
      "--in-process",
      "--out",
      childOut,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let killed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs !== null) {
    timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // The child already exited; its output decides below.
      }
    }, timeoutMs);
  }
  const output = await child.output();
  if (timer !== null) clearTimeout(timer);
  printChildOutput(caseName, output);
  const item = await readChildCase(childOut, caseName);
  if (item !== null && childCaseComplete(item, count)) {
    return {
      samples: item.samples,
      formattedBytes: item.formattedBytes,
      idempotent: item.idempotent,
      timedOut: false,
    };
  }
  if (killed) {
    return {
      samples: timeoutSamples(count),
      formattedBytes: null,
      idempotent: null,
      timedOut: true,
    };
  }
  const stderr = new TextDecoder().decode(output.stderr);
  throw new Error(
    "supervised child for " + caseName + " failed: " + stderr.slice(0, 500),
  );
}

function longestLineLength(source: string): number {
  let longest = 0;
  for (const line of source.split("\n")) {
    if (line.length > longest) longest = line.length;
  }
  return longest;
}

function assertOverlong(candidate: BenchCase, source: string): void {
  if (!candidate.expectOverlong) return;
  const longest = longestLineLength(source);
  if (longest <= 80) {
    throw new Error(
      "synthesis bug: case " + candidate.name + " has no overlong line",
    );
  }
}

function sampleCount(options: BenchOptions, candidate: BuiltCase): number {
  if (options.samples !== null) return options.samples;
  return candidate.samples;
}

function readCpuDescription(): string {
  try {
    const text = Deno.readTextFileSync("/proc/cpuinfo");
    let model = "";
    let threads = 0;
    for (const line of text.split("\n")) {
      if (line.startsWith("processor")) threads += 1;
      if (line.startsWith("model name") && model === "") {
        const parts = line.split(":");
        if (parts.length >= 2) model = parts.slice(1).join(":").trim();
      }
    }
    if (model === "") return "unknown";
    return model + " (" + threads + " threads)";
  } catch {
    return "unknown";
  }
}

function readMemoryDescription(): string {
  try {
    const text = Deno.readTextFileSync("/proc/meminfo");
    for (const line of text.split("\n")) {
      if (line.startsWith("MemTotal:")) {
        const parts = line.split(":");
        if (parts.length >= 2) return parts.slice(1).join(":").trim();
      }
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

function readGitCommit(): string {
  try {
    const command = new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      stdout: "piped",
      stderr: "null",
    });
    const output = command.outputSync();
    if (!output.success) return "unknown";
    return new TextDecoder().decode(output.stdout).trim();
  } catch {
    return "unknown";
  }
}

function environmentMeta(startedAt: string, options: BenchOptions): BenchMeta {
  return {
    tool: "scripts/bench_formatter.ts",
    deno: Deno.version.deno,
    v8: Deno.version.v8,
    typescript: Deno.version.typescript,
    os: Deno.build.os + "-" + Deno.build.arch,
    cpu: readCpuDescription(),
    memory: readMemoryDescription(),
    gitCommit: readGitCommit(),
    startedAt,
    argv: Deno.args,
    options: {
      only: options.only,
      samples: options.samples,
      timeoutMs: options.timeoutMs,
      supervise: options.supervise,
      inProcess: options.inProcess,
    },
  };
}

function defaultOutPath(gitCommit: string): string {
  let short = "unknown";
  if (gitCommit !== "unknown") short = gitCommit.slice(0, 8);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return "/tmp/blot-bench-" + short + "-" + stamp + ".json";
}

function medianOfSorted(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatMs(value: number): string {
  if (value < 1000) return value.toFixed(1) + "ms";
  return (value / 1000).toFixed(2) + "s";
}

function printTable(report: BenchReport): void {
  console.log(
    "case                 bytes  n  cold      min       med       max  notes",
  );
  for (const item of report.cases) {
    const times: number[] = [];
    let timeouts = 0;
    for (const sample of item.samples) {
      if (sample.timeout) {
        timeouts += 1;
      } else if (sample.ms !== null) {
        times.push(sample.ms);
      }
    }
    times.sort((left, right) => left - right);
    let cold = "-";
    const first = item.samples[0];
    if (first !== undefined && first.cold && first.ms !== null) {
      cold = formatMs(first.ms);
    }
    let timing = "TIMEOUT";
    if (times.length > 0) {
      timing = formatMs(times[0]) + " " + formatMs(medianOfSorted(times)) +
        " " + formatMs(times[times.length - 1]);
    }
    let notes = "";
    if (timeouts > 0) notes += "TIMEOUTx" + timeouts + " ";
    if (item.idempotent === false) notes += "NOT-IDEMPOTENT ";
    if (item.fixtureMs !== null) {
      notes += "fixture-" + formatMs(item.fixtureMs) + " ";
    }
    if (notes.endsWith(" ")) notes = notes.slice(0, notes.length - 1);
    const row = item.name.padEnd(20, " ") + " " +
      String(item.sourceBytes).padStart(6, " ") + " " +
      String(item.samples.length).padStart(2, " ") + " " +
      cold.padStart(7, " ") + " " +
      timing.padEnd(27, " ") + " " +
      notes;
    console.log(row);
  }
}

function printCaseList(): void {
  const encoder = new TextEncoder();
  for (const candidate of defineCases()) {
    const source = candidate.build();
    console.log(
      candidate.name + "  " + encoder.encode(source).byteLength + " bytes",
    );
  }
  console.log(ALREADY_FORMATTED_NAME + "  (fixture built at runtime)");
}

function supervisedReport(
  encoder: TextEncoder,
  candidate: BuiltCase,
  outcome: SupervisedOutcome,
  fixtureMs: number | null,
  fixtureInvocations: FrontendInvocationSample | null,
): CaseReport {
  let caseFixtureMs: number | null = null;
  let caseFixtureInvocations: FrontendInvocationSample | null = null;
  if (candidate.name === ALREADY_FORMATTED_NAME) {
    caseFixtureMs = fixtureMs;
    caseFixtureInvocations = fixtureInvocations;
  }
  return {
    name: candidate.name,
    kind: candidate.kind,
    constructCount: candidate.constructCount,
    sourceBytes: encoder.encode(candidate.source).byteLength,
    sourceLines: candidate.source.split("\n").length - 1,
    formattedBytes: outcome.formattedBytes,
    idempotent: outcome.idempotent,
    fixtureMs: caseFixtureMs,
    fixtureInvocations: caseFixtureInvocations,
    samples: outcome.samples,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(Deno.args);
  const startedAt = new Date().toISOString();
  if (options.list) {
    printCaseList();
    return;
  }
  const staticCases = defineCases();
  let selected: BenchCase[] = staticCases;
  let includeAlreadyFormatted = true;
  if (options.only !== null) {
    if (options.only === ALREADY_FORMATTED_NAME) {
      selected = [];
    } else {
      selected = staticCases.filter((candidate) =>
        candidate.name === options.only
      );
      includeAlreadyFormatted = false;
      if (selected.length === 0) {
        throw new Error("Unknown benchmark case: " + options.only);
      }
    }
  }
  const built: BuiltCase[] = selected.map((candidate) => {
    const source = candidate.build();
    assertOverlong(candidate, source);
    return { ...candidate, source };
  });

  // The cold sample runs before any other frontend call in the process, but
  // only when the first case runs in-process; a supervised first case gets
  // its cold sample from its own fresh child process instead.
  let coldSample: SampleRecord | null = null;
  let coldFormatted: string | null = null;
  if (built.length > 0 && !supervisedCase(options, built[0])) {
    const outcome = await runSample(built[0].source);
    coldSample = {
      index: 0,
      ms: outcome.ms,
      cold: true,
      timeout: false,
      frontendInvocations: outcome.invocations,
    };
    coldFormatted = outcome.formatted;
  }

  let fixtureMs: number | null = null;
  let fixtureInvocations: FrontendInvocationSample | null = null;
  if (includeAlreadyFormatted) {
    const before = snapshotTotals();
    const start = performance.now();
    const formatted = await countedFormat(overlongArraySource(20));
    fixtureMs = performance.now() - start;
    fixtureInvocations = invocationDelta(before);
    if (!formatted.ok) {
      throw new Error("already-formatted fixture did not format");
    }
    const fixtureSource = formatted.source;
    const fixture: BuiltCase = {
      name: ALREADY_FORMATTED_NAME,
      kind: "already-formatted",
      constructCount: 20,
      samples: 3,
      timeout: false,
      checkIdempotent: true,
      expectOverlong: false,
      build(): string {
        return fixtureSource;
      },
      source: fixtureSource,
    };
    const heavyIndex = built.findIndex((candidate) =>
      candidate.name === "arrays-60"
    );
    if (heavyIndex < 0) built.push(fixture);
    else built.splice(heavyIndex, 0, fixture);
  }

  for (const candidate of built) {
    const parsed = await countedParse(candidate.source);
    if (!parsed.ok) {
      throw new Error(
        "benchmark case " + candidate.name + " does not parse: " +
          JSON.stringify(parsed.diagnostics),
      );
    }
  }

  const encoder = new TextEncoder();
  const reports: CaseReport[] = [];
  let sawTimeout = false;
  for (const candidate of built) {
    const count = sampleCount(options, candidate);
    if (supervisedCase(options, candidate)) {
      let timeoutMs: number | null = null;
      if (candidate.timeout) timeoutMs = options.timeoutMs;
      const outcome = await runSupervised(candidate.name, count, timeoutMs);
      if (outcome.timedOut) sawTimeout = true;
      reports.push(
        supervisedReport(
          encoder,
          candidate,
          outcome,
          fixtureMs,
          fixtureInvocations,
        ),
      );
      continue;
    }
    const samples: SampleRecord[] = [];
    let formatted: string | null = null;
    if (coldSample !== null && candidate.name === built[0].name) {
      samples.push(coldSample);
      formatted = coldFormatted;
    }
    for (let index = samples.length; index < count; index += 1) {
      const outcome = await runSample(candidate.source);
      samples.push({
        index,
        ms: outcome.ms,
        cold: false,
        timeout: false,
        frontendInvocations: outcome.invocations,
      });
      formatted = outcome.formatted;
    }
    let idempotent: boolean | null = null;
    if (candidate.checkIdempotent && formatted !== null) {
      const again = await countedFormat(formatted);
      if (!again.ok) {
        throw new Error("reformat of " + candidate.name + " did not parse");
      }
      idempotent = again.source === formatted;
    }
    let formattedBytes: number | null = null;
    if (formatted !== null) {
      formattedBytes = encoder.encode(formatted).byteLength;
    }
    let caseFixtureMs: number | null = null;
    let caseFixtureInvocations: FrontendInvocationSample | null = null;
    if (candidate.name === ALREADY_FORMATTED_NAME) {
      caseFixtureMs = fixtureMs;
      caseFixtureInvocations = fixtureInvocations;
    }
    reports.push({
      name: candidate.name,
      kind: candidate.kind,
      constructCount: candidate.constructCount,
      sourceBytes: encoder.encode(candidate.source).byteLength,
      sourceLines: candidate.source.split("\n").length - 1,
      formattedBytes,
      idempotent,
      fixtureMs: caseFixtureMs,
      fixtureInvocations: caseFixtureInvocations,
      samples,
    });
  }

  const report: BenchReport = {
    meta: environmentMeta(startedAt, options),
    cases: reports,
  };
  let out = options.out;
  if (out === null) out = defaultOutPath(report.meta.gitCommit);
  await Deno.writeTextFile(out, JSON.stringify(report, null, 2) + "\n");
  printTable(report);
  console.log("JSON: " + out);
  if (sawTimeout) {
    console.log(
      "note: one or more cases timed out; timeouts are recorded as data",
    );
  }
}

if (import.meta.main) {
  await main();
}
