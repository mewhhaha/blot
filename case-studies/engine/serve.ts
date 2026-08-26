// Serves the engine to a browser, and reloads it while it runs.
//
// Two kinds of reload, because they cost different things:
//
//   assets — `assets/scene.json` is re-read and the generation bumps. The
//            module is untouched; the guest notices on its next frame and
//            rebuilds its stores. No compiler runs.
//
//   code   — `main.blot` or `lib/*.blot` changed, so the module is rebuilt and
//            the page swaps in a new worker. The camera survives because the
//            camera was never in the guest.
//
// One Rust/Wasm compiler session is held for the life of the server.

import { Compiler } from "../../src/compiler/session.ts";

const root = new URL(".", import.meta.url);
const source = "case-studies/engine/main.blot";
const port = 8321;

const session = await Compiler.create();

interface Color {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

interface Entity {
  readonly kind: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  readonly spin: number;
  readonly color: Color;
  readonly texture: string;
}

/**
 * Thousandths. The guest's geometry is in floats, but a float cannot cross the
 * module boundary — so the wire carries whole units times a thousand and the
 * guest divides once at load.
 */
const ONE = 1000;
const fixed = (value: unknown): number => {
  if (typeof value !== "number") return 0;
  return Math.round(value * ONE);
};

async function readScene(): Promise<readonly Entity[]> {
  const text = await Deno.readTextFile(new URL("assets/scene.json", root));
  const parsed = JSON.parse(text);
  const entities = Array.isArray(parsed.entities) ? parsed.entities : [];
  return entities.map(
    (entity: Record<string, unknown>, index: number): Entity => {
      const mesh = entity.kind !== "sprite";
      let color: Color = { red: 0, green: 0, blue: 0 };
      if (mesh) {
        const sourceColor = entity.color;
        if (
          typeof sourceColor !== "object" || sourceColor === null ||
          Array.isArray(sourceColor)
        ) {
          throw new Error(`scene entity ${index} has no RGB color record`);
        }
        const channel = (name: keyof Color): number => {
          const value = (sourceColor as Record<string, unknown>)[name];
          if (
            !Number.isInteger(value) || Number(value) < 0 || Number(value) > 255
          ) {
            throw new Error(
              `scene entity ${index} color.${name} is not an integer from 0 through 255: ${value}`,
            );
          }
          return Number(value);
        };
        color = {
          red: channel("red"),
          green: channel("green"),
          blue: channel("blue"),
        };
      }
      let texture = "";
      if (!mesh) {
        texture = "spark";
        if (typeof entity.texture === "string") texture = entity.texture;
      }
      return {
        kind: mesh ? 0 : 1,
        x: fixed(entity.x),
        y: fixed(entity.y),
        z: fixed(entity.z),
        scale: fixed(entity.scale),
        // A spin is an angle step per frame, and angles are whole units of 1/256
        // of a turn — so this one is not scaled.
        spin: typeof entity.spin === "number" ? Math.round(entity.spin) : 0,
        color,
        texture,
      };
    },
  );
}

interface Bundle {
  readonly wasm: Uint8Array;
  readonly export: string;
  readonly revision: number;
}

let bundle: Bundle | null = null;
let scene = await readScene();
let generation = 1;

async function rebuild(): Promise<string | null> {
  try {
    const built = await session.compile(source);
    const manifest = JSON.parse(
      new TextDecoder().decode(built.manifestBytes),
    ) as {
      readonly exports: readonly {
        readonly sourceName: string;
        readonly name: string | null;
      }[];
    };
    const exported = manifest.exports.find(
      (candidate) => candidate.sourceName === "default",
    );
    if (exported === undefined || exported.name === null) {
      return "the engine did not publish a runtime default export";
    }
    const revision = bundle === null ? 1 : bundle.revision + 1;
    bundle = {
      wasm: new Uint8Array(built.wasm),
      export: exported.name,
      revision,
    };
    console.log(
      `code r${revision}: ${built.wasm.byteLength} bytes`,
    );
    return null;
  } catch (error) {
    // A broken edit must not take the server down — the page keeps running the
    // last module that compiled, and the error goes to the browser.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`code rejected: ${message.split("\n")[0]}`);
    return message;
  }
}

let failure = await rebuild();
if (bundle === null) throw new Error(`the engine does not compile: ${failure}`);

/** Pages waiting to hear that something changed. */
const listeners = new Set<(event: string) => void>();
const announce = (event: string) => {
  for (const listener of listeners) listener(event);
};

// One watcher for both trees. Editors write by rename and by truncate, so the
// event kind is not worth discriminating; what matters is which file moved.
(async () => {
  const watcher = Deno.watchFs([
    new URL("assets", root).pathname,
    new URL("lib", root).pathname,
    new URL("main.blot", root).pathname,
  ]);
  let pending: ReturnType<typeof setTimeout> | null = null;
  for await (const event of watcher) {
    const code = event.paths.some((path) => path.endsWith(".blot"));
    // Debounce: a single save can produce several events, and a rebuild is
    // expensive enough to be worth not doing four times.
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(async () => {
      pending = null;
      if (code) {
        failure = await rebuild();
        announce(failure === null ? "code" : "error");
        return;
      }
      try {
        scene = await readScene();
        generation += 1;
        console.log(`assets g${generation}: ${scene.length} entities`);
        announce("assets");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`assets rejected: ${message.split("\n")[0]}`);
      }
    }, 60);
  }
})();

const isolate = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
};

const files: Record<string, readonly [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/worker.js": ["worker.js", "text/javascript; charset=utf-8"],
};

Deno.serve({ port }, async (request) => {
  const { pathname } = new URL(request.url);

  if (pathname === "/main.wasm") {
    return new Response(new Uint8Array(bundle!.wasm), {
      headers: { ...isolate, "content-type": "application/wasm" },
    });
  }

  if (pathname === "/state.json") {
    return new Response(
      JSON.stringify({
        export: bundle!.export,
        revision: bundle!.revision,
        generation,
        scene,
        failure,
      }),
      { headers: { ...isolate, "content-type": "application/json" } },
    );
  }

  // Server-sent events, so the page learns about a change without polling.
  if (pathname === "/watch") {
    let listener: (event: string) => void;
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        listener = (event) => {
          controller.enqueue(encoder.encode(`data: ${event}\n\n`));
        };
        listeners.add(listener);
      },
      cancel() {
        listeners.delete(listener);
      },
    });
    return new Response(body, {
      headers: { ...isolate, "content-type": "text/event-stream" },
    });
  }

  const entry = files[pathname];
  if (entry === undefined) return new Response("not found", { status: 404 });
  const [name, type] = entry;
  const body = await Deno.readTextFile(new URL(name, root));
  return new Response(body, { headers: { ...isolate, "content-type": type } });
});

console.log(`engine on http://localhost:${port}`);
console.log(
  "editing assets/scene.json reloads the scene; editing a .blot rebuilds",
);
