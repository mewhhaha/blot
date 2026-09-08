import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DevelopmentProject } from "../development.ts";
import { DevelopmentRuntime } from "../development_runtime.ts";
import type { HostOperation } from "../host.ts";
import { HostScope } from "../resources.ts";
import { SparkRuntime } from "../spark.ts";
import { createNodeWorkerExecutor } from "./worker_executor.ts";

test("development activation drains async calls and runs cleanup against retained old providers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-async-development-"));
  const manifest = join(directory, "blot.json");
  const formula = join(directory, "formula.blot");
  await writeFile(
    manifest,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "app",
      units: { app: "./main.blot", formula: "./formula.blot" },
    }),
  );
  await writeFile(
    formula,
    'open import "blot:prelude"\nconst apply :: Int -> Int = fn value => value * 2\nreturn { .apply = apply; }\n',
  );
  await writeFile(
    join(directory, "main.blot"),
    `open import "blot:prelude"
const Spark = import "blot:spark"
const formula = import "./formula.blot"
const Gate = @effect.host { .wait = Effect.suspends (Int -> Int); }
const Cleanup = @effect.host { .record = Int -> Unit; }
let run :: Spark.Executor -> Int -> Int ~ { Spark.Effect, Gate, Cleanup }
let run = fn executor => fn number => do:
  let body :: Spark.Scope -> Int ~ { Spark.Effect, Gate, Cleanup }
  let body = fn scope => do:
    let ?cleanup :: Unit -> Unit ~ { Cleanup } = fn () => Cleanup.record (formula.apply number)
    use () <- Spark.on_exit scope (?cleanup)
    use value <- Gate.wait number
    return formula.apply value
  return Spark.scope executor body
return { .run = run; }
`,
  );
  const root = new HostScope();
  const sparks = new SparkRuntime(root);
  const started = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<bigint>();
  const cancelled = Promise.withResolvers<void>();
  const observed: bigint[] = [];
  let first = true;
  const wait: HostOperation = (context, value) => {
    if (!first) return value;
    first = false;
    started.resolve(context.signal);
    context.signal.addEventListener("abort", () => cancelled.resolve(), {
      once: true,
    });
    return release.promise;
  };
  const record: HostOperation = (_context, value) => {
    assert.equal(typeof value, "bigint");
    observed.push(BigInt(String(value)));
    return null;
  };
  const project = await DevelopmentProject.create(manifest);
  const runtime = new DevelopmentRuntime(undefined, {
    scope: root,
    capabilities(artifact) {
      const capabilities = new Map(sparks.capabilitiesFor(artifact));
      const imports =
        JSON.parse(new TextDecoder().decode(artifact.manifestBytes)).imports;
      if (
        imports.some((entry: { capability: string }) =>
          entry.capability === "Gate"
        )
      ) capabilities.set("Gate", new Map([["wait", wait]]));
      if (
        imports.some((entry: { capability: string }) =>
          entry.capability === "Cleanup"
        )
      ) capabilities.set("Cleanup", new Map([["record", record]]));
      return capabilities;
    },
  });
  try {
    await project.activate(runtime);
    const app = runtime.unitInstance("app");
    const provider = runtime.unitInstance("formula");
    const pending = runtime.callAsync("run", [sparks.executor, 7n]);
    const rejected = assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError",
    );
    const signal = await started.promise;
    await writeFile(
      formula,
      'open import "blot:prelude"\nconst apply :: Int -> Int = fn value => value * 3\nreturn { .apply = apply; }\n',
    );
    await project.markChanged(formula);
    const build = await project.prepareBuild();
    const activation = await runtime.prepareActivation(build);
    assert.equal(signal.aborted, false);
    assert.strictEqual(runtime.unitInstance("formula"), provider);
    project.commitBuild(build);
    const activated = runtime.commitActivation(activation);
    await cancelled.promise;
    assert.strictEqual(runtime.unitInstance("formula"), provider);
    assert.throws(
      () => runtime.callAsync("run", [sparks.executor, 1n]),
      /draining/,
    );
    release.resolve(999n);
    await activated;
    await rejected;
    assert.deepEqual(observed, [14n]);
    assert.strictEqual(runtime.unitInstance("app"), app);
    assert.notStrictEqual(runtime.unitInstance("formula"), provider);
    assert.equal(await runtime.callAsync("run", [sparks.executor, 7n]), 21n);
    assert.deepEqual(observed, [14n, 21n]);
  } finally {
    release.resolve(0n);
    await runtime.close();
    await root.close();
    project.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("development worker jobs reuse compiled units and select the reloaded provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-worker-development-"));
  const manifest = join(directory, "blot.json");
  const formula = join(directory, "formula.blot");
  await writeFile(
    manifest,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "app",
      units: { app: "./main.blot", formula: "./formula.blot" },
    }),
  );
  await writeFile(
    formula,
    'open import "blot:prelude"\nconst apply :: Int -> Int = fn value => value * 2\nreturn { .apply = apply; }\n',
  );
  await writeFile(
    join(directory, "main.blot"),
    `open import "blot:prelude"
const Spark = import "blot:spark"
const formula = import "./formula.blot"
let run :: Spark.Executor -> Int -> Int ~ { Spark.Effect }
let run = fn executor => fn number => do:
  let body :: Spark.Scope -> Int ~ { Spark.Effect } = fn scope => do:
    let ?work :: Unit -> Int = fn () => formula.apply number
    use job <- Spark.parallel scope (?work)
    return Spark.join job
  return Spark.scope executor body
return { .run = run; }
`,
  );
  const root = new HostScope();
  const workers = createNodeWorkerExecutor(root, { size: 1 });
  const sparks = new SparkRuntime(root, { workers });
  const project = await DevelopmentProject.create(manifest);
  const runtime = new DevelopmentRuntime(undefined, {
    scope: root,
    capabilities: (artifact) => sparks.capabilitiesFor(artifact),
  });
  try {
    await project.activate(runtime);
    const app = runtime.unitInstance("app");
    assert.equal(await runtime.callAsync("run", [sparks.executor, 7n]), 14n);
    assert.equal(await runtime.callAsync("run", [sparks.executor, 9n]), 18n);
    assert.equal(workers.statistics.programsInstalled, 1);
    for (let multiplier = 3; multiplier <= 20; multiplier += 1) {
      await writeFile(
        formula,
        `open import "blot:prelude"\nconst apply :: Int -> Int = fn value => value * ${multiplier}\nreturn { .apply = apply; }\n`,
      );
      await project.markChanged(formula);
      await project.activate(runtime);
      assert.strictEqual(runtime.unitInstance("app"), app);
      assert.equal(
        await runtime.callAsync("run", [sparks.executor, 7n]),
        7n * BigInt(multiplier),
      );
    }
    assert.equal(workers.statistics.workersStarted, 1);
    assert.equal(workers.statistics.programsInstalled, 19);
    assert.equal(workers.statistics.programsCached, 16);
    assert.equal(workers.statistics.jobsCompleted, 20);
    await writeFile(
      formula,
      `open import "blot:prelude"
const apply :: Int -> Int = fn count => do:
  let total = 0
  for index in Iter.range (0, count):
    total := total + index
  return total
return { .apply = apply; }
`,
    );
    await project.markChanged(formula);
    await project.activate(runtime);
    const cancellation = new AbortController();
    const pending = runtime.callAsync(
      "run",
      [sparks.executor, 1_000_000_000n],
      { signal: cancellation.signal },
    );
    const rejected = assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError",
    );
    while (workers.statistics.jobsStarted < 21) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    cancellation.abort();
    await rejected;
    assert.equal(await runtime.callAsync("run", [sparks.executor, 10n]), 45n);
    assert.equal(workers.statistics.workersStarted, 1);
  } finally {
    await runtime.close();
    await root.close();
    project.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
