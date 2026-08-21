import { createHash } from "node:crypto";
import { resolve } from "@std/path";
import type { Loaded } from "./frontend.ts";
import { refreshProgram } from "./frontend.ts";
import { checkProgram } from "./typecheck.ts";
import { checkedSourceFingerprint } from "./checked_boundary.ts";
import { relationalSummaryFingerprint } from "../check/relational.ts";
import { loadedRevisionKey } from "./revision.ts";

interface Dependency {
  readonly specifier: string;
  readonly path: string;
}

interface GraphNode {
  readonly loaded: Loaded;
  readonly depth: number;
  readonly dependencies: readonly Dependency[];
  readonly parents: ReadonlySet<string>;
}

interface SnapshotNode {
  readonly inputRevision: string;
  readonly dependencies: readonly Dependency[];
  readonly fingerprint: string;
}

interface Summary {
  readonly type: string;
  readonly effects: string;
}

interface RootState {
  readonly nodes: Map<string, SnapshotNode>;
  summary: Summary;
  checked: Checked;
}

export interface IncrementalCheckResult extends Summary {
  readonly checked: Checked;
  readonly rechecked: readonly string[];
  readonly cacheHit: boolean;
  readonly graphReset: boolean;
}

/**
 * Resident checked-interface cache with conservative sealed propagation.
 * Live inference state never crosses a module boundary: a changed module is
 * freshly checked, and its exact immutable revision fingerprint decides
 * whether parents need the same treatment. Source origins are backend facts,
 * so even a type-neutral edit propagates to importers that inline them.
 */
export class IncrementalCheckCache {
  readonly #roots = new Map<string, RootState>();

  async check(path: string): Promise<IncrementalCheckResult> {
    const rootPath = resolve(path);
    const root = await refreshProgram(rootPath);
    const graph = collectGraph(root);
    const previous = this.#roots.get(rootPath);
    if (previous === undefined || !sameGraph(previous.nodes, graph)) {
      return await this.#prime(rootPath, graph, previous !== undefined);
    }

    const changed = new Set<string>();
    for (const [nodePath, node] of graph) {
      const old = previous.nodes.get(nodePath);
      if (
        old === undefined || old.inputRevision !== inputRevision(node.loaded)
      ) {
        changed.add(nodePath);
      }
    }
    if (changed.size === 0) {
      return {
        ...previous.summary,
        checked: previous.checked,
        rechecked: [],
        cacheHit: true,
        graphReset: false,
      };
    }

    // Publish only after every fresh check succeeds.
    const nodes = new Map(previous.nodes);
    let summary = previous.summary;
    let rootChecked = previous.checked;
    const pending = new Set(changed);
    const rechecked: string[] = [];
    while (pending.size > 0) {
      const nodePath = deepest(pending, graph);
      pending.delete(nodePath);
      const node = graph.get(nodePath);
      const old = nodes.get(nodePath);
      if (node === undefined || old === undefined) {
        throw new Error(`incremental check graph lost ${nodePath}`);
      }
      const checked = await checkProgram(nodePath);
      const fingerprint = moduleFingerprint(
        node.loaded,
        checked,
        node.dependencies,
        nodes,
      );
      nodes.set(nodePath, {
        inputRevision: inputRevision(node.loaded),
        dependencies: node.dependencies,
        fingerprint,
      });
      rechecked.push(nodePath);
      if (nodePath === rootPath) {
        summary = summarize(checked);
        rootChecked = checked;
      }
      if (fingerprint !== old.fingerprint) {
        for (const parent of node.parents) pending.add(parent);
      }
    }

    this.#roots.set(rootPath, { nodes, summary, checked: rootChecked });
    return {
      ...summary,
      checked: rootChecked,
      rechecked,
      cacheHit: !rechecked.includes(rootPath),
      graphReset: false,
    };
  }

  async #prime(
    rootPath: string,
    graph: ReadonlyMap<string, GraphNode>,
    graphReset: boolean,
  ): Promise<IncrementalCheckResult> {
    const rootChecked = await checkProgram(rootPath);
    const nodes = new Map<string, SnapshotNode>();
    const order = [...graph].sort((left, right) =>
      right[1].depth - left[1].depth
    );
    for (const [nodePath, node] of order) {
      let checked = rootChecked;
      if (nodePath !== rootPath) checked = await checkProgram(nodePath);
      nodes.set(nodePath, {
        inputRevision: inputRevision(node.loaded),
        dependencies: node.dependencies,
        fingerprint: moduleFingerprint(
          node.loaded,
          checked,
          node.dependencies,
          nodes,
        ),
      });
    }
    const summary = summarize(rootChecked);
    this.#roots.set(rootPath, { nodes, summary, checked: rootChecked });
    return {
      ...summary,
      checked: rootChecked,
      rechecked: [...graph.keys()],
      cacheHit: false,
      graphReset,
    };
  }
}

