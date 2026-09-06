import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LiveReport } from "./host.ts";

export async function serveReport(entry: string, port = 8322) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("port must be between 0 and 65535");
  }
  const report = await LiveReport.create(entry);
  let page: string;
  try {
    page = await readFile(new URL("./index.html", import.meta.url), "utf8");
  } catch (error) {
    await report.close();
    throw error;
  }
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end();
      return;
    }
    let target = "/";
    if (request.url !== undefined) target = request.url;
    let url: URL;
    try {
      url = new URL(target, "http://127.0.0.1");
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(page);
      return;
    }
    if (url.pathname !== "/report") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    const quantity = url.searchParams.get("quantity");
    if (quantity === null) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: "quantity is required" }));
      return;
    }
    try {
      response.end(JSON.stringify(report.evaluate(quantity)));
    } catch (error) {
      let status = 500;
      if (error instanceof TypeError || error instanceof RangeError) {
        status = 400;
      }
      response.writeHead(status);
      let message = "report evaluation failed";
      if (error instanceof Error) message = error.message;
      response.end(JSON.stringify({ error: message }));
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
    await report.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    await report.close();
    throw new Error("report server has no TCP address");
  }
  return {
    port: address.port,
    report,
    async close(): Promise<void> {
      await new Promise<void>((accept, reject) => {
        server.close((error) => {
          if (error !== undefined) reject(error);
          else accept();
        });
      });
      await report.close();
    },
  };
}

async function main(): Promise<void> {
  const entry = fileURLToPath(new URL("./main.blot", import.meta.url));
  let port = 8322;
  if (process.argv[2] !== undefined) port = Number(process.argv[2]);
  const hosted = await serveReport(entry, port);
  console.log(`Live report: http://127.0.0.1:${hosted.port}`);
  const changed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(dirname(entry), { recursive: true }, (_event, name) => {
    if (name === null) return;
    if (!name.endsWith(".blot") && !name.endsWith(".txt")) return;
    changed.add(resolve(dirname(entry), name));
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const paths = [...changed];
      changed.clear();
      hosted.report.reload(paths).then(
        (result) => console.log(`Report ${result}`),
        (error) => console.error("Keeping previous report:", error),
      );
    }, 50);
  });
  await new Promise<void>((accept) => {
    const stop = () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      accept();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  watcher.close();
  if (timer !== undefined) clearTimeout(timer);
  await hosted.close();
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
