import { CompilerWasm } from "../../src/compiler/wasm.ts";
import { DevelopmentProject } from "../../src/development.ts";
import { Session } from "node:inspector";

const cpuProfilePath = Deno.env.get("BLOT_RELOAD_CPU_PROFILE");
const inspector = new Session();
if (cpuProfilePath !== undefined) inspector.connect();

// Observe the selected transport without changing the compiler.
// Nested transport calls are charged to their outermost operation.
const transport = new Map<string, { calls: number; milliseconds: number }>();
let depth = 0;
for (const name of Object.getOwnPropertyNames(CompilerWasm.prototype)) {
  if (name === "constructor") continue;
  const descriptor = Object.getOwnPropertyDescriptor(
    CompilerWasm.prototype,
    name,
  );
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    continue;
  }
  const original = descriptor.value;
  Object.defineProperty(CompilerWasm.prototype, name, {
    ...descriptor,
    value: function (this: CompilerWasm, ...args: unknown[]) {
      const outermost = depth === 0;
      const started = performance.now();
      depth += 1;
      try {
        return Reflect.apply(original, this, args);
      } finally {
        depth -= 1;
        if (outermost) {
          let timing = transport.get(name);
          if (timing === undefined) {
            timing = { calls: 0, milliseconds: 0 };
            transport.set(name, timing);
          }
          timing.calls += 1;
          timing.milliseconds += performance.now() - started;
        }
      }
    },
  });
}

const activate = DevelopmentProject.prototype.activate;
let activation = 0;
DevelopmentProject.prototype.activate = async function (runtime) {
  transport.clear();
  const build = await activate.call(this, runtime);
  console.error(JSON.stringify({
    activation: activation++,
    buildMilliseconds: build.durationMilliseconds,
    transport: Object.fromEntries(transport),
    work: build.work,
  }));
  if (activation === 1 && cpuProfilePath !== undefined) {
    await new Promise<void>((resolve, reject) => {
      inspector.post("Profiler.enable", (error) => {
        if (error !== null) reject(error);
        else resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      inspector.post("Profiler.start", (error) => {
        if (error !== null) reject(error);
        else resolve();
      });
    });
  }
  return build;
};

// Accept the benchmark's ordinary arguments and preserve its correctness checks.
const workload = Deno.env.get("BLOT_RELOAD_WORKLOAD");
if (workload === "active") {
  await import("./active_worker.ts");
} else if (workload === undefined || workload === "catalog") {
  await import("./benchmark.ts");
} else {
  throw new Error(`unknown reload workload: ${workload}`);
}
if (cpuProfilePath !== undefined) {
  const profile = await new Promise((resolve, reject) => {
    inspector.post("Profiler.stop", (error, result) => {
      if (error !== null) reject(error);
      else resolve(result.profile);
    });
  });
  inspector.disconnect();
  await Deno.writeTextFile(cpuProfilePath, JSON.stringify(profile));
}
