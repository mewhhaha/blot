import { assertEquals } from "@std/assert";
import { Worker } from "node:worker_threads";
import { checkFile } from "../src/check.ts";
import { Compiler } from "../src/compiler/session.ts";
import { evaluateFile, show } from "../src/run.ts";

for (
  const source of [
    "case-studies/grep/main.blot",
    "case-studies/terminal/main.blot",
    "case-studies/agent/main.blot",
    "case-studies/engine/main.blot",
    "case-studies/engine/game_loop.blot",
  ]
) {
  Deno.test(`${source} type checks and lowers`, async () => {
    await checkFile(source);
    const compiler = await Compiler.create();
    try {
      await compiler.prepare(source);
    } finally {
      compiler.destroy();
    }
  });
}

Deno.test("game_loop.blot streams every shrubbery off the main thread", async () => {
  const compiler = await Compiler.create();
  let artifact;
  try {
    artifact = await compiler.compile("case-studies/engine/game_loop.blot");
  } finally {
    compiler.destroy();
  }
  const observe = async (selection: number) => {
    const worker = new Worker(
      new URL("./engine/game_loop_test_worker.mjs", import.meta.url),
      { workerData: { wasm: artifact.wasm, selection } },
    );
    let observation;
    try {
      observation = await new Promise<{
        readonly frames: bigint;
        readonly streamedBatches: number;
        readonly uploadedBatches: number;
        readonly redraws: number;
      }>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
    } finally {
      await worker.terminate();
    }
    return { selection, observation };
  };
  const observations = [];
  for (const selection of [1, 2, 3, 4, 5]) {
    observations.push(await observe(selection));
  }
  for (const { selection, observation } of observations) {
    assertEquals(observation.frames, 1n, `selection ${selection} frame count`);
    assertEquals(
      observation.streamedBatches > 0,
      true,
      `selection ${selection} stream`,
    );
    assertEquals(
      observation.uploadedBatches > 0,
      true,
      `selection ${selection} upload`,
    );
    assertEquals(observation.redraws, 1, `selection ${selection} redraw`);
  }
});

Deno.test("Text.contains searches Unicode text", async () => {
  const directory = await Deno.makeTempDir();
  const source = `${directory}/contains.blot`;
  await Deno.writeTextFile(
    source,
    `open import "blot:prelude"
return Text.contains "GPU 😀 frontend" "😀 front"
`,
  );
  const value = await evaluateFile(source, { write: () => {} });
  assertEquals(show(value), "#True");

  await Deno.writeTextFile(
    source,
    `open import "blot:prelude"
return {
  .unicode = Text.contains "GPU 😀 frontend" "😀 front";
  .absent = Text.contains "abc" "z";
  .empty = Text.contains "abc" "";
}
`,
  );
  const compiler = await Compiler.create();
  const artifact = await compiler.compile(source);
  compiler.destroy();
  const module = await WebAssembly.compile(artifact.wasm as BufferSource);
  const instance = await WebAssembly.instantiate(module);
  const call = (name: string) => {
    const exported = instance.exports[`blot:${name}`];
    if (typeof exported !== "function") {
      throw new Error(`missing blot:${name}`);
    }
    return exported();
  };
  assertEquals(call("unicode"), 1);
  assertEquals(call("absent"), 0);
  assertEquals(call("empty"), 1);
});

Deno.test("terminal preserves its dynamic Text dependency in Runtime HIR", async () => {
  const compiler = await Compiler.create();
  const hir = await compiler.prepare("case-studies/terminal/main.blot");
  compiler.destroy();
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
    throw new Error("Runtime HIR omitted the dynamic Text dependency chain");
  }
  assertEquals(append.operands[1], read.result);
  assertEquals(write.operands, [append.result]);
});

Deno.test("terminal emitted Wasm preserves both runtime branches", async () => {
  const compiler = await Compiler.create();
  const artifact = await compiler.compile("case-studies/terminal/main.blot");
  compiler.destroy();
  const compiled = await WebAssembly.compile(artifact.wasm as BufferSource);
  for (const input of ["", "Łucja 🦆"]) {
    const writes: string[] = [];
    const instance = await WebAssembly.instantiate(compiled, {
      "blot:host/Terminal": {
        read_line(resultPointer: number) {
          const memory = instance.exports.memory;
          const realloc = instance.exports.cabi_realloc;
          if (!(memory instanceof WebAssembly.Memory)) {
            throw new Error("emitted Wasm omitted canonical memory");
          }
          if (!(realloc instanceof Function)) {
            throw new Error("emitted Wasm omitted cabi_realloc");
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
            throw new Error("emitted Wasm omitted canonical memory");
          }
          writes.push(new TextDecoder("utf-8", { fatal: true }).decode(
            new Uint8Array(memory.buffer, pointer, length),
          ));
        },
      },
    });
    const run = instance.exports["blot:default"];
    if (!(run instanceof Function)) {
      throw new Error("emitted Wasm omitted blot:default");
    }
    run();
    assertEquals(writes, [
      "What is your name?",
      input === "" ? "Hello, stranger." : `Hello, ${input}`,
    ]);
  }
});
