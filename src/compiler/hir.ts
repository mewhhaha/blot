import { checkProgram } from "./typecheck.ts";
import type { Imports } from "../comptime/eval.ts";
import { loadProgram, type Loaded } from "./frontend.ts";
import type { BlotRuntimeModule } from "../runtime/hir.ts";
import { stageModule } from "../stage.ts";
import { exportResidualRuntimeHir } from "./lower/runtime_hir.ts";

const hirByLoadedRevision = new WeakMap<Loaded, BlotRuntimeModule>();

/**
 * Runs Blot's TypeScript semantics and lowers the settled program directly to
 * validated Runtime HIR. This module is the Node counterpart of
 * `compiler/src/hir.rs`; target emission begins only after this boundary.
 */
export async function lowerRuntimeHir(
  path: string,
): Promise<BlotRuntimeModule> {
  const loaded = await loadProgram(path);
  const cached = hirByLoadedRevision.get(loaded);
  if (cached !== undefined) return cached;

  const checked = await checkProgram(path);
  if (loaded.closure.tag !== "closure") {
    throw new Error("a module must load as a closure");
  }

  let imports: Imports = new Map();
  if (loaded.closure.imports !== undefined) {
    imports = loaded.closure.imports;
  }
  const staged = stageModule(
    loaded.module,
    checked.values,
    imports,
    checked.shapes,
    checked.recordAdaptations,
  );
  const hir = freezeSnapshot(exportResidualRuntimeHir(
    loaded.path,
    checked,
    staged.exports,
    "blot:default",
    staged.module,
  ));
  hirByLoadedRevision.set(loaded, hir);
  return hir;
}

function freezeSnapshot<Value>(
  value: Value,
  seen: WeakSet<object> = new WeakSet(),
): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  if (seen.has(value)) return value;
  seen.add(value);
  const object = value as object & Record<PropertyKey, unknown>;
  for (const property of Reflect.ownKeys(object)) {
    freezeSnapshot(object[property], seen);
  }
  return Object.freeze(value);
}
