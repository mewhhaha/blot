import type { Loaded } from "../../src/compiler/frontend.ts";

export interface Dependency {
  readonly specifier: string;
  readonly path: string;
}

export interface GraphNode {
  readonly loaded: Loaded;
  readonly depth: number;
  readonly dependencies: readonly Dependency[];
  readonly parents: ReadonlySet<string>;
}

interface SnapshotGraphNode {
  readonly dependencies: readonly Dependency[];
}

export function collectGraph(root: Loaded): Map<string, GraphNode> {
  const loadedByPath = new Map<string, Loaded>();
  const dependenciesByPath = new Map<string, readonly Dependency[]>();
  const parentsByPath = new Map<string, Set<string>>();
  const pending = [root];

  // Visit each loaded module once. Parent edges are still recorded for every
  // occurrence, but a shared dependency subtree is not recursively walked once
  // per path through a diamond.
  while (pending.length > 0) {
    const loaded = pending.pop();
    if (loaded === undefined || loadedByPath.has(loaded.path)) continue;
    loadedByPath.set(loaded.path, loaded);
    if (!parentsByPath.has(loaded.path)) {
      parentsByPath.set(loaded.path, new Set());
    }

    const dependencies = [...loaded.dependencies].map(
      ([specifier, dependency]): Dependency => ({
        specifier,
        path: dependency.path,
      }),
    );
    dependenciesByPath.set(loaded.path, dependencies);
    for (const dependency of loaded.dependencies.values()) {
      let parents = parentsByPath.get(dependency.path);
      if (parents === undefined) {
        parents = new Set();
        parentsByPath.set(dependency.path, parents);
      }
      parents.add(loaded.path);
      if (!loadedByPath.has(dependency.path)) pending.push(dependency);
    }
  }

  const depths = new Map<string, number>([[root.path, 0]]);
  const active = new Set<string>();
  const depthOf = (path: string): number => {
    const cached = depths.get(path);
    if (cached !== undefined) return cached;
    if (active.has(path)) {
      throw new Error(`sealed check graph contains an import cycle at ${path}`);
    }
    active.add(path);
    const parents = parentsByPath.get(path);
    if (parents === undefined || parents.size === 0) {
      throw new Error(`sealed check graph cannot place ${path}`);
    }
    let depth = 0;
    for (const parent of parents) depth = Math.max(depth, depthOf(parent) + 1);
    active.delete(path);
    depths.set(path, depth);
    return depth;
  };

  return new Map(
    [...loadedByPath].map(([path, loaded]) => [path, {
      loaded,
      depth: depthOf(path),
      dependencies: dependenciesByPath.get(path) ?? [],
      parents: parentsByPath.get(path) ?? new Set(),
    }]),
  );
}

export function sameGraph(
  previous: ReadonlyMap<string, SnapshotGraphNode>,
  current: ReadonlyMap<string, GraphNode>,
): boolean {
  if (previous.size !== current.size) return false;
  for (const [path, node] of current) {
    const old = previous.get(path);
    if (old === undefined) return false;
    if (old.dependencies.length !== node.dependencies.length) return false;
    for (let index = 0; index < node.dependencies.length; index += 1) {
      const left = old.dependencies[index];
      const right = node.dependencies[index];
      if (
        left === undefined || right === undefined ||
        left.specifier !== right.specifier || left.path !== right.path
      ) {
        return false;
      }
    }
  }
  return true;
}

export function deepest(
  paths: ReadonlySet<string>,
  graph: ReadonlyMap<string, GraphNode>,
): string {
  let chosen: string | undefined;
  let depth = -1;
  for (const path of paths) {
    const node = graph.get(path);
    if (node === undefined) throw new Error(`sealed graph omitted ${path}`);
    if (node.depth <= depth) continue;
    chosen = path;
    depth = node.depth;
  }
  if (chosen === undefined) throw new Error("sealed check queue was empty");
  return chosen;
}
