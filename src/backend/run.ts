// Instantiating what the backend produced.
//
// The GPU evaluator agreeing is a cross-check on the lowering; this is the
// actual artifact. They are separate on purpose — a lowering can satisfy one
// and not the other, and only one of them is what ships.

export interface Ran {
  readonly value: unknown;
  readonly exports: readonly string[];
}

export async function runWasm(wasm: Uint8Array, entry = "main"): Promise<Ran> {
  const { instance } = await WebAssembly.instantiate(wasm as BufferSource, {});
  const exports = Object.keys(instance.exports);
  const main = instance.exports[entry];
  if (typeof main !== "function") {
    return { value: null, exports };
  }
  return { value: (main as () => unknown)(), exports };
}
