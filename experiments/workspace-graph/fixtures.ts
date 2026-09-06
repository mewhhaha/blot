import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Loaded } from "../../src/load.ts";

interface DiamondNode {
  readonly name: string;
  readonly dependencies: readonly string[];
}

function diamondNodes(depth: number): readonly DiamondNode[] {
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 32) {
    throw new RangeError("diamond depth must be an integer from 1 through 32");
  }
  const nodes: DiamondNode[] = [{ name: "leaf.blot", dependencies: [] }];
  let previous = ["leaf.blot"];
  for (let level = 1; level <= depth; level += 1) {
    const names = [`level-${level}-left.blot`, `level-${level}-right.blot`];
    for (const name of names) nodes.push({ name, dependencies: previous });
    previous = names;
  }
  nodes.push({ name: "root.blot", dependencies: previous });
  return nodes;
}

/** The source version qualifies the same topology through the real compiler. */
export async function writeDiamond(directory: string, depth: number) {
  const nodes = diamondNodes(depth);
  for (const node of nodes) {
    let source = "return 1\n";
    if (node.dependencies.length === 1) {
      source = `const first = import "./${node.dependencies[0]}"\n` +
        "return @int.add first first\n";
    } else if (node.dependencies.length === 2) {
      source = `const first = import "./${node.dependencies[0]}"\n` +
        `const second = import "./${node.dependencies[1]}"\n` +
        "return @int.add first second\n";
    }
    await writeFile(join(directory, node.name), source);
  }
  return {
    root: join(directory, "root.blot"),
    moduleCount: nodes.length,
    expected: 1n << BigInt(depth + 1),
  };
}

/** Retained nodes isolate host traversal from parsing and inference. */
export function cachedDiamond(depth: number, onVisit: (path: string) => void) {
  const cache = new Map<string, Loaded>();
  for (const node of diamondNodes(depth)) {
    const path = resolve("workspace-graph-fixture", node.name);
    const dependencies = new Map<string, Loaded>();
    for (const name of node.dependencies) {
      const dependency = cache.get(resolve("workspace-graph-fixture", name));
      if (dependency === undefined) throw new Error(`missing fixture ${name}`);
      dependencies.set(`./${name}`, dependency);
    }
    cache.set(path, {
      path,
      source: "",
      storage: { tag: "snapshot", digest: `fixture:${node.name}` },
      includedFiles: new Map(),
      get module(): never {
        throw new Error("unchanged graph traversal materialized syntax");
      },
      get dependencies() {
        onVisit(path);
        return dependencies;
      },
    });
  }
  return { cache, root: resolve("workspace-graph-fixture", "root.blot") };
}
