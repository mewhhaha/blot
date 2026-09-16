// src/tooling/formatter_perf_gates.ts
//
// Merge-blocking gates for formatter performance (CI's gate:editor step).
// This file is not discovered by the default suite (no .test.ts suffix)
// because three gates assert wall-clock bounds. Run it explicitly:
//   deno test --allow-read src/tooling/formatter_perf_gates.ts
//
// Each gate is labeled DETERMINISTIC or SMOKE:
// - DETERMINISTIC gates assert exact frontend invocation counts. They are
//   immune to machine speed and CI load: the changed path performs exactly
//   two frontend invocations independent of construct count, a matching
//   supplied snapshot performs exactly one, and an already-formatted input
//   performs exactly one (input only, no output parse). Any return of
//   per-construct reparsing trips these first.
// - SMOKE gates assert wall-clock bounds and trip only on a gross
//   regression; the DETERMINISTIC gates above trip first on any return of
//   per-construct reparsing. The absolute smokes carry large headroom
//   (arrays-20 < 150ms against a ~16ms P8 median, arrays-60 < 1000ms
//   against ~60ms). The scaling smoke asserts linear-ish growth: 12x the
//   input must cost less than 20x the time (measured ~9-12x; the old
//   pipeline measured ~41x on its reference machine).

import { assert } from "@std/assert";
import {
  resetFrontendMetrics,
  snapshotFrontendMetrics,
} from "../syntax/frontend_metrics.ts";
import { snapshotSource } from "../syntax/snapshot.ts";
import { formatSource } from "./formatter.ts";

Deno.test("gates warm up the frontend before measuring", async () => {
  const warmed = await formatSource("let single = 1\nreturn single\n");
  if (!warmed.ok) throw new Error(JSON.stringify(warmed.diagnostics));
});

// SMOKE: wall-clock cap with ~9x headroom.
Deno.test("gate: 20 overlong arrays format within 150ms warm", async () => {
  const ms = await fastestOf(overlongArrays(20), 3);
  assert(ms < 150, "arrays-20 warm took " + ms.toFixed(1) + "ms, want < 150ms");
});

// SMOKE: wall-clock cap with ~16x headroom.
Deno.test("gate: 60 overlong arrays format within 1000ms warm", async () => {
  const ms = await fastestOf(overlongArrays(60), 3);
  assert(
    ms < 1000,
    "arrays-60 warm took " + ms.toFixed(1) + "ms, want < 1000ms",
  );
});

// SMOKE: wall-clock ratio with ~1.7x headroom; the DETERMINISTIC gates
// below are the sharp check, this one only names the scaling shape.
Deno.test("gate: 60 arrays scale linearly against 5 arrays", async () => {
  const five = await fastestOf(overlongArrays(5), 3);
  const sixty = await fastestOf(overlongArrays(60), 3);
  const ratio = sixty / five;
  assert(ratio < 20, "ratio is " + ratio.toFixed(2) + "x, want < 20x");
});

// DETERMINISTIC: exact invocation counts, immune to machine speed.
Deno.test("gate: changed-format path uses bounded frontend invocations", async () => {
  for (const count of [5, 20, 60]) {
    resetFrontendMetrics();
    const formatted = await formatSource(overlongArrays(count));
    if (!formatted.ok) throw new Error(JSON.stringify(formatted.diagnostics));
    const invocations = snapshotFrontendMetrics().parseConcrete;
    assert(
      invocations === 2,
      `${count} arrays used ${invocations} frontend invocations, want 2`,
    );
  }
});

// DETERMINISTIC: exact invocation counts, immune to machine speed.
Deno.test("gate: supplied snapshot and formatted input parse once", async () => {
  const source = overlongArrays(20);
  const input = await snapshotSource(source);
  if (!input.ok) throw new Error(JSON.stringify(input.diagnostics));
  resetFrontendMetrics();
  const formatted = await formatSource(source, input.snapshot);
  if (!formatted.ok) throw new Error(JSON.stringify(formatted.diagnostics));
  assertEqualsInvocations(1, "supplied snapshot");
  resetFrontendMetrics();
  const second = await formatSource(formatted.source);
  if (!second.ok) throw new Error(JSON.stringify(second.diagnostics));
  assertEqualsInvocations(1, "already-formatted input");
});

function assertEqualsInvocations(want: number, what: string): void {
  const invocations = snapshotFrontendMetrics().parseConcrete;
  assert(
    invocations === want,
    `${what} used ${invocations} frontend invocations, want ${want}`,
  );
}

async function fastestOf(source: string, runs: number): Promise<number> {
  let fastest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    const formatted = await formatSource(source);
    const ms = performance.now() - start;
    if (!formatted.ok) throw new Error(JSON.stringify(formatted.diagnostics));
    if (ms < fastest) fastest = ms;
  }
  return fastest;
}

function overlongArrays(count: number): string {
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
