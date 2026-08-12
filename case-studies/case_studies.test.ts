import { assertEquals } from "@std/assert";
import {
  prepareGpupaperHir,
  validateLowering,
} from "../src/conformance/gpufuck/compile.ts";
import { checkFile } from "../src/check/mod.ts";
import { evaluateFile } from "../src/run.ts";
import { show } from "../src/comptime/value.ts";
import { validateBlotRuntimeModule } from "../src/runtime/hir.ts";
import { compileBlotRuntimeModulesOnRustWasm } from "../src/compiler/backend/runtime/target.ts";

for (
  const source of [
    "case-studies/grep/main.blot",
    "case-studies/terminal/main.blot",
    "case-studies/agent/main.blot",
    "case-studies/engine/main.blot",
  ]
) {
  Deno.test(`${source} type checks and lowers`, async () => {
    await checkFile(source);
    await validateLowering(source);
  });
}

Deno.test("Text.contains searches Unicode text", async () => {
  const directory = await Deno.makeTempDir();
  const source = `${directory}/contains.blot`;
  await Deno.writeTextFile(
    source,
    `open @import "blot:prelude" ()
return Text.contains "GPU 😀 frontend" "😀 front"
`,
  );
  const value = await evaluateFile(source, { write: () => {} });
  assertEquals(show(value), "#True");
});

Deno.test("terminal preserves its dynamic Text dependency in gpupaper HIR", async () => {
  const hir = await prepareGpupaperHir("case-studies/terminal/main.blot");
  const operations = hir.functions[0].blocks.flatMap((block) =>
    block.operations
  );
  const read = operations.find((operation) =>
    operation.kind === "host.call" && operation.capability === "Terminal" &&
    operation.operation === "read_line"
  );
  const append = operations.find((operation) =>
    operation.kind === "text.append" && operation.operands[1] === read?.result
  );
  const write = operations.find((operation) =>
    operation.kind === "host.call" && operation.capability === "Terminal" &&
    operation.operation === "write" && operation.operands[0] === append?.result
  );
  if (
    read?.kind !== "host.call" || append?.kind !== "text.append" ||
    write?.kind !== "host.call"
  ) {
    throw new Error("gpupaper HIR omitted the dynamic Text dependency chain");
  }
  assertEquals(append.operands[1], read.result);
  assertEquals(write.operands, [append.result]);
});

Deno.test("terminal gpupaper Wasm preserves both runtime branches", async () => {
  const hir = validateBlotRuntimeModule(
    await prepareGpupaperHir("case-studies/terminal/main.blot"),
  );
  const batch = await compileBlotRuntimeModulesOnRustWasm([hir]);
  const artifact = batch.artifacts[0];
  if (artifact === undefined) throw new Error("gpupaper omitted Rust/Wasm");
  const compiled = await WebAssembly.compile(artifact.wasm as BufferSource);
  for (const input of ["", "Łucja 🦆"]) {
    const writes: string[] = [];
    const instance = await WebAssembly.instantiate(compiled, {
      "blot:host/Terminal": {
        read_line(resultPointer: number) {
          const memory = instance.exports.memory;
          const realloc = instance.exports.cabi_realloc;
          if (!(memory instanceof WebAssembly.Memory)) {
            throw new Error("gpupaper omitted canonical memory");
          }
          if (!(realloc instanceof Function)) {
            throw new Error("gpupaper omitted cabi_realloc");
          }
          const encoded = new TextEncoder().encode(input);
          const pointer = Number(realloc(0, 0, 1, encoded.length));
          new Uint8Array(memory.buffer).set(encoded, pointer);
          const view = new DataView(memory.buffer);
          view.setUint32(resultPointer, pointer, true);
          view.setUint32(resultPointer + 4, encoded.length, true);
        },
        write(pointer: number, length: number) {
          const memory = instance.exports.memory;
          if (!(memory instanceof WebAssembly.Memory)) {
            throw new Error("gpupaper omitted canonical memory");
          }
          writes.push(new TextDecoder("utf-8", { fatal: true }).decode(
            new Uint8Array(memory.buffer, pointer, length),
          ));
        },
      },
    });
    const run = instance.exports["blot:default"];
    if (!(run instanceof Function)) {
      throw new Error("gpupaper omitted blot:default");
    }
    run();
    assertEquals(writes, [
      "What is your name?",
      input === "" ? "Hello, stranger." : `Hello, ${input}`,
    ]);
  }
});
