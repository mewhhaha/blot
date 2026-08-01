import { build } from "../src/backend/compile.ts";

type Study =
  | {
    readonly kind: "grep";
    readonly source: "case-studies/grep/main.blot";
    readonly pattern: string;
    readonly lines: readonly string[];
  }
  | {
    readonly kind: "terminal";
    readonly source: "case-studies/terminal/main.blot";
  }
  | {
    readonly kind: "agent";
    readonly source: "case-studies/agent/main.blot";
  }
  | {
    readonly kind: "engine";
    readonly source: "case-studies/engine/main.blot";
    readonly frames: number;
    readonly lens: number;
  };

class GuestMemory {
  #instance: WebAssembly.Instance | null = null;

  attach(instance: WebAssembly.Instance): void {
    this.#instance = instance;
  }

  readText(pointer: number, length: number): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(this.memory().buffer, pointer, length),
    );
  }

  /** One canonical i64 field of a record the host is returning. */
  writeInt64(offset: number, value: number): void {
    new DataView(this.memory().buffer).setBigInt64(offset, BigInt(value), true);
  }

  writeText(resultPointer: number, value: string): void {
    const bytes = new TextEncoder().encode(value);
    const reallocate = this.exportedFunction("cabi_realloc");
    const pointer = Number(reallocate(0, 0, 1, bytes.length));
    new Uint8Array(this.memory().buffer, pointer, bytes.length).set(bytes);
    const result = new DataView(this.memory().buffer);
    result.setUint32(resultPointer, pointer, true);
    result.setUint32(resultPointer + 4, bytes.length, true);
  }

  private memory(): WebAssembly.Memory {
    const memory = this.instance().exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) {
      throw new Error("case study module did not export canonical ABI memory");
    }
    return memory;
  }

  private exportedFunction(name: string): CallableFunction {
    const exported = this.instance().exports[name];
    if (typeof exported !== "function") {
      throw new Error(`case study module did not export ${name}`);
    }
    return exported;
  }

  private instance(): WebAssembly.Instance {
    if (this.#instance === null) {
      throw new Error("case study host was called before instantiation");
    }
    return this.#instance;
  }
}

const [studyName, ...studyArguments] = Deno.args;
let study: Study;
if (studyName === "grep") {
  const [pattern, path] = studyArguments;
  if (
    pattern === undefined ||
    path === undefined ||
    studyArguments.length !== 2
  ) {
    throw new Error("usage: deno task case-study grep <pattern> <path>");
  }
  const file = await Deno.readTextFile(path);
  const lines = file.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") lines.pop();
  study = {
    kind: "grep",
    source: "case-studies/grep/main.blot",
    pattern,
    lines,
  };
} else if (studyName === "terminal" && studyArguments.length === 0) {
  study = {
    kind: "terminal",
    source: "case-studies/terminal/main.blot",
  };
} else if (studyName === "agent" && studyArguments.length === 0) {
  study = {
    kind: "agent",
    source: "case-studies/agent/main.blot",
  };
} else if (studyName === "engine" && studyArguments.length <= 2) {
  const [frames, lens] = studyArguments;
  study = {
    kind: "engine",
    source: "case-studies/engine/main.blot",
    frames: frames === undefined ? 120 : Number(frames),
    lens: lens === "ortho" ? 1 : 0,
  };
} else {
  throw new Error(
    "usage: deno task case-study " +
      "<grep <pattern> <path>|terminal|agent|engine [frames] [ortho]>",
  );
}

const guest = new GuestMemory();
const terminal = {
  read_line(resultPointer: number) {
    let line = prompt("");
    if (line === null) line = "";
    guest.writeText(resultPointer, line);
  },
  write(pointer: number, length: number) {
    console.log(guest.readText(pointer, length));
  },
};

