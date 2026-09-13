import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeValue } from "../../src/abi_values.ts";
import { Compiler } from "../../src/compiler.ts";
import { BlotError } from "../../src/diagnostic.ts";
import { instantiateArtifact } from "../../src/host.ts";
import { observeArtifact } from "../../src/node/run.ts";
import { evaluationObservation } from "../../src/runtime_observation.ts";

function record(fields: Record<string, RuntimeValue>): RuntimeValue {
  return { kind: "record", fields: new Map(Object.entries(fields)) };
}

function tuple(...values: RuntimeValue[]): RuntimeValue {
  return record(
    Object.fromEntries(values.map((value, index) => [String(index), value])),
  );
}

test("query guards skip later work and combined streams preserve order and empty seeds", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "case-studies/ecs/stream.test.blot";
    await compiler.checkSource(
      path,
      `
open import "blot:prelude"
const ECS = import "./ecs.blot"
const selected = fn values => ECS.Stream.choose (Iter.items values, fn value => ECS.Query.run (fn () => do:
  use ECS.Query.guard (value > 0)
  return 100 / value
))
const collect :: ([Int], [Int], [Int]) -> [Int]
const collect = fn (first, second, third) => Iter.collect (
  ECS.Stream.append (ECS.Stream.append (selected first, selected second), selected third)
)
const regrouped :: ([Int], [Int], [Int]) -> [Int]
const regrouped = fn (first, second, third) => Iter.collect (
  ECS.Stream.append (selected first, ECS.Stream.append (selected second, selected third))
)
const sum :: ([Int], [Int]) -> Int
const sum = fn (first, second) => Iter.fold_with (fn (total, value) => total + value) 7 (
  ECS.Stream.append (selected first, selected second)
)
return { .collect; .regrouped; .sum; }
`,
    );
    const guest = await instantiateArtifact(await compiler.compile(path));
    try {
      for (
        const inputs of [
          [[], [], []],
          [[0n, -1n], [2n], []],
          [[1n, 0n, 4n], [5n, -2n], [10n, 20n]],
          [[], [], [25n]],
        ]
      ) {
        const expected = inputs.flat().filter((value) => value > 0n).map((
          value,
        ) => 100n / value);
        for (const name of ["collect", "regrouped"]) {
          assert.deepEqual(guest.call(name, [tuple(...inputs)]), expected);
        }
        const sum = inputs.slice(0, 2).flat().filter((value) => value > 0n)
          .reduce((total, value) => total + 100n / value, 7n);
        assert.equal(guest.call("sum", [tuple(inputs[0], inputs[1])]), sum);
      }
      assert.equal(
        guest.call("sum", [tuple(Array(100_000).fill(0n), [2n])]),
        57n,
      );
    } finally {
      guest.destroy();
    }
    const kernel = "case-studies/ecs/fold.test.blot";
    await compiler.checkSource(
      kernel,
      `
open import "blot:prelude"
const ECS = import "./ecs.blot"
const sum :: ([Int], [Int]) -> Int
const sum = fn (first, second) => Iter.fold_with (fn (total, value) => total + value) 0 (
  ECS.Stream.append (Iter.items first, Iter.items second)
)
return sum
`,
    );
    const hir = await compiler.prepare(kernel);
    assert.deepEqual(hir.capabilities, []);
    const operations = hir.functions.flatMap((fn) =>
      fn.continuations.flatMap((block) => block.instructions)
    );
    assert.ok(
      !operations.some(({ operation }) =>
        ["store.empty", "store.grow", "store.literal"].includes(operation.kind)
      ),
    );
  } finally {
    compiler.destroy();
  }
});

