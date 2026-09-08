import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { sha256 } from "./compiler/artifact.ts";
import type { Compiler } from "./compiler/session.ts";

export type DevelopmentCacheOptions =
  | { readonly mode: "disabled" }
  | { readonly mode: "memory" }
  | { readonly mode: "disk"; readonly directory?: string };

export interface DevelopmentCacheReport {
  readonly mode: DevelopmentCacheOptions["mode"];
  readonly loadedEntries: number;
  readonly rejectedEntries: number;
  readonly storedEntries: number;
  readonly warnings: readonly string[];
}

const residentLimit = 64 * 1024 * 1024;
const diskLimit = 512 * 1024 * 1024;
const entryName = /^[a-f0-9]{64}\.entry$/;
const namespaceName = /^[a-f0-9]{64}$/;

export function isDevelopmentCachePath(
  path: string,
  cacheDirectory: string,
): boolean {
  const within = relative(resolve(cacheDirectory), resolve(path));
  return !isAbsolute(within) && within !== ".." &&
    !within.startsWith(`..${SEPARATOR}`);
}

/** Only Rust-produced graph memos live here. Browser revisions live in DevelopmentProject. */
export class DevelopmentDiskCache {
  readonly directory: string;
  readonly #namespace: string;
  #loadedEntries = 0;
  #rejectedEntries = 0;
  #storedEntries = 0;
  readonly #warnings: string[] = [];
  #writable = true;

  constructor(manifestPath: string, namespace: string, directory?: string) {
    if (directory === undefined) {
      directory = join(dirname(manifestPath), ".blot", "cache", "development");
    }
    this.directory = resolve(directory);
    this.#namespace = join(this.directory, namespace);
  }

  report(): DevelopmentCacheReport {
    return Object.freeze({
      mode: "disk",
      loadedEntries: this.#loadedEntries,
      rejectedEntries: this.#rejectedEntries,
      storedEntries: this.#storedEntries,
      warnings: Object.freeze(this.#warnings.slice()),
    });
  }

  async load(compiler: Compiler): Promise<void> {
    let entries;
    try {
      entries = await this.#entries(this.#namespace);
    } catch (error) {
      this.#unavailable("read", error);
      return;
    }
    // Newest entries take precedence within the resident budget. Import in
    // reverse order so Rust's eviction order also retains the newest entries.
    entries.sort((left, right) =>
      right.modified - left.modified || right.path.localeCompare(left.path)
    );
    let bytes = 0;
    const selected = [];
    for (const entry of entries) {
      if (entry.bytes > residentLimit) {
        this.#reject(entry.path, "entry exceeds the resident budget");
        continue;
      }
      if (bytes + entry.bytes > residentLimit) continue;
      bytes += entry.bytes;
      selected.push(entry);
    }
    for (const entry of selected.reverse()) {
      let payload: Uint8Array;
      try {
        payload = await readFile(entry.path);
      } catch (error) {
        if (missing(error)) continue;
        this.#unavailable("read", error);
        return;
      }
      if (
        payload.length !== entry.bytes ||
        `${await sha256(payload)}.entry` !== entry.name
      ) {
        this.#reject(entry.path, "content digest mismatch");
        continue;
      }
      const admitted = await compiler.importDevelopmentCacheEntry(payload);
      if (!admitted.accepted) {
        this.#reject(entry.path, admitted.reason);
        continue;
      }
      this.#loadedEntries += 1;
    }
  }

  async store(entries: readonly Uint8Array[]): Promise<void> {
    if (!this.#writable || entries.length === 0) return;
    try {
      await mkdir(this.#namespace, { recursive: true });
      for (const entry of entries) {
        const name = `${await sha256(entry)}.entry`;
        const destination = join(this.#namespace, name);
        const temporary = join(
          this.#namespace,
          `${name}.${crypto.randomUUID()}.tmp`,
        );
        try {
          await writeFile(temporary, entry, { flag: "wx", mode: 0o600 });
          await rename(temporary, destination);
        } finally {
          await rm(temporary, { force: true });
        }
        this.#storedEntries += 1;
      }
      await this.#evict();
    } catch (error) {
      this.#unavailable("write", error);
    }
  }

  async #evict(): Promise<void> {
    const namespaces = await readdir(this.directory, { withFileTypes: true });
    const entries = [];
    for (const namespace of namespaces) {
      if (namespace.isDirectory() && namespaceName.test(namespace.name)) {
        entries.push(
          ...await this.#entries(join(this.directory, namespace.name)),
        );
      }
    }
    entries.sort((left, right) =>
      left.modified - right.modified || left.path.localeCompare(right.path)
    );
    let bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    for (const entry of entries) {
      if (bytes <= diskLimit) break;
      await rm(entry.path, { force: true });
      bytes -= entry.bytes;
    }
  }

  async #entries(directory: string) {
    let names;
    try {
      names = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const entries = [];
    for (const name of names) {
      if (!name.isFile() || !entryName.test(name.name)) continue;
      const path = join(directory, name.name);
      try {
        const attributes = await stat(path);
        entries.push({
          name: name.name,
          path,
          bytes: attributes.size,
          modified: attributes.mtimeMs,
        });
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    return entries;
  }

  #reject(path: string, reason: string): void {
    this.#rejectedEntries += 1;
    this.#warnings.push(`Ignored development cache entry ${path}: ${reason}`);
  }

  #unavailable(operation: string, error: unknown): void {
    this.#writable = false;
    this.#warnings.push(
      `Development cache ${operation} failed: ${
        String(error)
      }. Compilation continues with memory caching.`,
    );
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
