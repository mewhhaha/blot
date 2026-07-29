// CST -> AST.
//
// Two jobs beyond shape translation:
//
//   1. fold flat operator chains into trees (delegated to fixity.ts);
//   2. reclassify a lambda's head as a pattern. The grammar parses that head as
//      an ordinary `postfix_expression` because sharing the operand prefix is
//      what lets the parser defer the lambda-versus-expression decision to
//      `=>`. Reclassification happens here, on the lowered tree, rather than as
//      a second walk over the CST.

import type {
  Arm,
  ArrayElement,
  Associativity,
  Branch,
  Decl,
  Expr,
  Fixity,
  Module,
  Pattern,
  Qualifier,
  ShapeMember,
  ShapePatternField,
  Span,
} from "./ast.ts";
import {
  buildFixityTable,
  type ChainStep,
  foldChain,
  targetExpr,
} from "./fixity.ts";
import { expect, fail } from "../diagnostic.ts";

// A structural view of baba's cursors. The generated types are a union of one
// interface per rule, which is exactly wrong for generic traversal: every
// helper here walks rules it cannot name in advance. Narrowing happens on
// `name`, so the precise types would be re-widened immediately anyway.

export interface TokenCursor {
  readonly type: "token";
  readonly kind: string;
  readonly text: string;
  readonly span: Span;
}

export interface Rule {
  readonly type: "rule";
  readonly name: string;
  readonly span: Span;
  child(index: number): Cursor | undefined;
  children(): readonly Cursor[];
  field(name: string): unknown;
}

type Cursor = Rule | TokenCursor;

function isRule(cursor: Cursor): cursor is Rule {
  return cursor.type === "rule";
}

function asRule(cursor: Cursor | null | undefined, name: string): Rule {
  expect(cursor !== null && cursor !== undefined, `missing ${name}`);
  expect(isRule(cursor), `expected rule ${name}, found a token`);
  return cursor;
}

function field(rule: Rule, name: string): Cursor | null {
  const value = rule.field(name);
  if (value === undefined || value === null) return null;
  expect(!Array.isArray(value), `field ${name} of ${rule.name} is an array`);
  return value as Cursor;
}

function required(rule: Rule, name: string): Cursor {
  const value = field(rule, name);
  expect(value !== null, `${rule.name} has no ${name}`);
  return value;
}

function fieldList(rule: Rule, name: string): readonly Cursor[] {
  const value = rule.field(name);
  if (value === undefined || value === null) return [];
  expect(Array.isArray(value), `field ${name} of ${rule.name} is not an array`);
  return value as readonly Cursor[];
}

/** Descends through wrapper rules — `value`, `pattern_core`, `field_name` — to a token. */
function tokenOf(cursor: Cursor): TokenCursor {
  let current = cursor;
  while (isRule(current)) {
    const first = current.child(0);
    expect(first !== undefined, `rule ${current.name} has no child`);
    current = first;
  }
  return current;
}

/** Unwraps a rule that exists only to name an alternation. */
function unwrap(cursor: Cursor): Cursor {
  expect(isRule(cursor), "expected a rule to unwrap");
  const first = cursor.child(0);
  expect(first !== undefined, `rule ${cursor.name} has no child`);
  return first;
}

function textOf(source: string, span: Span): string {
  return source.slice(span.start, span.end);
}

function decodeText(literal: string, span: Span): string {
  const body = literal.slice(1, -1);
  let result = "";
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "\\") {
      result += body[index];
      continue;
    }
    index += 1;
    const escape = body[index];
    if (escape === "n") result += "\n";
    else if (escape === "t") result += "\t";
    else if (escape === "r") result += "\r";
    else if (escape === '"') result += '"';
    else if (escape === "\\") result += "\\";
    else fail("BLOT_BAD_ESCAPE", `Unknown escape \`\\${escape}\`.`, span);
  }
  return result;
}

