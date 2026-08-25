import assert from "node:assert/strict";
import test from "node:test";
import {
  type CompilerStartupPhase,
  compilerStartupPhases,
  type CompilerStartupReport,
  compilerStartupSchema,
  decodeCompilerStartupChildSample,
  decodeCompilerStartupReport,
  distribution,
  semanticProcessMilliseconds,
} from "./schema.ts";

function phaseDurations(
  bootstrapMilliseconds: number,
): Record<CompilerStartupPhase, number> {
  return Object.fromEntries(compilerStartupPhases.map((phase) => {
    let milliseconds = 1;
    if (phase === "process-bootstrap-and-module-load") {
      milliseconds = bootstrapMilliseconds;
    }
    return [phase, milliseconds];
  })) as Record<CompilerStartupPhase, number>;
}

function report(): CompilerStartupReport {
  const phases = phaseDurations(8);
  const sample = {
    internalMilliseconds: 10,
    syntaxConsumerInternalMilliseconds: 12,
    processMilliseconds: 18,
    syntaxConsumerProcessMilliseconds: 20,
    phases,
    observation: "unchanged",
  };
  return {
    schema: compilerStartupSchema,
    commit: "a".repeat(40),
    hostInputsSha256: "b".repeat(64),
    benchmarkInputsSha256: "c".repeat(64),
    graphIdentity: "d".repeat(64),
    compilerArtifactSha256: "e".repeat(64),
    compilerManifestSha256: "f".repeat(64),
    compilerInputsSha256: "1".repeat(64),
    compilerPreludeSha256: "2".repeat(64),
    compilerSourceCommit: "3".repeat(40),
    compilerSourceTree: "4".repeat(40),
    compilerRustc: "rustc 1.97.1 (test)",
    environment: {
      platform: "linux",
      arch: "x64",
      cpuModels: ["test cpu"],
      logicalCpuCount: 8,
      nodeInvocationSha256: "0".repeat(64),
    },
    sourcePath: "/stable/minimal.blot",
    sourceBytes: 42,
    sampleCount: 1,
    node: "v24.0.0",
    v8: "13.0",
    observation: sample.observation,
    process: distribution([sample.processMilliseconds]),
    internal: distribution([sample.internalMilliseconds]),
    syntaxConsumerProcess: distribution([
      sample.syntaxConsumerProcessMilliseconds,
    ]),
    syntaxConsumerInternal: distribution([
      sample.syntaxConsumerInternalMilliseconds,
    ]),
    phases: Object.fromEntries(compilerStartupPhases.map((phase) => [
      phase,
      distribution([phases[phase]]),
    ])) as CompilerStartupReport["phases"],
    samples: [sample],
  };
}

test("semantic startup excludes optional syntax materialization", () => {
  const semantic = semanticProcessMilliseconds(200, {
    internalMilliseconds: 100,
    syntaxConsumerInternalMilliseconds: 150,
    phases: {},
    observation: "unchanged",
  });

  assert.equal(semantic, 150);
});

test("semantic startup rejects inconsistent nested boundaries", () => {
  assert.throws(
    () =>
      semanticProcessMilliseconds(200, {
        internalMilliseconds: 160,
        syntaxConsumerInternalMilliseconds: 150,
        phases: {},
        observation: "unchanged",
      }),
    /precedes semantic internal time/,
  );
});

test("startup report accepts complete provenance and recomputed distributions", () => {
  assert.deepEqual(decodeCompilerStartupReport(report()), report());
});

test("startup report rejects missing provenance", () => {
  const malformed = {
    ...structuredClone(report()),
    compilerManifestSha256: "unavailable",
  };

  assert.throws(
    () => decodeCompilerStartupReport(malformed),
    /invalid compiler manifest identity/,
  );
});

test("startup report rejects an incomplete benchmark environment", () => {
  const original = report();
  const malformed = {
    ...structuredClone(original),
    environment: { ...original.environment, logicalCpuCount: 0 },
  };

  assert.throws(
    () => decodeCompilerStartupReport(malformed),
    /logical CPU count is not a positive integer/,
  );
});

test("startup report rejects a distribution that does not match its samples", () => {
  const original = report();
  const malformed = {
    ...structuredClone(original),
    process: { ...original.process, p50Milliseconds: 17 },
  };

  assert.throws(
    () => decodeCompilerStartupReport(malformed),
    /expected 18 from its samples/,
  );
});

test("startup child rejects an incomplete phase matrix", () => {
  const phases = phaseDurations(8);
  delete (phases as Partial<Record<CompilerStartupPhase, number>>)[
    "root-check"
  ];

  assert.throws(
    () =>
      decodeCompilerStartupChildSample({
        internalMilliseconds: 10,
        syntaxConsumerInternalMilliseconds: 12,
        phases: Object.fromEntries(
          Object.entries(phases).filter(([phase]) =>
            phase !== "process-bootstrap-and-module-load"
          ),
        ),
        observation: "unchanged",
      }),
    /unexpected phase matrix/,
  );
});
