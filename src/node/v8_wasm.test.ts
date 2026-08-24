import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";

interface TargetManifest {
  readonly abi: {
    readonly coreSpecification: string;
    readonly requiredFeatures: readonly string[];
  };
}

test("V8 executes the Wasm 3 tail-call profile without stack growth", async () => {
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

    const instantiated = await WebAssembly.instantiate(bytes);
    const isEven = instantiated.instance.exports["blot:is_even"] as
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
