import { createHash } from "node:crypto";
import { resolve } from "@std/path";
import type { Loaded } from "../../src/compiler/frontend.ts";
import { refreshProgram } from "../../src/compiler/frontend.ts";
import { checkProgram } from "../../src/compiler/typecheck.ts";
import { liveDeclarations } from "../../src/syntax/live.ts";
import { encodePortableModule } from "../../src/syntax/portable.ts";

export interface SealedCheckResult {
  readonly type: string;
  readonly effects: string;
  readonly moduleInterface: string;
  readonly rechecked: readonly string[];
  readonly cacheHit: boolean;
  readonly graphReset: boolean;
}

interface Summary {
  readonly type: string;
  readonly effects: string;
  readonly moduleInterface: string;
}

interface GraphNode {
  readonly loaded: Loaded;
  readonly depth: number;
  readonly dependencies: readonly Dependency[];
  readonly parents: ReadonlySet<string>;
}

interface Dependency {
  readonly specifier: string;
  readonly path: string;
}

interface SnapshotNode {
  readonly inputRevision: string;
  readonly dependencies: readonly Dependency[];
  readonly baseFingerprint: string;
  readonly fingerprint: string;
  readonly moduleInterface: string;
}

interface RootState {
  readonly nodes: Map<string, SnapshotNode>;
  summary: Summary;
}

/**
 * Experimental check-only incremental cache.
 *
 * Blot can evaluate imported closures while checking, so a type signature alone
 * is not an honest module boundary. The cache therefore fingerprints both the
 * canonical module type and the live source slice that a downstream compile-time
 * evaluation can observe. Dead private declarations are deliberately forgotten.
 *
 * This does not feed Runtime HIR or artifact caching. It measures whether a real
 * sealing phase could make the Node development check loop cheaper before the
 * compiler contract is changed.
 */
export class SealedCheckSession {
  readonly #roots = new Map<string, RootState>();

  async check(path: string): Promise<SealedCheckResult> {
    const rootPath = resolve(path);
    const root = await refreshProgram(rootPath);
    const graph = collectGraph(root);
    const previous = this.#roots.get(rootPath);
    if (previous === undefined || !sameGraph(previous.nodes, graph)) {
      return await this.#prime(rootPath, graph, previous !== undefined);
    }

    const changed = new Set<string>();
    for (const [nodePath, node] of graph) {
      const snapshot = previous.nodes.get(nodePath);
      if (
        snapshot === undefined ||
        snapshot.inputRevision !== loadedInputRevision(node.loaded)
      ) {
        changed.add(nodePath);
      }
    }
    if (changed.size === 0) {
      return {
        ...previous.summary,
        rechecked: [],
        cacheHit: true,
        graphReset: false,
      };
    }

    const pending = new Set(changed);
    const rechecked: string[] = [];
    while (pending.size > 0) {
      const nodePath = deepest(pending, graph);
      pending.delete(nodePath);
      const node = graph.get(nodePath);
      const old = previous.nodes.get(nodePath);
      if (node === undefined || old === undefined) {
        throw new Error(`sealed check graph lost ${nodePath}`);
      }

      const checked = await checkProgram(nodePath);
      const moduleInterface = observableTypeBoundary(checked.type, checked.effects);
      const baseFingerprint = moduleBaseFingerprint(
        node.loaded,
        moduleInterface,
      );
      const fingerprint = moduleFingerprint(
        baseFingerprint,
        node.dependencies,
        previous.nodes,
      );
      previous.nodes.set(nodePath, {
        inputRevision: loadedInputRevision(node.loaded),
        dependencies: node.dependencies,
        baseFingerprint,
        fingerprint,
        moduleInterface,
      });
      rechecked.push(nodePath);

      if (nodePath === rootPath) previous.summary = summarize(checked);
      if (fingerprint !== old.fingerprint) {
        for (const parent of node.parents) pending.add(parent);
      }
    }

    return {
      ...previous.summary,
      rechecked,
      cacheHit: !rechecked.includes(rootPath),
      graphReset: false,
    };
  }

