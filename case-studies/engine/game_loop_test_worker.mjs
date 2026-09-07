import assert from "node:assert/strict";
import { treeGeometry } from "./tree_geometry_reference.mjs";
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

let treeOracle = [];
if (executionInput.selection === 1) {
  treeOracle = [
    ...treeGeometry("oak", 424242 + 1729, [-10, 0, -4]),
    ...treeGeometry("fir", 424242 + 3571, [12, 0, 10]),
  ];
} else if (executionInput.selection === 2) {
  treeOracle = treeGeometry("oak", 424242 + 101);
} else if (executionInput.selection === 3) {
  treeOracle = treeGeometry("fir", 424242 + 503);
}
let remainingFrames = 1;
let streamedBatches = 0;
let uploadedBatches = 0;
let redraws = 0;
let uploadedVoxels = 0;
let voxelCalls = 0;
let geometryHash = 14695981039346656037n;
const hashVoxelField = (value) => {
  geometryHash ^= BigInt.asUintN(64, value);
  geometryHash = BigInt.asUintN(64, geometryHash * 1099511628211n);
};
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
    clear() {
      uploadedVoxels = 0;
    },
    voxel(colorBlue, colorGreen, colorRed, scale, x, y, z) {
      if (voxelCalls < treeOracle.length) {
        assert.deepEqual(
          [x, y, z, scale, colorRed, colorGreen, colorBlue].map(Number),
          treeOracle[voxelCalls],
          `selection ${executionInput.selection} tree voxel ${voxelCalls}`,
        );
      }
      uploadedVoxels += 1;
      voxelCalls += 1;
      hashVoxelField(x);
      hashVoxelField(y);
      hashVoxelField(z);
      hashVoxelField(scale);
      hashVoxelField(colorRed);
      hashVoxelField(colorGreen);
      hashVoxelField(colorBlue);
    },
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

const frames = run();
assert.ok(
  voxelCalls >= treeOracle.length,
  "every reference tree voxel was emitted",
);
if (executionInput.selection === 2 || executionInput.selection === 3) {
  assert.equal(
    voxelCalls,
    treeOracle.length,
    "standalone trees contain no extra voxels",
  );
}
parentPort.postMessage({
  frames,
  streamedBatches,
  uploadedBatches,
  uploadedVoxels,
  voxelCalls,
  geometryHash,
  redraws,
});
