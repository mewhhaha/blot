import { scalarExport } from "../../test_support/guest_abi.ts";
import { DevelopmentProject } from "../../src/development.ts";
import { DevelopmentRuntime } from "../../src/development_runtime.ts";
import { writeActiveDevelopmentWorkload } from "./active_workload.ts";

const [directory, providerCount, mode, phase] = Deno.args;
const unitCount = Number(providerCount);
if (
  directory === undefined || !Number.isSafeInteger(unitCount) ||
  unitCount < 1 ||
  (mode !== "disabled" && mode !== "memory" && mode !== "disk") ||
  (phase !== "initial" && phase !== "restart")
) {
  throw new Error(
    "usage: active_worker.ts <directory> <provider-count> <disabled|memory|disk> <initial|restart>",
  );
}
const workload = await writeActiveDevelopmentWorkload({
  directory,
  unitCount,
  helpersPerUnit: 32,
});
const observations = [];
let restart = 0;
if (phase === "restart") {
  restart = 1;
  await Deno.writeTextFile(
    workload.editedProviderPath,
    workload.providerSource(21),
  );
}
{
  const opening = performance.now();
  const project = await DevelopmentProject.create(workload.manifestPath, {
    cache: { mode },
  });
  const startupMilliseconds = performance.now() - opening;
  const runtime = new DevelopmentRuntime(() => ({}));
  try {
    let iterations = 21;
    if (restart > 0) iterations = 1;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      let increment = iteration + 1;
      if (restart > 0) increment = 21;
      const started = performance.now();
      if (iteration > 0) {
        await Deno.writeTextFile(
          workload.editedProviderPath,
          workload.providerSource(increment),
        );
        await project.markChanged(workload.editedProviderPath);
      }
      const build = await project.activate(runtime).catch((cause) => {
        throw new Error(
          `active workload failed: ${unitCount} providers, ${mode}, restart ${restart}, iteration ${iteration}`,
          { cause },
        );
      });
      const committedMilliseconds = performance.now() - started;
      const integerRun = scalarExport(runtime.entryInstance, "blot:run");
      const floatRun = scalarExport(runtime.entryInstance, "blot:float_run");
      if (typeof integerRun !== "function" || typeof floatRun !== "function") {
        throw new Error("active workload lost its exports");
      }
      const integer = integerRun(7n);
      const float = floatRun(0.5);
      if (
        integer !== workload.expectedInteger(7n, increment) ||
        float !== unitCount * 0.5
      ) throw new Error(`active workload returned ${integer}, ${float}`);
      const changed = build.changedUnits.map((unit) => unit.name);
      if (iteration > 0 && (changed.length !== 1 || changed[0] !== "unit-0")) {
        throw new Error(`unrelated units changed: ${changed.join(", ")}`);
      }
      observations.push({
        mode,
        unitCount,
        helpersPerUnit: 32,
        restart,
        iteration,
        startupMilliseconds,
        committedMilliseconds,
        buildMilliseconds: build.durationMilliseconds,
        changed,
        work: build.work,
        cache: build.cache,
        memory: Deno.memoryUsage(),
        integer: String(integer),
        float,
      });
    }
  } finally {
    project.destroy();
  }
}
console.log(JSON.stringify(observations));
