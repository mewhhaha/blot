import { Buffer } from "node:buffer";
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

function installUint8ArrayBase64(): void {
  const constructor = Uint8Array as typeof Uint8Array & {
    fromBase64?: (source: string) => Uint8Array;
  };
  if (constructor.fromBase64 === undefined) {
    Object.defineProperty(constructor, "fromBase64", {
      value(source: string): Uint8Array {
        return Uint8Array.from(Buffer.from(source, "base64"));
      },
      configurable: true,
      writable: true,
    });
  }

  const prototype = Uint8Array.prototype as Uint8Array & {
    toBase64?: () => string;
  };
  if (prototype.toBase64 === undefined) {
    Object.defineProperty(prototype, "toBase64", {
      value(this: Uint8Array): string {
        return Buffer.from(
          this.buffer,
          this.byteOffset,
          this.byteLength,
        ).toString("base64");
      },
      configurable: true,
      writable: true,
    });
  }
}

export function installDenoShim(): void {
  installUint8ArrayBase64();
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
