import type { CheckResult } from "../check/mod.ts";
import { bridge } from "../check/bridge.ts";
import { show } from "../check/print.ts";
import type { SimpleType } from "../check/type.ts";
import { lookup, type Value } from "../comptime/value.ts";
import type { Decl, Expr, Module, Pattern, Span } from "../syntax/ast.ts";
import { buildFixityTable } from "../syntax/fixity.ts";
import type { Rule, TokenCursor } from "../syntax/cursor.ts";
import { definitionAt, identifierSpan } from "./definition.ts";

export interface HoverDescription {
  readonly markdown: string;
  readonly span: Span;
}

interface BindingDescription {
  readonly name: string;
  readonly preview: string | null;
  readonly documentationStart: number | null;
  readonly type: string | null;
}

type ValueSite =
  | { readonly tag: "expression"; readonly expression: Expr }
  | {
    readonly tag: "shape-field";
    readonly name: string;
    readonly value: Expr;
  };

export function hoverAt(
  module: Module,
  source: string,
  cst: Rule,
  offset: number,
  checked: CheckResult | null,
): HoverDescription | null {
  const token = tokenAt(cst, offset);
  if (token === null) return null;

  const binding = bindingAt(module, source, token, offset, checked);
  const tokenDocs = tokenDocumentation(module, token);
  if (binding === null) {
    if (tokenDocs === null) return null;
    return { markdown: tokenDocs, span: token.span };
  }

  const lines: string[] = [];
  if (binding.type !== null) {
    lines.push(`sig ${binding.name} = ${binding.type}`);
  }
  if (binding.preview !== null) {
    lines.push(binding.preview);
  }

  const sections: string[] = [];
  if (lines.length > 0) {
    sections.push(`\`\`\`blot\n${lines.join("\n")}\n\`\`\``);
  }
  if (binding.documentationStart !== null) {
    const docs = documentationBefore(source, binding.documentationStart);
    if (docs !== null) sections.push(docs);
  }
  if (tokenDocs !== null && token.kind === "INTRINSIC") {
    sections.push(tokenDocs);
  }
  if (sections.length === 0) return null;
  return { markdown: sections.join("\n\n"), span: token.span };
}

function bindingAt(
  module: Module,
  source: string,
  token: TokenCursor,
  offset: number,
  checked: CheckResult | null,
): BindingDescription | null {
  const site = valueSiteAt(module, source, token);
  if (site?.tag === "shape-field") {
    const inferred = checked?.expressionTypes.get(site.value);
    let value = source.slice(site.value.span.start, site.value.span.end);
    if (site.value.tag === "lambda" || site.value.tag === "rec") {
      value = compactFunction(site.value, source);
    }
    let type: string | null = null;
    if (inferred !== undefined) type = show(inferred);
    return {
      name: site.name,
      preview: `.${site.name} = ${value}`,
      documentationStart:
        source.lastIndexOf("\n", Math.max(0, token.span.start - 1)) + 1,
      type,
    };
  }

  const definition = definitionAt(module, source, offset);
  let declaration: Decl | null = null;
  if (definition !== null) {
    declaration = declarationAt(module, source, definition);
  }
  let occurrence: Expr | null = null;
  if (site?.tag === "expression") occurrence = site.expression;
  let type: SimpleType | null | undefined = null;
  if (occurrence !== null && checked !== null) {
    type = checked.expressionTypes.get(occurrence);
  }
  if (
    (type === null || type === undefined) && declaration !== null &&
    checked !== null
  ) {
    type = checked.expressionTypes.get(declaration.value);
  }
  if (
    (type === null || type === undefined) && definition !== null &&
    checked !== null
  ) {
    type = referencedType(module, source, definition, checked);
  }

  let attachedMember: Value | null = null;
  if (
    occurrence !== null && occurrence.tag === "field" && checked !== null
  ) {
    attachedMember = attachedMemberValue(occurrence, checked);
    if (type === null || type === undefined) {
      if (attachedMember !== null) {
        type = bridge(attachedMember);
        if (type === null && attachedMember.tag === "closure") {
          type = { tag: "top" };
        }
      }
    }
  }

  let name: string | null = null;
  if (definition !== null) {
    name = source.slice(definition.start, definition.end);
  }
  if (name === null && occurrence !== null) {
    name = expressionName(occurrence, token);
  }
  if (name === null) return null;
  let preview: string | null = null;
  let documentationStart: number | null = null;
  if (declaration !== null) {
    preview = compactDeclaration(declaration, source);
    documentationStart = declaration.span.start;
  } else if (
    attachedMember !== null && attachedMember.tag === "closure" &&
    attachedMember.source !== undefined &&
    expressionBelongsTo(module, attachedMember.source)
  ) {
    let memberName = name;
    if (occurrence?.tag === "field") memberName = occurrence.name;
    preview = `.${memberName} = ${
      compactFunction(attachedMember.source, source)
    }`;
    documentationStart = attachedMember.source.span.start;
  }
  let shownType: string | null = null;
  if (type !== null && type !== undefined) shownType = show(type);
  return {
    name,
    preview,
    documentationStart,
    type: shownType,
  };
}