export function lowerModule(root: Rule, source: string): Module {
  expect(root.name === "program", "root is not a program");

  const headerCursor = field(root, "header");
  const parameter = headerCursor === null ? null : lowerPattern(
    asRule(
      field(asRule(headerCursor, "module_header"), "parameter"),
      "parameter",
    ),
  );

  const operatorsCursor = field(root, "operators");
  const fixities = operatorsCursor === null
    ? []
    : fieldList(asRule(operatorsCursor, "operator_section"), "declarations")
      .map((cursor) =>
        lowerFixity(asRule(cursor, "fixity_declaration"), source)
      );

  const table = buildFixityTable(fixities);
  const context: Context = { source, table };

  const declarations = fieldList(root, "declarations")
    .map((cursor) => unwrap(cursor));

  const { body, result } = splitResult(declarations, context, root.span);
  return { parameter, fixities, declarations: body, result, span: root.span };
}

interface Context {
  readonly source: string;
  readonly table: ReturnType<typeof buildFixityTable>;
}

/**
 * `return expr;` is a declaration form rather than a trailing bare expression,
 * because the strict root loop needs one repeated `;`-bounded island. Here it
 * becomes what it always meant: the body's result.
 */
function splitResult(
  cursors: readonly Cursor[],
  context: Context,
  span: Span,
): { body: readonly Decl[]; result: Expr } {
  const body: Decl[] = [];
  let result: Expr | null = null;

  for (const cursor of cursors) {
    const rule = asRule(cursor, "declaration");
    if (rule.name === "result") {
      if (result !== null) {
        fail("BLOT_MULTIPLE_RESULTS", "A body has one `return`.", rule.span);
      }
      result = lowerValue(asRule(field(rule, "value"), "value"), context);
      continue;
    }
    if (result !== null) {
      fail(
        "BLOT_DECLARATION_AFTER_RESULT",
        "`return` is the last declaration in a body.",
        rule.span,
      );
    }
    body.push(lowerDecl(rule, context));
  }

  if (result === null) {
    fail("BLOT_MISSING_RESULT", "A body ends with `return expr;`.", span);
  }
  return { body, result };
}

function lowerFixity(rule: Rule, source: string): Fixity {
  const associativity = readAssociativity(
    tokenOf(required(rule, "associativity")).text,
    rule.span,
  );
  const operator = tokenOf(required(rule, "operator")).text;
  const precedence = Number(tokenOf(required(rule, "precedence")).text);
  const target = lowerQualifiedName(
    asRule(field(rule, "target"), "target"),
    source,
  );
  return { operator, associativity, precedence, target, span: rule.span };
}

function readAssociativity(text: string, span: Span): Associativity {
  if (text === "infixl") return "left";
  if (text === "infixr") return "right";
  if (text === "infix") return "none";
  if (text === "prefix") return "prefix";
  fail("BLOT_BAD_FIXITY", `Unknown associativity \`${text}\`.`, span);
}

function lowerQualifiedName(rule: Rule, _source: string): readonly string[] {
  const root = tokenOf(required(rule, "root")).text;
  const rest = fieldList(rule, "rest").map((part) =>
    tokenOf(required(asRule(part, "qualified_name_part"), "name")).text
  );
  return [root, ...rest];
}

/**
 * `for source do … end;` becomes a call to `iterate`.
 *
 * There is no loop in the AST, no loop in the evaluator, and no loop in the
 * backend, because a loop is a fold and `iterate` is the fold — prelude source
 * over `rec` and `case`, which already compile. The whole construct is surface
 * syntax over a function, exactly as `a + b` is surface syntax over `Num.add`,
 * and it depends on `iterate` being in scope for the same reason `+` depends
 * on `Num`.
 *
 * The names the body rebinds with `:=` are the accumulator. Only a direct `:=`
 * counts: a `let` inside the body is a local the next iteration cannot see,
 * which is what makes the escaping set syntactic.
 *
 *   for let n = src do total := total + n; end;
 *
 *   let { .total; } = iterate (src, { .total = total; },
 *     ((loop$, item$) => do
 *        let { .total; } = loop$;
 *        let n = item$;
 *        total := total + n;
 *        return { .total = total; };
 *      end));
 */
