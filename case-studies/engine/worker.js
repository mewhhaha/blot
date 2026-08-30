// The guest side of the browser and raw Deno Desktop hosts.
//
// Blot Core Wasm ABI 2 calls host effects synchronously, while drawing is paced
// asynchronously, which is not something a synchronous call can wait for. So
// the module runs here, off the main thread, where blocking is allowed:
// `Host.frame` parks on `Atomics.wait` until the rendering host bumps a shared
// counter.
//
// That is the whole reconciliation. The program keeps its own frame loop and
// the host keeps its refresh rate; neither has to know about the other.

/**
 * Shared with the rendering host, so the guest reads input without a round
 * trip:
 * [0] tick, [1] running, [2] yaw, [3] pitch, [4] distance, [5] lens,
 * [6] asset generation for the ECS entry point, or shrubbery selection for
 * the game-loop entry point.
 */
const TICK = 0;
const RUNNING = 1;
const YAW = 2;
const PITCH = 3;
const DISTANCE = 4;
const LENS = 5;
const GENERATION = 6;
const SELECTION = 6;
const SCREEN_SCALE = 256;

let shared = null;
let lastTick = 0;

/** The scene, sent by the page and replaced whenever it changes on disk. */
let scene = [];
let projectedBatch = [];
let voxelBatch = [];
let voxelResetPending = false;
let instance = null;
let settled = false;
let renderedDistance = 0;
let renderedLens = 0;

const decoder = new TextDecoder("utf-8", { fatal: true });

function readText(pointer, length) {
  return decoder.decode(
    new Uint8Array(instance.exports.memory.buffer, pointer, length),
  );
}

function writeText(resultPointer, value) {
  const bytes = new TextEncoder().encode(value);
  const pointer = Number(instance.exports.cabi_realloc(0, 0, 1, bytes.length));
  new Uint8Array(instance.exports.memory.buffer, pointer, bytes.length)
    .set(bytes);
  const view = new DataView(instance.exports.memory.buffer);
  view.setUint32(resultPointer, pointer, true);
  view.setUint32(resultPointer + 4, bytes.length, true);
}

function waitForFrame() {
  while (Atomics.load(shared, TICK) === lastTick) {
    if (Atomics.load(shared, RUNNING) === 0) return 0n;
    Atomics.wait(shared, TICK, lastTick, 100);
  }
  lastTick = Atomics.load(shared, TICK);
  return BigInt(Atomics.load(shared, RUNNING));
}

