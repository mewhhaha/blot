// The first Core boundary: pure definitions and sequenced computations.
//
// Surface blocks carry declarations in one array because that is convenient
// for parsing. Every consumer used to rediscover which declarations survive
// demand analysis and which of them are `<-` binds. This elaboration is the one
// answer shared by evaluation and both backends. Expressions remain surface
// values for now; control and effect lowering can move behind this boundary
// without changing its ordering contract.

import type { Decl, Expr } from "../syntax/ast.ts";
import { liveDeclarations } from "../syntax/live.ts";

export type CoreStep =
  | { readonly tag: "define"; readonly declaration: Decl }
  | { readonly tag: "bind"; readonly declaration: Decl };

export type CoreResult =
  | { readonly tag: "return"; readonly value: Expr }
  | { readonly tag: "tail"; readonly computation: Expr };

export interface CoreComputation {
  readonly steps: readonly CoreStep[];
  readonly result: CoreResult;
}

export function coreResultExpression(result: CoreResult): Expr {
  if (result.tag === "return") return result.value;
  return result.computation;
}

export function elaborateComputation(
  declarations: readonly Decl[],
  result: Expr,
  resultEffects: "pure" | "ambient",
): CoreComputation {
  const live = liveDeclarations(declarations, result);
  const steps: CoreStep[] = [];
  for (const declaration of declarations) {
    if (!live.has(declaration)) continue;
    if (declaration.tag === "binding" && declaration.kind === "effect") {
      steps.push({ tag: "bind", declaration });
    } else {
      steps.push({ tag: "define", declaration });
    }
  }
  let coreResult: CoreResult;
  if (resultEffects === "pure") coreResult = { tag: "return", value: result };
  else coreResult = { tag: "tail", computation: result };
  return { steps, result: coreResult };
}
