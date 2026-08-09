import { readFile as nodeReadFile } from "node:fs/promises";

class NotFound extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NotFound";
  }
}

function isNodeNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (!("code" in error)) return false;
  return (error as { readonly code?: unknown }).code === "ENOENT";
}

function translateReadError(error: unknown, target: string | URL): never {
  if (isNodeNotFound(error)) {
    throw new NotFound(`No such file: ${String(target)}`, { cause: error });
  }
  throw error;
}

async function readFile(target: string | URL): Promise<Uint8Array> {
  try {
    const bytes = await nodeReadFile(target);
    return new Uint8Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).slice();
  } catch (error) {
    return translateReadError(error, target);
  }
}

async function readTextFile(target: string | URL): Promise<string> {
  try {
    return await nodeReadFile(target, "utf8");
  } catch (error) {
    return translateReadError(error, target);
  }
}

export function installDenoShim(): void {
  if ("Deno" in globalThis) return;
  Object.defineProperty(globalThis, "Deno", {
    value: Object.freeze({
      readFile,
      readTextFile,
      errors: Object.freeze({ NotFound }),
    }),
    configurable: true,
    enumerable: false,
    writable: false,
  });
}
