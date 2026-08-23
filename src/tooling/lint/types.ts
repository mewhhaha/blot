import type { Diagnostic, DiagnosticCode } from "../../diagnostic.ts";
import type { Decl, Expr, Module, Pattern, Span } from "../../syntax/ast.ts";
import type { Rule } from "../../syntax/cursor.ts";

export type AstNode = Module | Decl | Expr | Pattern;

export interface AstPath<Node extends AstNode = AstNode> {
  readonly node: Node;
  readonly parent: AstNode | null;
  readonly ancestors: readonly AstNode[];
}

export type LintSeverity = "warning" | "hint";

export interface LintFix {
  readonly title: string;
  readonly span: Span;
  readonly replacement: string;
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
  sourceText(node: { readonly span: Span }): string;
  report(report: LintReport): void;
  fix(
    span: Span,
    title: string,
    replacement: string,
    validation?: "parse" | "check" | "check-interface",
  ): LintFix | null;
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

export interface LintRule {
  readonly name: string;
  readonly code: DiagnosticCode;
  readonly severity: LintSeverity;
  create(context: LintRuleContext): LintVisitors;
}
