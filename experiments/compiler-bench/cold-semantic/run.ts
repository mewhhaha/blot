// Cold-semantic batch runner: one fresh Deno process per cold sample.
//
// Usage:
//   deno run --allow-read --allow-write --allow-env --allow-sys --allow-run=deno,git \
//     run.ts --fixtures=prefix.blot,full.blot --samples=15 --runs=3 \
//     --out=pilot --sample=./sample.ts [--telemetry=off|phase]
//
// Contract (see cold-semantic README + manifest):
// - resolves every fixture to a stable absolute path once, then spawns
//   runs x samples x fixtures `deno run sample.ts` children (--samples is
//   per fixture per run); fixture order rotates each run so no fixture
//   always runs first inside a run;
// - captures provenance before the first sample and after the last sample;
//   a changed capture rejects the report instead of mixing revisions;
// - retains every sample (ok + classified failures) as raw JSONL; no index
//   pairing, no discarding startups; summaries recompute from raw samples.
import { dirname, fromFileUrl, resolve } from "@std/path";
import { medianAbsoluteDeviation, percentile } from "../schema.ts";

// Mirrors coldSemanticSampleSchema in sample.ts (kept local so importing this
// runner never executes the sampler's top-level main).
const coldSemanticSampleSchema = 1 as const;

export const coldSemanticRunSchema = 1 as const;

const runnerDirectory = dirname(fromFileUrl(import.meta.url));

type TelemetryMode = "off" | "phase";

interface RunOptions {
  readonly fixtures: readonly string[];
  readonly samples: number;
  readonly runs: number;
  readonly out: string;
  readonly samplePath: string;
  readonly denoPath: string;
  readonly telemetry: TelemetryMode;
}

interface SampleRecord {
  readonly run: number;
  readonly slot: number;
  readonly fixture: string;
  readonly wallMilliseconds: number;
  readonly exitCode: number;
  readonly sample: unknown;
}

function parseOptions(args: readonly string[]): RunOptions {
  let fixtures: readonly string[] | null = null;
  let samples = 15;
  let runs = 3;
  let out: string | null = null;
  let samplePath = resolve(runnerDirectory, "sample.ts");
  let denoPath = Deno.execPath();
  let telemetry: TelemetryMode = "off";
  for (const arg of args) {
    if (arg.startsWith("--fixtures=")) {
      fixtures = arg.slice("--fixtures=".length).split(",").map((entry) =>
        resolve(entry.trim())
      );
    } else if (arg.startsWith("--samples=")) {
      samples = Number(arg.slice("--samples=".length));
    } else if (arg.startsWith("--runs=")) {
      runs = Number(arg.slice("--runs=".length));
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    } else if (arg.startsWith("--sample=")) {
      samplePath = resolve(arg.slice("--sample=".length));
    } else if (arg.startsWith("--deno=")) {
      denoPath = arg.slice("--deno=".length);
    } else if (arg.startsWith("--telemetry=")) {
      const value = arg.slice("--telemetry=".length);
      if (value !== "off" && value !== "phase") {
        throw new Error(
          `run.ts supports only --telemetry=off|phase (got ${value})`,
        );
      }
      telemetry = value;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "usage: run.ts --fixtures=A,B --samples=N --runs=R --out=DIR [--sample=PATH] [--deno=PATH] [--telemetry=off|phase]",
      );
    } else {
      throw new Error(`run.ts takes no positional arguments (got ${arg})`);
    }
  }
  if (
    fixtures === null || fixtures.length === 0 ||
    fixtures.some((f) => f.length === 0)
  ) {
    throw new Error("run.ts requires --fixtures=A,B with at least one fixture");
  }
  if (!Number.isSafeInteger(samples) || samples < 1) {
    throw new Error("--samples must be a positive integer");
  }
  if (!Number.isSafeInteger(runs) || runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  if (out === null || out.length === 0) {
    throw new Error("run.ts requires --out=DIR");
  }
  return {
    fixtures,
    samples,
    runs,
    out: resolve(out),
    samplePath,
    denoPath,
    telemetry,
  };
}

async function gitText(args: readonly string[]): Promise<string | null> {
  try {
    const child = new Deno.Command("git", {
      args: [...args],
      stdout: "piped",
      stderr: "null",
    });
    const { code, stdout } = await child.output();
    if (code !== 0) return null;
    return new TextDecoder().decode(stdout).trim();
  } catch {
    return null;
  }
}

// Scoped host-input scopes from experiments/compiler-bench/provenance.ts: the
// measured host closure. Ambient worktree drift outside these scopes (docs,
// examples, unbuilt Rust sources) is recorded but does not reject a batch;
// any byte drift inside the closure does.
const hostInputScopes = [
  "src",
  "generated/wasm",
  "generated/queries",
  "generated/.baba-manifest.json",
  "generated/compiler/prelude.snapshot",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "deno.json",
] as const;