/**
 * Can this pattern fail to match?
 *
 * A binder that cannot fail is a `let`; one that can becomes the `case` that
 * makes `for #Some x in src` a filter. Aggregates are refutable exactly when a
 * part of them is — an array pattern also constrains the length, so it always
 * can fail.
 */
function refutable(pattern: Pattern): boolean {
  switch (pattern.tag) {
    case "name":
    case "wildcard":
      return false;
    case "tuple":
      return pattern.elements.some(refutable);
    case "shape":
      return pattern.fields.some((field) => refutable(field.pattern));
    default:
      return true;
  }
}

function desugarLoop(
  binder: Pattern | null,
  source: Expr,
  body: readonly Decl[],
  span: Span,
): Decl {
  const carried: string[] = [];
  for (const declaration of body) {
    if (declaration.tag === "shadow" && !carried.includes(declaration.name)) {
      carried.push(declaration.name);
    }
  }

  const name = (text: string): Expr => ({ tag: "var", name: text, span });
  const state: Expr = carried.length === 0
    ? { tag: "unit", span }
    : {
      tag: "shape",
      members: carried.map((field) => ({
        tag: "field" as const,
        name: field,
        value: name(field),
      })),
      span,
    };
  const statePattern: Pattern = carried.length === 0
    ? { tag: "wildcard", span }
    : {
      tag: "shape",
      fields: carried.map((field) => ({
        name: field,
        pattern: { tag: "name" as const, name: field, qualifier: "none" as const, span },
      })),
      span,
    };

  // Named so they cannot collide with anything a program can write: `$` is in
  // the operator class, so no identifier contains one.
  const carriedIn = "loop$";
  const pairIn = "pair$";

  // The element is `pair$.0`, projected where it is used rather than bound to a
  // name of its own — one fewer synthetic binding for the backend to see.
  const element: Expr = {
    tag: "field",
    target: { tag: "var", name: pairIn, span },
    name: "0",
    span,
  };

  const declarations: Decl[] = [];
  if (carried.length > 0) {
    declarations.push({
      tag: "binding",
      kind: "let",
      pattern: statePattern,
      value: name(carriedIn),
      span,
    });
  }
  // An irrefutable binder is a `let`. A refutable one — `#Some x in src` — is
  // a `case` whose other arm hands the accumulator back untouched, so an
  // element that does not match skips the iteration instead of failing it.
  // That is the filter, and it costs one arm.
  const filtering = binder !== null && refutable(binder);
  if (binder !== null && !filtering) {
    declarations.push({
      tag: "binding",
      kind: "let",
      pattern: binder,
      value: element,
      span,
    });
  }
  declarations.push(...body);

  const step: Expr = { tag: "block", declarations, result: state, span };
  const visited: Expr = filtering && binder !== null
    ? {
      tag: "case",
      target: element,
      arms: [
        { pattern: binder, body: step },
        { pattern: { tag: "wildcard", span }, body: name(carriedIn) },
      ],
      span,
    }
    : step;

  // The recursion, inline. `for` names nothing: it emits the same `rec`/`case`
  // that `iterate` contains rather than calling it, so a module that loops over
  // an iterator it wrote itself needs nothing in scope. Looping over an *array*
  // still needs `Iter.items`, but that is a call the program writes and can see.
  const iterIn = "iter$";
  const stateIn = "state$";
  const goIn = "go$";
  const at = (target: Expr, field: string): Expr => ({
    tag: "field",
    target,
    name: field,
    span,
  });

  const go: Expr = {
    tag: "rec",
    lambda: {
      tag: "lambda",
      parameter: {
        tag: "tuple",
        elements: [
          { tag: "name", name: stateIn, qualifier: "none", span },
          { tag: "name", name: carriedIn, qualifier: "none", span },
        ],
        span,
      },
      body: {
        tag: "case",
        target: {
          tag: "apply",
          fn: at(name(iterIn), "step"),
          arg: name(stateIn),
          span,
        },
        arms: [
          {
            pattern: { tag: "constructor", name: "None", payload: null, span },
            body: name(carriedIn),
          },
          {
            pattern: {
              tag: "constructor",
              name: "Some",
              payload: { tag: "name", name: pairIn, qualifier: "none", span },
              span,
            },
            body: {
              tag: "apply",
              fn: name(goIn),
              arg: {
                tag: "tuple",
                elements: [at(name(pairIn), "1"), visited],
                span,
              },
              span,
            },
          },
        ],
        span,
      },
      span,
    },
    span,
  };

  return {
    tag: "binding",
    kind: "let",
    pattern: statePattern,
    value: {
      tag: "block",
      declarations: [
        { tag: "binding", kind: "let", pattern: { tag: "name", name: iterIn, qualifier: "none", span }, value: source, span },
        { tag: "binding", kind: "let", pattern: { tag: "name", name: goIn, qualifier: "none", span }, value: go, span },
      ],
      result: {
        tag: "apply",
        fn: name(goIn),
        arg: { tag: "tuple", elements: [at(name(iterIn), "state"), state], span },
        span,
      },
      span,
    },
    span,
  };
}

