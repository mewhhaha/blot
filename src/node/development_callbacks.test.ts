import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeManifest } from "../abi_values.ts";
import {
  type HostCallback,
  isHostCallback,
  moveHostCallback,
} from "../callbacks.ts";
import { DevelopmentProject } from "../development.ts";
import { DevelopmentRuntime } from "../development_runtime.ts";
import type { HostOperation } from "../host.ts";
import { HostScope } from "../resources.ts";
import { SparkRuntime } from "../spark.ts";

test("development callbacks pin sync and async providers until consumption or scope release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-callback-revisions-"));
  const manifest = join(directory, "blot.json");
  const formula = join(directory, "formula.blot");
  const provider = join(directory, "provider.blot");
  const writeFormula = (multiplier: number) =>
    writeFile(
      formula,
      `open import "blot:prelude"
const apply :: Int -> Int = fn value => value * ${multiplier}
return { .apply = apply; }
`,
    );
  const writeProvider = (offset: number) =>
    writeFile(
      provider,
      `open import "blot:prelude"
const formula = import "./formula.blot"
const Gate = @effect.host { .wait = Effect.suspends (Int -> Int); }
const sync :: Int -> Int = fn value => formula.apply value
const wait :: Int -> Int ~ { Gate } = fn value => do:
  use answer <- Gate.wait value
  return formula.apply answer + ${offset}
return { .sync = sync; .wait = wait; .Gate = Gate; }
`,
    );
  await writeFile(
    manifest,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "app",
      units: {
        app: "./main.blot",
        provider: "./provider.blot",
        formula: "./formula.blot",
      },
    }),
  );
  await writeFormula(2);
  await writeProvider(1);
  await writeFile(
    join(directory, "main.blot"),
    `open import "blot:prelude"
const formula = import "./formula.blot"
const provider = import "./provider.blot"
const Capture = @effect.host {
  .save = {
    .signature = @forall (fn e => (((Unit -> Int) ~ [e]) -> Unit) ~ [e]);
    .input = #Affine;
    .result = #Unrestricted;
    .suspends = True;
  };
}
const save :: Int -> Unit ~ { Capture, provider.Gate } = fn value => do:
  let ?work :: Unit -> Int ~ { provider.Gate } = fn () => provider.wait (provider.sync value)
  return Capture.save (?work)
return { .save = save; }
`,
  );
  const scope = new HostScope();
  const captured: HostCallback[] = [];
  const inputs: bigint[] = [];
  const started = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const save: HostOperation = (context, value) => {
    assert.ok(isHostCallback(value));
    moveHostCallback(value, context.authority);
    captured.push(value);
    return null;
  };
  const wait: HostOperation = (context, value) => {
    assert.equal(typeof value, "bigint");
    inputs.push(BigInt(String(value)));
    if (inputs.length === 1) {
      started.resolve(context.signal);
      return release.promise.then(() => value);
    }
    return Promise.resolve(value);
  };
  const runtime = new DevelopmentRuntime(undefined, {
    scope,
    capabilities(artifact) {
      const capabilities = new Map<string, Map<string, HostOperation>>();
      for (const operation of decodeManifest(artifact.manifestBytes).imports) {
        if (operation.capability === "Capture") {
          capabilities.set("Capture", new Map([["save", save]]));
        }
        if (operation.capability === "Gate") {
          capabilities.set("Gate", new Map([["wait", wait]]));
        }
      }
      return capabilities;
    },
  });
  const project = await DevelopmentProject.create(manifest);
  try {
    await project.activate(runtime);
    await runtime.callAsync("save", [7n]);
    await runtime.callAsync("save", [8n]);
    assert.equal(captured.length, 2);
    assert.equal(runtime.statistics.pinnedUnits, 3);
    const oldCall = captured[0].call();
    const oldSignal = await started.promise;
    await writeFormula(3);
    await writeProvider(10);
    await project.markChanged(formula);
    await project.markChanged(provider);
    const build = await project.prepareBuild();
    const abandoned = await runtime.prepareActivation(build);
    await runtime.abortActivation(abandoned);
    assert.equal(runtime.statistics.retiredUnits, 0);
    const activation = await runtime.prepareActivation(build);
    project.commitBuild(build);
    await runtime.commitActivation(activation);
    assert.ok(runtime.statistics.retiredUnits >= 2);
    assert.equal(oldSignal.aborted, false);
    await runtime.callAsync("save", [7n]);
    release.resolve();
    assert.equal(await oldCall, 29n);
    assert.equal(await captured[2].call(), 73n);
    assert.deepEqual(inputs, [14n, 21n]);
    assert.ok(runtime.statistics.retiredUnits >= 2);
    assert.equal(await captured[1].call(), 33n);
    assert.deepEqual(runtime.statistics, { pinnedUnits: 0, retiredUnits: 0 });
    await runtime.callAsync("save", [9n]);
    await writeFormula(4);
    await writeProvider(100);
    await project.markChanged(formula);
    await project.markChanged(provider);
    await project.activate(runtime);
    assert.ok(runtime.statistics.retiredUnits >= 2);
    await runtime.close();
    assert.deepEqual(runtime.statistics, { pinnedUnits: 0, retiredUnits: 0 });
    await assert.rejects(captured[3].call(), /released/);
  } finally {
    release.resolve();
    await runtime.close();
    await scope.close();
    project.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pure development links validate resource tokens inside copied records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-scoped-direct-links-"));
  const manifest = join(directory, "blot.json");
  await writeFile(
    manifest,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "app",
      units: { app: "./main.blot", provider: "./provider.blot" },
    }),
  );
  await writeFile(
    join(directory, "provider.blot"),
    `open import "blot:prelude"
const Spark = import "blot:spark"
const Carried = { .label = Text; .scope = Spark.Scope; }
const keep :: Spark.Scope -> Carried = fn scope => { .label = "carried"; .scope = scope; }
return { .keep = keep; }
`,
  );
  await writeFile(
    join(directory, "main.blot"),
    `open import "blot:prelude"
const Spark = import "blot:spark"
const provider = import "./provider.blot"
const run :: Spark.Executor -> Int ~ { Spark.Effect } = fn executor => do:
  let body :: Spark.Scope -> Int ~ { Spark.Effect } = fn scope => do:
    let carried = provider.keep scope
    use () <- Spark.yield carried.scope
    return Text.length carried.label
  return Spark.scope executor body
return { .run = run; }
`,
  );
  const scope = new HostScope();
  const sparks = new SparkRuntime(scope);
  const runtime = new DevelopmentRuntime(undefined, {
    scope,
    capabilities: (artifact) => sparks.capabilitiesFor(artifact),
  });
  const project = await DevelopmentProject.create(manifest);
  try {
    const build = await project.activate(runtime);
    const app = build.changedUnits.find((unit) => unit.name === "app");
    assert.ok(app !== undefined);
    assert.equal(decodeManifest(app.manifestBytes).links?.[0].suspends, false);
    assert.equal(await runtime.callAsync("run", [sparks.executor]), 7n);
    assert.deepEqual(runtime.statistics, { pinnedUnits: 0, retiredUnits: 0 });
  } finally {
    await runtime.close();
    await scope.close();
    project.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
