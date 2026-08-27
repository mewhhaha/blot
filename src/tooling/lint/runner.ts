import type { Decl, Expr, Module, Pattern } from "../../syntax/ast.ts";
import type { Rule } from "../../syntax/cursor.ts";
import type { CompilerSpecializationFact } from "../../compiler/wasm.ts";
import { DEFAULT_LINT_RULES } from "./rules.ts";
import type {
  AstNode,
  LintDiagnostic,
  LintRule,
  LintRuleContext,
  LintVisitors,
} from "./types.ts";
import { spanKey } from "./syntax.ts";

export function lintModule(
  module: Module,
  source: string,
  cst: Rule,
  rules: readonly LintRule[] = DEFAULT_LINT_RULES,
  specializations: readonly CompilerSpecializationFact[] = [],
): readonly LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  const concrete = collectConcrete(cst);
  const visitors = rules.map((rule) => {
    const context: LintRuleContext = {
      module,
      source,
      cst,
      specializations,
      sourceText: (node) => source.slice(node.span.start, node.span.end).trim(),
      report: (report) =>
        diagnostics.push({
          code: rule.code,
          severity: rule.severity,
          message: report.message,
          span: report.span,
          fix: report.fix ?? null,
        }),
      fix: (span, title, replacement, validation = "parse") => {
        const replaced = source.slice(span.start, span.end);
        if (replaced.includes("//")) return null;
        return {
          title,
          span,
          replacement: replaced.endsWith("\n") && !replacement.endsWith("\n")
            ? `${replacement}\n`
            : replacement,
          validation,
        };
      },
      hasConcreteOrigin: (node, ruleName) =>
        concrete.spans.get(ruleName)?.has(spanKey(node.span)) === true,
      concreteHasDescendant: (node, ruleName, descendantName) =>
        concrete.descendants.get(`${ruleName}:${spanKey(node.span)}`)?.has(
          descendantName,
        ) === true,
    };
    return { rule, visitors: rule.create(context) };
  });

  visitModule(module, visitors.map((entry) => entry.visitors));
  visitConcrete(cst, [], visitors.map((entry) => entry.visitors));
  return diagnostics;
}

function collectConcrete(
  cst: Rule,
): {
  readonly spans: ReadonlyMap<string, ReadonlySet<string>>;
  readonly descendants: ReadonlyMap<string, ReadonlySet<string>>;
} {
  const spans = new Map<string, Set<string>>();
  const descendants = new Map<string, Set<string>>();
  const visit = (rule: Rule): ReadonlySet<string> => {
    let named = spans.get(rule.name);
    if (named === undefined) {
      named = new Set();
      spans.set(rule.name, named);
    }
    named.add(spanKey(rule.span));

    const below = new Set<string>();
    for (const child of rule.children()) {
      if (child.type !== "rule") continue;
      below.add(child.name);
      for (const name of visit(child)) below.add(name);
    }
    const key = `${rule.name}:${spanKey(rule.span)}`;
    let recorded = descendants.get(key);
    if (recorded === undefined) {
      recorded = new Set();
      descendants.set(key, recorded);
    }
    for (const name of below) recorded.add(name);
    return below;
  };
  visit(cst);
  return { spans, descendants };
}

function visitModule(module: Module, visitors: readonly LintVisitors[]): void {
  const path = { node: module, parent: null, ancestors: [] } as const;
  for (const visitor of visitors) visitor.module?.(path);
  if (module.parameter !== null) {
    visitPattern(module.parameter, module, [module], visitors);
  }
  for (const declaration of module.declarations) {
    visitDeclaration(declaration, module, [module], visitors);
  }
  visitExpression(module.result, module, [module], visitors);
}

function visitDeclaration(
  declaration: Decl,
  parent: AstNode,
  ancestors: readonly AstNode[],
  visitors: readonly LintVisitors[],
): void {
  const path = { node: declaration, parent, ancestors } as const;
  for (const visitor of visitors) visitor.declaration?.(path);
  const nested = [...ancestors, declaration];
  if (declaration.tag === "binding") {
    visitPattern(declaration.pattern, declaration, nested, visitors);
    for (const tag of declaration.tags) {
      visitExpression(tag.descriptor, declaration, nested, visitors);
    }
  }
  visitExpression(declaration.value, declaration, nested, visitors);
}

function visitExpression(
  expression: Expr,
  parent: AstNode,
  ancestors: readonly AstNode[],
  visitors: readonly LintVisitors[],
): void {
  const path = { node: expression, parent, ancestors } as const;
  for (const visitor of visitors) visitor.expression?.(path);
  const nested = [...ancestors, expression];
  switch (expression.tag) {
    case "apply":
      visitExpression(expression.fn, expression, nested, visitors);
      visitExpression(expression.arg, expression, nested, visitors);
      return;
    case "field":
      visitExpression(expression.target, expression, nested, visitors);
      return;
    case "lambda":
      visitPattern(expression.parameter, expression, nested, visitors);
      visitExpression(expression.body, expression, nested, visitors);
      return;
    case "rec":
      visitExpression(expression.lambda, expression, nested, visitors);
      return;
    case "tuple":
      for (const element of expression.elements) {
        visitExpression(element, expression, nested, visitors);
      }
      return;
    case "array":
      for (const element of expression.elements) {
        visitExpression(element.value, expression, nested, visitors);
      }
      return;
    case "shape":
      for (const member of expression.members) {
        visitExpression(member.value, expression, nested, visitors);
      }
      return;
    case "if":
      for (const branch of expression.branches) {
        visitExpression(branch.condition, expression, nested, visitors);
        visitExpression(branch.consequence, expression, nested, visitors);
      }
      if (expression.fallback !== null) {
        visitExpression(expression.fallback, expression, nested, visitors);
      }
      return;
    case "case":
      visitExpression(expression.target, expression, nested, visitors);
      for (const arm of expression.arms) {
        visitPattern(arm.pattern, expression, nested, visitors);
        visitExpression(arm.body, expression, nested, visitors);
      }
      return;
    case "block":
      for (const declaration of expression.declarations) {
        visitDeclaration(declaration, expression, nested, visitors);
      }
      visitExpression(expression.result, expression, nested, visitors);
      return;
    default:
      return;
  }
}

function visitPattern(
  pattern: Pattern,
  parent: AstNode,
  ancestors: readonly AstNode[],
  visitors: readonly LintVisitors[],
): void {
  const path = { node: pattern, parent, ancestors } as const;
  for (const visitor of visitors) visitor.pattern?.(path);
  const nested = [...ancestors, pattern];
  if (pattern.tag === "tuple" || pattern.tag === "array") {
    for (const element of pattern.elements) {
      visitPattern(element, pattern, nested, visitors);
    }
  } else if (pattern.tag === "constructor" && pattern.payload !== null) {
    visitPattern(pattern.payload, pattern, nested, visitors);
  } else if (pattern.tag === "shape") {
    for (const field of pattern.fields) {
      visitPattern(field.pattern, pattern, nested, visitors);
    }
  }
}

function visitConcrete(
  rule: Rule,
  ancestors: readonly Rule[],
  visitors: readonly LintVisitors[],
): void {
  for (const visitor of visitors) visitor.concrete?.(rule, ancestors);
  const nested = [...ancestors, rule];
  for (const child of rule.children()) {
    if (child.type === "rule") visitConcrete(child, nested, visitors);
  }
}
