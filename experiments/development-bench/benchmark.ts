import { DevelopmentProject } from "../../src/development.ts";
import { DevelopmentRuntime } from "../../src/development_runtime.ts";
import {
  captureDevelopmentBenchmarkProvenance,
  requireStableDevelopmentBenchmarkProvenance,
} from "./provenance.ts";
import {
  type DevelopmentBenchmarkCompilerProfile,
  developmentBenchmarkCompilerProfiling,
  developmentBenchmarkMaximumRssGrowthBytes,
  type DevelopmentBenchmarkReport,
  type DevelopmentBenchmarkSample,
  developmentBenchmarkSchema,
  maximumRssGrowth,
  summarizeDurations,
} from "./schema.ts";
import {
  developmentBenchmarkTargetBytes,
  developmentBenchmarkUnitCount,
  writeDevelopmentBenchmarkWorkload,
} from "./workload.ts";

interface BenchmarkOptions {
  readonly samples: number;
  readonly targetSourceBytes: number;
  readonly gate: "enforce" | "report-only";
  readonly output: string | null;
  readonly compilerProfile: DevelopmentBenchmarkCompilerProfile;
}

const options = parseOptions(Deno.args);
const {
  provenance: initialProvenance,
  compilerOptions,
} = await captureDevelopmentBenchmarkProvenance(options.compilerProfile);
const directory = await Deno.makeTempDir({
  prefix: "blot-development-bench-",
});

try {
  const workload = await writeDevelopmentBenchmarkWorkload({
    directory,
    targetSourceBytes: options.targetSourceBytes,
    unitCount: developmentBenchmarkUnitCount,
  });
  const project = await DevelopmentProject.create(
    workload.manifestPath,
    compilerOptions,
  );
  const runtime = new DevelopmentRuntime(() => ({
    "blot:host/Source": { value: () => 10n },
  }));
  try {
    const initialActivationStarted = performance.now();
    const initial = await project.activate(runtime);
    const initialActivated = performance.now();
    const initialHostRssBytes = Deno.memoryUsage().rss;
    const initialActivationMilliseconds = initialActivated -
      initialActivationStarted - initial.durationMilliseconds;
    requireNonNegativeDuration(
      initialActivationMilliseconds,
      "initial activation",
    );
    const initialObservation = run(runtime.entryInstance);
    requireObservation(
      initialObservation,
      workload.expectedObservation(101),
      "initial build",
    );

    const samples: DevelopmentBenchmarkSample[] = [];
    const sampleProfiles: Array<typeof initial.developmentProfile> = [];
    for (let iteration = 0; iteration < options.samples; iteration += 1) {
      let increment = 102;
      if (iteration % 2 === 1) increment = 101;
      const committedStarted = performance.now();
      await Deno.writeTextFile(
        workload.editedProviderPath,
        workload.editedProviderSource(increment),
      );
      await project.markChanged(workload.editedProviderPath);
      const activationStarted = performance.now();
      const build = await project.activate(runtime);
      const activated = performance.now();
      const hostRssBytes = Deno.memoryUsage().rss;
      const committedMilliseconds = activated - committedStarted;
      const activationMilliseconds = activated - activationStarted -
        build.durationMilliseconds;
      requireNonNegativeDuration(
        activationMilliseconds,
        `sample ${iteration} activation`,
      );
      const changedUnits = build.changedUnits.map((unit) => unit.name);
      if (changedUnits.length !== 1 || changedUnits[0] !== "unit-1") {
        throw new Error(
          `development benchmark rebuilt [${
            changedUnits.join(", ")
          }], expected only unit-1`,
        );
      }
      const observation = run(runtime.entryInstance);
      requireObservation(
        observation,
        workload.expectedObservation(increment),
        `sample ${iteration}`,
      );
      samples.push({
        iteration,
        buildMilliseconds: build.durationMilliseconds,
        activationMilliseconds,
        committedMilliseconds,
        changedUnits,
        retainedUnits: build.retainedUnits.map((unit) => unit.name),
        transferredWasmBytes: build.changedUnits.reduce(
          (total, unit) => total + unit.wasm.byteLength,
          0,
        ),
        transferredManifestBytes: build.changedUnits.reduce(
          (total, unit) => total + unit.manifestBytes.byteLength,
          0,
        ),
        observation: observation.toString(),
        hostRssBytes,
      });
      sampleProfiles.push(build.developmentProfile);
    }

    const { provenance: finalProvenance } =
      await captureDevelopmentBenchmarkProvenance(options.compilerProfile);
    requireStableDevelopmentBenchmarkProvenance(
      initialProvenance,
      finalProvenance,
    );
    const report: DevelopmentBenchmarkReport = {
      schema: developmentBenchmarkSchema,
      ...initialProvenance,
      compilerProfiling: developmentBenchmarkCompilerProfiling(
        initialProvenance.compilerProfile,
        initial.developmentProfile,
        sampleProfiles,
      ),
      workload: {
        sourceBytes: workload.sourceBytes,
        editedProviderBytes: workload.editedProviderBytes,
        unitCount: workload.unitCount,
        voxelDeclarations: workload.voxelDeclarations,
      },
      initial: {
        buildMilliseconds: initial.durationMilliseconds,
        activationMilliseconds: initialActivationMilliseconds,
        changedUnits: initial.changedUnits.map((unit) => unit.name),
        observation: initialObservation.toString(),
        hostRssBytes: initialHostRssBytes,
      },
      samples,
      committed: summarizeDurations(
        samples.map((sample) => sample.committedMilliseconds),
      ),
      build: summarizeDurations(
        samples.map((sample) => sample.buildMilliseconds),
      ),
      activation: summarizeDurations(
        samples.map((sample) => sample.activationMilliseconds),
      ),
      maximumRssGrowthBytes: maximumRssGrowth(
        initialHostRssBytes,
        samples,
      ),
    };
    const encoded = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output === null) {
      await Deno.stdout.write(new TextEncoder().encode(encoded));
    } else {
      await Deno.writeTextFile(options.output, encoded);
    }
    if (
      options.gate === "enforce" &&
      report.committed.p95Milliseconds >= 100
    ) {
      throw new Error(
        `development edit-through-activation p95 was ${
          report.committed.p95Milliseconds.toFixed(1)
        } ms, expected less than 100 ms`,
      );
    }
    if (
      options.gate === "enforce" &&
      report.maximumRssGrowthBytes >= developmentBenchmarkMaximumRssGrowthBytes
    ) {
      throw new Error(
        `development RSS grew by ${report.maximumRssGrowthBytes} bytes, expected less than ${developmentBenchmarkMaximumRssGrowthBytes} bytes`,
      );
    }
  } finally {
    project.destroy();
  }
} finally {
  await Deno.remove(directory, { recursive: true });
}

