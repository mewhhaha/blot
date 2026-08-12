import assert from "node:assert/strict";
import test from "node:test";
import {
  close,
  CompilerInvariantFailure,
  CompilerTargetRefusal,
  defaultCompilerTargetPolicy,
  resolveTargetPolicy,
} from "./backend.ts";

test("compiler target policy names the production boundary", () => {
  assert.deepEqual(defaultCompilerTargetPolicy, {
    abiMajor: 1,
    wasmTarget: "wasm-simd128",
  });
});

test("unsupported target policy is a compiler refusal, not a source diagnostic", () => {
  assert.throws(
    () =>
      resolveTargetPolicy({
        ...defaultCompilerTargetPolicy,
        abiMajor: 2,
      }),
    (error: unknown) => {
      assert.ok(error instanceof CompilerTargetRefusal);
      assert.match(error.message, /ABI major 2/);
      return true;
    },
  );
});

test("invalid Runtime HIR is a compiler invariant failure", () => {
  const policy = resolveTargetPolicy(undefined);
  assert.throws(
    () =>
      close(
        { format: "blot-runtime-hir", schemaVersion: 1 } as never,
        policy,
      ),
    CompilerInvariantFailure,
  );
});