function lowerDecl(rule: Rule, context: Context): Decl {
  if (rule.name === "binding") {
    const kind = tokenOf(required(rule, "kind")).text;
    expect(
      kind === "let" || kind === "const" || kind === "sig",
      `unknown binding kind ${kind}`,
    );
    return {
      tag: "binding",
      kind,
      pattern: lowerPattern(asRule(field(rule, "pattern"), "pattern")),
      value: lowerValue(asRule(field(rule, "value"), "value"), context),
      span: rule.span,
    };
  }
  if (rule.name === "iteration") {
    const head = lowerValue(asRule(field(rule, "head"), "value"), context);
    const drawn = field(rule, "drawn");
    // A loop body is declarations and nothing else: there is no `return`,
    // because a loop produces no value — what it produces is the rebindings
    // that escape it.
    const body = fieldList(rule, "body").map((statement) => {
      const inner = asRule(unwrap(statement), "statement");
      if (inner.name === "result") {
        fail(
          "BLOT_RETURN_IN_LOOP",
          "A loop body has no `return`: a loop produces its rebindings, not a value.",
          inner.span,
        );
      }
      return lowerDecl(inner, context);
    });
    if (drawn === null) return desugarLoop(null, head, body, rule.span);
    return desugarLoop(
      patternFromExpr(head),
      lowerValue(
        asRule(required(asRule(drawn, "iteration_source"), "source"), "value"),
        context,
      ),
      body,
      rule.span,
    );
  }
  if (rule.name === "opening") {
    return {
      tag: "open",
      value: lowerValue(asRule(field(rule, "value"), "value"), context),
      span: rule.span,
    };
  }
  if (rule.name === "rebinding") {
    const name = tokenOf(required(rule, "name")).text;
    const value = lowerValue(asRule(field(rule, "value"), "value"), context);
    if (tokenOf(required(rule, "arrow")).text === ":=") {
      return { tag: "shadow", name, value, span: rule.span };
    }
    // `x <- computation;` is `let x = computation ();`.
    //
    // Performing is an ordinary call in blot — the row is inferred, so there is
    // nothing for a `perform` form to declare — which leaves `<-` one honest
    // job: naming the result of a computation without spelling the `()`. That
    // is what "get input from an effect" needs and all it needs, so it is
    // surface syntax over application rather than a construct of its own.
    // Requiring the value to be nullary is the type system's business, and it
    // is what stops `<-` from being a second spelling for `let`.
    return {
      tag: "binding",
      kind: "let",
      pattern: { tag: "name", name, qualifier: "none", span: rule.span },
      value: {
        tag: "apply",
        fn: value,
        arg: { tag: "unit", span: rule.span },
        span: rule.span,
      },
      span: rule.span,
    };
  }
  fail(
    "BLOT_UNKNOWN_DECLARATION",
    `Unknown declaration \`${rule.name}\`.`,
    rule.span,
  );
}

