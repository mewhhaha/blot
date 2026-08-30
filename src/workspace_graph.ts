import { resolve } from "@std/path";
import {
  type IncludedFile,
  invalidateLoadedInputs,
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

interface WorkspaceState {
  loaded: Map<string, Loaded>;
  overlays: Map<string, OverlayRevision>;
  dirty: Set<string>;
  roots: Set<string>;
  overlaySequence: number;
}

/**
 * Persistent source/package/include graph shared by compiler and editor hosts.
 *
 * Parsed module payloads remain stable until their own source, includes, or an
 * overlay changes. Graph wrappers may change when they are rebound to a new
 * dependency revision. Overlay text always wins over the disk revision.
 */
export class WorkspaceGraph {
  #state: WorkspaceState = {
    loaded: new Map(),
    overlays: new Map(),
    dirty: new Set(),
    roots: new Set(),
    overlaySequence: 0,
  };
  readonly #pinnedPaths = new Set<string>();
  readonly #inspect: SourceInspector | undefined;

  constructor(
    inspect?: SourceInspector,
    pinnedModules: readonly Loaded[] = [],
  ) {
    this.#inspect = inspect;
    for (const loaded of pinnedModules) {
      this.#state.loaded.set(loaded.path, loaded);
      this.#pinnedPaths.add(loaded.path);
    }
  }

  async refresh(path: string): Promise<Loaded> {
    const absolute = resolve(path);
    const staged = this.#stage();
    staged.roots.add(absolute);
    await refreshLoadedModules(
      staged.loaded,
      new Set([...staged.overlays.keys(), ...this.#pinnedPaths]),
    );
    const loaded = await this.#loadCurrent(absolute, staged);
    this.#state = staged;
    return loaded;
  }

  async refreshAfterKnownChanges(path: string): Promise<Loaded> {
    const absolute = resolve(path);
    const staged = this.#stage();
    staged.roots.add(absolute);
    const loaded = await this.#refreshKnownChanges(
      absolute,
      new Set(staged.dirty),
      staged,
    );
    this.#state = staged;
    return loaded;
  }

  async updateOverlay(
    path: string,
    source: string,
    version?: number,
  ): Promise<Loaded> {
    const absolute = resolve(path);
    const staged = this.#stage();
    staged.roots.add(absolute);
    const previous = staged.overlays.get(absolute);
    let nextVersion = version;
    if (nextVersion === undefined) {
      let previousVersion = 0;
      if (previous !== undefined) previousVersion = previous.version;
      nextVersion = Math.max(staged.overlaySequence, previousVersion) + 1;
      staged.overlaySequence = nextVersion;
    }
    if (
      previous !== undefined && previous.source === source &&
      previous.version === nextVersion
    ) {
      const loaded = await this.#loadCurrent(absolute, staged);
      this.#state = staged;
      return loaded;
    }
    if (previous !== undefined && nextVersion <= previous.version) {
      throw new Error(
        `overlay ${absolute} version ${nextVersion} does not follow ${previous.version}`,
      );
    }
    staged.overlays.set(absolute, { source, version: nextVersion });
    staged.dirty.add(absolute);
    const loaded = await this.#refreshKnownChanges(
      absolute,
      new Set([absolute]),
      staged,
    );
    this.#state = staged;
    return loaded;
  }

  async closeOverlay(path: string): Promise<readonly Loaded[]> {
    const absolute = resolve(path);
    const staged = this.#stage();
    if (!staged.overlays.has(absolute)) return [];
    const affectedRoots = [...staged.roots].filter((root) =>
      workspacePathReaches(staged, root, absolute)
    );
    staged.overlays.delete(absolute);
    staged.dirty.add(absolute);
    await this.#invalidateKnownChanges(new Set([absolute]), staged);
    const loaded: Loaded[] = [];
    for (const root of affectedRoots) {
      loaded.push(await this.#loadCurrent(root, staged));
    }
    staged.dirty.delete(absolute);
    this.#state = staged;
    return loaded;
  }

  releaseRoot(path: string): void {
    const absolute = resolve(path);
    if (!this.#state.roots.delete(absolute)) return;
    const activePaths = workspaceActivePaths(this.#state);
    for (const [cachedPath, loaded] of this.#state.loaded) {
      if (this.#pinnedPaths.has(cachedPath)) continue;
      if (activePaths.has(cachedPath) || activePaths.has(loaded.path)) continue;
      this.#state.loaded.delete(cachedPath);
    }
    const activeInputs = new Set(activePaths);
    for (const loaded of this.#state.loaded.values()) {
      if (!activePaths.has(loaded.path)) continue;
      if (loaded.storage.tag === "capsule") {
        activeInputs.add(loaded.storage.path);
      }
      for (const included of loaded.includedFiles.values()) {
        activeInputs.add(included.path);
      }
    }
    this.#state.dirty = new Set(
      [...this.#state.dirty].filter((dirtyPath) => activeInputs.has(dirtyPath)),
    );
  }

  markDirty(path: string): void {
    const absolute = resolve(path);
    if (this.#pinnedPaths.has(absolute)) return;
    this.#state.dirty.add(absolute);
  }

  committedRevision(path: string): Loaded | undefined {
    return this.#state.loaded.get(resolve(path));
  }

  activePaths(): ReadonlySet<string> {
    return workspaceActivePaths(this.#state);
  }

  node(path: string): WorkspaceNode | undefined {
    const absolute = resolve(path);
    const loaded = this.#state.loaded.get(absolute);
    if (loaded === undefined) return undefined;
    const reverseImports = new Set<string>();
    for (const [importerPath, importer] of this.#state.loaded) {
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
    const overlaySource = this.#state.overlays.get(absolute);
    const common = {
      path: absolute,
      storage: loaded.storage,
      diskSource: loaded.source,
      imports,
      includes: new Map(loaded.includedFiles),
      reverseImports,
      payloadDigest: loadedPayloadDigest(loaded),
      configurationDigest: loadedConfigurationDigest(loaded),
      dirty: this.#state.dirty.has(absolute),
    };
    if (overlaySource === undefined) return common;
    return { ...common, overlaySource };
  }

  async #loadCurrent(
    path: string,
    state: WorkspaceState,
  ): Promise<Loaded> {
    const cached = state.loaded.get(path);
    if (cached !== undefined) {
      return await load(path, state.loaded, [], this.#inspect);
    }
    const overlay = state.overlays.get(path);
    if (overlay !== undefined) {
      return await loadSource(
        path,
        overlay.source,
        state.loaded,
        this.#inspect,
      );
    }
    return await load(path, state.loaded, [], this.#inspect);
  }

  async #refreshKnownChanges(
    path: string,
    changedInputs: ReadonlySet<string>,
    state: WorkspaceState,
  ): Promise<Loaded> {
    if (changedInputs.size === 0) {
      return await this.#loadCurrent(path, state);
    }

    await this.#invalidateKnownChanges(changedInputs, state);
    const loaded = await this.#loadCurrent(path, state);
    for (const changed of changedInputs) {
      state.dirty.delete(changed);
    }
    return loaded;
  }

  async #invalidateKnownChanges(
    changedInputs: ReadonlySet<string>,
    state: WorkspaceState,
  ): Promise<void> {
    const invalidatedModules = invalidateLoadedInputs(
      state.loaded,
      changedInputs,
    );
    for (const modulePath of invalidatedModules) {
      const overlay = state.overlays.get(modulePath);
      if (overlay === undefined) continue;
      await loadSource(
        modulePath,
        overlay.source,
        state.loaded,
        this.#inspect,
      );
    }
  }

  #stage(): WorkspaceState {
    return {
      loaded: new Map(this.#state.loaded),
      overlays: new Map(this.#state.overlays),
      dirty: new Set(this.#state.dirty),
      roots: new Set(this.#state.roots),
      overlaySequence: this.#state.overlaySequence,
    };
  }
}

function workspaceActivePaths(state: WorkspaceState): Set<string> {
  const active = new Set<string>();
  const visited = new Set<string>();
  const pending = [...state.roots];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || visited.has(path)) continue;
    visited.add(path);
    const loaded = state.loaded.get(path);
    if (loaded === undefined) continue;
    active.add(path);
    active.add(loaded.path);
    for (const dependency of loaded.dependencies.values()) {
      pending.push(dependency.path);
    }
  }
  return active;
}

function workspacePathReaches(
  state: WorkspaceState,
  root: string,
  target: string,
): boolean {
  const visited = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || visited.has(path)) continue;
    visited.add(path);
    if (path === target) return true;
    const loaded = state.loaded.get(path);
    if (loaded === undefined) continue;
    if (loaded.path === target) return true;
    for (const dependency of loaded.dependencies.values()) {
      pending.push(dependency.path);
    }
  }
  return false;
}
