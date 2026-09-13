import { resolve } from "node:path";
import { DevelopmentProject } from "../../src/development.ts";
import { DevelopmentRuntime } from "../../src/development_runtime.ts";
import {
  decodeCompilerArtifactManifest,
  sha256,
  validateCompilerArtifact,
} from "../../src/compiler/artifact.ts";
import { COMPILER_HOST_ABI_VERSION } from "../../src/compiler/host_abi.ts";
import { scalarExport } from "../../test_support/guest_abi.ts";
import { writeActiveDevelopmentWorkload } from "./active_workload.ts";
import {
  captureDevelopmentBenchmarkProvenance,
  requireStableDevelopmentBenchmarkProvenance,
} from "./provenance.ts";

const [baselineDirectory, count] = Deno.args;
let unitCount = 10;
if (count !== undefined) unitCount = Number(count);
if (
  baselineDirectory === undefined || Deno.args.length > 2 ||
  !Number.isSafeInteger(unitCount) || unitCount < 1
) {
  throw new Error(
    "usage: compare_active.ts <baseline-compiler-directory> [provider-count]",
  );
}
const baselineRoot = resolve(baselineDirectory);
const [wasm, preludeSnapshot, manifestSource] = await Promise.all([
  Deno.readFile(`${baselineRoot}/compiler.wasm`),
  Deno.readFile(`${baselineRoot}/prelude.snapshot`),
  Deno.readTextFile(`${baselineRoot}/compiler-artifact.json`),
]);
const baseline = decodeCompilerArtifactManifest(manifestSource);
await validateCompilerArtifact(wasm, baseline, {
  hostAbi: COMPILER_HOST_ABI_VERSION,
  preludeSha256: await sha256(preludeSnapshot),
  profile: "production",
});
const current = await captureDevelopmentBenchmarkProvenance("production");
const directory = await Deno.makeTempDir({ prefix: "blot-active-comparison-" });
const compilers: {
  revision: string;
  project: DevelopmentProject;
  runtime: DevelopmentRuntime;
}[] = [];
const observations = [];
try {
  const workload = await writeActiveDevelopmentWorkload({
    directory,
    unitCount,
    helpersPerUnit: 32,
  });
  for (
    const [revision, compiler] of [
      ["baseline", { wasm, preludeSnapshot }],
      ["current", current.compilerOptions],
    ] as const
  ) {
    compilers.push({
      revision,
      project: await DevelopmentProject.create(workload.manifestPath, {
        compiler,
        cache: { mode: "memory" },
      }),
      runtime: new DevelopmentRuntime(() => ({})),
    });
  }
  for (let iteration = 0; iteration <= 20; iteration += 1) {
    const increment = iteration + 1;
    let writeMilliseconds = 0;
    if (iteration > 0) {
      const started = performance.now();
      await Deno.writeTextFile(
        workload.editedProviderPath,
        workload.providerSource(increment),
      );
      writeMilliseconds = performance.now() - started;
    }
    const order = compilers.slice();
    if (iteration % 2 === 1) order.reverse();
    for (const { revision, project, runtime } of order) {
      const started = performance.now();
      if (iteration > 0) await project.markChanged(workload.editedProviderPath);
      const build = await project.activate(runtime);
      const committedMilliseconds = performance.now() - started +
        writeMilliseconds;
      const integer = scalarExport(runtime.entryInstance, "blot:run")(7n);
      const float = scalarExport(runtime.entryInstance, "blot:float_run")(0.5);
      if (
        integer !== workload.expectedInteger(7n, increment) ||
        float !== unitCount * 0.5
      ) throw new Error(`${revision} returned ${integer}, ${float}`);
      const changed = build.changedUnits.map((unit) => unit.name);
      if (iteration > 0 && (changed.length !== 1 || changed[0] !== "unit-0")) {
        throw new Error(
          `${revision} changed unrelated units: ${changed.join(", ")}`,
        );
      }
      observations.push({
        revision,
        iteration,
        committedMilliseconds,
        buildMilliseconds: build.durationMilliseconds,
        changed,
        work: build.work,
        integer: String(integer),
        float,
      });
    }
  }
  const final = await captureDevelopmentBenchmarkProvenance("production");
  requireStableDevelopmentBenchmarkProvenance(
    current.provenance,
    final.provenance,
  );
} finally {
  for (const { project } of compilers) project.destroy();
  await Deno.remove(directory, { recursive: true });
}
console.log(JSON.stringify(
  {
    schema: 1,
    provenance: current.provenance,
    baseline,
    unitCount,
    helpersPerUnit: 32,
    observations,
  },
  null,
  2,
));
