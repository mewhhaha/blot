// The guest side of the browser host.
//
// Blot Core Wasm ABI 1 calls host effects synchronously, and a browser paces
// drawing with `requestAnimationFrame`, which is not something a synchronous
// call can wait for. So the module runs here, off the main thread, where
// blocking is allowed: `Host.frame` parks on `Atomics.wait` until the page's
// animation frame bumps a shared counter.
//
// That is the whole reconciliation. The program keeps its own frame loop and
// the page keeps its refresh rate; neither has to know about the other.

/** Shared with the page: [0] tick, [1] axis, [2] running. */
let shared = null;
let lastTick = 0;
let batch = [];

let instance = null;

const decoder = new TextDecoder("utf-8", { fatal: true });

function memory() {
  return instance.exports.memory.buffer;
}

function readText(pointer, length) {
  return decoder.decode(new Uint8Array(memory(), pointer, length));
}

const imports = {
  "blot:host/Canvas": {
    clear() {
      batch = [];
    },
    // Canonical field order is alphabetical, so a record parameter arrives
    // flattened as colour, h, w, x, y. `docs/abi.md` is the authority on that
    // order; it is not the order the program wrote them in.
    fill(colourPointer, colourLength, h, w, x, y) {
      batch.push({
        colour: readText(colourPointer, colourLength),
        h: Number(h),
        w: Number(w),
        x: Number(x),
        y: Number(y),
      });
    },
    present() {
      self.postMessage({ kind: "frame", rects: batch });
    },
  },
  "blot:host/Host": {
    axis() {
      return BigInt(Atomics.load(shared, 1));
    },
    frame() {
      // Park until the page has drawn. `Atomics.wait` is why this runs in a
      // worker at all — on the main thread it would deadlock the page it is
      // waiting for.
      while (Atomics.load(shared, 0) === lastTick) {
        if (Atomics.load(shared, 2) === 0) return 0n;
        Atomics.wait(shared, 0, lastTick, 100);
      }
      lastTick = Atomics.load(shared, 0);
      return BigInt(Atomics.load(shared, 2));
    },
  },
};

self.onmessage = async (event) => {
  const message = event.data;
  if (message.kind !== "start") return;

  shared = new Int32Array(message.shared);
  lastTick = Atomics.load(shared, 0);

  const module = await WebAssembly.compile(message.wasm);
  instance = await WebAssembly.instantiate(module, imports);

  const main = instance.exports[message.export];
  const frames = main();
  self.postMessage({ kind: "done", frames: Number(frames) });
};
