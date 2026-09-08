import { assertEquals, assertThrows } from "@std/assert";
import {
  CompilerTargetRefusal,
  defaultCompilerTargetPolicy,
  resolveTargetPolicy,
} from "./policy.ts";

Deno.test("default target policy selects the emitted Core Wasm ABI", () => {
  assertEquals(defaultCompilerTargetPolicy.abiMajor, 3);
  assertEquals(resolveTargetPolicy(undefined), {
    abiMajor: 3,
    wasmTarget: "wasm-simd128",
  });
});

Deno.test("an older Core Wasm ABI major is refused", () => {
  assertThrows(
    () =>
      resolveTargetPolicy({
        abiMajor: 1,
        wasmTarget: "wasm-simd128",
      }),
    CompilerTargetRefusal,
    "Blot ABI major 1 is not supported; expected 3",
  );
});