function attachedMemberValue(
  expression: Expr & { tag: "field" },
  checked: CheckResult,
): Value | null {
  const path: string[] = [];
  let target: Expr = expression;
  while (target.tag === "field") {
    path.unshift(target.name);
    target = target.target;
  }
  if (target.tag !== "var") return null;

  let value = lookup(checked.values, target.name);
  if (value === undefined) return null;
  for (const name of path) {
    let member: Value | undefined;
    if (value.tag === "extended") {
      member = value.members.get(name);
    } else if (value.tag === "shape") {
      member = value.fields.get(name);
    } else {
      return null;
    }
    if (member === undefined) return null;
    value = member;
  }
  return value;
}

function expressionBelongsTo(module: Module, wanted: Expr): boolean {
  let found = false;
  const visit = (expression: Expr): void => {
    if (found) return;
    if (expression === wanted) {
      found = true;
      return;
    }
    switch (expression.tag) {
      case "apply":
        visit(expression.fn);
        visit(expression.arg);
        return;
      case "field":
        visit(expression.target);
        return;
      case "lambda":
        visit(expression.body);
        return;
      case "rec":
        visit(expression.lambda);
        return;
      case "comptime":
        visit(expression.body);
        return;
      case "tuple":
        for (const element of expression.elements) visit(element);
        return;
      case "array":
        for (const element of expression.elements) visit(element.value);
        return;
      case "shape":
        for (const member of expression.members) visit(member.value);
        return;
      case "if":
        for (const branch of expression.branches) {
          visit(branch.condition);
          visit(branch.consequence);
        }
        if (expression.fallback !== null) visit(expression.fallback);
        return;
      case "case":
        visit(expression.target);
        for (const arm of expression.arms) visit(arm.body);
        return;
      case "block":
        for (const declaration of expression.declarations) {
          visitDeclarationExpressions(declaration, visit);
        }
        visit(expression.result);
        return;
      default:
        return;
    }
  };
  for (const declaration of module.declarations) {
    visitDeclarationExpressions(declaration, visit);
  }
  visit(module.result);
  return found;
}