type Checked = Awaited<ReturnType<typeof checkProgram>>;

function summarize(checked: Checked): Summary {
  return { type: checked.type, effects: checked.effects };
}

function inputRevision(loaded: Loaded): string {
  return loadedRevisionKey(loaded);
}

function moduleFingerprint(
  loaded: Loaded,
  checked: Checked,
  dependencies: readonly Dependency[],
  snapshots: ReadonlyMap<string, SnapshotNode>,
): string {
  const dependencyFingerprints = dependencies.map((dependency) => {
    const snapshot = snapshots.get(dependency.path);
    if (snapshot === undefined) {
      throw new Error(`checked interface omitted ${dependency.path}`);
    }
    return [dependency.specifier, snapshot.fingerprint] as const;
  });
  let capsule: string | null = null;
  if (loaded.storage.tag === "capsule") capsule = loaded.storage.source;
  return hash(JSON.stringify({
    inputRevision: inputRevision(loaded),
    type: checked.type,
    effects: checked.effects,
    relational: relationalSummaryFingerprint(checked.values),
    checkedSource: checkedSourceFingerprint(loaded),
    includedFiles: [...loaded.includedFiles].map(([specifier, included]) => ({
      specifier,
      path: included.path,
      source: included.source,
    })),
    capsule,
    dependencyFingerprints,
  }));
}

function collectGraph(root: Loaded): Map<string, GraphNode> {
  const loadedByPath = new Map<string, Loaded>();
  const dependenciesByPath = new Map<string, readonly Dependency[]>();
  const parentsByPath = new Map<string, Set<string>>();
  const pending = [root];
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
      throw new Error(
        `incremental check graph contains an import cycle at ${path}`,
      );
    }
    active.add(path);
    const parents = parentsByPath.get(path);
    if (parents === undefined || parents.size === 0) {
      throw new Error(`incremental check graph cannot place ${path}`);
    }
    let depth = 0;
    for (const parent of parents) depth = Math.max(depth, depthOf(parent) + 1);
    active.delete(path);
    depths.set(path, depth);
    return depth;
  };

  return new Map([...loadedByPath].map(([path, loaded]) => {
    let dependencies: readonly Dependency[] = [];
    const foundDependencies = dependenciesByPath.get(path);
    if (foundDependencies !== undefined) dependencies = foundDependencies;
    let parents: ReadonlySet<string> = new Set();
    const foundParents = parentsByPath.get(path);
    if (foundParents !== undefined) parents = foundParents;
    return [path, {
      loaded,
      depth: depthOf(path),
      dependencies,
      parents,
    }];
  }));
}

function sameGraph(
  previous: ReadonlyMap<string, SnapshotNode>,
  current: ReadonlyMap<string, GraphNode>,
): boolean {
  if (previous.size !== current.size) return false;
  for (const [path, node] of current) {
    const old = previous.get(path);
    if (
      old === undefined || old.dependencies.length !== node.dependencies.length
    ) {
      return false;
    }
    for (let index = 0; index < node.dependencies.length; index += 1) {
      const left = old.dependencies[index];
      const right = node.dependencies[index];
      if (
        left === undefined || right === undefined ||
        left.specifier !== right.specifier || left.path !== right.path
      ) return false;
    }
  }
  return true;
}

function deepest(
  paths: ReadonlySet<string>,
  graph: ReadonlyMap<string, GraphNode>,
): string {
  let chosen: string | undefined;
  let depth = -1;
  for (const path of paths) {
    const node = graph.get(path);
    if (node === undefined) {
      throw new Error(`incremental graph omitted ${path}`);
    }
    if (node.depth <= depth) continue;
    chosen = path;
    depth = node.depth;
  }
  if (chosen === undefined) {
    throw new Error("incremental check queue was empty");
  }
  return chosen;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Test oracle demonstrating why a type-only boundary is insufficient. */
export function typeOnlyFingerprint(type: string, effects: string): string {
  return hash(JSON.stringify({ type, effects }));
}
