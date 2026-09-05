import type { CompilerAnalysis } from "../compiler.ts";
import type { Module, Span } from "../syntax/ast.ts";
import type { Rule } from "../syntax/cursor.ts";
import { hoverAt as bindingHoverAt } from "./binding_hover.ts";
import { controlFlowAt } from "./control_flow.ts";

export interface HoverDescription {
  readonly markdown: string;
  readonly span: Span;
}

/** Control syntax precedes the ordinary binding and token documentation. */
export function hoverAt(
  module: Module,
  source: string,
  cst: Rule,
  offset: number,
  checked: CompilerAnalysis | null,
): HoverDescription | null {
  const control = controlFlowAt(module, source, cst, offset);
  if (control !== null) return control;
  return bindingHoverAt(module, source, cst, offset, checked);
}
