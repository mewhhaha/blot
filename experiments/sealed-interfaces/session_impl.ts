import { createHash } from "node:crypto";
import { resolve } from "@std/path";
import type { Loaded } from "../../src/compiler/frontend.ts";
import { refreshProgram } from "../../src/compiler/frontend.ts";
import { checkProgram } from "../../src/compiler/typecheck.ts";
import { checkedSourceFingerprint } from "./boundary.ts";
import {
  collectGraph,
  deepest,
  type Dependency,
  type GraphNode,
  sameGraph,
} from "./graph.ts";

export interface SealedCheckResult {
  readonly type: string;
  readonly effects: string;
  readonly typeBoundary: string;
  readonly rechecked: readonly string[];
  readonly cacheHit: boolean;
  readonly graphReset: boolean;
}

interface Summary {
  readonly type: string;
  readonly effects: string;
  readonly typeBoundary: string;
}

interface SnapshotNode {
  readonly inputRevision: string;
  readonly dependencies: readonly Dependency[];
  readonly baseFingerprint: string;
  readonly fingerprint: string;
  readonly typeBoundary: string;
}

interface RootState {
  readonly nodes: Map<string, SnapshotNode>;
  summary: Summary;
}

/**
 * Experimental check-only incremental cache.
 *
 * Blot can evaluate imported closures while checking, so a result type alone is
 * not an honest module boundary. The cache combines the reported result/effects
 * boundary with a conservative semantic source fingerprint. It only forgets
 * dead declarations whose inference isolation is explicit and trivial.
 *
 * This does not feed Runtime HIR or artifact caching. It measures whether a real
 * checked-module boundary could make the Node development loop cheaper before
 * the compiler contract is changed.
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

    // Build the next state transactionally. A parent may reject after one of its
    // children was rechecked successfully; publishing the child early would
    // leave a mixed revision behind and could turn the next request into a
    // false cache hit for the still-invalid program.
    const nodes = new Map(previous.nodes);
    let summary = previous.summary;
    const pending = new Set(changed);
    const rechecked: string[] = [];
    while (pending.size > 0) {
      const nodePath = deepest(pending, graph);
      pending.delete(nodePath);
      const node = graph.get(nodePath);
      const old = nodes.get(nodePath);
      if (node === undefined || old === undefined) {
        throw new Error(`sealed check graph lost ${nodePath}`);
      }

      const checked = await checkProgram(nodePath);
      const typeBoundary = observableTypeBoundary(checked.type, checked.effects);
      const baseFingerprint = moduleBaseFingerprint(node.loaded, typeBoundary);
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
        typeBoundary,
      });
      rechecked.push(nodePath);

      if (nodePath === rootPath) summary = summarize(checked);
      if (fingerprint !== old.fingerprint) {
        for (const parent of node.parents) pending.add(parent);
      }
    }

    this.#roots.set(rootPath, { nodes, summary });
    return {
      ...summary,
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
      const moduleChecked = nodePath === rootPath
        ? checked
        : await checkProgram(nodePath);
      const typeBoundary = observableTypeBoundary(
        moduleChecked.type,
        moduleChecked.effects,
      );
      const baseFingerprint = moduleBaseFingerprint(node.loaded, typeBoundary);
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
        typeBoundary,
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
    typeBoundary: observableTypeBoundary(checked.type, checked.effects),
  };
}

/** A type-only seal, useful for demonstrating why Blot needs more than types. */
export function typeOnlyFingerprint(type: string, effects: string): string {
  return digest(observableTypeBoundary(type, effects));
}

function observableTypeBoundary(type: string, effects: string): string {
  return JSON.stringify({ type, effects });
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
  typeBoundary: string,
): string {
  return digest(JSON.stringify({
    typeBoundary,
    checkedSource: checkedSourceFingerprint(loaded),
    includedFiles: [...loaded.includedFiles].map(([specifier, included]) => ({
      specifier,
      path: included.path,
      source: included.source,
    })),
    capsule: loaded.storage.tag === "capsule" ? loaded.storage.source : null,
  }));
}

/**
 * Propagated boundary fingerprint.
 *
 * Direct dependencies are deliberately unconditional in this experiment. A
 * changed dependency therefore forces every importer boundary to change even
 * when rechecking an intermediate module produces the same local boundary. That
 * is conservative; re-sealing dependency changes needs a richer checked
 * interface than this experiment currently has.
 */
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
