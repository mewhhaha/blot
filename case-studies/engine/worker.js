// The guest side of the browser host.
//
// Blot Core Wasm ABI 2 calls host effects synchronously, and a browser paces
// drawing with `requestAnimationFrame`, which is not something a synchronous
// call can wait for. So the module runs here, off the main thread, where
// blocking is allowed: `Host.frame` parks on `Atomics.wait` until the page's
// animation frame bumps a shared counter.
//
// That is the whole reconciliation. The program keeps its own frame loop and
// the page keeps its refresh rate; neither has to know about the other.

/**
 * Shared with the page, so the guest reads input without a round trip:
 * [0] tick, [1] running, [2] yaw, [3] pitch, [4] distance, [5] lens,
 * [6] asset generation.
 */
const TICK = 0;
const RUNNING = 1;
const YAW = 2;
const PITCH = 3;
const DISTANCE = 4;
const LENS = 5;
const GENERATION = 6;

let shared = null;
let lastTick = 0;

/** The scene, sent by the page and replaced whenever it changes on disk. */
let scene = [];
let batch = [];
let instance = null;

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

const imports = {
  "blot:host/Canvas": {
    clear() {
      batch = [];
    },
    // A record parameter arrives flattened in *canonical* field order, which is
    // alphabetical and not the order the program wrote them. `docs/abi.md` is
    // the authority; getting this wrong silently transposes the geometry.
    tri(ax, ay, bx, by, colorBlue, colorGreen, colorRed, cx, cy, depth, shade) {
      batch.push({
        kind: "tri",
        ax: Number(ax),
        ay: Number(ay),
        bx: Number(bx),
        by: Number(by),
        cx: Number(cx),
        cy: Number(cy),
        depth: Number(depth),
        shade: Number(shade),
        color: {
          red: Number(colorRed),
          green: Number(colorGreen),
          blue: Number(colorBlue),
        },
      });
    },
    sprite(depth, size, texturePointer, textureLength, x, y) {
      batch.push({
        kind: "sprite",
        depth: Number(depth),
        size: Number(size),
        texture: readText(texturePointer, textureLength),
        x: Number(x),
        y: Number(y),
      });
    },
    present() {
      self.postMessage({ kind: "frame", draws: batch });
    },
  },

  "blot:host/View": {
    yaw: () => BigInt(Atomics.load(shared, YAW)),
    pitch: () => BigInt(Atomics.load(shared, PITCH)),
    distance: () => BigInt(Atomics.load(shared, DISTANCE)),
    lens: () => BigInt(Atomics.load(shared, LENS)),
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
    frame() {
      // Park until the page has drawn. `Atomics.wait` is why this runs in a
      // worker at all — on the main thread it would deadlock the page it is
      // waiting for.
      while (Atomics.load(shared, TICK) === lastTick) {
        if (Atomics.load(shared, RUNNING) === 0) return 0n;
        Atomics.wait(shared, TICK, lastTick, 100);
      }
      lastTick = Atomics.load(shared, TICK);
      return BigInt(Atomics.load(shared, RUNNING));
    },
  },
};

self.onmessage = async (event) => {
  const message = event.data;

  // A scene reload does not touch the module. The page bumps the generation in
  // shared memory and the guest reloads on its own next frame.
  if (message.kind === "scene") {
    scene = message.scene;
    return;
  }

  if (message.kind !== "start") return;

  shared = new Int32Array(message.shared);
  lastTick = Atomics.load(shared, TICK);
  scene = message.scene;

  const module = await WebAssembly.compile(message.wasm);
  instance = await WebAssembly.instantiate(module, imports);

  const frames = instance.exports[message.export]();
  self.postMessage({ kind: "done", frames: Number(frames) });
};