let imports: WebAssembly.Imports;
if (study.kind === "grep") {
  imports = {
    "blot:host/Arguments": {
      pattern(resultPointer: number) {
        guest.writeText(resultPointer, study.pattern);
      },
    },
    "blot:host/File": {
      line_count() {
        return BigInt(study.lines.length);
      },
      line(index: bigint, resultPointer: number) {
        const line = study.lines[Number(index)];
        if (line === undefined) {
          throw new RangeError(
            `grep requested line ${index} from ${study.lines.length} lines`,
          );
        }
        guest.writeText(resultPointer, line);
      },
    },
    "blot:host/Console": {
      write(pointer: number, length: number) {
        console.log(guest.readText(pointer, length));
      },
    },
  };
} else if (study.kind === "terminal") {
  imports = { "blot:host/Terminal": terminal };
} else if (study.kind === "engine") {
  // The headless canvas. It rasterizes to a character grid instead of a page,
  // so the study runs in CI and its output is a value a test can compare. It
  // grants exactly the capabilities the browser host does, against a scene
  // read from the same file — which is what makes this a check of the engine
  // rather than of a second engine that happens to agree.
  // Thousandths on the wire; the guest's own geometry is in floats.
  const ONE = 1000;
  const columns = 78;
  const rows = 30;
  const scaleX = 480 / columns;
  const scaleY = 300 / rows;
  const ramp = " .:-=+*#%@";

  const sceneText = await Deno.readTextFile(
    "case-studies/engine/assets/scene.json",
  );
  const parsed = JSON.parse(sceneText);
  const fixed = (value: unknown) =>
    typeof value === "number" ? Math.round(value * ONE) : 0;
  const scene = (parsed.entities as Record<string, unknown>[]).map((entity) => {
    const mesh = entity.kind !== "sprite";
    return {
      kind: mesh ? 0 : 1,
      x: fixed(entity.x),
      y: fixed(entity.y),
      z: fixed(entity.z),
      scale: fixed(entity.scale),
      spin: typeof entity.spin === "number" ? Math.round(entity.spin) : 0,
      colour: mesh
        ? String(entity.colour ?? "#888888")
        : String(entity.texture ?? "spark"),
    };
  });

  // Painter's algorithm over a character grid: the guest hands over projected
  // geometry with a view depth, and sorting it is the host's job in both hosts.
  let cells: { shade: number; depth: number }[][] = [];
  const frames = study.frames;
  let remaining = frames;
  let batch: {
    kind: string;
    points: [number, number][];
    depth: number;
    shade: number;
  }[] = [];

  const plot = (
    x: number,
    y: number,
    depth: number,
    shade: number,
  ) => {
    const column = Math.round(x / scaleX);
    const row = Math.round(y / scaleY);
    if (row < 0 || row >= rows || column < 0 || column >= columns) return;
    const cell = cells[row][column];
    if (depth >= cell.depth) return;
    cells[row][column] = { shade, depth };
  };

  // Scanline fill, so a triangle covers area rather than only its edges — the
  // grid is coarse enough that outlines alone would not show a solid.
  const fillTriangle = (
    points: [number, number][],
    depth: number,
    shade: number,
  ) => {
    const ys = points.map((point) => point[1]);
    const top = Math.max(0, Math.floor(Math.min(...ys)));
    const bottom = Math.min(300, Math.ceil(Math.max(...ys)));
    for (let y = top; y <= bottom; y += scaleY / 2) {
      const crossings: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % 3];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
          crossings.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a - b);
      for (let x = crossings[0]; x <= crossings[1]; x += scaleX / 2) {
        plot(x, y, depth, shade);
      }
    }
  };

  imports = {
    "blot:host/Canvas": {
      clear() {
        batch = [];
      },
      tri(
        ax: bigint,
        ay: bigint,
        bx: bigint,
        by: bigint,
        _colourPointer: number,
        _colourLength: number,
        cx: bigint,
        cy: bigint,
        depth: bigint,
        shadeValue: bigint,
      ) {
        batch.push({
          kind: "tri",
          points: [
            [Number(ax), Number(ay)],
            [Number(bx), Number(by)],
            [Number(cx), Number(cy)],
          ],
          depth: Number(depth),
          shade: Number(shadeValue),
        });
      },
      sprite(
        depth: bigint,
        size: bigint,
        _texturePointer: number,
        _textureLength: number,
        x: bigint,
        y: bigint,
      ) {
        const half = Number(size) / 2;
        batch.push({
          kind: "sprite",
          points: [[Number(x) - half, Number(y) - half], [
            Number(x) + half,
            Number(y) + half,
          ], [0, 0]],
          depth: Number(depth),
          shade: 255,
        });
      },
      present() {
        if (remaining > 0) return;
        cells = Array.from(
          { length: rows },
          () =>
            Array.from({ length: columns }, () => ({
              shade: -1,
              depth: Number.MAX_SAFE_INTEGER,
            })),
        );
        for (const item of batch) {
          if (item.kind === "tri") {
            fillTriangle(item.points, item.depth, item.shade);
            continue;
          }
          const [[left, top], [right, bottom]] = item.points;
          for (let y = top; y <= bottom; y += scaleY / 2) {
            for (let x = left; x <= right; x += scaleX / 2) {
              plot(x, y, item.depth, item.shade);
            }
          }
        }
        const picture = cells.map((row) =>
          row.map((cell) => {
            if (cell.shade < 0) return " ";
            const step = Math.min(
              ramp.length - 1,
              Math.max(1, Math.round((cell.shade / 255) * (ramp.length - 1))),
            );
            return ramp[step];
          }).join("")
        ).join("\n");
        console.log(picture);
      },
    },

    // A fixed camera, so the study is deterministic. The browser host puts a
    // pointer behind these four.
    "blot:host/View": {
      yaw: () => 34n,
      pitch: () => 18n,
      distance: () => BigInt(9 * ONE),
      lens: () => BigInt(study.kind === "engine" ? study.lens : 0),
    },

    "blot:host/Assets": {
      // Nothing changes on disk during a headless run, so the generation is
      // constant and the guest loads once.
      generation: () => 1n,
      count: () => BigInt(scene.length),
      entry(id: bigint, resultPointer: number) {
        const entity = scene[Number(id)];
        guest.writeText(resultPointer, entity.colour);
        guest.writeInt64(resultPointer + 8, entity.kind);
        guest.writeInt64(resultPointer + 16, entity.scale);
        guest.writeInt64(resultPointer + 24, entity.spin);
        guest.writeInt64(resultPointer + 32, entity.x);
        guest.writeInt64(resultPointer + 40, entity.y);
        guest.writeInt64(resultPointer + 48, entity.z);
      },
    },

    "blot:host/Host": {
      frame(): bigint {
        const answer = remaining;
        remaining -= 1;
        return BigInt(answer);
      },
    },
  };
} else {
  imports = {
    "blot:host/Terminal": terminal,
    "blot:host/Model": {
      complete(pointer: number, length: number, resultPointer: number) {
        const transcript = guest.readText(pointer, length);
        const turns = transcript.split("\nUser: ");
        let request = turns.at(-1);
        if (request === undefined) request = transcript;
        const message = request.replace(/\nAssistant:$/, "");
        let reply = `I heard: ${message}`;
        if (message.includes("help")) {
          reply = "Try asking a short, concrete question.";
        }
        guest.writeText(resultPointer, reply);
      },
    },
  };
}

const built = await build(study.source);
const wasm = new Uint8Array(built.wasm);
const module = await WebAssembly.compile(wasm);
const instance = await WebAssembly.instantiate(module, imports);
guest.attach(instance);

const exported = built.manifest.exports.find((candidate) =>
  candidate.sourceName === "default"
);
if (exported?.name === null || exported?.name === undefined) {
  throw new Error("case study did not publish a runtime default export");
}
const main = instance.exports[exported.name];
if (typeof main !== "function") {
  throw new Error(`case study module did not export ${exported.name}`);
}
const result = main();
if (study.kind === "grep" && result === 0n) Deno.exitCode = 1;
if (study.kind === "engine") console.log(`${result} frames simulated`);
