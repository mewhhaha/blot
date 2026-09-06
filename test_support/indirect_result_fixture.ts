import type { BlotAbiType } from "../src/compiler/backend/runtime/abi.ts";
import { flattenedAbiType } from "../src/compiler/backend/runtime/abi.ts";
import type { CompilerArtifact } from "../src/compiler/session.ts";
import { wasmFixture } from "./wasm_fixture.ts";

/** A static canonical result at address zero; no source compilation is involved. */
export function indirectResultFixture(
  result: BlotAbiType,
  data: Uint8Array,
): CompilerArtifact {
  if (flattenedAbiType(result).length <= 1) {
    throw new Error(
      "indirect result fixture requires more than one flat value",
    );
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify({
    format: "blot-core-wasm",
    abi: {
      major: 2,
      minor: 0,
      memory: "memory32",
      stringEncoding: "utf-8",
      maximumFlatParameters: 16,
      maximumFlatResults: 1,
      memoryExport: "memory",
      reallocExport: "cabi_realloc",
    },
    source: "/fixture.blot",
    imports: [],
    exports: [{
      sourceName: "default",
      name: "result",
      phase: "runtime",
      function: { parameters: [], result },
      postReturn: "post_result",
      effects: [],
      ownership: "owned",
    }],
  }));
  const wasm = wasmFixture({
    manifest: manifestBytes,
    types: [
      { parameters: [], results: ["i32"] },
      { parameters: ["i32"], results: [] },
      { parameters: ["i32", "i32", "i32", "i32"], results: ["i32"] },
    ],
    functions: [
      { type: 0, instructions: [0x41, 0] },
      { type: 1, instructions: [] },
      // No allocation occurs in this fixture; unexpected allocation traps.
      { type: 2, instructions: [0x00] },
    ],
    exports: { result: 0, post_result: 1, cabi_realloc: 2 },
    data,
  });
  return { wasm, manifestBytes, capabilities: [], artifactSource: "compiled" };
}
