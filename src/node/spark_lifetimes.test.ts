import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { decodeManifest, type RuntimeValue } from "../abi_values.ts";
import type { BlotAbiType } from "../compiler/backend/runtime/abi.ts";
import { createHostCallback, isHostCallback } from "../callbacks.ts";
import { Compiler } from "../compiler.ts";
import { type HostOperation, instantiateArtifact } from "../host.ts";
import { HostScope } from "../resources.ts";
import { SparkRuntime } from "../spark.ts";

test("source job handles cannot be consumed twice through join, cancel, or aliases", async () => {
  const compiler = await Compiler.create();
  try {
    for (const operation of ["join", "cancel"]) {
      for (const second of ["join job", "cancel job", "join alias"]) {
        await assert.rejects(
          compiler.checkSource(
            `/tmp/spark-consumed-${operation}-${
              second.replaceAll(" ", "-")
            }.blot`,
            `open import "blot:prelude"
const Spark = import "blot:spark"
const run = fn scope => do:
  let ?work = fn () => 42
  use job <- Spark.spawn scope (?work)
  let alias = job
  use first <- Spark.${operation} job
  return Spark.${second}
return { .run = run; }
`,
          ),
          /BLOT_LINEAR_CONSUMED_TWICE/,
        );
      }
    }
  } finally {
    compiler.destroy();
  }
});

test("finished work drains before late join and consuming a job retires it inside an open scope", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile(
      "examples/lib/spark_retirement.blot",
    );
    const sparks = new SparkRuntime(root);
    const capabilities = new Map(sparks.capabilitiesFor(artifact));
    const sparkOperations = capabilities.get("SparkRuntime");
    assert.ok(sparkOperations !== undefined);
    const join = sparkOperations.get("join");
    assert.ok(join !== undefined);
    let joins = 0;
    const once: HostOperation = async (context, job) => {
      const pending = Promise.resolve(join(context, job));
      await assert.rejects(
        Promise.resolve(join(context, job)),
        /revoked|consumed/,
      );
      const result = await pending;
      await assert.rejects(
        Promise.resolve(join(context, job)),
        /revoked|consumed/,
      );
      joins += 1;
      return result;
    };
    capabilities.set(
      "SparkRuntime",
      new Map([...sparkOperations, ["join", once]]),
    );
    const observed: bigint[] = [];
    const tick: HostOperation = async (_context, index) => {
      assert.equal(typeof index, "bigint");
      await setImmediate();
      return index;
    };
    const completed: HostOperation = async () => {
      while (sparks.statistics.jobsActive !== 0) await setImmediate();
      assert.equal(sparks.statistics.jobsRetained, 1);
      return null;
    };
    const retired: HostOperation = (_context, value) => {
      assert.equal(typeof value, "bigint");
      assert.equal(sparks.statistics.jobsActive, 0);
      assert.equal(sparks.statistics.jobsRetained, 0);
      observed.push(BigInt(String(value)));
      return null;
    };
    capabilities.set(
      "Probe",
      new Map([
        ["tick", tick],
        ["completed", completed],
        ["retired", retired],
      ]),
    );
    const hosted = await instantiateArtifact(artifact, capabilities, {
      scope: root,
    });
    try {
      assert.equal(
        await hosted.callAsync("run", [{
          kind: "record",
          fields: new Map([["executor", sparks.executor]]),
        }, 32n]),
        496n,
      );
      assert.deepEqual(
        observed,
        Array.from({ length: 32 }, (_, i) => BigInt(i)),
      );
      assert.equal(joins, 32);
      assert.deepEqual(sparks.statistics, {
        jobsActive: 0,
        jobsRetained: 0,
        maximumJobsRetained: 1,
      });
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});

test("host scope callback results survive completed jobs and scope retirement", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile(
      "examples/lib/spark_retirement.blot",
    );
    const manifest = decodeManifest(artifact.manifestBytes);
    const answerType: BlotAbiType = {
      kind: "callback",
      entry: "test:answer",
      function: {
        parameters: [{ kind: "unit" }],
        result: { kind: "signed-integer-64" },
      },
      environment: { kind: "record", fields: [] },
    };
    const resultType: BlotAbiType = {
      kind: "record",
      fields: [{ name: "answer", type: answerType }],
    };
    const imports = manifest.imports.filter((entry) =>
      entry.capability === "SparkRuntime"
    ).map((entry) => {
      if (entry.sourceName !== "scope") return entry;
      const parameter = entry.function.parameters[0];
      assert.equal(parameter.kind, "record");
      if (parameter.kind !== "record") throw new Error("expected Spark tuple");
      const fields = parameter.fields.map((field) => {
        if (field.name !== "1") return field;
        assert.equal(field.type.kind, "callback");
        if (field.type.kind !== "callback") {
          throw new Error("expected Spark work");
        }
        return {
          ...field,
          type: {
            ...field.type,
            function: { ...field.type.function, result: resultType },
          },
        };
      });
      return {
        ...entry,
        function: {
          parameters: [{ ...parameter, fields }],
          result: resultType,
        },
      };
    });
    const sparks = new SparkRuntime(root);
    const operations = sparks.capabilitiesFor({
      manifestBytes: new TextEncoder().encode(
        JSON.stringify({ ...manifest, imports }),
      ),
    }).get("SparkRuntime");
    assert.ok(operations !== undefined);
    const invoke = async (
      name: string,
      scope: HostScope,
      argument: RuntimeValue,
    ) => {
      const operation = imports.find((entry) => entry.sourceName === name);
      const perform = operations.get(name);
      assert.ok(operation !== undefined && perform !== undefined);
      return await perform({
        scope,
        authority: root,
        signal: scope.signal,
        operation,
      }, argument);
    };
    let workLifetime: HostScope | undefined;
    let bodyLifetime: HostScope | undefined;
    const body = createHostCallback(
      root,
      () => {},
      async (scope, scopeHandle) => {
        bodyLifetime = scope;
        const work = createHostCallback(scope, () => {}, (jobScope) => {
          workLifetime = jobScope;
          return Promise.resolve(42n);
        });
        const job = await invoke("spawn", scope, {
          kind: "record",
          fields: new Map<string, RuntimeValue>([["0", scopeHandle], [
            "1",
            work,
          ]]),
        });
        const value = await invoke("join", scope, job);
        const answer = createHostCallback(
          scope,
          () => {},
          () => Promise.resolve(value),
        );
        return { kind: "record", fields: new Map([["answer", answer]]) };
      },
    );
    const result = await invoke("scope", root, {
      kind: "record",
      fields: new Map<string, RuntimeValue>([["0", sparks.executor], [
        "1",
        body,
      ]]),
    });
    assert.ok(workLifetime !== undefined && workLifetime.signal.aborted);
    assert.ok(bodyLifetime !== undefined && bodyLifetime.signal.aborted);
    assert.equal(sparks.statistics.jobsRetained, 0);
    assert.equal(sparks.statistics.jobsActive, 0);
    assert.ok(
      result !== null && typeof result === "object" && "kind" in result &&
        result.kind === "record",
    );
    const answer = result.fields.get("answer");
    assert.ok(isHostCallback(answer));
    assert.equal(await answer.call(), 42n);
  } finally {
    await root.close();
    compiler.destroy();
  }
});
