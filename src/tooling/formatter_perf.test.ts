// src/tooling/formatter_perf.test.ts
//
// Regression characterization for formatter performance structure (P0b).
// Documents CURRENT behavior as green diagnostic coverage: formatting is
// syntax-only (no module-graph loading, no semantic analysis) and its
// changed-format path currently re-parses per construct. Desired bounds that
// fail today live in the explicitly-run gate file
// src/tooling/formatter_perf_gates.ts:
//   deno test --allow-read src/tooling/formatter_perf_gates.ts
// Raw timings live in scripts/bench_formatter.ts JSON output, not here.

import { assert, assertEquals } from "@std/assert";
import { formatSource } from "./formatter.ts";

Deno.test("formatting never loads the module graph", async () => {
  const source = `const Missing = import "./does-not-exist.blot"
return Missing
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error(JSON.stringify(formatted.diagnostics));
  const again = await formatSource(formatted.source);
  assertEquals(again, formatted);
});

Deno.test("formatting never runs semantic analysis", async () => {
  const source = "return missing\n";
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error(JSON.stringify(formatted.diagnostics));
  assertEquals(formatted.source, source);
});

Deno.test("formatting breaks each overlong array onto its own lines", async () => {
  // TODO(P4): extend this structural pin with the P1 invocation counter so
  // the changed-format path asserts a bounded number of frontend invocations
  // independent of construct count. Wall-clock scaling is recorded by
  // scripts/bench_formatter.ts instead of asserting flaky time bounds here.
  for (const count of [1, 5]) {
    const source = overlongArrays(count);
    const formatted = await formatSource(source);
    if (!formatted.ok) throw new Error(JSON.stringify(formatted.diagnostics));
    assert(
      formatted.source !== source,
      "expected layout to change for " + count + " overlong arrays",
    );
    const again = await formatSource(formatted.source);
    assertEquals(again, formatted);
  }
});

Deno.test("formatting an already-formatted source is a stable fixpoint", async () => {
  // The second format parses its input once and skips output validation
  // (the gates file pins the exact invocation bound).
  const source = overlongArrays(5);
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error(JSON.stringify(formatted.diagnostics));
  const again = await formatSource(formatted.source);
  assertEquals(again, formatted);
});

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