// --- patterns ---------------------------------------------------------------

function readQualifier(text: string, span: Span): Qualifier {
  if (text === "!") return "linear";
  if (text === "?") return "affine";
  if (text === "&") return "borrow";
  fail(
    "BLOT_BAD_PATTERN_QUALIFIER",
    `\`${text}\` is not a pattern qualifier. Only \`!\`, \`?\`, and \`&\` are, and \`-\` before an integer literal.`,
    span,
  );
}

function lowerPattern(rule: Rule): Pattern {
  expect(
    rule.name === "binding_pattern",
    `expected binding_pattern, got ${rule.name}`,
  );
  const qualifierCursor = field(rule, "qualifier");
  const core = unwrap(asRule(field(rule, "value"), "pattern_core"));
  const qualifierText = qualifierCursor === null
    ? null
    : tokenOf(qualifierCursor).text;

  // `-` folds into the literal it negates rather than surviving as a qualifier.
  if (qualifierText === "-") {
    const token = core.type === "token" ? core : null;
    if (token === null || token.kind !== "INTEGER") {
      fail(
        "BLOT_BAD_NEGATION",
        "`-` in a pattern applies only to an integer literal.",
        rule.span,
      );
    }
    return { tag: "int", value: -BigInt(token.text), span: rule.span };
  }

  const qualifier: Qualifier = qualifierText === null
    ? "none"
    : readQualifier(qualifierText, rule.span);

  if (core.type === "token") {
    if (core.kind === "IDENT" || core.kind === "TYPE_IDENT") {
      // `_` is a name the grammar cannot distinguish from any other, so the
      // wildcard is recognized here instead of in the lexer.
      if (core.text === "_") return { tag: "wildcard", span: rule.span };
      return { tag: "name", name: core.text, qualifier, span: rule.span };
    }
    if (core.kind === "INTEGER") {
      return { tag: "int", value: BigInt(core.text), span: rule.span };
    }
    if (core.kind === "TEXT") {
      return {
        tag: "text",
        value: decodeText(core.text, rule.span),
        span: rule.span,
      };
    }
    fail("BLOT_BAD_PATTERN", `\`${core.text}\` is not a pattern.`, rule.span);
  }

  if (core.name === "unit_pattern") return { tag: "unit", span: rule.span };

  if (core.name === "tuple_pattern") {
    const first = lowerPattern(asRule(field(core, "first"), "first"));
    const rest = fieldList(core, "rest").map((c) =>
      lowerPattern(asRule(c, "rest"))
    );
    return { tag: "tuple", elements: [first, ...rest], span: rule.span };
  }

  if (core.name === "array_pattern") {
    return {
      tag: "array",
      elements: fieldList(core, "elements").map((c) =>
        lowerPattern(asRule(c, "element"))
      ),
      span: rule.span,
    };
  }

  if (core.name === "constructor_pattern") {
    const payloadCursor = field(core, "payload");
    return {
      tag: "constructor",
      name: tokenOf(required(core, "constructor")).text,
      payload: payloadCursor === null
        ? null
        : lowerPattern(asRule(payloadCursor, "payload")),
      span: rule.span,
    };
  }

  if (core.name === "shape_pattern") {
    const fields: ShapePatternField[] = fieldList(core, "fields").map((c) => {
      const member = asRule(c, "shape_pattern_field");
      const name = tokenOf(required(member, "name")).text;
      const valuePair = member.field("value");
      if (valuePair === null || valuePair === undefined) {
        // `{ .x; }` puns: the field binds a name of the same spelling.
        return {
          name,
          pattern: { tag: "name", name, qualifier: "none", span: member.span },
        };
      }
      expect(Array.isArray(valuePair), "shape pattern value is not a pair");
      const [, patternCursor] = valuePair as readonly Cursor[];
      return { name, pattern: lowerPattern(asRule(patternCursor, "pattern")) };
    });
    return { tag: "shape", fields, span: rule.span };
  }

  fail("BLOT_BAD_PATTERN", `\`${core.name}\` is not a pattern.`, rule.span);
}

