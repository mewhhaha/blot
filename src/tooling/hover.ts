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
  const binding = bindingHoverAt(module, source, cst, offset, checked);
  if (binding === null) return null;
  if (binding.markdown.includes("**Related value:** `Op.negate`")) {
    return {
      ...binding,
      markdown: `${binding.markdown}\n\nBuilt-in numeric members include \`Int.negate\`, \`F64.negate\`, and \`F32.negate\`.`,
    };
  }
  return binding;
}
