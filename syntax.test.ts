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
      const result = frontend.ingest(elaborated.layout.source);
      if (!result.ok) {
        throw new Error(
          result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
        );
      }
    });
  }
}
