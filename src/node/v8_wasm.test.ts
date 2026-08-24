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
      resolve("experiments/generated-code/programs/tail_recursion.blot"),
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
    const sumTo = instantiated.instance.exports["blot:sum_to"] as
      | ((count: bigint) => bigint)
      | undefined;
    assert.equal(typeof sumTo, "function");
    if (sumTo === undefined) {
      throw new Error("tail-recursion artifact omitted blot:sum_to");
    }
    assert.equal(sumTo(250_000n), 31_250_125_000n);
  } finally {
    compiler.destroy();
  }
});
