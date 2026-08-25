import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  type CompilerStartupChildSample,
  type CompilerStartupPhase,
  compilerStartupPhases,
  type CompilerStartupReport,
  type CompilerStartupSample,
  compilerStartupSchema,
  decodeCompilerStartupChildSample,
  decodeCompilerStartupReport,
  distribution,
  semanticProcessMilliseconds,
} from "./schema.ts";
import { compilerStartupProvenance } from "./provenance.ts";
import { compilerStartupChildExecArgv } from "./invocation.ts";

const exec = promisify(execFile);
const experimentDirectory = dirname(fileURLToPath(import.meta.url));

interface Options {
  readonly sourcePath: string;
  readonly samples: number;
  readonly output: string | null;
}

function options(): Options {
  let sourcePath = "examples/minimal.blot";
  let samples = 31;
  let output: string | null = null;
  for (const argument of process.argv.slice(2)) {
    if (argument === "--") {
      continue;
    } else if (argument.startsWith("--samples=")) {
      samples = Number(argument.slice("--samples=".length));
    } else if (argument.startsWith("--output=")) {
      output = argument.slice("--output=".length);
    } else {
      sourcePath = argument;
    }
  }
  if (!Number.isSafeInteger(samples) || samples < 1 || samples % 2 === 0) {
    throw new Error("--samples must be a positive odd integer");
  }
  return { sourcePath: resolve(sourcePath), samples, output };
}

async function main(): Promise<void> {
  const selected = options();
  const initialProvenance = await compilerStartupProvenance(
    selected.sourcePath,
  );
  const samples: CompilerStartupSample[] = [];
  let expectedObservation = "";
  for (let index = 0; index < selected.samples; index += 1) {
    const before = performance.now();
    const child = await exec(process.execPath, [
      ...compilerStartupChildExecArgv,
      resolve(experimentDirectory, "sample.ts"),
      selected.sourcePath,
    ]);
    const syntaxConsumerProcessMilliseconds = performance.now() - before;
    const decoded: CompilerStartupChildSample =
      decodeCompilerStartupChildSample(
        JSON.parse(child.stdout),
      );
    if (index === 0) expectedObservation = decoded.observation;
    assert.equal(
      decoded.observation,
      expectedObservation,
      "compiler startup observation changed",
    );
    const processMilliseconds = semanticProcessMilliseconds(
      syntaxConsumerProcessMilliseconds,
      decoded,
    );
    const bootstrapMilliseconds = processMilliseconds -
      decoded.internalMilliseconds;
    samples.push({
      ...decoded,
      processMilliseconds,
      syntaxConsumerProcessMilliseconds,
      phases: {
        ...decoded.phases,
        "process-bootstrap-and-module-load": bootstrapMilliseconds,
      },
    });
  }
  const finalProvenance = await compilerStartupProvenance(selected.sourcePath);
  assert.deepEqual(
    finalProvenance,
    initialProvenance,
    "compiler startup inputs changed while sampling",
  );
  const phases = Object.fromEntries(
    compilerStartupPhases.map((phase) => [
      phase,
      distribution(samples.map((sample) => requiredPhase(sample, phase))),
    ]),
  ) as Record<CompilerStartupPhase, ReturnType<typeof distribution>>;
  const report: CompilerStartupReport = decodeCompilerStartupReport({
    schema: compilerStartupSchema,
    ...initialProvenance,
    sourcePath: selected.sourcePath,
    sampleCount: selected.samples,
    node: process.version,
    v8: process.versions.v8,
    observation: expectedObservation,
    process: distribution(
      samples.map((sample) => sample.processMilliseconds),
    ),
    internal: distribution(
      samples.map((sample) => sample.internalMilliseconds),
    ),
    syntaxConsumerProcess: distribution(
      samples.map((sample) => sample.syntaxConsumerProcessMilliseconds),
    ),
    syntaxConsumerInternal: distribution(
      samples.map((sample) => sample.syntaxConsumerInternalMilliseconds),
    ),
    phases,
    samples,
  });
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (selected.output === null) {
    process.stdout.write(encoded);
  } else {
    await writeFile(selected.output, encoded);
  }
}

function requiredPhase(
  sample: CompilerStartupSample,
  phase: CompilerStartupPhase,
): number {
  const milliseconds = sample.phases[phase];
  if (milliseconds === undefined) {
    throw new Error(`compiler startup sample omitted ${phase}`);
  }
  return milliseconds;
}

main().catch((error: unknown) => {
  if (error instanceof Error) console.error(error.message);
  else console.error(String(error));
  process.exitCode = 1;
});
