// Serves the engine case study to a browser.
//
// Compiles `main.blot` through gpufuck once at startup — which is why this
// needs a WebGPU adapter — and then serves the page, the worker, and the
// module bytes. The cross-origin isolation headers are what make
// `SharedArrayBuffer` available, and the worker needs it to block on the
// page's animation frame.

import { build } from "../../src/backend/compile.ts";

const root = new URL(".", import.meta.url);

const built = await build("case-studies/engine/main.blot");
const exported = built.manifest.exports.find(
  (candidate) => candidate.sourceName === "default",
);
if (exported === undefined || exported.name === null) {
  throw new Error("the engine did not publish a runtime default export");
}
console.log(
  `built ${built.wasm.byteLength} bytes, ` +
    `${built.storeReads.proven}/${built.storeReads.total} bounds checks removed`,
);

const isolate = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
};

const files: Record<string, readonly [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/worker.js": ["worker.js", "text/javascript; charset=utf-8"],
};

const port = 8321;
Deno.serve({ port }, async (request) => {
  const { pathname } = new URL(request.url);

  if (pathname === "/main.wasm") {
    return new Response(new Uint8Array(built.wasm), {
      headers: { ...isolate, "content-type": "application/wasm" },
    });
  }
  if (pathname === "/export.txt") {
    return new Response(exported.name, {
      headers: { ...isolate, "content-type": "text/plain; charset=utf-8" },
    });
  }

  const entry = files[pathname];
  if (entry === undefined) return new Response("not found", { status: 404 });
  const [name, type] = entry;
  const body = await Deno.readTextFile(new URL(name, root));
  return new Response(body, {
    headers: { ...isolate, "content-type": type },
  });
});

console.log(`engine case study on http://localhost:${port}`);