  async #prime(
    rootPath: string,
    graph: ReadonlyMap<string, GraphNode>,
    graphReset: boolean,
  ): Promise<SealedCheckResult> {
    const checked = await checkProgram(rootPath);
    const nodes = new Map<string, SnapshotNode>();
    const order = [...graph].sort((left, right) =>
      right[1].depth - left[1].depth
    );
    for (const [nodePath, node] of order) {
      const moduleChecked = nodePath === rootPath ? checked : await checkProgram(nodePath);
      const moduleInterface = observableTypeBoundary(moduleChecked.type, moduleChecked.effects);
      const baseFingerprint = moduleBaseFingerprint(
        node.loaded,
        moduleInterface,
      );
      const fingerprint = moduleFingerprint(
        baseFingerprint,
        node.dependencies,
        nodes,
      );
      nodes.set(nodePath, {
        inputRevision: loadedInputRevision(node.loaded),
        dependencies: node.dependencies,
        baseFingerprint,
        fingerprint,
        moduleInterface,
      });
    }
    const summary = summarize(checked);
    this.#roots.set(rootPath, { nodes, summary });
    return {
      ...summary,
      rechecked: [...graph.keys()],
      cacheHit: false,
      graphReset,
    };
  }
}

function summarize(checked: Awaited<ReturnType<typeof checkProgram>>): Summary {
  return {
    type: checked.type,
    effects: checked.effects,
    moduleInterface: observableTypeBoundary(checked.type, checked.effects),
  };
}

/** A type-only seal, useful for demonstrating why Blot needs more than types. */
export function typeOnlyFingerprint(type: string, effects: string): string {
  return digest(observableTypeBoundary(type, effects));
}

function observableTypeBoundary(type: string, effects: string): string {
  return JSON.stringify({ type, effects });
}

/**
 * The source part of the observable boundary.
 *
 * The evaluator and backend already use the same liveness calculation. Keeping
 * only live declarations means a changed dead private binding is checked in its
 * own module but does not invalidate importers.
 */
export function liveModuleFingerprint(loaded: Loaded): string {
  const live = liveDeclarations(loaded.module.declarations, loaded.module.result);
  const sliced = {
    ...loaded.module,
    declarations: loaded.module.declarations.filter((declaration) =>
      live.has(declaration)
    ),
  };
  return digest(JSON.stringify(encodePortableModule(sliced)));
}

function loadedInputRevision(loaded: Loaded): string {
  return digest(JSON.stringify({
    source: loaded.source,
    includedFiles: [...loaded.includedFiles].map(([specifier, included]) => ({
      specifier,
      path: included.path,
      source: included.source,
    })),
    capsule: loaded.storage.tag === "capsule" ? loaded.storage.source : null,
  }));
}

function moduleBaseFingerprint(
  loaded: Loaded,
  moduleInterface: string,
): string {
  return digest(JSON.stringify({
    moduleInterface,
    liveSource: liveModuleFingerprint(loaded),
    includedFiles: [...loaded.includedFiles].map(([specifier, included]) => ({
      specifier,
      path: included.path,
      source: included.source,
    })),
    capsule: loaded.storage.tag === "capsule" ? loaded.storage.source : null,
  }));
}

function moduleFingerprint(
  baseFingerprint: string,
  dependencies: readonly Dependency[],
  snapshots: ReadonlyMap<string, SnapshotNode>,
): string {
  const dependencyFingerprints = dependencies.map((dependency) => {
    const snapshot = snapshots.get(dependency.path);
    if (snapshot === undefined) {
      throw new Error(`sealed interface omitted ${dependency.path}`);
    }
    return [dependency.specifier, snapshot.fingerprint] as const;
  });
  return digest(JSON.stringify({ baseFingerprint, dependencyFingerprints }));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function collectGraph(root: Loaded): Map<string, GraphNode> {
  const mutable = new Map<
    string,
    {
      loaded: Loaded;
      depth: number;
      dependencies: Dependency[];
      parents: Set<string>;
    }
  >();

  const visit = (loaded: Loaded, depth: number): void => {
    let node = mutable.get(loaded.path);
    if (node === undefined) {
      node = {
        loaded,
        depth,
        dependencies: [],
        parents: new Set(),
      };
      mutable.set(loaded.path, node);
    } else {
      if (depth > node.depth) node.depth = depth;
      node.loaded = loaded;
      node.dependencies.length = 0;
    }
    for (const [specifier, dependency] of loaded.dependencies) {
      node.dependencies.push({ specifier, path: dependency.path });
      visit(dependency, depth + 1);
      const child = mutable.get(dependency.path);
      if (child === undefined) {
        throw new Error(`sealed graph omitted dependency ${dependency.path}`);
      }
      child.parents.add(loaded.path);
    }
  };
  visit(root, 0);

  return new Map(
    [...mutable].map(([path, node]) => [path, {
      loaded: node.loaded,
      depth: node.depth,
      dependencies: node.dependencies,
      parents: node.parents,
    }]),
  );
}

function sameGraph(
  previous: ReadonlyMap<string, SnapshotNode>,
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

function deepest(
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
