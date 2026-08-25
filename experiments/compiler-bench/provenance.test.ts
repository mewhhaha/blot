import assert from "node:assert/strict";
import test from "node:test";
import type { Loaded } from "../../src/load.ts";
import {
  benchmarkInputsIdentity,
  hostInputsIdentity,
  workloadGraphIdentity,
} from "./provenance.ts";

function sourceModule(
  path: string,
  source: string,
  dependencies: ReadonlyMap<string, Loaded> = new Map(),
  includedFiles: Loaded["includedFiles"] = new Map(),
): Loaded {
  return {
    get module(): never {
      throw new Error("source graph identity materialized an AST");
    },
    dependencies,
    includedFiles,
    source,
    path,
    storage: { tag: "source" },
  };
}

test("workload graph identity ignores paths and dependency insertion order", () => {
  const firstLeft = sourceModule("/first/left.blot", "return 1\n");
  const firstRight = sourceModule("/first/right.blot", "return 2\n");
  const first = sourceModule(
    "/first/root.blot",
    "return 3\n",
    new Map([["right", firstRight], ["left", firstLeft]]),
  );
  const secondLeft = sourceModule("/second/left.blot", "return 1\n");
  const secondRight = sourceModule("/second/right.blot", "return 2\n");
  const second = sourceModule(
    "/second/root.blot",
    "return 3\n",
    new Map([["left", secondLeft], ["right", secondRight]]),
  );

  assert.equal(workloadGraphIdentity(second), workloadGraphIdentity(first));
  assert.notEqual(
    workloadGraphIdentity(sourceModule(
      "/second/root.blot",
      "return 3\n",
      new Map([
        ["left", sourceModule("/second/left.blot", "return 4\n")],
        ["right", secondRight],
      ]),
    )),
    workloadGraphIdentity(first),
  );
});

test("workload graph identity rejects cycles", () => {
  const dependencies = new Map<string, Loaded>();
  const root = sourceModule("/cycle/root.blot", "return 1\n", dependencies);
  dependencies.set("self", root);

  assert.throws(
    () => workloadGraphIdentity(root),
    /workload graph contains a cycle/,
  );
});

test("workload graph identity preserves shared dependency topology", () => {
  const shared = sourceModule("/shared/dependency.blot", "return 1\n");
  const sharedRoot = sourceModule(
    "/shared/root.blot",
    "return 2\n",
    new Map([["left", shared], ["right", shared]]),
  );
  const copiedRoot = sourceModule(
    "/copied/root.blot",
    "return 2\n",
    new Map([
      ["left", sourceModule("/copied/left.blot", "return 1\n")],
      ["right", sourceModule("/copied/right.blot", "return 1\n")],
    ]),
  );

  assert.notEqual(
    workloadGraphIdentity(sharedRoot),
    workloadGraphIdentity(copiedRoot),
  );
});

test("workload graph identity preserves path-visible include identity", () => {
  const first = sourceModule(
    "/first/root.blot",
    'return @include("./text/message.txt")\n',
    new Map(),
    new Map([["./text/message.txt", {
      path: "/first/text/message.txt",
      source: "hello",
    }]]),
  );
  const relocated = sourceModule(
    "/second/root.blot",
    first.source,
    new Map(),
    new Map([["./text/message.txt", {
      path: "/second/text/message.txt",
      source: "hello",
    }]]),
  );
  const changedPath = sourceModule(
    "/second/root.blot",
    first.source,
    new Map(),
    new Map([["./text/message.txt", {
      path: "/second/other/message.txt",
      source: "hello",
    }]]),
  );

  assert.equal(workloadGraphIdentity(relocated), workloadGraphIdentity(first));
  assert.notEqual(
    workloadGraphIdentity(changedPath),
    workloadGraphIdentity(first),
  );
});

test("benchmark input identity covers the runnable harness", async () => {
  assert.match(await benchmarkInputsIdentity(), /^[0-9a-f]{64}$/);
});

test("host input identity represents the current worktree", async () => {
  assert.match(await hostInputsIdentity(), /^[0-9a-f]{64}$/);
});
