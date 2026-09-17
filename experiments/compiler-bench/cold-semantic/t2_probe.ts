// T2 decisive-experiment probe: API splits + H6 priming with guest timing.
//
// Each invocation runs ONE op sequence in a fresh process and prints one JSON
// document on stdout. Unlike sample.ts (canonical first-analysis only), this
// probe issues the exact call sequences that distinguish H1 (target preflight
// forces staging) from H2 (comptime eval during preparation) and H6 (engine
// first-use / host output):
//
//   check               create -> checkSource
//   analyze             create -> analyzeSource
//   prepare             create -> prepare (source read from disk by the call)
//   prepare_then_compile create -> prepare -> compile
//   analyze_twice       create -> analyzeSource -> analyzeSource (resident)
//   check_then_analyze  create -> checkSource -> analyzeSource
//   second_compiler     create -> analyzeSource -> create#2 -> analyzeSource
//   prime_trivial       create -> analyzeSource(trivial) -> analyzeSource(fixture)
//
// Usage:
//   deno run --allow-read --allow-env --allow-sys t2_probe.ts \
//     --fixture=/abs/path/to/full.blot --op=prepare_then_compile [--telemetry=phase]
//
// Contract:
// - readMs sits outside every call clock; each call is timed separately with
//   performance.now(); RSS (Deno.memoryUsage) is sampled outside the clocks;
// - --telemetry=phase enables guest schema-2 + host spans on analyze calls
//   (check/prepare/compile calls have no guest telemetry by construction);
// - failures print a classified JSON doc and exit nonzero (never missing).

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Compiler } from "../../../src/compiler.ts";

export const t2ProbeSchema = 1 as const;

type ProbeOp =
  | "check"
  | "analyze"
  | "prepare"
  | "prepare_then_compile"
  | "analyze_twice"
  | "check_then_analyze"
  | "second_compiler"
  | "prime_trivial";

const PROBE_OPS: readonly ProbeOp[] = [
  "check",
  "analyze",
  "prepare",
  "prepare_then_compile",
  "analyze_twice",
  "check_then_analyze",
  "second_compiler",
  "prime_trivial",
];

// Embedded priming input for prime_trivial (recorded by hash in output).
export const TRIVIAL_SOURCE = "const trivial_probe_value = 1\n";

type FailureClass =
  | "fixture-read-error"
  | "create-error"
  | "probe-error";

interface ProbeOptions {
  readonly fixture: string;
  readonly op: ProbeOp;
  readonly telemetry: "off" | "phase";
}

function parseOptions(args: readonly string[]): ProbeOptions {
  let fixture: string | null = null;
  let op: ProbeOp | null = null;
  let telemetry: "off" | "phase" = "off";
  for (const arg of args) {
    if (arg.startsWith("--fixture=")) {
      fixture = arg.slice("--fixture=".length);
    } else if (arg.startsWith("--op=")) {
      const value = arg.slice("--op=".length);
      if (!(PROBE_OPS as readonly string[]).includes(value)) {
        throw new Error(
          `t2_probe.ts supports only --op=${
            PROBE_OPS.join("|")
          } (got ${value})`,
        );
      }
      op = value as ProbeOp;
    } else if (arg.startsWith("--telemetry=")) {
      const value = arg.slice("--telemetry=".length);
      if (value !== "off" && value !== "phase") {
        throw new Error(
          `t2_probe.ts supports only --telemetry=off|phase (got ${value})`,
        );
      }
      telemetry = value;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "usage: t2_probe.ts --fixture=PATH --op=OP [--telemetry=off|phase]",
      );
    } else {
      throw new Error(`t2_probe.ts takes no positional arguments (got ${arg})`);
    }
  }
  if (fixture === null || fixture.length === 0) {
    throw new Error("t2_probe.ts requires --fixture=PATH");
  }
  if (op === null) throw new Error("t2_probe.ts requires --op=OP");
  return { fixture: resolve(fixture), op, telemetry };
}

function rssBytes(): number | null {
  try {
    const deno =
      (globalThis as { Deno?: { memoryUsage(): { rss: number } } }).Deno;
    if (deno !== undefined) return deno.memoryUsage().rss;
    const proc =
      (globalThis as { process?: { memoryUsage(): { rss: number } } }).process;
    if (proc !== undefined) return proc.memoryUsage().rss;
  } catch {
    // ignore
  }
  return null;
}

function failureJson(
  options: ProbeOptions,
  startedAt: number,
  failureClass: FailureClass,
  error: unknown,
): string {
  return JSON.stringify({
    schema: t2ProbeSchema,
    ok: false,
    class: failureClass,
    message: error instanceof Error ? error.message : String(error),
    fixture: options.fixture,
    op: options.op,
    operationalMilliseconds: performance.now() - startedAt,
  });
}

interface CallRecord {
  name: string;
  ms: number;
  type?: string;
  effects?: string;
  preflightSupported?: boolean;
  work?: unknown;
  guest?: unknown;
}

