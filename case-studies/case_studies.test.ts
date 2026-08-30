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

Deno.test("game_loop.blot streams exact shrubbery geometry once", async () => {
  const compiler = await Compiler.create();
  let artifact;
  try {
    artifact = await compiler.compile("case-studies/engine/game_loop.blot");
  } finally {
    compiler.destroy();
  }
  const module = await WebAssembly.compile(Uint8Array.from(artifact.wasm));
  const observe = async (selection: number) => {
    const worker = new Worker(
      new URL("./engine/game_loop_test_worker.mjs", import.meta.url),
      { workerData: { module, selection } },
    );
    let observation;
    try {
      observation = await new Promise<{
        readonly frames: bigint;
        readonly streamedBatches: number;
        readonly uploadedBatches: number;
        readonly uploadedVoxels: number;
        readonly voxelCalls: number;
        readonly geometryHash: bigint;
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
  const expectedShrubberies = [
    { selection: 1, voxels: 8_581, hash: 8_352_871_537_366_778_277n },
    { selection: 2, voxels: 5_402, hash: 581_267_836_942_678_797n },
    { selection: 3, voxels: 1_865, hash: 891_817_835_035_434_143n },
    { selection: 4, voxels: 160, hash: 5_278_148_221_706_545_873n },
    { selection: 5, voxels: 1_154, hash: 11_831_599_231_652_038_555n },
  ];
  const observations = [];
  for (const expected of expectedShrubberies) {
    observations.push({ expected, ...await observe(expected.selection) });
  }
  for (const { expected, selection, observation } of observations) {
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
    assertEquals(
      observation.voxelCalls,
      expected.voxels,
      `selection ${selection} transfers each voxel once`,
    );
    assertEquals(
      observation.uploadedVoxels,
      expected.voxels,
      `selection ${selection} final voxel count`,
    );
    assertEquals(
      observation.geometryHash,
      expected.hash,
      `selection ${selection} geometry`,
    );
    assertEquals(observation.redraws, 1, `selection ${selection} redraw`);
  }

  const mixed = observations.find(({ expected }) => expected.selection === 1);
  if (mixed === undefined) {
    throw new Error("game-loop observations omitted mixed shrubbery");
  }
  const shared = new Int32Array(
    new SharedArrayBuffer(7 * Int32Array.BYTES_PER_ELEMENT),
  );
  Atomics.store(shared, 1, 1);
  Atomics.store(shared, 6, mixed.selection);
  const guest = new Worker(
    new URL("./engine/browser_worker_test_adapter.mjs", import.meta.url),
  );
  let receivedVoxels = 0;
  let receivedBatches = 0;
  let firstBatchReset: boolean | undefined;
  let laterBatchReset = false;
  const settled = new Promise<void>((resolve, reject) => {
    guest.once("error", reject);
    guest.on("message", (message) => {
      if (
        typeof message !== "object" || message === null ||
        !("kind" in message)
      ) {
        reject(new Error("game-loop worker emitted a malformed message"));
        return;
      }
      if (message.kind === "voxel-frame") {
        if (
          !("voxels" in message) || !Array.isArray(message.voxels) ||
          !("reset" in message) || typeof message.reset !== "boolean"
        ) {
          reject(new Error("game-loop worker emitted a malformed voxel frame"));
          return;
        }
        receivedVoxels += message.voxels.length;
        receivedBatches += 1;
        if (firstBatchReset === undefined) firstBatchReset = message.reset;
        else if (message.reset) laterBatchReset = true;
      }
      if (message.kind === "settled") resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    guest.once("error", reject);
    guest.once("message", (message) => {
      if (
        typeof message !== "object" || message === null ||
        !("kind" in message) || message.kind !== "ready"
      ) {
        reject(new Error("game-loop worker test adapter did not become ready"));
        return;
      }
      resolve();
    });
  });
  const tick = setInterval(() => {
    Atomics.add(shared, 0, 1);
    Atomics.notify(shared, 0);
  }, 1);
  try {
    guest.postMessage({
      kind: "start",
      module,
      shared: shared.buffer,
      export: "blot:default",
      scene: [],
    });
    await settled;
  } finally {
    clearInterval(tick);
    Atomics.store(shared, 1, 0);
    Atomics.add(shared, 0, 1);
    Atomics.notify(shared, 0);
    await guest.terminate();
  }
  assertEquals(firstBatchReset, true, "first streamed batch resets the scene");
  assertEquals(laterBatchReset, false, "later batches append to the scene");
  assertEquals(
    receivedBatches,
    mixed.observation.uploadedBatches,
    "worker preserves the source batch count",
  );
  assertEquals(
    receivedVoxels,
    mixed.observation.uploadedVoxels,
    "worker sends each generated voxel once",
  );
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
