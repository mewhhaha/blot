import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "./session.ts";

const shaderBodySentinel = new TextEncoder().encode(
  "SHADER_BODY_SHOULD_NOT_ESCAPE_7F3A",
);

test("compile-time include transforms can omit source text", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile("examples/shader_metadata.blot");
    const wasm = Uint8Array.from(artifact.wasm);
    assert.equal(containsBytes(wasm, shaderBodySentinel), false);
  } finally {
    compiler.destroy();
  }
});

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0) return true;
  for (
    let start = 0;
    start + needle.byteLength <= haystack.byteLength;
    start += 1
  ) {
    let matches = true;
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}