function referencedType(
  module: Module,
  source: string,
  definition: Span,
  checked: CheckResult,
): SimpleType | undefined {
  let found: SimpleType | undefined;
  const visit = (expression: Expr): void => {
    if (found !== undefined) return;
    if (expression.tag === "var") {
      const occurrence = identifierSpan(
        expression.span,
        expression.name,
        source,
      );
      if (
        occurrence !== null &&
        sameSpan(definitionAt(module, source, occurrence.start), definition)
      ) {
        found = checked.expressionTypes.get(expression);
      }
      return;
    }
    switch (expression.tag) {
      case "apply":
        visit(expression.fn);
        visit(expression.arg);
        return;
      case "field":
        visit(expression.target);
        return;
      case "lambda":
        visit(expression.body);
        return;
      case "rec":
        visit(expression.lambda);
        return;
      case "comptime":
        visit(expression.body);
        return;
      case "tuple":
        for (const element of expression.elements) visit(element);
        return;
      case "array":
        for (const element of expression.elements) visit(element.value);
        return;
      case "shape":
        for (const member of expression.members) visit(member.value);
        return;
      case "if":
        for (const branch of expression.branches) {
          visit(branch.condition);
          visit(branch.consequence);
        }
        if (expression.fallback !== null) visit(expression.fallback);
        return;
      case "case":
        visit(expression.target);
        for (const arm of expression.arms) visit(arm.body);
        return;
      case "block":
        for (const declaration of expression.declarations) {
          visitDeclarationExpressions(declaration, visit);
        }
        visit(expression.result);
        return;
      default:
        return;
    }
  };
  for (const declaration of module.declarations) {
    visitDeclarationExpressions(declaration, visit);
  }
  visit(module.result);
  return found;
}

function expressionName(expression: Expr, token: TokenCursor): string | null {
  if (expression.tag === "var") return expression.name;
  if (expression.tag === "intrinsic") return expression.name;
  if (expression.tag === "tag") return `#${expression.name}`;
  if (expression.tag === "field") {
    const parts = [expression.name];
    let target = expression.target;
    while (target.tag === "field") {
      parts.unshift(target.name);
      target = target.target;
    }
    if (target.tag === "var" || target.tag === "intrinsic") {
      parts.unshift(target.name);
    }
    return parts.join(".");
  }
  if (expression.tag === "int" || expression.tag === "float") {
    return token.text;
  }
  if (expression.tag === "text" || expression.tag === "unit") {
    return token.text;
  }
  return null;
}

function valueSiteAt(
  module: Module,
  source: string,
  token: TokenCursor,
): ValueSite | null {
  const found: { readonly site: ValueSite; readonly width: number }[] = [];
  const visit = (expression: Expr): void => {
    if (expressionCandidate(expression, source, token)) {
      found.push({
        site: { tag: "expression", expression },
        width: expression.span.end - expression.span.start,
      });
    }
    switch (expression.tag) {
      case "apply":
        visit(expression.fn);
        visit(expression.arg);
        return;
      case "field":
        visit(expression.target);
        return;
      case "lambda":
        visit(expression.body);
        return;
      case "rec":
        visit(expression.lambda);
        return;
      case "comptime":
        visit(expression.body);
        return;
      case "tuple":
        for (const element of expression.elements) visit(element);
        return;
      case "array":
        for (const element of expression.elements) visit(element.value);
        return;
      case "shape": {
        let memberStart = expression.span.start;
        for (const member of expression.members) {
          if (member.tag === "field" && member.name === token.text) {
            const header = source.slice(memberStart, member.value.span.start);
            const relative = header.lastIndexOf(member.name);
            if (relative >= 0) {
              const start = memberStart + relative;
              if (
                sameSpan({ start, end: start + member.name.length }, token.span)
              ) {
                found.push({
                  site: {
                    tag: "shape-field",
                    name: member.name,
                    value: member.value,
                  },
                  width: token.span.end - token.span.start,
                });
              }
            }
          }
          visit(member.value);
          memberStart = member.value.span.end;
        }
        return;
      }
      case "if":
        for (const branch of expression.branches) {
          visit(branch.condition);
          visit(branch.consequence);
        }
        if (expression.fallback !== null) visit(expression.fallback);
        return;
      case "case":
        visit(expression.target);
        for (const arm of expression.arms) visit(arm.body);
        return;
      case "block":
        for (const declaration of expression.declarations) {
          visitDeclarationExpressions(declaration, visit);
        }
        visit(expression.result);
        return;
      default:
        return;
    }
  };
  for (const declaration of module.declarations) {
    visitDeclarationExpressions(declaration, visit);
  }
  visit(module.result);
  found.sort((left, right) => left.width - right.width);
  const nearest = found[0];
  if (nearest === undefined) return null;
  return nearest.site;
}

