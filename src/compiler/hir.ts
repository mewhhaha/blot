import { checkProgram } from "./typecheck.ts";
import type { CheckResult } from "../check/mod.ts";
import type { Imports } from "../comptime/eval.ts";
import { type Loaded, loadProgram } from "./frontend.ts";
import {
  type BlotRuntimeModule,
  validateBlotRuntimeModule,
} from "../runtime/hir.ts";
import { stageModule } from "../stage.ts";
import { elaborateModule } from "../core/computation.ts";
import { CompilerTargetRefusal } from "./backend.ts";
import { exportResidualRuntimeHir } from "./lower/runtime_hir.ts";

const hirByLoadedRevision = new WeakMap<Loaded, BlotRuntimeModule>();

/**
 * Runs Blot's TypeScript semantics and lowers the settled program directly to
 * validated Runtime HIR. This module is the Node counterpart of
 * `compiler/src/hir.rs`; target emission begins only after this boundary.
 */
export async function lowerRuntimeHir(
  path: string,
  existingCheck?: CheckResult,
): Promise<BlotRuntimeModule> {
  const loaded = await loadProgram(path);
  const cached = hirByLoadedRevision.get(loaded);
  if (cached !== undefined) return cached;

  let checked = existingCheck;
  if (checked === undefined) checked = await checkProgram(path);
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
    checked.resultEffects,
    checked.shapes,
    checked.recordAdaptations,
  );
  const runtimeExports = staged.exports.filter((exported) =>
    exported.phase === "runtime"
  );
  // A staged value is already independent of runtime initialization. An
  // unresolved value combined with a host capability is the Node-side witness
  // for the host calls the Rust evaluator records while preparing the root.
  const residualTopLevel = runtimeExports.some((exported) =>
    exported.value === undefined
  );
  const residualTypes = new Map(checked.expressionTypes);
  residualTypes.set(staged.module.result, checked.moduleType);
  const residualCore = elaborateModule(
    staged.module,
    residualTypes,
    checked.moduleType,
    true,
    checked.comptimeValues,
    checked.opens,
    checked.recordAdaptations,
    checked.arrayProofs,
    new Map([...checked.shapes, ...staged.shapes]),
    checked.variants,
    checked.optionalCases,
    checked.grants,
    checked.modules,
  );
  const hir = freezeSnapshot(validateBlotRuntimeModule(exportResidualRuntimeHir(
    loaded.path,
    checked,
    staged.exports,
    "blot:default",
    residualCore,
  )));
  if (
    residualTopLevel && hir.capabilities.length > 0 &&
    runtimeExports.length > 1
  ) {
    throw new CompilerTargetRefusal(
      "an effectful module top level cannot be replayed across multiple runtime fields; return one runtime value or move the effect into a returned function",
    );
  }
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