/**
 * Reclassifies a lambda head. The grammar could not commit to "pattern" before
 * seeing `=>`, so the head arrives as an expression and is converted here.
 */
function patternFromExpr(expr: Expr): Pattern {
  if (expr.tag === "var") {
    if (expr.name === "_") return { tag: "wildcard", span: expr.span };
    return { tag: "name", name: expr.name, qualifier: "none", span: expr.span };
  }
  if (expr.tag === "unit") return { tag: "unit", span: expr.span };
  if (expr.tag === "int") {
    return { tag: "int", value: expr.value, span: expr.span };
  }
  if (expr.tag === "text") {
    return { tag: "text", value: expr.value, span: expr.span };
  }
  if (expr.tag === "tuple") {
    return {
      tag: "tuple",
      elements: expr.elements.map(patternFromExpr),
      span: expr.span,
    };
  }
  if (expr.tag === "array") {
    for (const element of expr.elements) {
      if (element.spread) {
        fail("BLOT_BAD_PARAMETER", "A parameter cannot spread.", expr.span);
      }
    }
    return {
      tag: "array",
      elements: expr.elements.map((element) => patternFromExpr(element.value)),
      span: expr.span,
    };
  }
  if (expr.tag === "shape") {
    const fields: ShapePatternField[] = expr.members.map((member) => {
      if (member.tag === "spread") {
        fail("BLOT_BAD_PARAMETER", "A parameter cannot spread.", expr.span);
      }
      return { name: member.name, pattern: patternFromExpr(member.value) };
    });
    return { tag: "shape", fields, span: expr.span };
  }
  if (expr.tag === "tag") {
    return {
      tag: "constructor",
      name: expr.name,
      payload: null,
      span: expr.span,
    };
  }
  if (expr.tag === "apply") {
    if (expr.fn.tag === "tag") {
      return {
        tag: "constructor",
        name: expr.fn.name,
        payload: patternFromExpr(expr.arg),
        span: expr.span,
      };
    }
    // `!x` and `&x` reach here as prefix-operator applications.
    if (expr.fn.tag === "intrinsic") {
      const qualifier = expr.fn.name === "@linear.own"
        ? "linear"
        : expr.fn.name === "@linear.maybe"
        ? "affine"
        : expr.fn.name === "@linear.borrow"
        ? "borrow"
        : null;
      if (qualifier !== null) {
        const inner = patternFromExpr(expr.arg);
        if (inner.tag !== "name") {
          fail(
            "BLOT_BAD_PARAMETER",
            "`!`, `?`, and `&` qualify a name, not a compound pattern.",
            expr.span,
          );
        }
        return { tag: "name", name: inner.name, qualifier, span: expr.span };
      }
    }
  }
  fail(
    "BLOT_BAD_PARAMETER",
    "This is not a valid parameter pattern.",
    expr.span,
  );
}

// --- expressions ------------------------------------------------------------

function lowerValue(rule: Rule, context: Context): Expr {
  const inner = unwrap(rule);
  const target = asRule(inner, "value alternative");
  if (target.name === "lambda") return lowerLambda(target, context);
  return lowerExpression(target, context);
}

function lowerLambda(rule: Rule, context: Context): Expr {
  const head = lowerPostfix(
    asRule(field(rule, "parameter"), "parameter"),
    context,
  );
  return {
    tag: "lambda",
    parameter: patternFromExpr(head),
    body: lowerExpression(asRule(field(rule, "body"), "body"), context),
    span: rule.span,
  };
}

