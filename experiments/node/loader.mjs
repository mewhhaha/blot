const aliases = new Map([
  ["@std/path", new URL("./std_path.ts", import.meta.url).href],
  [
    "@mewhhaha/baba/runtime/webgpu",
    new URL("./baba_runtime.ts", import.meta.url).href,
  ],
  [
    "@mewhhaha/baba/runtime/generated-wasm",
    new URL("../../vendor/baba/src/runtime/generated_wasm.ts", import.meta.url).href,
  ],
  [
    "@mewhhaha/gpupaper",
    new URL("../../vendor/gpupaper/mod.ts", import.meta.url).href,
  ],
  [
    "@mewhhaha/gpupaper/core",
    new URL("../../vendor/gpupaper/src/core.ts", import.meta.url).href,
  ],
  [
    "@mewhhaha/gpupaper/gpu",
    new URL("../../vendor/gpupaper/gpu.ts", import.meta.url).href,
  ],
  [
    "@mewhhaha/gpupaper/rewrite",
    new URL("../../vendor/gpupaper/rewrite.ts", import.meta.url).href,
  ],
  [
    "@mewhhaha/gpupaper/runtime",
    new URL("../../vendor/gpupaper/src/runtime.ts", import.meta.url).href,
  ],
  [
    "@mewhhaha/gpupaper/wasm",
    new URL("../../vendor/gpupaper/src/wasm.ts", import.meta.url).href,
  ],
]);

export async function resolve(specifier, context, nextResolve) {
  const alias = aliases.get(specifier);
  if (alias !== undefined) {
    return { url: alias, shortCircuit: true };
  }
  return await nextResolve(specifier, context);
}
