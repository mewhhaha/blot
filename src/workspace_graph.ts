import { resolve } from "@std/path";
import {
  type IncludedFile,
  load,
  type Loaded,
  type LoadedStorage,
  loadSource,
  refreshLoadedModules,
  type SourceInspector,
} from "./load.ts";
import {
  loadedConfigurationDigest,
  loadedPayloadDigest,
} from "./compiler/revision.ts";

export interface WorkspaceNode {
  readonly path: string;
  storage: LoadedStorage;
  diskSource?: string;
  overlaySource?: { readonly version: number; readonly source: string };
  imports: Map<string, string>;
  includes: Map<string, IncludedFile>;
  reverseImports: Set<string>;
  payloadDigest: string;
  configurationDigest: string;
  dirty: boolean;
}

interface OverlayRevision {
  readonly source: string;
  readonly version: number;
}

/**
 * Persistent source/package/include graph shared by compiler and editor hosts.
 *
 * Parsed `Loaded` nodes remain stable until their own payload, direct edges, or
 * an overlay changes. Overlay text always wins over the disk revision.
 */
export class WorkspaceGraph {
  readonly #loaded = new Map<string, Loaded>();
  readonly #overlays = new Map<string, OverlayRevision>();
  readonly #dirty = new Set<string>();
  readonly #roots = new Set<string>();
  readonly #inspect: SourceInspector | undefined;
  #overlaySequence = 0;

  constructor(inspect?: SourceInspector) {
    this.#inspect = inspect;
  }

  async refresh(path: string): Promise<Loaded> {
    const absolute = resolve(path);
    this.#roots.add(absolute);
    await refreshLoadedModules(this.#loaded, new Set(this.#overlays.keys()));
    return await this.#loadCurrent(absolute);
  }

  async updateOverlay(
    path: string,
    source: string,
    version?: number,
  ): Promise<Loaded> {
    const absolute = resolve(path);
    this.#roots.add(absolute);
    const previous = this.#overlays.get(absolute);
    let nextVersion = version;
    if (nextVersion === undefined) {
      this.#overlaySequence += 1;
      nextVersion = this.#overlaySequence;
    }
    if (
      previous !== undefined && previous.source === source &&
      previous.version === nextVersion
    ) {
      return await this.#loadCurrent(absolute);
    }
    if (previous !== undefined && nextVersion <= previous.version) {
      throw new Error(
        `overlay ${absolute} version ${nextVersion} does not follow ${previous.version}`,
      );
    }
    this.#overlays.set(absolute, { source, version: nextVersion });
    this.#invalidate(absolute);
    return await this.#loadCurrent(absolute);
  }

  async closeOverlay(path: string): Promise<Loaded> {
    const absolute = resolve(path);
    this.#overlays.delete(absolute);
    this.#invalidate(absolute);
    return await this.#loadCurrent(absolute);
  }

  markDirty(path: string): void {
    const absolute = resolve(path);
    this.#dirty.add(absolute);
    this.#invalidate(absolute);
  }

  activePaths(): ReadonlySet<string> {
    const active = new Set<string>();
    const pending = [...this.#roots];
    while (pending.length > 0) {
      const path = pending.pop();
      if (path === undefined || active.has(path)) continue;
      const loaded = this.#loaded.get(path);
      if (loaded === undefined) continue;
      active.add(path);
      for (const dependency of loaded.dependencies.values()) {
        pending.push(dependency.path);
      }
    }
    return active;
  }

  node(path: string): WorkspaceNode | undefined {
    const absolute = resolve(path);
    const loaded = this.#loaded.get(absolute);
    if (loaded === undefined) return undefined;
    const reverseImports = new Set<string>();
    for (const [importerPath, importer] of this.#loaded) {
      if (
        [...importer.dependencies.values()].some((dependency) =>
          dependency.path === absolute
        )
      ) {
        reverseImports.add(importerPath);
      }
    }
    const imports = new Map(
      [...loaded.dependencies].map(([specifier, dependency]) => [
        specifier,
        dependency.path,
      ]),
    );
    const overlaySource = this.#overlays.get(absolute);
    const common = {
      path: absolute,
      storage: loaded.storage,
      diskSource: loaded.source,
      imports,
      includes: new Map(loaded.includedFiles),
      reverseImports,
      payloadDigest: loadedPayloadDigest(loaded),
      configurationDigest: loadedConfigurationDigest(loaded),
      dirty: this.#dirty.has(absolute),
    };
    if (overlaySource === undefined) return common;
    return { ...common, overlaySource };
  }

  async #loadCurrent(path: string): Promise<Loaded> {
    const cached = this.#loaded.get(path);
    if (cached !== undefined) {
      this.#dirty.delete(path);
      return cached;
    }
    const overlay = this.#overlays.get(path);
    let loaded: Loaded;
    if (overlay !== undefined) {
      loaded = await loadSource(
        path,
        overlay.source,
        this.#loaded,
        this.#inspect,
      );
    } else {
      loaded = await load(path, this.#loaded, [], this.#inspect);
    }
    this.#dirty.delete(path);
    return loaded;
  }

  #invalidate(changed: string): void {
    const invalidated = new Set([changed]);
    let found = true;
    while (found) {
      found = false;
      for (const [path, loaded] of this.#loaded) {
        if (invalidated.has(path)) continue;
        if (
          [...loaded.dependencies.values()].some((dependency) =>
            invalidated.has(dependency.path)
          )
        ) {
          invalidated.add(path);
          found = true;
        }
      }
    }
    for (const path of invalidated) {
      this.#dirty.add(path);
      this.#loaded.delete(path);
    }
  }
}
