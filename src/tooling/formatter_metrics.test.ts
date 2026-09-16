import { assert, assertEquals } from "@std/assert";
import {
  resetFrontendMetrics,
  snapshotFrontendMetrics,
} from "../syntax/frontend_metrics.ts";
import { snapshotSource } from "../syntax/snapshot.ts";
import {
  type FormatLoopIteration,
  type FormatPhaseMetrics,
  formatSource,
} from "./formatter.ts";

function requireMetrics(
  value: FormatPhaseMetrics | null,
): FormatPhaseMetrics {
  if (value === null) throw new Error("format metrics hook did not fire");
  return value;
}

function collectHooks(): {
  hooks: {
    onLoopIteration: (iteration: FormatLoopIteration) => void;
    onComplete: (metrics: FormatPhaseMetrics) => void;
  };
  iterations: FormatLoopIteration[];
  completed: () => FormatPhaseMetrics;
} {
  const iterations: FormatLoopIteration[] = [];
  let completed: FormatPhaseMetrics | null = null;
  return {
    hooks: {
      onLoopIteration: (iteration) => {
        iterations.push(iteration);
      },
      onComplete: (metrics) => {
        completed = metrics;
      },
    },
    iterations,
    completed: () => requireMetrics(completed),
  };
}

Deno.test("unchanged input parses once and skips output validation", async () => {
  const source =
    "const first = [1, 2, 3]\nconst second = [4, 5, 6]\nreturn first\n";
  resetFrontendMetrics();
  const observed = collectHooks();
  const formatted = await formatSource(source, undefined, observed.hooks);
  if (!formatted.ok) throw new Error(JSON.stringify(formatted.diagnostics));
  assertEquals(formatted.source, source);
  assertEquals(snapshotFrontendMetrics(), {
    parseConcrete: 1,
    layoutElaboration: 1,
    generatedLexing: 1,
    babaCpuParse: 1,
    cstMaterialization: 1,
    lowering: 1,
    surfaceElaboration: 1,
  });
  assertEquals(observed.iterations, []);
  assertEquals(observed.completed(), {
    horizontalSpacingChanged: false,
    redundantParenSpans: 0,
    parenRemovalChanged: false,
    loopIterations: 0,
    loopHelpers: [],
    structuralIndentationAccepted: true,
    finalValidationPassed: true,
  });
});

Deno.test("changed input parses exactly twice regardless of construct count", async () => {
  const one =
    "const values = [aaaaaaaaaa01, bbbbbbbbbb02, cccccccccc03, dddddddddd04, eeeeeeee05, ffffffff06, gggggggg07, hhhhhhhh08]\nreturn values\n";
  let many = "";
  for (let index = 0; index < 5; index += 1) {
    many += `const value${index} = [${
      Array.from({ length: 25 }, (_, element) => element).join(",")
    }]\n`;
  }
  many += "return value0\n";
  for (const source of [one, many]) {
    resetFrontendMetrics();
    const formatted = await formatSource(source);
    if (!formatted.ok) throw new Error(JSON.stringify(formatted.diagnostics));
    assert(formatted.source !== source);
    assertEquals(snapshotFrontendMetrics().parseConcrete, 2);
  }
});

Deno.test("a matching supplied snapshot skips the input parse", async () => {
  const source = "const values=[1,2]\nreturn values\n";
  const input = await snapshotSource(source);
  if (!input.ok) throw new Error(JSON.stringify(input.diagnostics));
  resetFrontendMetrics();
  const formatted = await formatSource(source, input.snapshot);
  if (!formatted.ok) throw new Error(JSON.stringify(formatted.diagnostics));
  assert(formatted.source !== source);
  assertEquals(snapshotFrontendMetrics().parseConcrete, 1);
});

Deno.test("formatter hooks observe without changing output", async () => {
  const source = "const values=[1,2]\nreturn values\n";
  const withoutHooks = await formatSource(source);
  const observed = collectHooks();
  const withHooks = await formatSource(source, undefined, observed.hooks);
  assertEquals(withHooks, withoutHooks);
  assertEquals(observed.completed().finalValidationPassed, true);
});

Deno.test("formatter metrics never write to stdout", async () => {
  const calls: unknown[][] = [];
  const originalLog = console.log;
  const originalInfo = console.info;
  console.log = (...args: unknown[]): void => {
    calls.push(args);
  };
  console.info = (...args: unknown[]): void => {
    calls.push(args);
  };
  try {
    resetFrontendMetrics();
    const formatted = await formatSource(
      "const first = [1, 2, 3]\nreturn first\n",
      undefined,
      {
        onLoopIteration: () => {},
        onComplete: () => {},
      },
    );
    if (!formatted.ok) throw new Error(JSON.stringify(formatted.diagnostics));
    snapshotFrontendMetrics();
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
  }
  assertEquals(calls, []);
});