function visitDeclarationExpressions(
  declaration: Decl,
  visit: (expression: Expr) => void,
): void {
  if (declaration.tag === "binding") {
    for (const tag of declaration.tags) visit(tag.descriptor);
  }
  visit(declaration.value);
}

function expressionCandidate(
  expression: Expr,
  source: string,
  token: TokenCursor,
): boolean {
  if (expression.tag === "var") {
    return sameSpan(
      identifierSpan(expression.span, expression.name, source),
      token.span,
    );
  }
  if (expression.tag === "intrinsic") {
    return expression.name === token.text &&
      contains(expression.span, token.span);
  }
  if (expression.tag === "tag") {
    return expression.name === token.text &&
      contains(expression.span, token.span);
  }
  if (expression.tag === "field") {
    return expression.name === token.text &&
      contains(expression.span, token.span);
  }
  return false;
}

function declarationAt(
  module: Module,
  source: string,
  definition: Span,
): Decl | null {
  let found: Decl | null = null;
  const visitPattern = (pattern: Pattern, declaration: Decl): void => {
    if (found !== null) return;
    if (pattern.tag === "name") {
      if (
        sameSpan(identifierSpan(pattern.span, pattern.name, source), definition)
      ) {
        found = declaration;
      }
      return;
    }
    if (pattern.tag === "tuple" || pattern.tag === "array") {
      for (const element of pattern.elements) {
        visitPattern(element, declaration);
      }
      return;
    }
    if (pattern.tag === "constructor" && pattern.payload !== null) {
      visitPattern(pattern.payload, declaration);
      return;
    }
    if (pattern.tag === "shape") {
      for (const field of pattern.fields) {
        visitPattern(field.pattern, declaration);
      }
    }
  };
  const visitExpression = (expression: Expr): void => {
    if (found !== null) return;
    switch (expression.tag) {
      case "apply":
        visitExpression(expression.fn);
        visitExpression(expression.arg);
        return;
      case "field":
        visitExpression(expression.target);
        return;
      case "lambda":
        visitExpression(expression.body);
        return;
      case "rec":
        visitExpression(expression.lambda);
        return;
      case "comptime":
        visitExpression(expression.body);
        return;
      case "tuple":
        for (const element of expression.elements) visitExpression(element);
        return;
      case "array":
        for (const element of expression.elements) {
          visitExpression(element.value);
        }
        return;
      case "shape":
        for (const member of expression.members) visitExpression(member.value);
        return;
      case "if":
        for (const branch of expression.branches) {
          visitExpression(branch.condition);
          visitExpression(branch.consequence);
        }
        if (expression.fallback !== null) visitExpression(expression.fallback);
        return;
      case "case":
        visitExpression(expression.target);
        for (const arm of expression.arms) visitExpression(arm.body);
        return;
      case "block":
        for (const declaration of expression.declarations) {
          visitDeclaration(declaration);
        }
        visitExpression(expression.result);
        return;
      default:
        return;
    }
  };
  const visitDeclaration = (declaration: Decl): void => {
    if (found !== null) return;
    if (declaration.tag === "shadow") {
      if (
        sameSpan(
          identifierSpan(declaration.span, declaration.name, source),
          definition,
        )
      ) {
        found = declaration;
        return;
      }
    } else if (declaration.tag === "binding" && declaration.kind !== "sig") {
      visitPattern(declaration.pattern, declaration);
    }
    visitExpression(declaration.value);
  };
  for (const declaration of module.declarations) visitDeclaration(declaration);
  visitExpression(module.result);
  return found;
}

