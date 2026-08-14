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
  readonly fingerprint: string;
}

interface RootState {
  readonly nodes: Map<string, SnapshotNode>;
  summary: Summary;
}

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
      if (
        previous.nodes.get(nodePath)?.inputRevision !==
          inputRevision(node.loaded)
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

    // Publish only after every recheck succeeds, so a failed parent cannot leave
    // child snapshots from a mixed revision behind.
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
      const fingerprint = moduleFingerprint(
        node.loaded,
        checked.type,
        checked.effects,
        node.dependencies,
        nodes,
      );
      nodes.set(nodePath, {
        inputRevision: inputRevision(node.loaded),
        dependencies: node.dependencies,
        fingerprint,
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
      const result = nodePath === rootPath
        ? checked
        : await checkProgram(nodePath);
      nodes.set(nodePath, {
        inputRevision: inputRevision(node.loaded),
        dependencies: node.dependencies,
        fingerprint: moduleFingerprint(
          node.loaded,
          result.type,
          result.effects,
          node.dependencies,
          nodes,
        ),
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
    typeBoundary: typeBoundary(checked.type, checked.effects),
  };
}

export function typeOnlyFingerprint(type: string, effects: string): string {
  return hash(typeBoundary(type, effects));
}

function typeBoundary(type: string, effects: string): string {
  return JSON.stringify({ type, effects });
}

function inputRevision(loaded: Loaded): string {
  return hash(JSON.stringify({
    source: loaded.source,
    includedFiles: [...loaded.includedFiles].map(([specifier, included]) => ({
      specifier,
      path: included.path,
      source: included.source,
    })),
    capsule: loaded.storage.tag === "capsule" ? loaded.storage.source : null,
  }));
}

function moduleFingerprint(
  loaded: Loaded,
  type: string,
  effects: string,
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
  return hash(JSON.stringify({
    typeBoundary: typeBoundary(type, effects),
    checkedSource: checkedSourceFingerprint(loaded),
    includedFiles: [...loaded.includedFiles].map(([specifier, included]) => ({
      specifier,
      path: included.path,
      source: included.source,
    })),
    capsule: loaded.storage.tag === "capsule" ? loaded.storage.source : null,
    dependencyFingerprints,
  }));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
