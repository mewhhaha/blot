import { parentPort } from "node:worker_threads";

if (parentPort === null) {
  throw new Error("browser worker test adapter requires a parent port");
}

globalThis.self = {
  onmessage: undefined,
  postMessage(message) {
    parentPort.postMessage(message);
  },
};

await import("./worker.js");

if (typeof globalThis.self.onmessage !== "function") {
  throw new Error("engine browser worker did not install its message listener");
}

parentPort.on("message", async (message) => {
  await globalThis.self.onmessage({ data: message });
});
parentPort.postMessage({ kind: "ready" });
