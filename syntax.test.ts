// M0's gate. Two invariants:
//
//   1. every example in `examples/` is accepted by Baba's CPU frontend;
//   2. the generated plan carries the version-3 general frontend that preserves
//      every grammar rule as a compact CST island.
//
// The WebGPU executor remains an optional comparison tool in
// `scripts/parity.ts`. This gate stays runnable without WebGPU because every
// compiler command shares the CPU entry point.

import { assert, assertEquals } from "@std/assert";
import {
  CpuFrontend,
  inspectGpuFrontendPlan,
} from "@mewhhaha/baba/runtime/webgpu";
import { elaborateLayout } from "./src/syntax/layout.ts";
import { ingestCpuSource, parse } from "./src/syntax/parse.ts";

const plan = await Deno.readFile("generated/wasm/parser.plan");
const frontend = CpuFrontend.create(plan);

Deno.test("the generated plan carries a general version-3 frontend", () => {
  const inspection = inspectGpuFrontendPlan(plan);
  assert(
    inspection !== null,
    "parser.plan has no version-3 GPU frontend section",
  );
  assertEquals(inspection.version, 3);
  assertEquals(inspection.throughput, "general");
  assertEquals(frontend.plan.islands.length, 68);
});

// The prelude and case-study libraries are Blot source too, so they are held to
// the same frontend plan as user programs.
const CORPUS = [
  "examples",
  "examples/lib",
  "src/prelude",
  "case-studies/engine/lib",
];

for (const directory of CORPUS) {
  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile || !entry.name.endsWith(".blot")) continue;
    const path = `${directory}/${entry.name}`;
    Deno.test(`${path} is accepted by the CPU frontend`, async () => {
      const source = await Deno.readTextFile(path);
      const elaborated = await elaborateLayout(source);
      if (!elaborated.ok) {
        throw new Error(
          elaborated.diagnostics.map((diagnostic) => diagnostic.message).join(
            "\n",
          ),
        );
      }
      // Use the same I64-aware Baba adapter as production parsing. Baba
      // still owns acceptance; its compact I32 policy is not Blot syntax.
      const result = ingestCpuSource(frontend, elaborated.layout.source);
      if (!result.ok) {
        throw new Error(
          result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
        );
      }
    });
  }
}

Deno.test("full-width integer syntax preserves the original I64 value", async () => {
  const parsed = await parse("return 9223372036854775807\n");
  assert(parsed.ok);
  assertEquals(parsed.module.result.tag, "int");
  assert(parsed.module.result.tag === "int");
  assertEquals(parsed.module.result.value, 9223372036854775807n);
});

Deno.test("full-width integers do not hide malformed syntax", async () => {
  const parsed = await parse("return 9223372036854775807 +\n");
  assert(!parsed.ok);
  assert(
    parsed.diagnostics.some((diagnostic) =>
      diagnostic.code === "GPU_FRONTEND_SYNTAX_ERROR"
    ),
  );
});