function lowerExpression(rule: Rule, context: Context): Expr {
  expect(rule.name === "expression", `expected expression, got ${rule.name}`);
  const first = lowerOperand(asRule(field(rule, "first"), "first"), context);
  const steps: ChainStep[] = fieldList(rule, "rest").map((cursor) => {
    const step = asRule(cursor, "infix_operation");
    return {
      operator: tokenOf(required(step, "operator")).text,
      right: lowerOperand(asRule(field(step, "right"), "right"), context),
      span: step.span,
    };
  });
  return foldChain(first, steps, context.table);
}

function lowerOperand(rule: Rule, context: Context): Expr {
  const valueCursor = field(rule, "value");
  if (valueCursor === null) {
    // The bare `postfix_expression` alternative binds no fields.
    return lowerPostfix(asRule(rule.child(0), "postfix_expression"), context);
  }

  let result = lowerPostfix(asRule(valueCursor, "postfix_expression"), context);
  const prefixes = fieldList(rule, "prefixes")
    .map((cursor) => tokenOf(cursor))
    .reverse();

  for (const prefix of prefixes) {
    const span = { start: rule.span.start, end: result.span.end };
    // A negated literal folds here rather than dispatching to `Num.negate`,
    // so writing `-1` does not require the prelude to be in scope.
    if (prefix.text === "-" && result.tag === "int") {
      result = { tag: "int", value: -result.value, span };
      continue;
    }
    if (prefix.text === "rec") {
      result = { tag: "rec", lambda: result, span };
      continue;
    }
    if (prefix.text === "comptime") {
      result = { tag: "comptime", body: result, span };
      continue;
    }
    const fixity = context.table.prefix(prefix.text);
    if (fixity === undefined) {
      fail(
        "BLOT_UNKNOWN_OPERATOR",
        `No fixity is declared for the prefix operator \`${prefix.text}\`.`,
        rule.span,
      );
    }
    result = { tag: "apply", fn: targetExpr(fixity, span), arg: result, span };
  }
  return result;
}

function lowerPostfix(rule: Rule, context: Context): Expr {
  let result = lowerPrimary(
    unwrap(asRule(field(rule, "value"), "value")),
    context,
  );
  result = applySuffixes(result, fieldList(rule, "suffixes"));

  for (const cursor of fieldList(rule, "arguments")) {
    const argumentRule = asRule(cursor, "application_argument");
    let argument = lowerPrimary(
      unwrap(asRule(field(argumentRule, "value"), "value")),
      context,
    );
    argument = applySuffixes(argument, fieldList(argumentRule, "suffixes"));
    result = {
      tag: "apply",
      fn: result,
      arg: argument,
      span: { start: result.span.start, end: argument.span.end },
    };
  }
  return result;
}

function applySuffixes(target: Expr, suffixes: readonly Cursor[]): Expr {
  let result = target;
  for (const cursor of suffixes) {
    const suffix = asRule(cursor, "field_suffix");
    result = {
      tag: "field",
      target: result,
      name: tokenOf(required(suffix, "field")).text,
      span: { start: result.span.start, end: suffix.span.end },
    };
  }
  return result;
}