async function main(): Promise<void> {
  const options = parseOptions(Deno.args);
  const startedAt = performance.now();

  let source: string;
  let readMilliseconds: number;
  try {
    const before = performance.now();
    source = await readFile(options.fixture, "utf8");
    readMilliseconds = performance.now() - before;
  } catch (error) {
    console.log(failureJson(options, startedAt, "fixture-read-error", error));
    Deno.exitCode = 1;
    return;
  }

  const compilers: Compiler[] = [];
  const calls: CallRecord[] = [];
  const rssBefore = rssBytes();
  let hostTelemetry: unknown = null;
  try {
    const createCompiler = async (): Promise<Compiler> => {
      try {
        const compiler = await Compiler.create(
          options.telemetry === "phase" ? { phaseTelemetry: true } : {},
        );
        compilers.push(compiler);
        return compiler;
      } catch (error) {
        console.log(failureJson(options, startedAt, "create-error", error));
        throw error;
      }
    };

    const timedAnalyze = async (
      compiler: Compiler,
      name: string,
      path: string,
      text: string,
    ): Promise<void> => {
      const before = performance.now();
      const analysis = await compiler.analyzeSource(path, text);
      const ms = performance.now() - before;
      calls.push({
        name,
        ms,
        type: analysis.type,
        effects: analysis.effects,
        preflightSupported: analysis.targetPreflight?.supported,
        work: analysis.work,
        guest: analysis.phaseTelemetry ?? null,
      });
    };

    let compiler = await createCompiler();
    switch (options.op) {
      case "check": {
        const before = performance.now();
        const checked = await compiler.checkSource(options.fixture, source);
        calls.push({
          name: "checkSource",
          ms: performance.now() - before,
          type: checked.type,
          effects: checked.effects,
        });
        break;
      }
      case "analyze": {
        await timedAnalyze(compiler, "analyzeSource", options.fixture, source);
        break;
      }
      case "prepare": {
        const before = performance.now();
        await compiler.prepare(options.fixture);
        calls.push({ name: "prepare", ms: performance.now() - before });
        break;
      }
      case "prepare_then_compile": {
        const beforePrepare = performance.now();
        await compiler.prepare(options.fixture);
        calls.push({ name: "prepare", ms: performance.now() - beforePrepare });
        const beforeCompile = performance.now();
        await compiler.compile(options.fixture);
        calls.push({ name: "compile", ms: performance.now() - beforeCompile });
        break;
      }
      case "analyze_twice": {
        await timedAnalyze(
          compiler,
          "analyzeSource#1",
          options.fixture,
          source,
        );
        await timedAnalyze(
          compiler,
          "analyzeSource#2",
          options.fixture,
          source,
        );
        break;
      }
      case "check_then_analyze": {
        const before = performance.now();
        await compiler.checkSource(options.fixture, source);
        calls.push({ name: "checkSource", ms: performance.now() - before });
        await timedAnalyze(compiler, "analyzeSource", options.fixture, source);
        break;
      }
      case "second_compiler": {
        await timedAnalyze(
          compiler,
          "analyzeSource#1",
          options.fixture,
          source,
        );
        if (options.telemetry === "phase") {
          hostTelemetry = compiler.takePhaseTelemetry();
        }
        compiler = await createCompiler();
        await timedAnalyze(
          compiler,
          "analyzeSource#freshCompiler",
          options.fixture,
          source,
        );
        break;
      }
      case "prime_trivial": {
        await timedAnalyze(
          compiler,
          "analyzeSource#trivial",
          options.fixture + ".trivial.blot",
          TRIVIAL_SOURCE,
        );
        await timedAnalyze(
          compiler,
          "analyzeSource#fixture",
          options.fixture,
          source,
        );
        break;
      }
    }
    if (options.telemetry === "phase" && options.op !== "second_compiler") {
      hostTelemetry = compiler.takePhaseTelemetry();
    }
  } catch (error) {
    if (Deno.exitCode !== 1) {
      console.log(failureJson(options, startedAt, "probe-error", error));
      Deno.exitCode = 1;
    }
    return;
  } finally {
    for (const compiler of compilers) {
      try {
        compiler.destroy();
      } catch {
        // ignore teardown errors; the calls already completed
      }
    }
  }

  const rssAfter = rssBytes();
  console.log(JSON.stringify({
    schema: t2ProbeSchema,
    ok: true,
    fixture: options.fixture,
    op: options.op,
    telemetry: options.telemetry,
    readMilliseconds,
    calls,
    host: hostTelemetry,
    rssBeforeBytes: rssBefore,
    rssAfterBytes: rssAfter,
    trivialSourceSha256: options.op === "prime_trivial"
      ? await sha256Hex(TRIVIAL_SOURCE)
      : null,
    operationalMilliseconds: performance.now() - startedAt,
  }));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

await main();
