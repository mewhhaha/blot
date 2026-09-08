import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeManifest } from "../abi_values.ts";
import { DevelopmentProject } from "../development.ts";
import { DevelopmentRuntime } from "../development_runtime.ts";
import type { HostOperation } from "../host.ts";
import { HostScope } from "../resources.ts";
import { SparkRuntime } from "../spark.ts";

test("suspending development links share caller scopes and drain independent calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-suspending-links-"));
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
const Gate = @effect.host { .wait = Effect.suspends (Text -> Text); }
const Finish = @effect.host { .record = Text -> Unit; }
let work :: Spark.Scope -> Text -> [Text] ~ { Spark.Effect, Gate, Finish }
let work = fn scope => fn label => do:
  let ?cleanup :: Unit -> Unit ~ { Finish } = fn () => Finish.record label
  use () <- Spark.on_exit scope (?cleanup)
  use answer <- Gate.wait label
  return [answer, Text.of_int (Text.length label)]
return { .work = work; .Gate = Gate; .Finish = Finish; .Scheduling = Spark.Effect; }
`,
  );
  await writeFile(
    join(directory, "main.blot"),
    `open import "blot:prelude"
const Spark = import "blot:spark"
const provider = import "./provider.blot"
let run :: Spark.Executor -> Text -> [Text] ~ { Spark.Effect, provider.Scheduling, provider.Gate, provider.Finish }
let run = fn executor => fn label => do:
  let body :: Spark.Scope -> [Text] ~ { provider.Scheduling, provider.Gate, provider.Finish }
  let body = fn scope => provider.work scope label
  return Spark.scope executor body
return { .run = run; }
`,
  );
  const root = new HostScope();
  const sparks = new SparkRuntime(root);
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  const bothStarted = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const finished: string[] = [];
  const wait: HostOperation = (context, label) => {
    signals.push(context.signal);
    if (signals.length === 2) bothStarted.resolve();
    if (label === "left") return first.promise;
    assert.equal(label, "right");
    return second.promise;
  };
  const record: HostOperation = (_context, label) => {
    assert.equal(typeof label, "string");
    finished.push(String(label));
    return null;
  };
  const project = await DevelopmentProject.create(manifest);
  const runtime = new DevelopmentRuntime(undefined, {
    scope: root,
    capabilities(artifact) {
      const capabilities = new Map(sparks.capabilitiesFor(artifact));
      for (const operation of decodeManifest(artifact.manifestBytes).imports) {
        if (operation.capability === "Gate") {
          capabilities.set("Gate", new Map([["wait", wait]]));
        }
        if (operation.capability === "Finish") {
          capabilities.set("Finish", new Map([["record", record]]));
        }
      }
      return capabilities;
    },
  });
  try {
    await project.activate(runtime);
    const cancellation = new AbortController();
    const left = runtime.callAsync("run", [sparks.executor, "left"], {
      signal: cancellation.signal,
    });
    const rejected = assert.rejects(
      left,
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError",
    );
    const right = runtime.callAsync("run", [sparks.executor, "right"]);
    await bothStarted.promise;
    cancellation.abort();
    second.resolve("世界");
    assert.deepEqual(await right, ["世界", "5"]);
    assert.deepEqual(finished, ["right"]);
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);
    first.resolve("late result");
    await rejected;
    assert.deepEqual(finished, ["right", "left"]);
  } finally {
    first.resolve("released");
    second.resolve("released");
    await runtime.close();
    await root.close();
    project.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
