import { load, type Loaded, refreshLoadedModules } from "../load.ts";

/**
 * Compiler-owned source-graph entry points.
 *
 * The graph implementation is shared with tooling, but compiler phases import
 * it through this module so the host/compiler boundary remains explicit.
 */
export async function loadProgram(path: string): Promise<Loaded> {
  return await load(path);
}

/** Refreshes disk-backed inputs, then returns the current root graph. */
export async function refreshProgram(path: string): Promise<Loaded> {
  await refreshLoadedModules();
  return await load(path);
}

export type { Loaded };