function compactDeclaration(declaration: Decl, source: string): string {
  if (declaration.value.tag !== "lambda" && declaration.value.tag !== "rec") {
    return source.slice(declaration.span.start, declaration.span.end).trim();
  }
  const before = source.slice(
    declaration.span.start,
    declaration.value.span.start,
  );
  return `${before}${compactFunction(declaration.value, source)}`.trim();
}

function compactFunction(expression: Expr, source: string): string {
  if (expression.tag === "rec") {
    return `rec (${compactFunction(expression.lambda, source)})`;
  }
  if (expression.tag !== "lambda") {
    return source.slice(expression.span.start, expression.span.end);
  }
  const parameters: string[] = [];
  let current: Expr = expression;
  while (current.tag === "lambda") {
    parameters.push(
      source.slice(current.parameter.span.start, current.parameter.span.end),
    );
    current = current.body;
  }
  return parameters.map((parameter) => `fn ${parameter} => `).join("") +
    "body";
}

function documentationBefore(source: string, offset: number): string | null {
  let anchor = offset;
  const lineStart = source.lastIndexOf("\n", Math.max(0, anchor - 1)) + 1;
  if (lineStart > 0) {
    const previousEnd = lineStart - 1;
    const previousStart = source.lastIndexOf("\n", previousEnd - 1) + 1;
    const previousLine = source.slice(previousStart, previousEnd).trimStart();
    if (previousLine.startsWith("sig ")) anchor = previousStart;
  }
  const before = source.slice(0, anchor);
  const lines = before.split(/\r?\n/);
  if (lines.at(-1)?.trim() === "") lines.pop();
  const comments: string[] = [];
  while (lines.length > 0) {
    const line = lines.at(-1)?.trimStart();
    if (line === undefined || !line.startsWith("//")) break;
    comments.unshift(line.replace(/^\/\/\/? ?/, ""));
    lines.pop();
  }
  if (comments.length === 0) return null;
  return comments.join("\n");
}

function tokenAt(rule: Rule, offset: number): TokenCursor | null {
  let found: TokenCursor | null = null;
  const visit = (current: Rule): void => {
    for (const child of current.children()) {
      if (child.type === "rule") {
        visit(child);
        continue;
      }
      if (child.span.start <= offset && offset < child.span.end) found = child;
    }
  };
  visit(rule);
  return found;
}

const KEYWORD_DOCUMENTATION: Readonly<Record<string, string>> = {
  module: "Introduces the single explicit input pattern accepted by a module.",
  with: "Separates a module or import from its explicit input.",
  import: "Instantiates a module once with unit or the value following `with`.",
  operators: "Begins the module's fixity declarations.",
  infixl: "Declares a left-associative infix operator.",
  infixr: "Declares a right-associative infix operator.",
  infix: "Declares a non-associative infix operator.",
  prefix: "Declares a prefix operator.",
  let: "Binds a runtime value in the current scope.",
  const: "Evaluates and binds a compile-time value.",
  sig: "Constrains the declaration immediately following it.",
  return: "Supplies the result of the nearest module or explicit `do` scope.",
  if:
    "Selects a branch; a standalone suite inherits its surrounding control targets.",
  else: "Provides the fallback branch of an `if` or deconstructing guard.",
  case: "Matches a value against ordered patterns.",
  of: "Separates a `case` target from its arms.",
  rec: "Makes a function binding recursively visible in its own body.",
  comptime: "Requires its expression to be evaluated while compiling.",
  open: "Spreads a compile-time record's fields into lexical scope.",
  for: "Folds an iterator, carrying names rebound with `:=` as loop state.",
  in: "Separates a `for` pattern from its iterator.",
  break: "Leaves the nearest `for` and returns its current accumulator state.",
  fn: "Introduces a one-parameter function; adjacent `fn` forms are curried.",
};