function parseOptions(arguments_: readonly string[]): BenchmarkOptions {
  let samples = 20;
  let targetSourceBytes = developmentBenchmarkTargetBytes;
  let gate: BenchmarkOptions["gate"] = "enforce";
  let output: string | null = null;
  let compilerProfile: DevelopmentBenchmarkCompilerProfile = "production";
  for (const argument of arguments_) {
    if (argument === "--") {
      continue;
    } else if (argument.startsWith("--samples=")) {
      samples = Number(argument.slice("--samples=".length));
    } else if (argument.startsWith("--target-bytes=")) {
      targetSourceBytes = Number(argument.slice("--target-bytes=".length));
    } else if (argument === "--report-only") {
      gate = "report-only";
    } else if (argument.startsWith("--output=")) {
      output = argument.slice("--output=".length);
    } else if (argument === "--development-profile") {
      compilerProfile = "development-profile";
    } else {
      throw new Error(`unknown development benchmark argument ${argument}`);
    }
  }
  if (!Number.isSafeInteger(samples) || samples < 1) {
    throw new Error("--samples must be a positive integer");
  }
  if (!Number.isSafeInteger(targetSourceBytes) || targetSourceBytes < 1) {
    throw new Error("--target-bytes must be a positive integer");
  }
  return {
    samples,
    targetSourceBytes,
    gate,
    output,
    compilerProfile,
  };
}

function run(instance: WebAssembly.Instance): bigint {
  const exported = instance.exports["blot:default"];
  if (typeof exported !== "function") {
    throw new Error("development entry unit omitted blot:default");
  }
  const result = exported();
  if (typeof result !== "bigint") {
    throw new Error(
      `development entry unit returned ${typeof result}, expected bigint`,
    );
  }
  return result;
}

function requireObservation(
  actual: bigint,
  expected: bigint,
  phase: string,
): void {
  if (actual === expected) return;
  throw new Error(`${phase} returned ${actual}, expected ${expected}`);
}

function requireNonNegativeDuration(duration: number, phase: string): void {
  if (duration >= 0) return;
  throw new Error(
    `development benchmark ${phase} measured ${duration} ms before its build completed`,
  );
}
