import { requiredFunction } from "../abi_values.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";

const productSource = `open import "blot:prelude"

let direct :: (Int, Int) -> Int
let direct = fn (left, right) => left - right

let named :: (Int, Int) -> Int
let named = fn pair => pair.0 - pair.1

let rebound :: (Int, Int) -> Int
let rebound = fn pair => do:
  let alias = pair
  let (left, right) = alias
  return left - right

let nested :: (Int, Int) -> Int
let nested = fn (left, right) => do:
  let value = ((left, right), { .right = right; .left = left; })
  let (positional, fields) = value
  return positional.0 - fields.right

let choice :: (Int, Int, Int) -> Int
let choice = fn (selector, left, right) => do:
  let pair = case selector of
    0 => (left, right)
    _ => (right, left)
  return named pair

let captured :: (Int, Int) -> Int
let captured = fn (left, right) => do:
  let pair = (left, right)
  let read = fn () => named pair
  return read ()

let rec exchange :: (Int, Int, Int) -> (Int, Int)
let rec exchange = fn (remaining, left, right) => case remaining of
  0 => (left, right)
  _ => exchange (remaining - 1, right, left)

let returned :: (Int, Int, Int) -> Int
let returned = fn arguments => named (exchange arguments)

let mixed :: (F64, Int) -> Int
let mixed = fn pair => do:
  let alias = pair
  return F64.truncate alias.0 + alias.1

return {
  .direct = direct;
  .named = named;
  .rebound = rebound;
  .nested = nested;
  .choice = choice;
  .captured = captured;
  .returned = returned;
  .mixed = mixed;
}
`;

async function withSource(
  source: string,
  run: (compiler: Compiler, path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "blot-inline-products-"));
  const path = join(directory, "main.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(path, source);
    await run(compiler, path);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
}

test("products stay inline beyond destructured arguments", async (t) => {
  await withSource(productSource, async (compiler, path) => {
    const hir = await compiler.prepare(path);
    const operations = hir.functions.flatMap((function_) =>
      function_.continuations.flatMap((continuation) =>
        continuation.instructions
      )
    );
    assert.ok(
      hir.signatures.some((signature) =>
        hir.types[signature.result].kind === "product"
      ),
      "the recursive helper must retain an internal product result",
    );
    assert.ok(
      hir.functions.some((function_) =>
        function_.continuations.some((continuation) =>
          continuation.transition.kind === "call" &&
          continuation.transition.target.kind === "function"
        )
      ),
      "the test must exercise a residual call, not only inlined arithmetic",
    );
    assert.equal(
      operations.some((instruction) =>
        instruction.operation.kind.startsWith("store.") ||
        instruction.operation.kind.startsWith("indirect.")
      ),
      false,
      "plain products must not lower to an array Store or recursive box",
    );

    const artifact = await compiler.compile(path);
    const { instance } = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
    );
    const memory = instance.exports.memory;
    assert.ok(memory instanceof WebAssembly.Memory);

    const cases: readonly {
      readonly name: string;
      readonly arguments: readonly (number | bigint)[];
      readonly expected: bigint;
    }[] = [
      { name: "direct", arguments: [41n, 9n], expected: 32n },
      { name: "named", arguments: [41n, 9n], expected: 32n },
      { name: "rebound", arguments: [41n, 9n], expected: 32n },
      { name: "nested", arguments: [41n, 9n], expected: 32n },
      { name: "choice", arguments: [0n, 41n, 9n], expected: 32n },
      { name: "choice", arguments: [1n, 41n, 9n], expected: -32n },
      { name: "captured", arguments: [41n, 9n], expected: 32n },
      { name: "returned", arguments: [200n, 41n, 9n], expected: 32n },
      { name: "returned", arguments: [201n, 41n, 9n], expected: -32n },
      { name: "mixed", arguments: [1.75, 40n], expected: 41n },
    ];
    for (const entry of cases) {
      await t.test(`${entry.name} ${entry.arguments.join(", ")}`, () => {
        const run = requiredFunction(instance, `blot:${entry.name}`);
        assert.equal(typeof run, "function");
        if (typeof run !== "function") {
          throw new Error(`missing product test export ${entry.name}`);
        }
        const scope = Number(requiredFunction(instance, "cabi_enter")());
        try {
          // Scope entry writes its administrative record. The source call itself
          // must keep products in locals, including transient intermediate values.
          const before = new Uint8Array(memory.buffer).slice();
          assert.equal(run(scope, ...entry.arguments), entry.expected);
          assert.equal(memory.buffer.byteLength, before.byteLength);
          assert.deepEqual(new Uint8Array(memory.buffer), before);
          assert.equal(
            requiredFunction(instance, "blot:live-allocations")(),
            0,
          );
        } finally {
          requiredFunction(instance, "cabi_leave")(scope);
        }
      });
    }
  });
});

for (
  const [parameterType, argument] of [
    ["(Int, Int)", "[1, 2]"],
    ["[Int]", "(1, 2)"],
  ] as const
) {
  test(`${argument} does not implicitly convert to ${parameterType}`, async () => {
    await withSource(
      `open import "blot:prelude"
let consume :: ${parameterType} -> Int
let consume = fn value => 0
return consume ${argument}
`,
      async (compiler, path) => {
        await assert.rejects(() => compiler.check(path), /BLOT_TYPE_ERROR/);
      },
    );
  });
}
