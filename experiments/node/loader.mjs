const aliases = new Map([
  ["@std/path", new URL("./std_path.ts", import.meta.url).href],
  [
    "@mewhhaha/baba/runtime/webgpu",
    new URL("./baba_runtime.ts", import.meta.url).href,
  ],
  [
    "@mewhhaha/gpupaper",
    new URL("../../vendor/gpupaper/mod.ts", import.meta.url).href,
  ],
]);

export async function resolve(specifier, context, nextResolve) {
  const alias = aliases.get(specifier);
  if (alias !== undefined) {
    return { url: alias, shortCircuit: true };
  }
  return await nextResolve(specifier, context);
}
