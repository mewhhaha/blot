import { scalarExport } from "../../test_support/guest_abi.ts";
import { assertEquals } from "@std/assert";
import { DevelopmentProject } from "../../src/development.ts";
import { DevelopmentRuntime } from "../../src/development_runtime.ts";
import { writeActiveDevelopmentWorkload } from "./active_workload.ts";

Deno.test("active development workload executes generics and recursion across edits", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const workload = await writeActiveDevelopmentWorkload({
      directory,
      unitCount: 2,
      helpersPerUnit: 4,
    });
    const project = await DevelopmentProject.create(workload.manifestPath);
    const runtime = new DevelopmentRuntime(() => ({}));
    try {
      for (const increment of [1, 2, 10]) {
        if (increment !== 1) {
          await Deno.writeTextFile(
            workload.editedProviderPath,
            workload.providerSource(increment),
          );
          await project.markChanged(workload.editedProviderPath);
        }
        const build = await project.activate(runtime);
        const integerRun = scalarExport(runtime.entryInstance, "blot:run");
        const floatRun = scalarExport(runtime.entryInstance, "blot:float_run");
        if (
          typeof integerRun !== "function" || typeof floatRun !== "function"
        ) {
          throw new Error("active workload lost its exports");
        }
        for (const argument of [-7n, 0n, 7n, 17n]) {
          assertEquals(
            integerRun(argument),
            workload.expectedInteger(argument, increment),
          );
        }
        assertEquals(floatRun(0.5), 1);
        if (increment !== 1) {
          assertEquals(build.work.emittedUnits, 1);
          assertEquals(build.changedUnits.map((unit) => unit.name), ["unit-0"]);
          assertEquals(
            Object.keys(build.work.specializedFunctions).filter((path) =>
              path.endsWith("unit_1.blot")
            ),
            [],
          );
        }
      }
      const unchanged = await project.activate(runtime);
      assertEquals(unchanged.work, {
        emittedUnits: 0,
        specializedFunctions: {},
        graphCache: {},
        reusedFunctions: {},
      });
    } finally {
      project.destroy();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
