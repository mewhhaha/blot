import { assertEquals, assertThrows } from "@std/assert";
import {
  developmentBenchmarkCompilerProfiling,
  type DevelopmentBenchmarkSample,
  developmentBenchmarkSchema,
  maximumRssGrowth,
  summarizeDurations,
} from "./schema.ts";

function sample(hostRssBytes: number): DevelopmentBenchmarkSample {
  return {
    iteration: 0,
    buildMilliseconds: 1,
    activationMilliseconds: 1,
    committedMilliseconds: 2,
    changedUnits: ["game"],
    retainedUnits: [],
    transferredWasmBytes: 1,
    transferredManifestBytes: 1,
    observation: "0",
    hostRssBytes,
  };
}

Deno.test("development benchmark report schema is version 3", () => {
  assertEquals(developmentBenchmarkSchema, 3);
});

Deno.test("development duration summary preserves nearest-rank percentiles", () => {
  assertEquals(summarizeDurations([5, 1, 4, 2, 3]), {
    p50Milliseconds: 3,
    p95Milliseconds: 5,
    maximumMilliseconds: 5,
  });
});

Deno.test("compiler profiling reports a production artifact explicitly", () => {
  assertEquals(
    developmentBenchmarkCompilerProfiling(
      "production",
      undefined,
      [undefined],
    ),
    {
      featureStatus: "production",
      measurementsIncluded: false,
    },
  );
});

Deno.test("compiler profiling retains every observed memory checkpoint", () => {
  assertEquals(
    developmentBenchmarkCompilerProfiling(
      "development-profile",
      {
        checkpoints: [{
          stage: "initial",
          pages: 10,
          solver: {
            variables: 5,
            constraintTypeNodes: 4,
            constraintTypeInterned: 3,
            settledVariables: 2,
            residualVariables: 1,
          },
        }],
      },
      [{ checkpoints: [{ stage: "sample", pages: 11 }] }],
    ),
    {
      featureStatus: "development-profile",
      measurementsIncluded: true,
      initialCheckpoints: [{
        stage: "initial",
        pages: 10,
        solver: {
          variables: 5,
          constraintTypeNodes: 4,
          constraintTypeInterned: 3,
          settledVariables: 2,
          residualVariables: 1,
        },
      }],
      sampleCheckpoints: [[{ stage: "sample", pages: 11 }]],
    },
  );
});

Deno.test("compiler profiling rejects a mixed artifact observation", () => {
  assertThrows(
    () =>
      developmentBenchmarkCompilerProfiling(
        "production",
        undefined,
        [{ checkpoints: [] }],
      ),
    Error,
    "production compiler returned a memory profile in sample 0",
  );
  assertThrows(
    () =>
      developmentBenchmarkCompilerProfiling(
        "development-profile",
        undefined,
        [undefined],
      ),
    Error,
    "development-profile compiler omitted its initial memory profile",
  );
  assertThrows(
    () =>
      developmentBenchmarkCompilerProfiling(
        "development-profile",
        { checkpoints: [] },
        [undefined],
      ),
    Error,
    "disappeared in sample 0",
  );
});

Deno.test("development RSS growth is measured from the activated baseline", () => {
  assertEquals(
    maximumRssGrowth(100, [sample(90), sample(140), sample(120)]),
    40,
  );
});

Deno.test("development RSS growth never reports allocator contraction", () => {
  assertEquals(maximumRssGrowth(100, [sample(90)]), 0);
});

Deno.test("development RSS growth requires a measured sample", () => {
  assertThrows(
    () => maximumRssGrowth(100, []),
    Error,
    "requires at least one RSS sample",
  );
});
