import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";

interface TargetManifest {
  readonly abi: {
    readonly coreSpecification: string;
    readonly requiredFeatures: readonly string[];
    readonly optimizationFeatures: readonly string[];
  };
}

test("V8 executes the Wasm 3 target and accepts branch metadata", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      resolve(
        "experiments/generated-code/programs/mutual_tail_recursion.blot",
      ),
    );
    const bytes = Uint8Array.from(artifact.wasm);
    assert.equal(WebAssembly.validate(bytes), true);

    const manifest = JSON.parse(
      new TextDecoder().decode(artifact.manifestBytes),
    ) as TargetManifest;
    assert.equal(manifest.abi.coreSpecification, "3.0");
    assert.ok(manifest.abi.requiredFeatures.includes("bulk-memory"));
    assert.ok(manifest.abi.requiredFeatures.includes("tail-call"));
    assert.ok(
      manifest.abi.optimizationFeatures.includes("branch-hinting"),
    );

    const module = await WebAssembly.compile(bytes);
    const branchHints = WebAssembly.Module.customSections(
      module,
      "metadata.code.branch_hint",
    );
    assert.equal(branchHints.length, 1);
    assert.ok(branchHints[0].byteLength > 0);

    const instance = await WebAssembly.instantiate(module);
    const isEven = instance.exports["blot:is_even"] as
      | ((remaining: bigint) => bigint)
      | undefined;
    assert.equal(typeof isEven, "function");
    if (isEven === undefined) {
      throw new Error("mutual-tail-recursion artifact omitted blot:is_even");
    }
    assert.equal(isEven(250_000n), 1n);
    assert.equal(isEven(250_001n), 0n);
  } finally {
    compiler.destroy();
  }
});

test("cabi_realloc grows the active allocation geometrically", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(resolve("examples/minimal.blot"));
    const instance = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
    );
    const realloc = instance.instance.exports.cabi_realloc as
      | ((
        oldPointer: number,
        oldSize: number,
        alignment: number,
        newSize: number,
      ) => number)
      | undefined;
    const memory = instance.instance.exports.memory as
      | WebAssembly.Memory
      | undefined;
    assert.equal(typeof realloc, "function");
    assert.ok(memory instanceof WebAssembly.Memory);
    if (realloc === undefined || memory === undefined) {
      throw new Error("minimal artifact omitted its canonical allocator");
    }

    const first = realloc(0, 0, 8, 8);
    new DataView(memory.buffer).setBigInt64(first, 0x102030405060708n, true);
    const withinInitialCapacity = realloc(first, 8, 8, 16);
    const grownAtHeapTop = realloc(withinInitialCapacity, 16, 8, 17);
    assert.equal(withinInitialCapacity, first);
    assert.equal(grownAtHeapTop, first);

    realloc(0, 0, 8, 16);
    const moved = realloc(grownAtHeapTop, 17, 8, 40);
    assert.notEqual(moved, first);
    assert.equal(
      new DataView(memory.buffer).getBigInt64(moved, true),
      0x102030405060708n,
    );
  } finally {
    compiler.destroy();
  }
});