function lowerPrimary(cursor: Cursor, context: Context): Expr {
  if (cursor.type === "token") {
    const span = cursor.span;
    if (cursor.kind === "IDENT" || cursor.kind === "TYPE_IDENT") {
      return { tag: "var", name: cursor.text, span };
    }
    if (cursor.kind === "INTEGER") {
      return { tag: "int", value: BigInt(cursor.text), span };
    }
    if (cursor.kind === "TEXT") {
      return { tag: "text", value: decodeText(cursor.text, span), span };
    }
    if (cursor.kind === "INTRINSIC") {
      return { tag: "intrinsic", name: cursor.text, span };
    }
    fail(
      "BLOT_BAD_EXPRESSION",
      `\`${cursor.text}\` is not an expression.`,
      span,
    );
  }

  const rule = cursor;
  if (rule.name === "constructor_expression") {
    return {
      tag: "tag",
      name: tokenOf(required(rule, "constructor")).text,
      span: rule.span,
    };
  }
  if (rule.name === "unit") return { tag: "unit", span: rule.span };

  if (rule.name === "parenthesized_or_tuple") {
    const first = lowerValue(asRule(field(rule, "first"), "first"), context);
    // The remaining elements live inside the optional `("," rest:...)` group,
    // so they are reached through `tail`; the flattened `rest` field is empty.
    const tail = rule.field("tail");
    if (tail === null || tail === undefined) return first;
    expect(Array.isArray(tail), "tuple tail is not a group");
    const rest = (tail[1] as readonly Cursor[]).map((c) =>
      lowerValue(asRule(c, "tuple element"), context)
    );
    if (rest.length === 0) return first;
    return { tag: "tuple", elements: [first, ...rest], span: rule.span };
  }

  if (rule.name === "array") {
    const elements: ArrayElement[] = fieldList(rule, "elements").map((c) => {
      const element = asRule(c, "array_element");
      return {
        spread: field(element, "spread") !== null,
        value: lowerValue(asRule(field(element, "value"), "value"), context),
      };
    });
    return { tag: "array", elements, span: rule.span };
  }

  if (rule.name === "shape") {
    const members: ShapeMember[] = fieldList(rule, "members").map((c) => {
      const member = asRule(unwrap(asRule(c, "shape_member")), "shape member");
      if (member.name === "shape_spread") {
        return {
          tag: "spread",
          value: lowerExpression(
            asRule(field(member, "value"), "value"),
            context,
          ),
        };
      }
      return {
        tag: "field",
        name: tokenOf(required(member, "name")).text,
        value: lowerValue(asRule(field(member, "value"), "value"), context),
      };
    });
    return { tag: "shape", members, span: rule.span };
  }

  if (rule.name === "conditional") {
    const branches: Branch[] = [{
      condition: lowerExpression(
        asRule(field(rule, "condition"), "condition"),
        context,
      ),
      consequence: lowerValue(
        asRule(field(rule, "consequence"), "consequence"),
        context,
      ),
    }];
    for (const cursor of fieldList(rule, "alternatives")) {
      const clause = asRule(cursor, "else_if_clause");
      branches.push({
        condition: lowerExpression(
          asRule(field(clause, "condition"), "condition"),
          context,
        ),
        consequence: lowerValue(
          asRule(field(clause, "consequence"), "consequence"),
          context,
        ),
      });
    }
    const fallbackCursor = field(rule, "fallback");
    const fallback = fallbackCursor === null ? null : lowerValue(
      asRule(
        field(asRule(fallbackCursor, "else_clause"), "alternative"),
        "alternative",
      ),
      context,
    );
    return { tag: "if", branches, fallback, span: rule.span };
  }

  if (rule.name === "case_expression") {
    const arms: Arm[] = [
      lowerArm(asRule(field(rule, "first"), "first"), context),
    ];
    for (const cursor of fieldList(rule, "rest")) {
      // Each entry is the `,` token paired with the arm.
      const pair = cursor as unknown as readonly Cursor[];
      arms.push(lowerArm(asRule(pair[1], "case_arm"), context));
    }
    return {
      tag: "case",
      target: lowerExpression(asRule(field(rule, "target"), "target"), context),
      arms,
      span: rule.span,
    };
  }

  if (rule.name === "block") {
    const statements = fieldList(rule, "statements").map((c) => unwrap(c));
    const { body, result } = splitResult(statements, context, rule.span);
    return { tag: "block", declarations: body, result, span: rule.span };
  }

  fail(
    "BLOT_BAD_EXPRESSION",
    `\`${rule.name}\` is not an expression.`,
    rule.span,
  );
}

function lowerArm(rule: Rule, context: Context): Arm {
  return {
    pattern: lowerPattern(asRule(field(rule, "pattern"), "pattern")),
    body: lowerValue(asRule(field(rule, "body"), "body"), context),
  };
}

export { textOf };