test("typed delivery merges outboxes in FIFO order and returns unknown destinations", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "case-studies/ecs/delivery.test.blot";
    await compiler.checkSource(
      path,
      `
open import "blot:prelude"
const ECS = import "./ecs.blot"
const Mail = ECS.Messages Text
const route :: (Int, [Mail.Envelope], [Mail.Envelope]) -> { .inboxes = [[Mail.Envelope]]; .undelivered = [Mail.Envelope]; }
const route = fn (count, first, second) => do:
  let delivery = Mail.deliver (count, ECS.Stream.append (Iter.items first, Iter.items second))
  return {
    .inboxes = Iter.collect (Iter.map (Iter.range (0, count), fn recipient => Iter.collect (Mail.expect_inbox (delivery, recipient))));
    .undelivered = Iter.collect (Mail.undelivered delivery);
  }
const bulk :: Int -> Int
const bulk = fn count => do:
  let first = Iter.map (Iter.range (0, count), fn sender => { .sender; .recipient = 0; .payload = "first"; })
  let second = Iter.map (Iter.range (0, count), fn sender => { .sender; .recipient = 0; .payload = "second"; })
  let delivery = Mail.deliver (1, ECS.Stream.append (first, second))
  return Iter.fold_with (fn (count, envelope) => count + 1) 0 (Mail.expect_inbox (delivery, 0))
return { .default = route; .bulk; }
`,
    );
    const guest = await instantiateArtifact(await compiler.compile(path));
    try {
      for (const count of [0, 1, 5, 31]) {
        for (const length of [0, 1, 129]) {
          const sent = Array.from({ length }, (_, index) => ({
            sender: BigInt(index),
            recipient: BigInt(index % (count + 2) - 1),
            payload: `message ${index} — 🐈`,
          }));
          const encoded = sent.map(record);
          const split = Math.floor(length / 3);
          const expected = record({
            inboxes: Array.from(
              { length: count },
              (_, recipient) =>
                sent.filter((envelope) =>
                  envelope.recipient === BigInt(recipient)
                ).map(record),
            ),
            undelivered: sent.filter((envelope) =>
              envelope.recipient < 0n || envelope.recipient >= BigInt(count)
            ).map(record),
          });
          assert.deepEqual(
            guest.call("default", [
              tuple(
                BigInt(count),
                encoded.slice(0, split),
                encoded.slice(split),
              ),
            ]),
            expected,
          );
        }
      }
      assert.equal(guest.call("bulk", [100_000n]), 200_000n);
      assert.throws(
        () => guest.call("default", [tuple(-1n, [], [])]),
        WebAssembly.RuntimeError,
      );
    } finally {
      guest.destroy();
    }
    const hir = await compiler.prepare(path);
    const updates = hir.functions.flatMap((fn) =>
      fn.continuations.flatMap((block) => block.instructions)
    )
      .map(({ operation }) => operation)
      .filter((operation) =>
        operation.kind === "store.write" || operation.kind === "store.grow"
      );
    assert.ok(updates.length > 0);
    for (const operation of updates) {
      if (operation.kind !== "store.write" && operation.kind !== "store.grow") {
        throw new Error("expected Store update");
      }
      assert.equal(operation.update, "owned-reuse");
    }
  } finally {
    compiler.destroy();
  }
});

test("archetype selection and messages compose across an explicit phase boundary", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "case-studies/ecs/arena.test.blot";
    await compiler.checkSource(
      path,
      `
open import "blot:prelude"
const a = import "./arena.blot"
const run :: Int -> { .before = a.Summary; .after = a.Summary; .again = a.Summary; }
const run = fn health => do:
  let world = a.seed health
  let next = a.tick (world, [])
  let again = a.tick (next.world, [])
  return { .before = a.summary world; .after = a.summary next.world; .again = a.summary again.world; }
const empty :: Unit -> a.Summary
const empty = fn () => a.summary { .fighters = []; .medics = []; .sleepers = []; .scenery = []; }
return { .default = run; .empty; }
`,
    );
    const guest = await instantiateArtifact(await compiler.compile(path));
    try {
      assert.deepEqual(
        guest.call("empty", [null]),
        record({ count: 0n, health: 0n, names: "" }),
      );
      assert.deepEqual(
        guest.call("default", [10n]),
        record({
          before: record({ count: 3n, health: 21n, names: "Ada, Cy, Dee" }),
          after: record({ count: 2n, health: 22n, names: "Ada, Dee" }),
          again: record({ count: 2n, health: 25n, names: "Ada, Dee" }),
        }),
      );
      assert.deepEqual(
        guest.call("default", [0n]),
        record({
          before: record({ count: 2n, health: 11n, names: "Cy, Dee" }),
          after: record({ count: 3n, health: 18n, names: "Ada, Cy, Dee" }),
          again: record({ count: 2n, health: 19n, names: "Ada, Dee" }),
        }),
      );
    } finally {
      guest.destroy();
    }
    const example = "case-studies/ecs/queries-and-messages.blot";
    const evaluated = await compiler.evaluate(example);
    const emitted = await observeArtifact(await compiler.compile(example));
    assert.deepEqual(
      evaluationObservation(evaluated.value, {
        kind: "record",
        fields: [{ name: "default", type: emitted.type }],
      }),
      record({ default: emitted.value }),
    );
    assert.deepEqual(evaluated.writes, []);
  } finally {
    compiler.destroy();
  }
});

test("message payloads and selected component reads retain their type obligations", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const source of [
        `const Mail = ECS.Messages Int
return Mail.send ([], { .sender = 0; .recipient = 1; .payload = "wrong"; })`,
        `const Mail = ECS.Messages Int
return Mail.send ([{ .sender = 0; .recipient = 1; .payload = "wrong"; }], { .sender = 1; .recipient = 0; .payload = 7; })`,
        `const Row = ECS.archetype { .Health = Int; }
const selected = ECS.Query.table (Row, ECS.Query.has "Health")
return Iter.collect (selected ([{ .Health = "wrong"; }], fn row => #Some row.Health))`,
      ]
    ) {
      await assert.rejects(
        compiler.checkSource(
          "case-studies/ecs/query-rejection.test.blot",
          `
open import "blot:prelude"
const ECS = import "./ecs.blot"
${source}
`,
        ),
        (error: unknown) => {
          assert.ok(error instanceof BlotError);
          assert.equal(error.diagnostic.code, "BLOT_TYPE_ERROR");
          assert.ok(error.diagnostic.span.end > error.diagnostic.span.start);
          assert.ok(error.origin);
          assert.ok(error.diagnostic.span.end <= error.origin.source.length);
          return true;
        },
      );
    }
  } finally {
    compiler.destroy();
  }
});
