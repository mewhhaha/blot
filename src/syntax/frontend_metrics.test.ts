import { assertEquals } from "@std/assert";
import {
  resetFrontendMetrics,
  snapshotFrontendMetrics,
} from "./frontend_metrics.ts";
import { parseConcrete } from "./parse.ts";

Deno.test("frontend metrics count every stage of a successful parse", async () => {
  resetFrontendMetrics();
  const parsed = await parseConcrete("return 1\n");
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  assertEquals(snapshotFrontendMetrics(), {
    parseConcrete: 1,
    layoutElaboration: 1,
    generatedLexing: 1,
    babaCpuParse: 1,
    cstMaterialization: 1,
    lowering: 1,
    surfaceElaboration: 1,
  });
});

Deno.test("frontend metrics stop counting at the failing stage", async () => {
  resetFrontendMetrics();
  const layoutFailed = await parseConcrete("return \u{e000} 1\n");
  assertEquals(layoutFailed.ok, false);
  assertEquals(snapshotFrontendMetrics(), {
    parseConcrete: 1,
    layoutElaboration: 1,
    generatedLexing: 0,
    babaCpuParse: 0,
    cstMaterialization: 0,
    lowering: 0,
    surfaceElaboration: 0,
  });

  resetFrontendMetrics();
  const parseFailed = await parseConcrete("let = =\n");
  assertEquals(parseFailed.ok, false);
  assertEquals(snapshotFrontendMetrics(), {
    parseConcrete: 1,
    layoutElaboration: 1,
    generatedLexing: 1,
    babaCpuParse: 1,
    cstMaterialization: 0,
    lowering: 0,
    surfaceElaboration: 0,
  });
});

Deno.test("frontend metrics reset to zero", async () => {
  resetFrontendMetrics();
  const parsed = await parseConcrete("return 1\n");
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  resetFrontendMetrics();
  assertEquals(snapshotFrontendMetrics(), {
    parseConcrete: 0,
    layoutElaboration: 0,
    generatedLexing: 0,
    babaCpuParse: 0,
    cstMaterialization: 0,
    lowering: 0,
    surfaceElaboration: 0,
  });
});

Deno.test("frontend metrics never write to stdout", async () => {
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
    const parsed = await parseConcrete("return 1\n");
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    snapshotFrontendMetrics();
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
  }
  assertEquals(calls, []);
});
