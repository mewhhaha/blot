// One cold-semantic sample in a fresh process.
//
// Usage:
//   deno run --allow-read --allow-env --allow-sys sample.ts \
//     --fixture=/abs/path/to/full.blot --mode=fresh-process-first-analysis \
//     [--telemetry=off|phase]
//
// Contract (see cold-semantic README + manifest):
// - exactly one Compiler.create() (timed as createMs) and one analyzeSource
//   call (timed as analyzeMs); no priming, no portableGraph/prepare/checkSource
//   before the canonical cold measurement;
// - --telemetry=phase opts into coarse phase telemetry (host spans plus
//   guest counter spans); canonical batches always run --telemetry=off and
//   keep phaseTelemetry null;
// - source is read before Compiler.create(); readMs sits outside the call
//   clock and inside the operational total;
// - observation, memory, and logging happen after analyzeMs stops;
// - always prints one JSON document to stdout: ok samples carry the full
//   work record and semantic results, failures carry a classified outcome
//   (never a missing sample or a zero duration).
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Compiler } from "../../../src/compiler.ts";
import { compilerObservation } from "../observation.ts";

export const coldSemanticSampleSchema = 1 as const;

type FailureClass =
  | "fixture-read-error"
  | "create-error"
  | "analysis-error";

type TelemetryMode = "off" | "phase";

interface SampleOptions {
  readonly fixture: string;
  readonly mode: string;
  readonly telemetry: TelemetryMode;
}

function parseOptions(args: readonly string[]): SampleOptions {
  let fixture: string | null = null;
  let mode = "fresh-process-first-analysis";
  let telemetry: TelemetryMode = "off";
  for (const arg of args) {
    if (arg.startsWith("--fixture=")) {
      fixture = arg.slice("--fixture=".length);
    } else if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
    } else if (arg.startsWith("--telemetry=")) {
      const value = arg.slice("--telemetry=".length);
      if (value !== "off" && value !== "phase") {
        throw new Error(
          `sample.ts supports only --telemetry=off|phase (got ${value})`,
        );
      }
      telemetry = value;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "usage: sample.ts --fixture=PATH [--mode=fresh-process-first-analysis] [--telemetry=off|phase]",
      );
    } else {
      throw new Error(`sample.ts takes no positional arguments (got ${arg})`);
    }
  }
  if (fixture === null || fixture.length === 0) {
    throw new Error("sample.ts requires --fixture=PATH");
  }
  if (mode !== "fresh-process-first-analysis") {
    throw new Error(
      `sample.ts supports only --mode=fresh-process-first-analysis (got ${mode})`,
    );
  }
  return { fixture: resolve(fixture), mode, telemetry };
}

function failureJson(
  options: SampleOptions,
  startedAt: number,
  failureClass: FailureClass,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error &&
      typeof (error as unknown as { code?: unknown }).code === "string"
    ? (error as unknown as { code: string }).code
    : null;
  return JSON.stringify({
    schema: coldSemanticSampleSchema,
    ok: false,
    class: failureClass,
    message,
    code,
    fixture: options.fixture,
    mode: options.mode,
    operationalMilliseconds: performance.now() - startedAt,
  });
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  const globals = globalThis as unknown as {
    Deno?: { args: readonly string[]; memoryUsage: () => { rss: number } };
    process?: { argv: readonly string[]; memoryUsage: () => { rss: number } };
  };
  const raw: readonly string[] = globals.Deno?.args ??
    globals.process?.argv.slice(2) ?? [];
  let options: SampleOptions;
  try {
    options = parseOptions(raw);
  } catch (error) {
    console.log(JSON.stringify({
      schema: coldSemanticSampleSchema,
      ok: false,
      class: "fixture-read-error",
      message: error instanceof Error ? error.message : String(error),
      code: null,
      fixture: null,
      mode: null,
      operationalMilliseconds: performance.now() - startedAt,
    }));
    throw error;
  }

  let source: string;
  let readMilliseconds: number;
  try {
    const before = performance.now();
    source = await readFile(options.fixture, "utf8");
    readMilliseconds = performance.now() - before;
  } catch (error) {
    console.log(failureJson(options, startedAt, "fixture-read-error", error));
    throw error;
  }

  let compiler: Compiler;
  let createMilliseconds: number;
  try {
    const before = performance.now();
    compiler = await Compiler.create(
      options.telemetry === "phase" ? { phaseTelemetry: true } : {},
    );
    createMilliseconds = performance.now() - before;
  } catch (error) {
    console.log(failureJson(options, startedAt, "create-error", error));
    throw error;
  }

  try {
    const before = performance.now();
    const analysis = await compiler.analyzeSource(options.fixture, source);
    const analyzeMilliseconds = performance.now() - before;

    // Observation, memory, and teardown stay outside the call clock.
    const observation = compilerObservation(analysis);
    const hostTelemetry = options.telemetry === "phase"
      ? compiler.takePhaseTelemetry()
      : null;
    let hostRssBytes: number | null = null;
    try {
      if (globals.Deno !== undefined) {
        hostRssBytes = globals.Deno.memoryUsage().rss;
      } else if (globals.process !== undefined) {
        hostRssBytes = globals.process.memoryUsage().rss;
      }
    } catch {
      hostRssBytes = null;
    }
    console.log(JSON.stringify({
      schema: coldSemanticSampleSchema,
      ok: true,
      fixture: options.fixture,
      mode: options.mode,
      readMilliseconds,
      createMilliseconds,
      analyzeMilliseconds,
      operationalMilliseconds: performance.now() - startedAt,
      observation,
      type: analysis.type,
      effects: analysis.effects,
      targetPreflight: analysis.targetPreflight,
      work: analysis.work,
      invalidation: analysis.invalidation,
      hostRssBytes,
      phaseTelemetry: options.telemetry === "phase"
        ? {
          schema: 1,
          host: hostTelemetry,
          rust: analysis.phaseTelemetry ?? null,
        }
        : null,
    }));
  } catch (error) {
    console.log(failureJson(options, startedAt, "analysis-error", error));
    throw error;
  } finally {
    compiler.destroy();
  }
}

await main();