const PUNCTUATION_DOCUMENTATION: Readonly<Record<string, string>> = {
  "(":
    "Begins a grouped expression, tuple, unit value, or explicit value scope.",
  ")": "Ends a parenthesized expression or scope.",
  "[": "Begins an array value or array pattern.",
  "]": "Ends an array value or array pattern.",
  "{": "Begins a structural record or an operator section.",
  "}": "Ends a structural record or operator section.",
  ",": "Separates tuple entries, arguments, or array elements.",
  ";": "Separates fields inside a structural record.",
  ".": "Projects a field or introduces a named record field.",
  "=": "Associates a binding, signature, field, or pattern with its value.",
  ":=": "Rebinds an existing name while preserving its stable type.",
  "<-":
    "Executes an effect value. `name <- effect` binds its result; leading `<- effect` discards it. A nullary effect value is forced with `()`.",
  "=>": "Separates a function parameter or case pattern from its body.",
  ":": "Introduces an indentation-delimited statement or branch suite.",
  "...": "Spreads the members or elements of the following value.",
  "#": "Introduces a variant constructor.",
  "@": "Introduces a compile-time declaration tag when followed by `[`.",
  "</": "Begins the closing tag of a paired element expression.",
  "/>": "Closes a self-closing element expression.",
  "?": "Marks an affine pattern or an optional structural field.",
};

const OPERATOR_EXAMPLES: Readonly<Record<string, string>> = {
  "$": "function $ argument",
  "|>": "value |> function",
  "~": "Input -> Output ~ { Console }",
  "->": "Input -> Output",
  "<+": "Type <+ { .member = value; }",
};

function tokenDocumentation(module: Module, token: TokenCursor): string | null {
  if (token.kind === "ELSE_IF") {
    return "Continues an `if` with another condition after every earlier condition failed.";
  }
  const keyword = KEYWORD_DOCUMENTATION[token.text];
  if (keyword !== undefined) return keyword;
  const punctuation = PUNCTUATION_DOCUMENTATION[token.text];
  if (punctuation !== undefined) return punctuation;
  if (token.kind === "INTEGER") {
    return "An integer literal has a singleton integer type.";
  }
  if (token.kind === "FLOAT") {
    return "A decimal floating-point literal has type `F64`.";
  }
  if (token.kind === "TEXT") {
    return "A UTF-8 text literal has a singleton text type.";
  }
  if (token.kind === "INTRINSIC") {
    return "An `@` name is a compiler primitive. Public conveniences normally live in the ordinary prelude instead.";
  }
  const table = buildFixityTable(module.fixities);
  const fixities = [table.infix(token.text), table.prefix(token.text)].filter(
    (fixity): fixity is NonNullable<typeof fixity> => fixity !== undefined,
  );
  if (fixities.length > 0) {
    return fixities.map((fixity) => {
      const form = fixity.associativity === "prefix"
        ? "prefix"
        : `${fixity.associativity}-associative infix`;
      const target = fixity.target.join(".");
      let example = OPERATOR_EXAMPLES[fixity.operator];
      if (fixity.associativity === "prefix") {
        example = `${fixity.operator}value`;
      } else if (example === undefined) {
        example = `left ${fixity.operator} right`;
      }
      return `A ${form} operator at precedence ${fixity.precedence}.

**Related value:** \`${target}\`

\`\`\`blot
${example}
\`\`\``;
    }).join("\n\n");
  }
  if (
    token.kind === "OPERATOR" || token.kind.startsWith("ANGLE_") ||
    token.kind === "QUESTION"
  ) {
    return "An operator whose meaning is supplied by a module fixity declaration.";
  }
  if (token.kind === "IDENT") return "A lowercase value or field name.";
  if (token.kind === "TYPE_IDENT") {
    return "A capitalized value or constructor name.";
  }
  return null;
}

function sameSpan(left: Span | null, right: Span): boolean {
  return left !== null && left.start === right.start && left.end === right.end;
}

function contains(outer: Span, inner: Span): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}