async function scopedHostInputsSha256(): Promise<string | null> {
  try {
    const child = new Deno.Command("git", {
      args: [
        "ls-files",
        "-co",
        "--exclude-standard",
        "-z",
        "--",
        ...hostInputScopes,
      ],
      stdout: "piped",
      stderr: "null",
    });
    const { code, stdout } = await child.output();
    if (code !== 0) return null;
    const paths = new TextDecoder().decode(stdout).split("\0")
      .filter((path) => path.length > 0).sort();
    if (!paths.includes(".pnp.cjs")) paths.push(".pnp.cjs");
    paths.sort();
    const parts: Uint8Array[] = [];
    const encoder = new TextEncoder();
    for (const path of paths) {
      parts.push(encoder.encode(`${path.length}:${path}:`));
      try {
        const bytes = await Deno.readFile(path);
        parts.push(encoder.encode(`present:${bytes.byteLength}:`));
        parts.push(bytes);
      } catch {
        parts.push(encoder.encode("missing:"));
      }
    }
    const total = parts.reduce((n, part) => n + part.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    return await sha256Hex(joined);
  } catch {
    return null;
  }
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    data.buffer as ArrayBuffer,
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fileSha256(path: string): Promise<string> {
  return await sha256Hex(await Deno.readFile(path));
}

async function captureProvenance(
  options: RunOptions,
): Promise<Record<string, unknown>> {
  const [commit, status, denoVersion, scopedHostSha256, denoExecutableSha256] =
    await Promise.all([
      gitText(["rev-parse", "HEAD"]),
      gitText(["status", "--short"]),
      Promise.resolve(`${Deno.version.deno} (v8 ${Deno.version.v8})`),
      scopedHostInputsSha256(),
      fileSha256(Deno.execPath()).catch(() => null),
    ]);
  const fixtureFiles: Record<string, string> = {};
  for (const fixture of options.fixtures) {
    fixtureFiles[fixture] = await fileSha256(fixture);
  }
  const harnessFiles: Record<string, string> = {};
  for (const name of ["generate.ts", "sample.ts", "run.ts", "framework.blot"]) {
    const path = resolve(runnerDirectory, name);
    harnessFiles[name] = await fileSha256(path);
  }
  return {
    commit,
    worktreeStatus: status,
    scopedHostSha256,
    denoExecutableSha256,
    denoVersion,
    nodeVersion: (Deno.version as { node?: string }).node ?? null,
    platform: Deno.build.os,
    arch: Deno.build.arch,
    fixtureSha256: fixtureFiles,
    harnessSha256: harnessFiles,
    compilerArtifactSha256: await fileSha256("generated/compiler/compiler.wasm")
      .catch(() => null),
    compilerManifestSha256: await fileSha256(
      "generated/compiler/compiler-artifact.json",
    ).catch(() => null),
    preludeSha256: await fileSha256("generated/compiler/prelude.snapshot")
      .catch(() => null),
    invocation: ["run.ts", ...Deno.args],
    samplePath: options.samplePath,
    denoPath: options.denoPath,
  };
}

interface SummarizedDurations {
  readonly count: number;
  readonly p50: number;
  readonly mad: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
}

function summarize(values: readonly number[]): SummarizedDurations {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    mad: medianAbsoluteDeviation(values),
    p95: percentile(values, 0.95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function okSampleDurations(
  records: readonly SampleRecord[],
): { analyze: number[]; create: number[]; wall: number[]; failed: number } {
  const analyze: number[] = [];
  const create: number[] = [];
  const wall: number[] = [];
  let failed = 0;
  for (const record of records) {
    const sample = record.sample as {
      ok?: unknown;
      analyzeMilliseconds?: unknown;
      createMilliseconds?: unknown;
    } | null;
    if (
      sample !== null && typeof sample === "object" && sample.ok === true &&
      typeof sample.analyzeMilliseconds === "number" &&
      typeof sample.createMilliseconds === "number"
    ) {
      analyze.push(sample.analyzeMilliseconds);
      create.push(sample.createMilliseconds);
      wall.push(record.wallMilliseconds);
    } else {
      failed += 1;
    }
  }
  return { analyze, create, wall, failed };
}

interface TelemetryPhaseView {
  readonly name: string;
  readonly milliseconds: number;
  readonly subSpans: readonly {
    readonly name: string;
    readonly milliseconds: number;
    readonly detail?: unknown;
  }[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

// Aggregates guest phase telemetry across one fixture's ok samples. Returns
// null when no sample carried guest telemetry (always the case for
// --telemetry=off batches). Phase/sub-span walls summarize as distributions;
// counters report medians (they are deterministic per fixture per artifact).
function summarizeTelemetry(
  records: readonly SampleRecord[],
): Record<string, unknown> | null {
  const phaseSeries = new Map<string, number[]>();
  const subSeries = new Map<string, number[]>();
  const convInsideSeries = new Map<string, number[]>();
  const evalSeries = new Map<string, number[]>();
  const structuralSeries = new Map<string, number[]>();
  const unattributed: number[] = [];
  let samples = 0;
  let guestSchema: unknown = null;
  let guestClock: unknown = null;
  for (const record of records) {
    const sample = asRecord(record.sample);
    const telemetry = sample !== null ? asRecord(sample.phaseTelemetry) : null;
    const rust = telemetry !== null ? asRecord(telemetry.rust) : null;
    const host = telemetry !== null ? asRecord(telemetry.host) : null;
    if (rust === null) continue;
    const phases = Array.isArray(rust.phases) ? rust.phases : [];
    const views: TelemetryPhaseView[] = [];
    for (const entry of phases) {
      const phase = asRecord(entry);
      const subSpans = phase !== null && Array.isArray(phase.subSpans)
        ? phase.subSpans
        : [];
      if (
        phase === null || typeof phase.name !== "string" ||
        typeof phase.milliseconds !== "number"
      ) {
        continue;
      }
      const subs: { name: string; milliseconds: number; detail?: unknown }[] =
        [];
      for (const sub of subSpans) {
        const span = asRecord(sub);
        if (
          span === null || typeof span.name !== "string" ||
          typeof span.milliseconds !== "number"
        ) {
          continue;
        }
        subs.push({
          name: span.name,
          milliseconds: span.milliseconds,
          detail: span.detail,
        });
      }
      views.push({
        name: phase.name,
        milliseconds: phase.milliseconds,
        subSpans: subs,
      });
    }
    if (views.length === 0) continue;
    samples += 1;
    guestSchema = rust.schema ?? null;
    guestClock = rust.clock ?? null;
    let phaseTotal = 0;
    for (const view of views) {
      phaseTotal += view.milliseconds;
      pushTo(phaseSeries, view.name, view.milliseconds);
      for (const sub of view.subSpans) {
        pushTo(subSeries, `${view.name}.${sub.name}`, sub.milliseconds);
        if (view.name !== "target-preflight" && sub.name === "conversion") {
          const detail = asRecord(sub.detail);
          if (detail !== null && typeof detail.insideEvalMs === "number") {
            pushTo(convInsideSeries, view.name, detail.insideEvalMs);
          }
        }
      }
    }
    const evalSection = asRecord(rust.eval);
    if (evalSection !== null) {
      for (const [key, value] of Object.entries(evalSection)) {
        if (typeof value === "number") pushTo(evalSeries, key, value);
      }
    }
    const structuralSection = asRecord(rust.structural);
    if (structuralSection !== null) {
      for (const [key, value] of Object.entries(structuralSection)) {
        if (typeof value === "number") pushTo(structuralSeries, key, value);
      }
    }
    const calls = host !== null && Array.isArray(host.calls) ? host.calls : [];
    const spans = calls.length > 0 ? asRecord(calls[0]!) : null;
    const spanList = spans !== null && Array.isArray(spans.spans)
      ? spans.spans
      : [];
    for (const span of spanList) {
      const entry = asRecord(span);
      if (
        entry !== null && entry.name === "guest-call" &&
        typeof entry.milliseconds === "number"
      ) {
        unattributed.push(entry.milliseconds - phaseTotal);
      }
    }
  }
  if (samples === 0) return null;
  const summarizeMap = (series: Map<string, number[]>) =>
    Object.fromEntries(
      [...series.entries()]
        .sort(([a], [b]) => a < b ? -1 : 1)
        .map(([key, values]) => [key, summarize(values)]),
    );
  const medianMap = (series: Map<string, number[]>) =>
    Object.fromEntries(
      [...series.entries()]
        .sort(([a], [b]) => a < b ? -1 : 1)
        .map(([key, values]) => [key, percentile(values, 0.5)]),
    );
  return {
    samples,
    guestSchema,
    guestClock,
    guestPhaseMs: summarizeMap(phaseSeries),
    subSpanMs: summarizeMap(subSeries),
    // Overlaps the eval sub-span; never sum with it (see spanSemantics).
    conversionInsideEvalMs: summarizeMap(convInsideSeries),
    eval: medianMap(evalSeries),
    structural: medianMap(structuralSeries),
    // Derived per sample: host guest-call minus guest phase walls =
    // response serialization + telemetry attach + Wasm call overhead.
    guestUnattributedMs: unattributed.length > 0
      ? summarize(unattributed)
      : null,
  };
}

function pushTo(
  series: Map<string, number[]>,
  key: string,
  value: number,
): void {
  const list = series.get(key);
  if (list === undefined) {
    series.set(key, [value]);
  } else {
    list.push(value);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(Deno.args);
  for (const fixture of options.fixtures) {
    const stat = await Deno.stat(fixture).catch(() => null);
    if (stat === null || !stat.isFile) {
      throw new Error(`run.ts fixture is not a file: ${fixture}`);
    }
  }
  const before = await captureProvenance(options);
  const records: SampleRecord[] = [];
  let slot = 0;
  for (let run = 0; run < options.runs; run += 1) {
    for (let sample = 0; sample < options.samples; sample += 1) {
      for (
        let pick = 0;
        pick < options.fixtures.length;
        pick += 1
      ) {
        const fixture = options
          .fixtures[(pick + run) % options.fixtures.length]!;
        const startedAt = performance.now();
        const child = new Deno.Command(options.denoPath, {
          args: [
            "run",
            "--allow-read",
            "--allow-env",
            "--allow-sys",
            options.samplePath,
            `--fixture=${fixture}`,
            "--mode=fresh-process-first-analysis",
            `--telemetry=${options.telemetry}`,
          ],
          stdout: "piped",
          stderr: "null",
        });
        const { code, stdout } = await child.output();
        const wallMilliseconds = performance.now() - startedAt;
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(stdout));
        } catch {
          parsed = {
            schema: coldSemanticSampleSchema,
            ok: false,
            class: "harness-error",
            message: "child sample did not print valid JSON",
            code: null,
            fixture,
            mode: "fresh-process-first-analysis",
          };
        }
        records.push({
          run,
          slot,
          fixture,
          wallMilliseconds,
          exitCode: code,
          sample: parsed,
        });
        const one = parsed as { ok?: unknown; analyzeMilliseconds?: unknown };
        console.log(
          `run=${run} slot=${slot} fixture=${fixture} exit=${code} ` +
            `ok=${one.ok === true} analyzeMs=${
              typeof one.analyzeMilliseconds === "number"
                ? one.analyzeMilliseconds.toFixed(1)
                : "?"
            } wallMs=${wallMilliseconds.toFixed(1)}`,
        );
        slot += 1;
      }
    }
  }
  const after = await captureProvenance(options);
  // Stability covers the measured input closure only: ambient worktree drift
  // outside the closure is recorded (worktreeStatus before/after) but never
  // rejects; any closure drift rejects the batch.
  const closureKeys = [
    "commit",
    "scopedHostSha256",
    "denoExecutableSha256",
    "denoVersion",
    "platform",
    "arch",
    "fixtureSha256",
    "harnessSha256",
    "compilerArtifactSha256",
    "compilerManifestSha256",
    "preludeSha256",
  ] as const;
  const closureBefore = Object.fromEntries(
    closureKeys.map((key) => [key, before[key]]),
  );
  const closureAfter = Object.fromEntries(
    closureKeys.map((key) => [key, after[key]]),
  );
  const stable = JSON.stringify(closureBefore) === JSON.stringify(closureAfter);

  await Deno.mkdir(options.out, { recursive: true });
  const rawLines = records.map((record) => JSON.stringify(record)).join("\n") +
    "\n";
  await Deno.writeTextFile(`${options.out}/raw.jsonl`, rawLines);

  const fixtures = options.fixtures.map((fixture) => {
    const mine = records.filter((record) => record.fixture === fixture);
    const perRun = Array.from({ length: options.runs }, (_, run) => {
      const durations = okSampleDurations(
        mine.filter((record) => record.run === run),
      );
      return {
        run,
        failed: durations.failed,
        analyzeMilliseconds: durations.analyze.length > 0
          ? summarize(durations.analyze)
          : null,
        createMilliseconds: durations.create.length > 0
          ? summarize(durations.create)
          : null,
        wallMilliseconds: durations.wall.length > 0
          ? summarize(durations.wall)
          : null,
      };
    });
    const all = okSampleDurations(mine);
    return {
      fixture,
      failed: all.failed,
      runs: perRun,
      aggregate: {
        analyzeMilliseconds: all.analyze.length > 0
          ? summarize(all.analyze)
          : null,
        createMilliseconds: all.create.length > 0
          ? summarize(all.create)
          : null,
        wallMilliseconds: all.wall.length > 0 ? summarize(all.wall) : null,
      },
      telemetrySummary: summarizeTelemetry(mine),
    };
  });
  await Deno.writeTextFile(
    `${options.out}/summary.json`,
    JSON.stringify(
      {
        schema: coldSemanticRunSchema,
        samplesPerFixturePerRun: options.samples,
        runs: options.runs,
        telemetry: options.telemetry,
        provenanceBefore: before,
        provenanceAfter: after,
        provenanceStable: stable,
        fixtures,
      },
      null,
      2,
    ) + "\n",
  );
  if (!stable) {
    throw new Error(
      "run.ts provenance changed during the batch; report rejected",
    );
  }
}

await main();
