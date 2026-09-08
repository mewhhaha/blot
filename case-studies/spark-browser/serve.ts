import { fileURLToPath } from "node:url";
import { serveHotReload } from "../hot-reload/serve.ts";

let port = 8324;
if (process.argv[2] !== undefined) port = Number(process.argv[2]);
const server = await serveHotReload(
  fileURLToPath(new URL("./blot.json", import.meta.url)),
  port,
  {
    page: new URL("./index.html", import.meta.url),
    client: new URL("./client.mjs", import.meta.url),
  },
);
console.log(`Blot events: http://127.0.0.1:${server.port}`);
await new Promise<void>((resolve) => {
  const stop = () => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    resolve();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
});
await server.close();
