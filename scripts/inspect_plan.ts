// Reports the version-3 GPU frontend counters for the generated plan.
//
// These numbers are the M0 gate: the profile must be accepted at all, and the
// counters must stay in the range that keeps parallel occupancy useful. They
// are recorded in docs/gpu-profile.md so that a grammar change which quietly
// degrades parallelism shows up in a diff instead of in a benchmark months
// later.

import { inspectGpuFrontendPlan } from "@mewhhaha/baba/runtime/webgpu";

const planPath = Deno.args[0] ?? "generated/wasm/parser.plan";
const plan = await Deno.readFile(planPath);
const inspection = inspectGpuFrontendPlan(plan);

if (inspection === null) {
  console.error(`${planPath} has no version-3 GPU frontend section.`);
  Deno.exit(1);
}

console.log(JSON.stringify(inspection, null, 2));
