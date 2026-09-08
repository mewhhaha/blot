import {
  captureDevelopmentBenchmarkProvenance,
  requireStableDevelopmentBenchmarkProvenance,
} from "./provenance.ts";

const { provenance } = await captureDevelopmentBenchmarkProvenance(
  "production",
);
const counts = Deno.args.map((argument) => {
  const count = Number(argument);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`unit count must be a positive integer: ${argument}`);
  }
  return count;
});
if (counts.length === 0) counts.push(10, 20, 40);

const observations = [];
for (const unitCount of counts) {
  const directory = await Deno.makeTempDir({
    prefix: "blot-active-development-",
  });
  try {
    // Each mode gets the same source paths in a fresh process. This also
    // releases the previous compiler's Wasm memory before the next sample set.
    for (
      const [mode, phase] of [["disabled", "initial"], ["memory", "initial"], [
        "disk",
        "initial",
      ], ["disk", "restart"]]
    ) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "--allow-env",
          "experiments/development-bench/active_worker.ts",
          directory,
          String(unitCount),
          mode,
          phase,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!result.success) {
        throw new Error(new TextDecoder().decode(result.stderr));
      }
      observations.push(...JSON.parse(new TextDecoder().decode(result.stdout)));
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}
const final = await captureDevelopmentBenchmarkProvenance("production");
requireStableDevelopmentBenchmarkProvenance(provenance, final.provenance);
console.log(JSON.stringify({ schema: 2, provenance, observations }, null, 2));
