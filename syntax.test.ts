// M0's gate. Two invariants:
//
//   1. every example in `examples/` is accepted by baba's CPU frontend oracle;
//   2. the generated plan still carries a version-3 GPU frontend section with
//      strict root-loop throughput.
//
// GPU parity itself needs an adapter, so it lives in `scripts/parity.ts` and
// runs from `just parity` rather than here. This file must stay runnable
// without WebGPU, because `blot check` will share its entry point.

import { assert, assertEquals } from "@std/assert";
import {
  CpuFrontend,
  inspectGpuFrontendPlan,
} from "@mewhhaha/baba/runtime/webgpu";

const plan = await Deno.readFile("generated/wasm/parser.plan");
const frontend = CpuFrontend.create(plan);

Deno.test("the generated plan carries a strict version-3 GPU frontend", () => {
  const inspection = inspectGpuFrontendPlan(plan);
  assert(
    inspection !== null,
    "parser.plan has no version-3 GPU frontend section",
  );
  assertEquals(inspection.version, 3);
  assertEquals(inspection.throughput, "strict");
  assert(
    inspection.rootLoopIsland !== null,
    "strict throughput requires a proven repeated root island",
  );
});

// The prelude is blot source too, so it is held to the same profile. That is
// what caught the signed-i32 literal bound: a prelude parsed only by the CPU
// path would have hidden it.
const CORPUS = ["examples", "examples/lib", "src/prelude"];

for (const directory of CORPUS) {
  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile || !entry.name.endsWith(".blot")) continue;
    const path = `${directory}/${entry.name}`;
    Deno.test(`${path} is accepted by the CPU frontend oracle`, async () => {
      const source = await Deno.readTextFile(path);
      const result = frontend.ingest(source);
      if (!result.ok) {
        throw new Error(
          result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
        );
      }
    });
  }
}
