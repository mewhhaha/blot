import type { Diagnostic, DiagnosticCode } from "../../diagnostic.ts";
import type { Decl, Expr, Module, Pattern, Span } from "../../syntax/ast.ts";
import type { Rule } from "../../syntax/cursor.ts";
import type {
  CompilerReadabilityFact,
  CompilerSimplificationFact,
  CompilerSpecializationFact,
} from "../../compiler/wasm.ts";

export type AstNode = Module | Decl | Expr | Pattern;

export interface AstPath<Node extends AstNode = AstNode> {
  readonly node: Node;
  readonly parent: AstNode | null;
  readonly ancestors: readonly AstNode[];
}

export type LintSeverity = "warning" | "hint";

export interface LintEdit {
  readonly span: Span;
  readonly replacement: string;
}

export interface LintFix {
  readonly title: string;
  readonly edits: readonly LintEdit[];
  readonly kind: "quickfix" | "refactor.rewrite";
  readonly validation: "parse" | "check" | "check-interface";
}

export interface LintDiagnostic extends Diagnostic {
  readonly severity: LintSeverity;
  readonly fix: LintFix | null;
}

export interface LintReport {
  readonly message: string;
  readonly span: Span;
  readonly fix?: LintFix | null;
}

export interface LintRuleContext {
  readonly module: Module;
  readonly source: string;
  readonly cst: Rule;
  readonly specializations: readonly CompilerSpecializationFact[];
  readonly simplifications: readonly CompilerSimplificationFact[];
  readonly readability: readonly CompilerReadabilityFact[];
  sourceText(node: { readonly span: Span }): string;
  report(report: LintReport): void;
  fix(
    span: Span,
    title: string,
    replacement: string,
    validation?: "parse" | "check" | "check-interface",
    kind?: "quickfix" | "refactor.rewrite",
  ): LintFix | null;
  fixEdits(options: LintFix): LintFix | null;
  hasConcreteOrigin(
    node: { readonly span: Span },
    ruleName: string,
  ): boolean;
  concreteHasDescendant(
    node: { readonly span: Span },
    ruleName: string,
    descendantName: string,
  ): boolean;
}

export interface LintVisitors {
  readonly module?: (path: AstPath<Module>) => void;
  readonly declaration?: (path: AstPath<Decl>) => void;
  readonly expression?: (path: AstPath<Expr>) => void;
  readonly pattern?: (path: AstPath<Pattern>) => void;
  readonly concrete?: (rule: Rule, ancestors: readonly Rule[]) => void;
}

/**
 * The evidence that establishes one rule's diagnostic claim.
 *
 * - `syntax-only`: the claim follows from the parsed syntax alone (AST plus
 *   concrete origin queries). The diagnostic publishes without any compiler
 *   work beyond parsing.
 * - `semantic-fact`: the claim follows from compiler-provided semantic facts
 *   (specializations, simplifications, readability) read during detection.
 *   The diagnostic publishes once those facts confirm it, without checking
 *   any proposed rewrite.
 * - `rewrite-validation`: the claim itself depends on a proposed rewrite
 *   checking (or preserving the module interface). The diagnostic publishes
 *   only after that validation succeeds, in the lower-priority validation
 *   stage; an unproven claim is never published.
 *
 * Evidence gates diagnostic publication only. Every fix keeps its own
 * validation obligation (`LintFix.validation`): a `check` or
 * `check-interface` fix is validated before its edits are returned, either
 * eagerly for clients without resolve support or when its action resolves.
 */
export type LintEvidence =
  | "syntax-only"
  | "semantic-fact"
  | "rewrite-validation";

export interface LintRule {
  readonly name: string;
  readonly code: DiagnosticCode;
  readonly severity: LintSeverity;
  readonly evidence: LintEvidence;
  create(context: LintRuleContext): LintVisitors;
}
