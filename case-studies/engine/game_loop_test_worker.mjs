import { parentPort, workerData as executionInput } from "node:worker_threads";

if (parentPort === null) {
  throw new Error("game loop test worker requires a parent port");
}
if (!(executionInput.module instanceof WebAssembly.Module)) {
  throw new Error("game loop test worker requires a compiled Wasm module");
}
if (!Number.isInteger(executionInput.selection)) {
  throw new Error(
    `game loop test worker requires an integer selection, received ${executionInput.selection}`,
  );
}

let remainingFrames = 1;
let streamedBatches = 0;
let uploadedBatches = 0;
let redraws = 0;
const instance = await WebAssembly.instantiate(executionInput.module, {
  "blot:host/Canvas": {
    clear() {},
    tri() {},
    sprite() {},
    present() {},
  },
  "blot:host/View": {
    yaw: () => 0n,
    pitch: () => 0n,
    distance: () => 1n,
    lens: () => 0n,
  },
  "blot:host/VoxelCanvas": {
    enabled: () => 1,
    clear() {},
    voxel() {},
    present() {
      uploadedBatches += 1;
    },
    redraw() {
      redraws += 1;
    },
  },
  "blot:host/Host": {
    option() {},
    seed: () => 424242n,
    selected() {},
    selection: () => BigInt(executionInput.selection),
    frame() {
      const current = remainingFrames;
      remainingFrames -= 1;
      return BigInt(current);
    },
  },
  "blot:host/Stream": {
    batch_size: () => 256n,
    "yield"() {
      streamedBatches += 1;
    },
  },
});
const run = instance.exports["blot:default"];
if (!(run instanceof Function)) {
  throw new Error("game_loop.blot omitted blot:default");
}
parentPort.postMessage({
  frames: run(),
  streamedBatches,
  uploadedBatches,
  redraws,
});
