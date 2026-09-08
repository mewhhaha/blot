import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as bundle } from "esbuild";
import type { DevelopmentUnitArtifact } from "../../src/compiler/session.ts";
import {
  type DevelopmentBuild,
  DevelopmentProject,
} from "../../src/development.ts";

export async function serveHotReload(manifestPath: string, port = 8323) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError(`port must be between 0 and 65535: ${port}`);
  }
  const manifest = resolve(manifestPath);
  const directory = dirname(manifest);
  const messagePath = resolve(directory, "message.txt");
  const page = await readFile(new URL("./index.html", import.meta.url), "utf8");
  const client = await bundle({
    entryPoints: [fileURLToPath(new URL("./client.mjs", import.meta.url))],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
  });
  const initialMessage = await readFile(messagePath, "utf8");
  let project = await DevelopmentProject.create(manifest, {
    cache: { mode: "disk" },
  });
  let units = new Map<string, DevelopmentUnitArtifact>();
  let active: DevelopmentBuild | undefined;
  let message = initialMessage;
  let failure: string | null = null;
  let resourceFailure: string | null = null;
  let manifestChanged = false;
  let generation = 0;
  let compilations = 0;
  let changed: readonly string[] = [];
  let durationMilliseconds = 0;
  let closed = false;
  const listeners = new Set<ServerResponse>();

  async function rebuild(paths: readonly string[]) {
    const started = performance.now();
    changed = [];
    try {
      if (paths.includes(messagePath)) {
        try {
          message = await readFile(messagePath, "utf8");
          resourceFailure = null;
        } catch (error) {
          resourceFailure = String(error);
          console.error(
            `Keeping the last working resource: ${resourceFailure}`,
          );
        }
      }
      const sources = paths.filter((path) => path !== messagePath);
      if (sources.includes(manifest)) manifestChanged = true;
      if (active === undefined || sources.length > 0 || manifestChanged) {
        let candidate = project;
        if (manifestChanged) {
          candidate = await DevelopmentProject.create(manifest, {
            cache: { mode: "disk" },
          });
        }
        try {
          for (const path of sources) {
            if (path !== manifest) await candidate.markChanged(path);
          }
          compilations += 1;
          const build = await candidate.prepareBuild();
          const next = new Map(units);
          for (const name of build.removedUnits) next.delete(name);
          if (candidate !== project) next.clear();
          for (const unit of build.changedUnits) next.set(unit.name, unit);
          candidate.commitBuild(build);
          if (candidate !== project) {
            project.destroy();
            project = candidate;
          }
          units = next;
          active = build;
          manifestChanged = false;
          changed = build.changedUnits.map((unit) => unit.name);
          failure = null;
        } catch (error) {
          if (candidate !== project) candidate.destroy();
          throw error;
        }
      }
    } catch (error) {
      failure = String(error);
      console.error(`Keeping the last working build: ${failure}`);
    }
    durationMilliseconds = performance.now() - started;
    generation += 1;
    for (const response of listeners) response.write(`data: ${generation}\n\n`);
  }

  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work = Promise.resolve();
  const watcher = watch(directory, (_event, name) => {
    if (closed) return;
    // A missing filename requires a complete refresh, including the manifest.
    if (name === null) {
      pending.add(manifest);
      pending.add(messagePath);
    } else {
      if (project.isCachePath(resolve(directory, name))) return;
      if (
        !name.endsWith(".blot") && !name.endsWith(".txt") &&
        resolve(directory, name) !== manifest
      ) return;
      pending.add(resolve(directory, name));
    }
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const paths = [...pending];
      pending = new Set();
      work = work.then(() => rebuild(paths));
    }, 35);
  });
  try {
    work = rebuild([]);
    await work;
    if (active === undefined) {
      throw new Error(`initial development build failed: ${failure}`);
    }
  } catch (error) {
    closed = true;
    watcher.close();
    if (timer !== undefined) clearTimeout(timer);
    await work;
    project.destroy();
    throw error;
  }

  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    let target = "/";
    if (request.url !== undefined) target = request.url;
    let url: URL;
    try {
      url = new URL(target, "http://127.0.0.1");
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(page);
    } else if (url.pathname === "/client.js") {
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
      }).end(client.outputFiles[0].contents);
    } else if (url.pathname === "/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      });
      listeners.add(response);
      response.write(`retry: 500\ndata: ${generation}\n\n`);
      response.on("close", () => listeners.delete(response));
    } else if (url.pathname === "/build") {
      if (active === undefined) {
        throw new Error("listening development server lost its active build");
      }
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          generation,
          message,
          failure: failure || resourceFailure,
          compilations,
          changed,
          durationMilliseconds,
          work: active.work,
          cache: active.cache,
          revision: active.revision,
          entryUnit: active.entryUnit,
          edges: active.edges,
          units: [...units.values()].map((
            { wasm: _wasm, manifestBytes: _manifestBytes, ...unit },
          ) => unit),
        }),
      );
    } else if (url.pathname.startsWith("/units/")) {
      const [, , name, digest] = url.pathname.split("/");
      const unit = units.get(name);
      if (unit === undefined || unit.wasmDigest !== digest) {
        // A save can replace this snapshot while the browser fetches its units.
        response.writeHead(409).end("Build changed; request /build again.");
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=31536000, immutable",
      }).end(
        JSON.stringify({
          wasm: [...unit.wasm],
          manifestBytes: [...unit.manifestBytes],
        }),
      );
    } else {
      response.writeHead(404).end();
    }
  });
  try {
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        accept();
      });
    });
  } catch (error) {
    closed = true;
    watcher.close();
    if (timer !== undefined) clearTimeout(timer);
    await work;
    project.destroy();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("HTTP server has no TCP address");
  }
  return {
    port: address.port,
    async close() {
      if (closed) return;
      closed = true;
      watcher.close();
      if (timer !== undefined) clearTimeout(timer);
      for (const response of listeners) response.end();
      await new Promise<void>((accept, reject) =>
        server.close((error) => {
          if (error !== undefined) reject(error);
          else accept();
        })
      );
      await work;
      project.destroy();
    },
  };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  let port = 8323;
  if (process.argv[2] !== undefined) port = Number(process.argv[2]);
  const server = await serveHotReload(
    fileURLToPath(new URL("./blot.json", import.meta.url)),
    port,
  );
  console.log(`Blot hot reload: http://127.0.0.1:${server.port}`);
  await new Promise<void>((accept) => {
    const stop = () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      accept();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await server.close();
}