const imports = {
  "blot:host/Canvas": {
    clear() {
      projectedBatch = [];
    },
    // A record parameter arrives flattened in *canonical* field order, which is
    // alphabetical and not the order the program wrote them. `docs/abi.md` is
    // the authority; getting this wrong silently transposes the geometry.
    tri(
      ax,
      ay,
      az,
      bx,
      by,
      bz,
      colorBlue,
      colorGreen,
      colorRed,
      cx,
      cy,
      cz,
      shade,
    ) {
      projectedBatch.push({
        kind: "tri",
        ax: Number(ax) / SCREEN_SCALE,
        ay: Number(ay) / SCREEN_SCALE,
        az: Number(az),
        bx: Number(bx) / SCREEN_SCALE,
        by: Number(by) / SCREEN_SCALE,
        bz: Number(bz),
        cx: Number(cx) / SCREEN_SCALE,
        cy: Number(cy) / SCREEN_SCALE,
        cz: Number(cz),
        depth: (Number(az) + Number(bz) + Number(cz)) / 3,
        shade: Number(shade),
        color: {
          red: Number(colorRed),
          green: Number(colorGreen),
          blue: Number(colorBlue),
        },
      });
    },
    sprite(depth, size, texturePointer, textureLength, x, y) {
      projectedBatch.push({
        kind: "sprite",
        depth: Number(depth),
        size: Number(size) / SCREEN_SCALE,
        texture: readText(texturePointer, textureLength),
        x: Number(x) / SCREEN_SCALE,
        y: Number(y) / SCREEN_SCALE,
      });
    },
    present() {
      self.postMessage({
        kind: "frame",
        draws: projectedBatch,
        distance: renderedDistance,
        lens: renderedLens,
      });
    },
  },

  "blot:host/View": {
    yaw: () => BigInt(Atomics.load(shared, YAW)),
    pitch: () => BigInt(Atomics.load(shared, PITCH)),
    distance() {
      renderedDistance = Atomics.load(shared, DISTANCE);
      return BigInt(renderedDistance);
    },
    lens() {
      renderedLens = Atomics.load(shared, LENS);
      return BigInt(renderedLens);
    },
  },

  "blot:host/VoxelCanvas": {
    enabled: () => 1,
    clear() {
      voxelBatch = [];
      voxelResetPending = true;
    },
    // Canonical record order: color.blue, color.green, color.red, scale,
    // x, y, z.
    voxel(colorBlue, colorGreen, colorRed, scale, x, y, z) {
      voxelBatch.push({
        kind: "voxel",
        x: Number(x) / 1000,
        y: Number(y) / 1000,
        z: Number(z) / 1000,
        scale: Number(scale) / 1000,
        color: {
          red: Number(colorRed),
          green: Number(colorGreen),
          blue: Number(colorBlue),
        },
      });
    },
    present() {
      self.postMessage({
        kind: "voxel-frame",
        voxels: voxelBatch,
        reset: voxelResetPending,
        distance: Atomics.load(shared, DISTANCE),
        lens: Atomics.load(shared, LENS),
      });
      voxelBatch = [];
      voxelResetPending = false;
    },
    redraw() {
      self.postMessage({ kind: "redraw" });
    },
  },

  "blot:host/Assets": {
    generation: () => BigInt(Atomics.load(shared, GENERATION)),
    count: () => BigInt(scene.length),
    entry(id, resultPointer) {
      const entity = scene[Number(id)];
      // Canonical order again: color.blue, color.green, color.red, kind, scale,
      // spin, texture, x, y, z. Nested records flatten in their own canonical
      // field order.
      const view = new DataView(instance.exports.memory.buffer);
      view.setBigInt64(resultPointer, BigInt(entity.color.blue), true);
      view.setBigInt64(resultPointer + 8, BigInt(entity.color.green), true);
      view.setBigInt64(resultPointer + 16, BigInt(entity.color.red), true);
      view.setBigInt64(resultPointer + 24, BigInt(entity.kind), true);
      view.setBigInt64(resultPointer + 32, BigInt(entity.scale), true);
      view.setBigInt64(resultPointer + 40, BigInt(entity.spin), true);
      writeText(resultPointer + 48, entity.texture);
      view.setBigInt64(resultPointer + 56, BigInt(entity.x), true);
      view.setBigInt64(resultPointer + 64, BigInt(entity.y), true);
      view.setBigInt64(resultPointer + 72, BigInt(entity.z), true);
    },
  },

  "blot:host/Host": {
    option(key, namePointer, nameLength) {
      self.postMessage({
        kind: "option",
        key: Number(key),
        name: readText(namePointer, nameLength),
      });
    },
    seed: () => 424242n,
    selected(key, namePointer, nameLength) {
      self.postMessage({
        kind: "selected",
        key: Number(key),
        name: readText(namePointer, nameLength),
      });
    },
    selection: () => BigInt(Atomics.load(shared, SELECTION)),
    frame() {
      const remaining = waitForFrame();
      if (!settled) {
        settled = true;
        self.postMessage({ kind: "settled" });
      }
      return remaining;
    },
  },

  "blot:host/Stream": {
    batch_size: () => 256n,
    yield() {
      waitForFrame();
    },
  },
};

self.onmessage = async (event) => {
  const message = event.data;

  // A scene reload does not touch the module. The host bumps the generation in
  // shared memory and the guest reloads on its own next frame.
  if (message.kind === "scene") {
    scene = message.scene;
    return;
  }

  if (message.kind !== "start") return;

  shared = new Int32Array(message.shared);
  lastTick = Atomics.load(shared, TICK);
  scene = message.scene;

  if (!(message.module instanceof WebAssembly.Module)) {
    throw new Error("engine worker requires a compiled Wasm module");
  }
  instance = await WebAssembly.instantiate(message.module, imports);

  const frames = instance.exports[message.export]();
  self.postMessage({ kind: "done", frames: Number(frames) });
};
