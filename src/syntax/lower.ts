// CST -> AST.
//
// Two jobs beyond shape translation:
//
//   1. fold flat operator chains into trees (delegated to fixity.ts);
//   2. fold the flat forms the grammar keeps flat so that its islands stay
//      bounded — a lambda's `fn a => fn b =>` prefix is a repetition here and a
//      nest of one-parameter lambdas in the AST — and reclassify a `for` head
//      as a pattern, which the parser could not commit to before seeing `in`.

import type {
  Arm,
  ArrayElement,
  Branch,
  Decl,
  DeclarationTag,
  Expr,
  Module,
  Pattern,
  Qualifier,
  ShapeMember,
  ShapePatternField,
  Span,
} from "./ast.ts";
import { patternNames } from "./ast.ts";
import {
  buildFixityTable,
  type ChainStep,
  foldChain,
  targetExpr,
} from "./fixity.ts";
import { expect, fail } from "../diagnostic.ts";
import {
  asRule,
  type Cursor,
  decodeText,
  field,
  fieldList,
  required,
  type Rule,
  textOf,
  tokenOf,
  unwrap,
} from "./cursor.ts";

export function lowerModule(root: Rule, source: string): Module {
  expect(root.name === "program", "root is not a program");

  const headerCursor = field(root, "header");
  const parameter = headerCursor === null ? null : lowerPattern(
    asRule(
      field(asRule(headerCursor, "module_header"), "parameter"),
      "parameter",
    ),
  );

  const operators = field(root, "operators");
  if (operators !== null) {
    fail(
      "BLOT_REMOVED_OPERATOR_SECTION",
      "Operator precedence and targets are fixed; use a named function for another operation.",
      operators.span,
    );
  }

  const table = buildFixityTable();
  const context: Context = {
    source,
    table,
    loop: null,
    returnScope: true,
    escapeBoundary: "none",
    patternHead: false,
  };

  let statements = fieldList(root, "declarations")
    .map((cursor) => unwrap(cursor));
  let result: Expr = { tag: "unit", span: root.span };
  let resultEffects: Module["resultEffects"] = "pure";
  const last = statements.at(-1);
  if (last !== undefined) {
    const terminalReturn = lowerTerminalReturn(last, context);
    if (terminalReturn !== null) {
      result = terminalReturn;
      resultEffects = "ambient";
      statements = statements.slice(0, -1);
    }
  }
  let loweredDeclarations: readonly Decl[];
  if (statementsNeedControlLowering(statements)) {
    result = {
      tag: "block",
      declarations: [],
      result,
      resultEffects,
      span: result.span,
    };
    result = resolveControlSequence(statements, result, context, root.span);
    resultEffects = "ambient";
    loweredDeclarations = [];
  } else {
    loweredDeclarations = statements.map((cursor) =>
      lowerDecl(asRule(cursor, "declaration"), context)
    );
  }
  return {
    parameter,
    declarations: loweredDeclarations,
    result,
    resultEffects,
    span: root.span,
  };
}

interface Context {
  readonly source: string;
  readonly table: ReturnType<typeof buildFixityTable>;
  readonly loop: {
    readonly tag: "control";
    readonly carried: readonly string[];
    readonly breakConstructor: string;
  } | null;
  readonly returnScope: boolean;
  readonly escapeBoundary: "none" | "value-condition";
  /** Reclassifies `^name` before fixity in a pattern-shaped value head. */
  readonly patternHead: boolean;
}

function statementRule(cursor: Cursor): Rule {
  const rule = asRule(cursor, "statement");
  if (rule.name === "statement" || rule.name === "declaration") {
    return asRule(unwrap(rule), "statement");
  }
  return rule;
}

function conditionalStatementBody(rule: Rule): Rule {
  return asRule(field(rule, "body"), "conditional statement");
}

function statementSuite(rule: Rule, name: string): readonly Cursor[] {
  const value = rule.field(name);
  if (Array.isArray(value)) {
    return (value as readonly (Cursor | null)[]).filter((entry) =>
      entry !== null && entry !== undefined
    ) as readonly Cursor[];
  }
  const suite = asRule(value as Cursor | null | undefined, "statement_suite");
  expect(
    suite.name === "statement_suite",
    `${rule.name}.${name} is not a suite`,
  );
  return fieldList(suite, "statements");
}

function nestedStatementLists(rule: Rule): readonly (readonly Cursor[])[] {
  if (rule.name === "iteration") {
    return [statementSuite(rule, "body")];
  }
  if (rule.name !== "conditional_statement") return [];

  const body = conditionalStatementBody(rule);
  if (body.name === "conditional_statement_guard") {
    return [statementSuite(body, "alternative")];
  }
  expect(
    body.name === "conditional_statement_branches",
    `unknown conditional statement ${body.name}`,
  );
  const nested: (readonly Cursor[])[] = [
    statementSuite(body, "consequence"),
  ];
  for (const alternative of fieldList(body, "alternatives")) {
    nested.push(
      statementSuite(
        asRule(
          alternative,
          "conditional_statement_else_if_clause",
        ),
        "consequence",
      ),
    );
  }
  const fallback = field(body, "fallback");
  if (fallback !== null) {
    nested.push(
      statementSuite(
        asRule(fallback, "conditional_statement_else_clause"),
        "alternative",
      ),
    );
  }
  return nested;
}

function statementsNeedControlLowering(cursors: readonly Cursor[]): boolean {
  for (const cursor of cursors) {
    const rule = statementRule(cursor);
    if (rule.name === "result" || rule.name === "breaking") return true;
    if (
      rule.name === "conditional_statement" &&
      conditionalStatementBody(rule).name === "conditional_statement_guard"
    ) {
      return true;
    }
    if (rule.name === "iteration") {
      const body = statementSuite(rule, "body");
      if (statementsContainReturn(body)) return true;
      continue;
    }
    for (const nested of nestedStatementLists(rule)) {
      if (statementsNeedControlLowering(nested)) return true;
    }
  }
  return false;
}

function statementsContainReturn(cursors: readonly Cursor[]): boolean {
  for (const cursor of cursors) {
    const rule = statementRule(cursor);
    if (rule.name === "result") return true;
    for (const nested of nestedStatementLists(rule)) {
      if (statementsContainReturn(nested)) return true;
    }
  }
  return false;
}

function statementsContainEffect(cursors: readonly Cursor[]): boolean {
  for (const cursor of cursors) {
    const rule = statementRule(cursor);
    if (rule.name === "sequencing") {
      return true;
    }
    for (const nested of nestedStatementLists(rule)) {
      if (statementsContainEffect(nested)) return true;
    }
  }
  return false;
}

function statementsContainLoopBreak(cursors: readonly Cursor[]): boolean {
  for (const cursor of cursors) {
    const rule = statementRule(cursor);
    if (rule.name === "breaking" && field(rule, "value") === null) return true;
    if (rule.name === "iteration") continue;
    for (const nested of nestedStatementLists(rule)) {
      if (statementsContainLoopBreak(nested)) return true;
    }
  }
  return false;
}

function statementsCanContinue(cursors: readonly Cursor[]): boolean {
  for (const cursor of cursors) {
    const rule = statementRule(cursor);
    if (rule.name === "result" || rule.name === "breaking") return false;
    if (rule.name !== "conditional_statement") continue;

    const body = conditionalStatementBody(rule);
    if (body.name === "conditional_statement_guard") continue;
    expect(
      body.name === "conditional_statement_branches",
      `unknown conditional statement ${body.name}`,
    );
    const fallback = field(body, "fallback");
    if (fallback === null) continue;
    const everyBranchLeaves = nestedStatementLists(rule).every((nested) =>
      !statementsCanContinue(nested)
    );
    if (everyBranchLeaves) return false;
  }
  return true;
}

function lowerTerminalReturn(cursor: Cursor, context: Context): Expr | null {
  const rule = statementRule(cursor);
  if (rule.name === "result") {
    return lowerValue(asRule(field(rule, "value"), "return value"), context);
  }
  if (rule.name !== "conditional_statement") return null;

  const body = conditionalStatementBody(rule);
  if (body.name !== "conditional_statement_branches") return null;
  const fallbackCursor = field(body, "fallback");
  if (fallbackCursor === null) return null;

  const clauses = [
    body,
    ...fieldList(body, "alternatives").map((alternative) =>
      asRule(alternative, "conditional_statement_else_if_clause")
    ),
  ];
  const branches: Branch[] = [];
  for (const clause of clauses) {
    const statements = statementSuite(clause, "consequence");
    const consequence = lowerTerminalSuite(statements, context);
    if (consequence === null) return null;
    branches.push({
      condition: lowerExpression(
        asRule(field(clause, "condition"), "condition"),
        context,
      ),
      consequence,
    });
  }

  const fallback = asRule(
    fallbackCursor,
    "conditional_statement_else_clause",
  );
  const fallbackStatements = statementSuite(fallback, "alternative");
  const alternative = lowerTerminalSuite(fallbackStatements, context);
  if (alternative === null) return null;
  return { tag: "if", branches, fallback: alternative, span: body.span };
}

function lowerTerminalSuite(
  cursors: readonly Cursor[],
  context: Context,
): Expr | null {
  const last = cursors.at(-1);
  if (last === undefined) return null;
  const result = lowerTerminalReturn(last, context);
  if (result === null) return null;

  const declarations = cursors.slice(0, -1);
  if (statementsNeedControlLowering(declarations)) return null;
  if (declarations.length === 0) return result;
  return {
    tag: "block",
    declarations: declarations.map((cursor) =>
      lowerDecl(statementRule(cursor), context)
    ),
    result,
    resultEffects: "ambient",
    span: {
      start: statementRule(declarations[0]).span.start,
      end: statementRule(last).span.end,
    },
  };
}

interface ControlConstructors {
  readonly return: string;
  readonly continue: string;
}

// Runtime HIR gives each constructor one monomorphic payload type. A boundary-
// specific, source-unspellable name keeps unrelated continuation payloads from
// being unified, and the wrapper keeps `()` distinct from a payloadless tag.
function syntheticConstructor(label: string, span: Span): string {
  return `${label}$${span.start}$${span.end}`;
}

function controlPayload(value: Expr, span: Span): Expr {
  return {
    tag: "shape",
    members: [{ tag: "field", name: "value", value }],
    span,
  };
}

/** Like `controlPayloadPattern`, but binds a whole rebound-name record. */
function controlStatePattern(
  carried: readonly string[],
  span: Span,
): Pattern {
  return {
    tag: "shape",
    fields: [{ name: "value", pattern: loopPattern(carried, span) }],
    span,
  };
}

function controlPayloadPattern(name: string | null, span: Span): Pattern {
  let pattern: Pattern = { tag: "wildcard", span };
  if (name !== null) {
    pattern = {
      tag: "name",
      name,
      qualifier: "none",
      span,
    };
  }
  return {
    tag: "shape",
    fields: [{ name: "value", pattern }],
    span,
  };
}

function controlOutcome(
  constructor: string,
  value: Expr,
  span: Span,
): Expr {
  return {
    tag: "apply",
    fn: { tag: "tag", name: constructor, span },
    arg: controlPayload(value, span),
    span,
  };
}

function resolveControlSequence(
  cursors: readonly Cursor[],
  normalResult: Expr,
  context: Context,
  span: Span,
): Expr {
  const constructors: ControlConstructors = {
    return: syntheticConstructor("ScopeReturn", span),
    continue: syntheticConstructor("ScopeContinue", span),
  };
  const outcome = lowerControlOutcome(
    cursors,
    context,
    span,
    normalResult,
    constructors,
  );
  const arms: Arm[] = [];
  if (statementsContainReturn(cursors)) {
    arms.push({
      pattern: {
        tag: "constructor",
        name: constructors.return,
        payload: controlPayloadPattern("returned$", span),
        span,
      },
      body: { tag: "var", name: "returned$", span },
    });
  }
  if (statementsCanContinue(cursors)) {
    arms.push({
      pattern: {
        tag: "constructor",
        name: constructors.continue,
        payload: controlPayloadPattern("continued$", span),
        span,
      },
      body: { tag: "var", name: "continued$", span },
    });
  }
  return {
    tag: "case",
    target: outcome,
    arms,
    span,
  };
}

function lowerControlOutcome(
  cursors: readonly Cursor[],
  context: Context,
  span: Span,
  continueValue: Expr,
  constructors: ControlConstructors,
): Expr {
  const first = cursors[0];
  if (first === undefined) {
    return controlOutcome(constructors.continue, continueValue, span);
  }
  const rule = statementRule(first);
  if (rule.name === "result") {
    if (!context.returnScope) {
      fail(
        "BLOT_RETURN_OUTSIDE_SCOPE",
        "`return` has no enclosing module or explicit block.",
        rule.span,
      );
    }
    return controlOutcome(
      constructors.return,
      lowerValue(asRule(field(rule, "value"), "value"), context),
      rule.span,
    );
  }
  if (rule.name === "breaking") {
    if (context.loop === null || context.loop.tag !== "control") {
      if (context.escapeBoundary === "value-condition") {
        fail(
          "BLOT_BREAK_IN_VALUE_CONDITION",
          "`break` cannot escape a value-producing `case`.",
          rule.span,
        );
      }
      fail(
        "BLOT_BREAK_OUTSIDE_LOOP",
        "`break` has no enclosing `for`.",
        rule.span,
      );
    }
    return controlOutcome(
      context.loop.breakConstructor,
      loopState(context.loop.carried, rule.span),
      rule.span,
    );
  }

  const remaining = cursors.slice(1);
  if (rule.name === "conditional_statement") {
    const body = conditionalStatementBody(rule);
    if (body.name === "conditional_statement_guard") {
      const alternative = statementSuite(body, "alternative");
      if (statementsCanContinue(alternative)) {
        fail(
          "BLOT_GUARD_MAY_CONTINUE",
          "The `else` branch of `if let` must `return` or `break`.",
          body.span,
        );
      }
      return {
        tag: "case",
        target: lowerValue(asRule(field(body, "value"), "value"), context),
        arms: [
          {
            pattern: lowerPattern(
              asRule(field(body, "pattern"), "pattern"),
            ),
            body: lowerControlOutcome(
              remaining,
              context,
              span,
              continueValue,
              constructors,
            ),
          },
          {
            pattern: { tag: "wildcard", span: body.span },
            body: lowerControlOutcome(
              alternative,
              context,
              body.span,
              { tag: "unit", span: body.span },
              constructors,
            ),
          },
        ],
        span: rule.span,
      };
    }
    expect(
      body.name === "conditional_statement_branches",
      `unknown conditional statement ${body.name}`,
    );
    // What a branch produces when it falls through. The names it rebound have
    // to ride across the rejoin, or the statements after the conditional read
    // the value from before it — which is how a rebinding under `if c:`
    // inside a `for` silently counted nothing.
    const rebound = reboundNames(nestedStatementLists(rule).flat(), context);
    let branchContinue: Expr = loopState(rebound, rule.span);
    let branchConstructors = constructors;
    let branchContext = context;
    if (remaining.length === 0) branchContinue = continueValue;
    if (remaining.length > 0) {
      branchConstructors = {
        return: syntheticConstructor("ConditionalReturn", rule.span),
        continue: syntheticConstructor("ConditionalContinue", rule.span),
      };
      if (context.loop !== null && context.loop.tag === "control") {
        branchContext = {
          ...context,
          loop: {
            ...context.loop,
            breakConstructor: syntheticConstructor(
              "ConditionalBreak",
              rule.span,
            ),
          },
        };
      }
    }
    const conditional = lowerControlConditional(
      body,
      branchContext,
      branchContinue,
      branchConstructors,
    );
    if (remaining.length === 0) return conditional;
    const arms: Arm[] = [];
    if (statementsContainReturn([rule])) {
      arms.push({
        pattern: {
          tag: "constructor",
          name: branchConstructors.return,
          payload: controlPayloadPattern("returned$", rule.span),
          span: rule.span,
        },
        body: controlOutcome(
          constructors.return,
          { tag: "var", name: "returned$", span: rule.span },
          rule.span,
        ),
      });
    }
    if (statementsCanContinue([rule])) {
      arms.push({
        pattern: {
          tag: "constructor",
          name: branchConstructors.continue,
          payload: controlStatePattern(rebound, rule.span),
          span: rule.span,
        },
        body: lowerControlOutcome(
          remaining,
          context,
          span,
          continueValue,
          constructors,
        ),
      });
    }
    if (
      context.loop !== null &&
      context.loop.tag === "control" &&
      branchContext.loop !== null &&
      branchContext.loop.tag === "control" &&
      statementsContainLoopBreak([rule])
    ) {
      arms.push({
        pattern: {
          tag: "constructor",
          name: branchContext.loop.breakConstructor,
          payload: controlPayloadPattern("stopped$", rule.span),
          span: rule.span,
        },
        body: controlOutcome(
          context.loop.breakConstructor,
          { tag: "var", name: "stopped$", span: rule.span },
          rule.span,
        ),
      });
    }
    return {
      tag: "case",
      target: conditional,
      arms,
      span: rule.span,
    };
  }
  if (rule.name === "iteration") {
    const loop = lowerControlLoop(rule, context);
    const arms: Arm[] = [];
    if (loop.returns) {
      arms.push({
        pattern: {
          tag: "constructor",
          name: loop.constructors.return,
          payload: controlPayloadPattern("returned$", rule.span),
          span: rule.span,
        },
        body: controlOutcome(
          constructors.return,
          { tag: "var", name: "returned$", span: rule.span },
          rule.span,
        ),
      });
    }
    arms.push({
      pattern: {
        tag: "constructor",
        name: loop.constructors.continue,
        payload: controlPayloadPattern("loopState$", rule.span),
        span: rule.span,
      },
      body: {
        tag: "block",
        declarations: [{
          tag: "binding",
          kind: "let",
          tags: [],
          pattern: loop.pattern,
          value: {
            tag: "var",
            name: "loopState$",
            span: rule.span,
          },
          span: rule.span,
        }],
        result: lowerControlOutcome(
          remaining,
          context,
          span,
          continueValue,
          constructors,
        ),
        resultEffects: "ambient",
        span: rule.span,
      },
    });
    return {
      tag: "case",
      target: loop.value,
      arms,
      span: rule.span,
    };
  }

  const declarations: Decl[] = [lowerDecl(rule, context)];
  let nextControl = remaining;
  while (nextControl.length > 0) {
    const nextRule = statementRule(nextControl[0]);
    if (
      nextRule.name === "result" ||
      nextRule.name === "breaking" ||
      nextRule.name === "conditional_statement" ||
      nextRule.name === "iteration"
    ) {
      break;
    }
    declarations.push(lowerDecl(nextRule, context));
    nextControl = nextControl.slice(1);
  }
  return {
    tag: "block",
    declarations,
    result: lowerControlOutcome(
      nextControl,
      context,
      span,
      continueValue,
      constructors,
    ),
    resultEffects: "ambient",
    span: {
      start: rule.span.start,
      end: span.end,
    },
  };
}

function lowerControlConditional(
  body: Rule,
  context: Context,
  continueValue: Expr,
  constructors: ControlConstructors,
): Expr {
  const branches: Branch[] = [{
    condition: lowerExpression(
      asRule(field(body, "condition"), "condition"),
      context,
    ),
    consequence: lowerControlOutcome(
      statementSuite(body, "consequence"),
      context,
      body.span,
      continueValue,
      constructors,
    ),
  }];
  for (const cursor of fieldList(body, "alternatives")) {
    const clause = asRule(
      cursor,
      "conditional_statement_else_if_clause",
    );
    branches.push({
      condition: lowerExpression(
        asRule(field(clause, "condition"), "condition"),
        context,
      ),
      consequence: lowerControlOutcome(
        statementSuite(clause, "consequence"),
        context,
        clause.span,
        continueValue,
        constructors,
      ),
    });
  }
  let fallback = controlOutcome(
    constructors.continue,
    continueValue,
    body.span,
  );
  const fallbackCursor = field(body, "fallback");
  if (fallbackCursor !== null) {
    const clause = asRule(
      fallbackCursor,
      "conditional_statement_else_clause",
    );
    fallback = lowerControlOutcome(
      statementSuite(clause, "alternative"),
      context,
      clause.span,
      continueValue,
      constructors,
    );
  }
  return { tag: "if", branches, fallback, span: body.span };
}

/**
 * `for source:` followed by an indented body becomes the recursion behind `iterate`.
 *
 * There is no loop in the AST, no loop in the evaluator, and no loop in the
 * backend, because a loop is a fold and `rec`/`case` already express the fold.
 * The construct emits that recursion directly, so its meaning does not depend
 * on a prelude name being in scope.
 *
 * The names the body rebinds with `:=` are the accumulator. Only a direct `:=`
 * counts: a `let` inside the body is a local the next iteration cannot see,
 * which is what makes the escaping set syntactic.
 *
 *   for let n = src do total := total + n; end;
 *
 * The resulting recursive step destructures `{ .total; }`, visits one item,
 * rebuilds that state, and recurs with the iterator's next state.
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

type LoopBody =
  | {
    readonly tag: "plain";
    readonly declarations: readonly Decl[];
    readonly carried: readonly string[];
  }
  | {
    readonly tag: "control";
    readonly outcome: Expr;
    readonly carried: readonly string[];
    readonly constructors: ControlConstructors;
    readonly resultConstructors: ControlConstructors;
    readonly breakConstructor: string;
    readonly returns: boolean;
    readonly continues: boolean;
    readonly breaks: boolean;
  };

interface LoweredLoop {
  readonly pattern: Pattern;
  readonly value: Expr;
}

interface LoweredControlLoop extends LoweredLoop {
  readonly constructors: ControlConstructors;
  readonly returns: boolean;
}

/** The destructuring counterpart of `loopState`. */
function loopPattern(carried: readonly string[], span: Span): Pattern {
  if (carried.length === 0) return { tag: "wildcard", span };
  return {
    tag: "shape",
    fields: carried.map((field) => ({
      name: field,
      pattern: {
        tag: "name" as const,
        name: field,
        qualifier: "none" as const,
        span,
      },
    })),
    span,
  };
}

function loopState(carried: readonly string[], span: Span): Expr {
  if (carried.length === 0) return { tag: "unit", span };
  return {
    tag: "shape",
    members: carried.map((field) => ({
      tag: "field",
      name: field,
      value: { tag: "var", name: field, span },
    })),
    span,
  };
}

function desugarLoop(
  binder: Pattern | null,
  source: Expr,
  body: LoopBody,
  effectful: boolean,
  filtering: boolean,
  completion:
    | { readonly tag: "iterate" }
    | { readonly tag: "control" },
  span: Span,
): LoweredLoop {
  // Both shapes name their accumulator the same way: from the `:=` the CST
  // holds. Recovering it from the lowered body instead would miss a rebinding
  // inside a statement conditional, which lowers to a `binding` rather than a
  // `shadow` — by then lowering has erased the distinction.
  const carried = body.carried;

  const name = (text: string): Expr => ({ tag: "var", name: text, span });
  const state = loopState(carried, span);
  const statePattern: Pattern = carried.length === 0
    ? { tag: "wildcard", span }
    : {
      tag: "shape",
      fields: carried.map((field) => ({
        name: field,
        pattern: {
          tag: "name" as const,
          name: field,
          qualifier: "none" as const,
          span,
        },
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
      tags: [],
      pattern: statePattern,
      value: name(carriedIn),
      span,
    });
  }
  // `for case` makes filtering visible at the source boundary. Ordinary `for`
  // binders are irrefutable and lower to a `let`.
  if (binder !== null && !filtering) {
    declarations.push({
      tag: "binding",
      kind: "let",
      tags: [],
      pattern: binder,
      value: element,
      span,
    });
  }
  if (body.tag === "plain") declarations.push(...body.declarations);

  let stepResult = state;
  if (body.tag === "control") stepResult = body.outcome;
  const step: Expr = {
    tag: "block",
    declarations,
    result: stepResult,
    resultEffects: "ambient",
    span,
  };
  let skipped: Expr = { tag: "unit", span };
  if (body.tag === "control") {
    skipped = controlOutcome(
      body.constructors.continue,
      name(carriedIn),
      span,
    );
  }
  if (body.tag === "plain") skipped = name(carriedIn);
  const visited: Expr = filtering && binder !== null
    ? {
      tag: "case",
      target: element,
      arms: [
        { pattern: binder, body: step },
        {
          pattern: { tag: "wildcard", span },
          body: skipped,
        },
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
  const continueWith = (nextIterator: Expr, nextState: Expr): Expr => ({
    tag: "apply",
    fn: name(goIn),
    arg: {
      tag: "tuple",
      elements: [nextIterator, nextState],
      span,
    },
    span,
  });
  const nextIterator = at(name(pairIn), "1");
  const resolveVisitOutcome = (outcome: Expr): Expr => {
    expect(body.tag === "control", "plain loop used control outcome");
    const arms: Arm[] = [];
    if (body.returns) {
      arms.push({
        pattern: {
          tag: "constructor",
          name: body.constructors.return,
          payload: controlPayloadPattern("returned$", span),
          span,
        },
        body: controlOutcome(
          body.resultConstructors.return,
          name("returned$"),
          span,
        ),
      });
    }
    if (body.continues) {
      arms.push({
        pattern: {
          tag: "constructor",
          name: body.constructors.continue,
          payload: controlPayloadPattern("continued$", span),
          span,
        },
        body: continueWith(nextIterator, name("continued$")),
      });
    }
    if (completion.tag === "control" && body.breaks) {
      arms.push({
        pattern: {
          tag: "constructor",
          name: body.breakConstructor,
          payload: controlPayloadPattern("stopped$", span),
          span,
        },
        body: controlOutcome(
          body.resultConstructors.continue,
          name("stopped$"),
          span,
        ),
      });
    }
    return { tag: "case", target: outcome, arms, span };
  };
  let completedVisit = continueWith(nextIterator, visited);
  if (body.tag === "control") {
    completedVisit = resolveVisitOutcome(visited);
  }

  let exhausted: Expr = name(carriedIn);
  if (body.tag === "control") {
    exhausted = controlOutcome(
      body.resultConstructors.continue,
      name(carriedIn),
      span,
    );
  }
  const goResult: Expr = {
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
        body: exhausted,
      },
      {
        pattern: {
          tag: "constructor",
          name: "Some",
          payload: { tag: "name", name: pairIn, qualifier: "none", span },
          span,
        },
        body: completedVisit,
      },
    ],
    span,
  };
  const sequencedResult = "loopResult$";
  let goBody: Expr = goResult;
  if (effectful) {
    goBody = {
      tag: "block",
      declarations: [{
        tag: "binding",
        kind: "effect",
        tags: [],
        pattern: {
          tag: "name",
          name: sequencedResult,
          qualifier: "none",
          span,
        },
        value: goResult,
        span,
      }],
      result: name(sequencedResult),
      resultEffects: "ambient",
      span,
    };
  }
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
      body: goBody,
      span,
    },
    span,
  };

  return {
    pattern: statePattern,
    value: {
      tag: "block",
      declarations: [
        {
          tag: "binding",
          kind: "let",
          tags: [],
          pattern: { tag: "name", name: iterIn, qualifier: "none", span },
          value: source,
          span,
        },
        {
          tag: "binding",
          kind: "let",
          tags: [],
          pattern: { tag: "name", name: goIn, qualifier: "none", span },
          value: go,
          span,
        },
      ],
      result: {
        tag: "apply",
        fn: name(goIn),
        arg: {
          tag: "tuple",
          elements: [at(name(iterIn), "state"), state],
          span,
        },
        span,
      },
      resultEffects: "ambient",
      span,
    },
  };
}

function loopFiltering(rule: Rule, binder: Pattern | null): boolean {
  const filtering = field(rule, "kind") !== null;
  if (binder === null) {
    if (filtering) {
      fail(
        "BLOT_FILTERING_LOOP_WITHOUT_PATTERN",
        "`for case` requires a pattern followed by `in`.",
        rule.span,
      );
    }
    return false;
  }
  if (refutable(binder) && !filtering) {
    fail(
      "BLOT_REFUTABLE_FOR_PATTERN",
      "A refutable loop pattern must be introduced with `for case`.",
      binder.span,
    );
  }
  return filtering;
}

/**
 * The names a statement stream rebinds with `:=`.
 *
 * Recursive through nested statement lists, because a statement branch is part
 * of the same stream: a `n := n + 1` suite under `if c:` rebinds `n` for
 * everything after it, and a loop containing that rebinds `n` per iteration.
 *
 * `:=` is the only form collected, and that is what makes this well defined.
 * A rebinding requires the name to be in scope already and to keep its type
 * (LANGUAGE.md 4.3), so there is always an outer binding to hand the value back
 * to and both paths agree on what it holds. A `let` introduces a new name with
 * a possibly new type and must not escape its branch — a name bound only when a
 * condition happened to hold is exactly what must not leak.
 *
 * Which is why a `let`, `const`, or `use pattern <- value` binding earlier in
 * the stream takes the name out of the running. After
 * `use current <- Counter.read ()`, the name denotes that local, so
 * `current := current - 1` rebinds the local and has nothing to hand outward —
 * carrying it would publish a value the outer binding never held. The shadow
 * reaches the statements after the binding and into the blocks nested in them,
 * and stops at the end of the stream that introduced it.
 */
function reboundNames(
  statements: readonly Cursor[],
  context: Context,
): readonly string[] {
  const rebound: string[] = [];
  const visit = (
    cursors: readonly Cursor[],
    outer: ReadonlySet<string>,
  ): void => {
    const shadowed = new Set(outer);
    for (const cursor of cursors) {
      const declaration = statementRule(cursor);
      if (declaration.name === "rebinding") {
        const pattern = lowerPattern(
          asRule(field(declaration, "pattern"), "pattern"),
        );
        if (pattern.tag !== "name" || pattern.qualifier !== "none") {
          fail(
            "BLOT_BAD_REBINDING_TARGET",
            "`:=` requires one unqualified name. Use `let` to bind a pattern.",
            declaration.span,
          );
        }
        const name = pattern.name;
        if (!shadowed.has(name) && !rebound.includes(name)) rebound.push(name);
        continue;
      }
      if (declaration.name === "sequencing") {
        if (field(declaration, "value") === null) continue;
        const pattern = patternFromExpr(
          lowerValue(
            asRule(field(declaration, "head"), "value"),
            { ...context, patternHead: true },
          ),
        );
        for (const name of patternNames(pattern)) shadowed.add(name);
        continue;
      }
      // Not into a nested `for`. Its own desugaring already threads what it
      // rebinds into this stream as a `let`, and the names it introduces for
      // itself are not this scope's to carry.
      if (declaration.name === "iteration") continue;
      // The initializer is read before the name it binds is in scope, so a
      // block inside it still sees the outer binding.
      for (const nested of nestedStatementLists(declaration)) {
        visit(nested, shadowed);
      }
      if (declaration.name !== "binding") continue;
      const kind = tokenOf(required(declaration, "kind")).text;
      if (kind !== "let" && kind !== "const") continue;
      const pattern = lowerPattern(
        asRule(field(declaration, "pattern"), "pattern"),
      );
      for (const name of patternNames(pattern)) {
        // Shadowing a name this stream already handed outward. The escaping
        // value is read where the stream ends, which is inside the shadow, so
        // the local would leave under the accumulator's name and at whatever
        // type it happens to have. Rebinding the name first and shadowing it
        // second reads as either intent, so neither is chosen for the program.
        if (rebound.includes(name)) {
          fail(
            "BLOT_SHADOWED_ACCUMULATOR",
            `\`${name}\` is rebound with \`:=\` earlier in this block, so it ` +
              `leaves the block; a \`let\` here would shadow the name that ` +
              `carries it out. Rename the local, or move the \`let\` above the ` +
              `first \`:=\`.`,
            declaration.span,
          );
        }
        shadowed.add(name);
      }
    }
  };
  visit(statements, new Set());
  return rebound;
}

const carriedNames = reboundNames;

function lowerControlLoop(
  rule: Rule,
  context: Context,
): LoweredControlLoop {
  const statements = statementSuite(rule, "body");
  const carried = carriedNames(statements, context);
  const constructors: ControlConstructors = {
    return: syntheticConstructor("LoopReturn", rule.span),
    continue: syntheticConstructor("LoopContinue", rule.span),
  };
  const bodyConstructors: ControlConstructors = {
    return: syntheticConstructor("LoopBodyReturn", rule.span),
    continue: syntheticConstructor("LoopBodyContinue", rule.span),
  };
  const breakConstructor = syntheticConstructor("LoopBreak", rule.span);
  const returns = statementsContainReturn(statements);
  const continues = statementsCanContinue(statements);
  const breaks = statementsContainLoopBreak(statements);
  const bodyContext: Context = {
    ...context,
    loop: { tag: "control", carried, breakConstructor },
  };
  const outcome = lowerControlOutcome(
    statements,
    bodyContext,
    rule.span,
    loopState(carried, rule.span),
    bodyConstructors,
  );

  expect(rule.name === "iteration", `expected a loop, got ${rule.name}`);
  const drawn = field(rule, "drawn");
  const head = lowerValue(
    asRule(field(rule, "head"), "value"),
    drawn === null ? context : { ...context, patternHead: true },
  );
  if (drawn === null) {
    const loop = desugarLoop(
      null,
      head,
      {
        tag: "control",
        outcome,
        carried,
        constructors: bodyConstructors,
        resultConstructors: constructors,
        breakConstructor,
        returns,
        continues,
        breaks,
      },
      statementsContainEffect(statements),
      loopFiltering(rule, null),
      { tag: "control" },
      rule.span,
    );
    return {
      ...loop,
      constructors,
      returns,
    };
  }
  const binder = patternFromExpr(head);
  const loop = desugarLoop(
    binder,
    lowerValue(
      asRule(
        required(asRule(drawn, "iteration_source"), "source"),
        "value",
      ),
      context,
    ),
    {
      tag: "control",
      outcome,
      carried,
      constructors: bodyConstructors,
      resultConstructors: constructors,
      breakConstructor,
      returns,
      continues,
      breaks,
    },
    statementsContainEffect(statements),
    loopFiltering(rule, binder),
    { tag: "control" },
    rule.span,
  );
  return {
    ...loop,
    constructors,
    returns,
  };
}

interface EffectRowTailUse {
  readonly name: string;
  readonly count: number;
  readonly span: Span;
}

function effectRowTailUses(cursor: Cursor): readonly EffectRowTailUse[] {
  const uses = new Map<string, { count: number; span: Span }>();
  const record = (name: { text: string; span: Span }): void => {
    const existing = uses.get(name.text);
    if (existing === undefined) {
      uses.set(name.text, { count: 1, span: name.span });
    } else {
      existing.count += 1;
    }
  };
  const visit = (current: Cursor): void => {
    if (current.type === "token") return;
    if (current !== cursor && current.name === "binding") return;
    if (current.name === "effect_row_tail") {
      record(tokenOf(required(current, "name")));
      return;
    }
    if (current.name === "effect_row") {
      const children = current.children();
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        const next = children[index + 1];
        if (
          child.type === "token" && child.text === ".." &&
          next?.type === "token"
        ) {
          record(next);
          index += 1;
        } else {
          visit(child);
        }
      }
      return;
    }
    for (const child of current.children()) visit(child);
  };
  visit(cursor);
  return [...uses].map(([name, use]) => ({ name, ...use }));
}

function quantifyEffectRowTails(
  value: Expr,
  tails: readonly EffectRowTailUse[],
  span: Span,
): Expr {
  let result = value;
  for (const tail of [...tails].reverse()) {
    const lambda: Expr = {
      tag: "lambda",
      parameter: {
        tag: "name",
        name: tail.name,
        qualifier: "none",
        span: tail.span,
      },
      body: result,
      span,
    };
    result = {
      tag: "apply",
      fn: { tag: "intrinsic", name: "@forall", span: tail.span },
      arg: lambda,
      span,
    };
  }
  return result;
}

function lowerDecl(rule: Rule, context: Context): Decl {
  if (rule.name === "signature") {
    const kind = tokenOf(required(rule, "kind")).text;
    expect(
      kind === "let" || kind === "const",
      `unknown signature kind ${kind}`,
    );
    const valueCursor = field(rule, "value");
    expect(valueCursor !== null, "a signature has no type value");
    const rowTails = effectRowTailUses(valueCursor);
    const unconstrained = rowTails.find((tail) => tail.count < 2);
    if (unconstrained !== undefined) {
      fail(
        "BLOT_EFFECT_ROW_TAIL_UNCONSTRAINED",
        `Effect-row tail \`..${unconstrained.name}\` must occur at least twice in one signature.`,
        unconstrained.span,
      );
    }
    let value = lowerValue(asRule(valueCursor, "value"), context);
    if (rowTails.length > 0) {
      value = quantifyEffectRowTails(value, rowTails, rule.span);
    }
    return {
      tag: "signature",
      kind,
      recursive: field(rule, "recursive") !== null,
      name: tokenOf(required(rule, "name")).text,
      value,
      span: rule.span,
    };
  }
  if (rule.name === "binding") {
    const kind = tokenOf(required(rule, "kind")).text;
    expect(
      kind === "let" || kind === "const",
      `unknown binding kind ${kind}`,
    );
    const tags = fieldList(rule, "tags").map((cursor) => {
      const tag = asRule(cursor, "declaration_tag");
      return {
        descriptor: lowerValue(
          asRule(required(tag, "descriptor"), "value"),
          context,
        ),
        span: tag.span,
      };
    });
    const pattern = lowerPattern(asRule(field(rule, "pattern"), "pattern"));
    const valueCursor = field(rule, "value");
    expect(valueCursor !== null, "a binding has no value");
    const rowTails = effectRowTailUses(valueCursor);
    if (rowTails.length > 0) {
      fail(
        "BLOT_EFFECT_ROW_TAIL_OUTSIDE_SIGNATURE",
        "An effect-row tail is scoped by a signature header; write `..e` only after `::`.",
        rowTails[0].span,
      );
    }
    let value = lowerValue(asRule(valueCursor, "value"), context);
    const recursive = field(rule, "recursive");
    if (recursive !== null) {
      const marker = tokenOf(recursive);
      value = {
        tag: "rec",
        lambda: value,
        span: { start: marker.span.start, end: value.span.end },
      };
    }
    if (tags.length > 0) {
      value = lowerTaggedValue(kind, pattern, value, tags, rule.span);
    }
    return {
      tag: "binding",
      kind,
      tags,
      pattern,
      value,
      span: rule.span,
    };
  }
  if (rule.name === "iteration") {
    const statements = statementSuite(rule, "body");
    let kind: "let" | "effect" = "let";
    if (statementsContainEffect(statements)) kind = "effect";
    if (statementsNeedControlLowering(statements)) {
      const loop = lowerControlLoop(rule, context);
      expect(!loop.returns, "a local control loop contains a return");
      return {
        tag: "binding",
        kind,
        tags: [],
        pattern: loop.pattern,
        value: {
          tag: "case",
          target: loop.value,
          arms: [{
            pattern: {
              tag: "constructor",
              name: loop.constructors.continue,
              payload: controlPayloadPattern("loopState$", rule.span),
              span: rule.span,
            },
            body: { tag: "var", name: "loopState$", span: rule.span },
          }],
          span: rule.span,
        },
        span: rule.span,
      };
    }
    const carried = carriedNames(statements, context);
    const drawn = field(rule, "drawn");
    const head = lowerValue(
      asRule(field(rule, "head"), "value"),
      drawn === null ? context : { ...context, patternHead: true },
    );
    const body = statements.map((statement) => {
      const inner = asRule(unwrap(statement), "statement");
      return lowerDecl(inner, { ...context, loop: null });
    });
    let loop: LoweredLoop;
    if (drawn === null) {
      loop = desugarLoop(
        null,
        head,
        { tag: "plain", declarations: body, carried },
        kind === "effect",
        loopFiltering(rule, null),
        { tag: "iterate" },
        rule.span,
      );
    } else {
      const binder = patternFromExpr(head);
      loop = desugarLoop(
        binder,
        lowerValue(
          asRule(
            required(asRule(drawn, "iteration_source"), "source"),
            "value",
          ),
          context,
        ),
        { tag: "plain", declarations: body, carried },
        kind === "effect",
        loopFiltering(rule, binder),
        { tag: "iterate" },
        rule.span,
      );
    }
    return {
      tag: "binding",
      kind,
      tags: [],
      pattern: loop.pattern,
      value: loop.value,
      span: rule.span,
    };
  }
  if (rule.name === "breaking") {
    if (context.loop === null) {
      if (context.escapeBoundary === "value-condition") {
        fail(
          "BLOT_BREAK_IN_VALUE_CONDITION",
          "`break` cannot escape a value-producing `case`.",
          rule.span,
        );
      }
      fail(
        "BLOT_BREAK_OUTSIDE_LOOP",
        "`break` has no enclosing `for`.",
        rule.span,
      );
    }
    throw new Error("control return reached declaration lowering");
  }
  if (rule.name === "conditional_statement") {
    const body = conditionalStatementBody(rule);
    expect(
      body.name === "conditional_statement_branches",
      "`if let` reached declaration lowering",
    );
    // Names the branches rebind escape the conditional. A branch is a scope for
    // `let`, which introduces a name, but not for `:=`, which hands an existing
    // one back — so a statement conditional can compute, and a `:=` inside one
    // is not silently dropped.
    const rebound = reboundNames(nestedStatementLists(rule).flat(), context);
    const branches: Branch[] = [{
      condition: lowerExpression(
        asRule(field(body, "condition"), "condition"),
        context,
      ),
      consequence: {
        tag: "block",
        declarations: statementSuite(body, "consequence").map((statement) =>
          lowerDecl(asRule(unwrap(statement), "statement"), context)
        ),
        result: loopState(rebound, rule.span),
        resultEffects: "ambient",
        span: rule.span,
      },
    }];
    for (const cursor of fieldList(body, "alternatives")) {
      const clause = asRule(
        cursor,
        "conditional_statement_else_if_clause",
      );
      branches.push({
        condition: lowerExpression(
          asRule(field(clause, "condition"), "condition"),
          context,
        ),
        consequence: {
          tag: "block",
          declarations: statementSuite(clause, "consequence").map((statement) =>
            lowerDecl(asRule(unwrap(statement), "statement"), context)
          ),
          result: loopState(rebound, clause.span),
          resultEffects: "ambient",
          span: clause.span,
        },
      });
    }
    // A missing `else` is the pass-through arm: it hands back the names as
    // they already are, which is what makes a one-branch rebinding mean what it
    // reads as.
    let fallback: Expr = loopState(rebound, rule.span);
    const fallbackCursor = field(body, "fallback");
    if (fallbackCursor !== null) {
      const clause = asRule(
        fallbackCursor,
        "conditional_statement_else_clause",
      );
      fallback = {
        tag: "block",
        declarations: statementSuite(clause, "alternative").map((statement) =>
          lowerDecl(asRule(unwrap(statement), "statement"), context)
        ),
        result: loopState(rebound, clause.span),
        resultEffects: "ambient",
        span: clause.span,
      };
    }
    let kind: "let" | "effect" = "let";
    if (statementsContainEffect(nestedStatementLists(rule).flat())) {
      kind = "effect";
    }
    return {
      tag: "binding",
      kind,
      tags: [],
      pattern: loopPattern(rebound, rule.span),
      value: {
        tag: "if",
        branches,
        fallback,
        span: rule.span,
      },
      span: rule.span,
    };
  }
  if (rule.name === "result") {
    fail(
      "BLOT_RETURN_OUTSIDE_SCOPE",
      "`return` has no enclosing module or explicit block.",
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
    const pattern = lowerPattern(asRule(field(rule, "pattern"), "pattern"));
    const value = lowerValue(asRule(field(rule, "value"), "value"), context);
    if (pattern.tag !== "name" || pattern.qualifier !== "none") {
      fail(
        "BLOT_BAD_REBINDING_TARGET",
        "`:=` requires one unqualified name. Use `let` to bind a pattern.",
        rule.span,
      );
    }
    return { tag: "shadow", name: pattern.name, value, span: rule.span };
  }
  if (rule.name === "sequencing") {
    const valueCursor = field(rule, "value");
    const head = lowerValue(
      asRule(field(rule, "head"), "value"),
      valueCursor === null ? context : { ...context, patternHead: true },
    );
    let pattern: Pattern = { tag: "wildcard", span: rule.span };
    let value = head;
    if (valueCursor !== null) {
      pattern = patternFromExpr(head);
      value = lowerValue(asRule(valueCursor, "value"), context);
    }
    // The effect declaration is the forcing boundary. Type-directed
    // elaboration applies a nullary effect value once and otherwise sequences
    // the already-applied expression as written.
    return {
      tag: "binding",
      kind: "effect",
      tags: [],
      pattern,
      value,
      span: rule.span,
    };
  }
  fail(
    "BLOT_UNKNOWN_DECLARATION",
    `Unknown declaration \`${rule.name}\`.`,
    rule.span,
  );
}

/**
 * Evaluates tag descriptors before the raw value, then applies the nearest tag
 * first. The raw binding keeps `rec` directly under its source name, which is
 * the condition that gives recursive binding its existing meaning.
 */
function lowerTaggedValue(
  kind: "let" | "const",
  pattern: Pattern,
  value: Expr,
  tags: readonly DeclarationTag[],
  span: Span,
): Expr {
  const declarations: Decl[] = tags.map((tag, index) => ({
    tag: "binding",
    kind: "const",
    tags: [],
    pattern: {
      tag: "name",
      name: `tag$${index}`,
      qualifier: "none",
      span: tag.span,
    },
    value: tag.descriptor,
    span: tag.span,
  }));

  const recursive = value.tag === "rec" && pattern.tag === "name";
  let rawName = "tag$value$";
  if (recursive && pattern.tag === "name") rawName = pattern.name;
  declarations.push({
    tag: "binding",
    kind,
    tags: [],
    pattern: {
      tag: "name",
      name: rawName,
      qualifier: "none",
      span: value.span,
    },
    value,
    span: value.span,
  });

  let transformed: Expr = { tag: "var", name: rawName, span: value.span };
  for (let index = tags.length - 1; index >= 0; index -= 1) {
    const descriptor: Expr = {
      tag: "var",
      name: `tag$${index}`,
      span: tags[index].span,
    };
    const transformer: Expr = {
      tag: "field",
      target: descriptor,
      name: "transform",
      span: tags[index].span,
    };
    transformed = {
      tag: "apply",
      fn: transformer,
      arg: transformed,
      span: { start: tags[index].span.start, end: transformed.span.end },
    };
  }

  return {
    tag: "block",
    declarations,
    result: transformed,
    resultEffects: "ambient",
    span,
  };
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

  if (qualifierText === "^") {
    if (
      core.type === "token" &&
      (core.kind === "IDENT" || core.kind === "TYPE_IDENT") &&
      core.text !== "_"
    ) {
      return { tag: "pin", name: core.text, span: rule.span };
    }
    fail(
      "BLOT_BAD_PIN",
      "A pinned pattern is `^name`, naming one existing binding.",
      rule.span,
    );
  }

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
    if (core.kind === "FLOAT") {
      return { tag: "float", value: Number(core.text), span: rule.span };
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
 * Reclassifies a `for` head. The grammar could not commit to "pattern" before
 * seeing `in`, so the head arrives as an expression and is converted here. A
 * lambda needs none of this: `fn` announces it, so its parameter is parsed as a
 * pattern in the first place.
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
        fail("BLOT_BAD_BINDER", "A binder cannot spread.", expr.span);
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
        fail("BLOT_BAD_BINDER", "A binder cannot spread.", expr.span);
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
    if (expr.fn.tag === "intrinsic" && expr.fn.name === "@pattern.pin") {
      if (expr.arg.tag !== "var" || expr.arg.name === "_") {
        fail(
          "BLOT_BAD_PIN",
          "A pinned pattern is `^name`, naming one existing binding.",
          expr.span,
        );
      }
      return { tag: "pin", name: expr.arg.name, span: expr.span };
    }
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
            "BLOT_BAD_BINDER",
            "`!`, `?`, and `&` qualify a name, not a compound pattern.",
            expr.span,
          );
        }
        return { tag: "name", name: inner.name, qualifier, span: expr.span };
      }
    }
  }
  fail(
    "BLOT_BAD_BINDER",
    "This is not a valid binder.",
    expr.span,
  );
}

// --- expressions ------------------------------------------------------------

function lowerValue(rule: Rule, context: Context): Expr {
  let inner: Cursor;
  if (rule.name === "indented_value") inner = required(rule, "value");
  else inner = unwrap(rule);
  const target = asRule(inner, "value alternative");
  if (target.name === "lambda") return lowerLambda(target, context);
  return lowerExpression(target, context);
}

// `fn a => fn b => e` parses as one lambda with two parameters, because an
// island without a closing terminal cannot nest inside itself. Every parameter
// after the first becomes a lambda whose body is what follows it, so the AST
// has only one-parameter lambdas and the rest of the compiler never learns that
// currying has a spelling.
function lowerLambdaParameter(
  parameter: Rule,
): { readonly pattern: Pattern; readonly deferred: boolean } {
  const pattern = asRule(field(parameter, "pattern"), "pattern");
  const qualifierCursor = field(pattern, "qualifier");
  if (qualifierCursor === null || tokenOf(qualifierCursor).text !== "~") {
    return { pattern: lowerPattern(pattern), deferred: false };
  }
  const core = unwrap(asRule(field(pattern, "value"), "pattern_core"));
  if (
    core.type !== "token" ||
    (core.kind !== "IDENT" && core.kind !== "TYPE_IDENT")
  ) {
    fail(
      "BLOT_BAD_DEFERRED_PARAMETER",
      "`~` defers one name parameter. Bind a name, then destructure the value after it is demanded.",
      pattern.span,
    );
  }
  if (core.text === "_") {
    return {
      pattern: { tag: "wildcard", span: pattern.span },
      deferred: true,
    };
  }
  return {
    pattern: {
      tag: "name",
      name: core.text,
      qualifier: "none",
      span: pattern.span,
    },
    deferred: true,
  };
}

function lowerLambda(rule: Rule, context: Context): Expr {
  expect(
    rule.name === "lambda" || rule.name === "bounded_lambda",
    `expected lambda, got ${rule.name}`,
  );
  const parameters = fieldList(rule, "parameters")
    .map((cursor) => asRule(cursor, "lambda_parameter"));
  expect(parameters.length > 0, "a lambda has no parameter");
  const bodyContext: Context = {
    ...context,
    loop: null,
    returnScope: false,
    escapeBoundary: "none",
  };
  const body = asRule(field(rule, "body"), "body");
  let result: Expr;
  if (rule.name === "bounded_lambda") {
    result = lowerPrimary(body, bodyContext);
  } else {
    result = lowerExpression(body, bodyContext);
  }
  for (const parameter of [...parameters].reverse()) {
    const lowered = lowerLambdaParameter(parameter);
    result = {
      tag: "lambda",
      parameter: lowered.pattern,
      // A source curried chain is one lambda island. Preserve the assertion on
      // every unary lambda produced from it so later parameters cannot make the
      // checked body vacuous.
      // Written only when the parameter is deferred, so an ordinary lambda is
      // the same node it was before this form existed — which is what the
      // capsule format round-trips and what the Rust middle builds.
      ...(lowered.deferred ? { deferred: true } : {}),
      body: result,
      span: { start: parameter.span.start, end: rule.span.end },
    };
  }
  return result;
}

function lowerExpression(rule: Rule, context: Context): Expr {
  expect(
    rule.name === "expression" || rule.name === "continued_expression",
    `expected expression, got ${rule.name}`,
  );
  const first = lowerOperand(asRule(field(rule, "first"), "first"), context);
  const steps: ChainStep[] = fieldList(rule, "rest").map((cursor) => {
    const step = asRule(cursor, "infix_operation");
    const right = asRule(field(step, "right"), "right");
    let loweredRight: Expr;
    if (right.name === "bounded_lambda") {
      loweredRight = lowerLambda(right, context);
    } else {
      loweredRight = lowerOperand(right, context);
    }
    return {
      operator: tokenOf(required(step, "operator")).text,
      right: loweredRight,
      span: step.span,
    };
  });
  return foldChain(first, steps, context.table);
}

function lowerOperand(rule: Rule, context: Context): Expr {
  let result = lowerPostfix(
    asRule(field(rule, "value"), "postfix_expression"),
    context,
  );
  const prefixes = fieldList(rule, "prefixes")
    .map((cursor) => tokenOf(cursor))
    .reverse();

  for (const prefix of prefixes) {
    const span = { start: rule.span.start, end: result.span.end };
    // A negated literal folds here rather than dispatching to `Int.negate`,
    // so writing `-1` does not require the prelude to be in scope.
    if (prefix.text === "-" && result.tag === "int") {
      result = { tag: "int", value: -result.value, span };
      continue;
    }
    if (prefix.text === "^" && context.patternHead) {
      result = {
        tag: "apply",
        fn: { tag: "intrinsic", name: "@pattern.pin", span: prefix.span },
        arg: result,
        span,
      };
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
    if (cursor.kind === "FLOAT") {
      return { tag: "float", value: Number(cursor.text), span };
    }
    if (cursor.kind === "TEXT") {
      return { tag: "text", value: decodeText(cursor.text, span), span };
    }
    if (cursor.kind === "INTRINSIC") {
      if (cursor.text === "@import") {
        fail(
          "BLOT_RETIRED_IMPORT",
          '`@import` is retired; write `import "path"` or `import "path" with value`.',
          span,
        );
      }
      return { tag: "intrinsic", name: cursor.text, span };
    }
    fail(
      "BLOT_BAD_EXPRESSION",
      `\`${cursor.text}\` is not an expression.`,
      span,
    );
  }

  const rule = cursor;
  if (rule.name === "import_expression") {
    const specifierToken = tokenOf(required(rule, "specifier"));
    const specifier: Expr = {
      tag: "text",
      value: decodeText(specifierToken.text, specifierToken.span),
      span: specifierToken.span,
    };
    const loaded: Expr = {
      tag: "apply",
      fn: { tag: "intrinsic", name: "@import", span: rule.span },
      arg: specifier,
      span: { start: rule.span.start, end: specifier.span.end },
    };
    const inputField = rule.field("input");
    let input: Expr = { tag: "unit", span: rule.span };
    if (Array.isArray(inputField)) {
      const inputCursor = inputField[1];
      expect(
        inputCursor !== null && inputCursor !== undefined,
        "import input has no value",
      );
      input = lowerValue(asRule(inputCursor, "import input"), context);
    }
    return {
      tag: "apply",
      fn: loaded,
      arg: input,
      span: rule.span,
    };
  }
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
    if (field(rule, "tail") === null) return first;
    const rest = fieldList(rule, "rest").map((c) =>
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

  // An effect row remains the compile-time array consumed by `~`. A tail is
  // lowered as the signature-local type variable that `lowerDecl` implicitly
  // quantifies with `@forall`; `@type.performs` is the only primitive that
  // interprets such an array member as a row tail.
  if (rule.name === "effect_row") {
    // The compact CPU CST keeps token-only tails transparent, so `{ ..e }`
    // arrives as `{`, `..`, `e`, `}` instead of a named child rule. Split at
    // top-level commas rather than relying on the optional-field view.
    const members: Cursor[][] = [];
    let current: Cursor[] = [];
    for (const child of rule.children().slice(1, -1)) {
      if (child.type === "token" && child.text === ",") {
        members.push(current);
        current = [];
      } else {
        current.push(child);
      }
    }
    if (current.length > 0) members.push(current);

    const elements: ArrayElement[] = [];
    let sawTail = false;
    for (let index = 0; index < members.length; index += 1) {
      const member = members[index];
      const tailName =
        member[0]?.type === "rule" && member[0].name === "effect_row_tail"
          ? tokenOf(required(member[0], "name"))
          : member[0]?.type === "token" && member[0].text === ".."
          ? member[1]?.type === "token" ? member[1] : null
          : null;
      if (tailName !== null) {
        if (sawTail || index !== members.length - 1) {
          fail(
            "BLOT_EFFECT_ROW_TAIL_POSITION",
            "An effect row has at most one tail, and it must be its final member.",
            tailName.span,
          );
        }
        sawTail = true;
        elements.push({
          spread: false,
          value: { tag: "var", name: tailName.text, span: tailName.span },
        });
        continue;
      }
      const expression = member.find((cursor) =>
        cursor.type === "rule" && cursor.name === "expression"
      );
      expect(
        expression !== undefined,
        `unknown effect-row member ${
          member[0]?.type === "rule" ? member[0].name : member[0]?.type
        }`,
      );
      elements.push({
        spread: false,
        value: lowerExpression(asRule(expression, "expression"), context),
      });
    }
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
      let value = lowerValue(
        asRule(field(member, "value"), "value"),
        context,
      );
      if (field(member, "optional") !== null) {
        const applied: Expr = {
          tag: "apply",
          fn: { tag: "intrinsic", name: "@type.union", span: member.span },
          arg: value,
          span: member.span,
        };
        value = {
          tag: "apply",
          fn: applied,
          arg: { tag: "unit", span: member.span },
          span: member.span,
        };
      }
      return {
        tag: "field",
        name: tokenOf(required(member, "name")).text,
        value,
      };
    });
    return { tag: "shape", members, span: rule.span };
  }

  if (rule.name === "case_expression") {
    const closed: Context = {
      ...context,
      loop: null,
      returnScope: false,
      escapeBoundary: "value-condition",
    };
    const arms: GuardedArm[] = [
      lowerArm(asRule(field(rule, "first"), "first"), closed),
    ];
    for (const cursor of fieldList(rule, "rest")) {
      arms.push(lowerArm(asRule(cursor, "case_arm"), closed));
    }
    const target = lowerExpression(
      asRule(field(rule, "target"), "target"),
      closed,
    );
    return lowerGuards(target, arms, rule.span);
  }

  if (rule.name === "do_block") {
    let statements = fieldList(rule, "statements");
    let result: Expr = { tag: "unit", span: rule.span };
    let resultEffects: "pure" | "ambient" = "pure";
    const blockContext: Context = {
      ...context,
      returnScope: true,
    };
    const last = statements.at(-1);
    let containsOnlyResult = false;
    if (last !== undefined) {
      const terminalReturn = lowerTerminalReturn(last, blockContext);
      if (terminalReturn !== null) {
        result = terminalReturn;
        resultEffects = "ambient";
        statements = statements.slice(0, -1);
        containsOnlyResult = statements.length === 0;
      }
    }
    if (containsOnlyResult) return result;
    if (statementsNeedControlLowering(statements)) {
      return {
        tag: "block",
        declarations: [],
        result: resolveControlSequence(
          statements,
          result,
          blockContext,
          rule.span,
        ),
        resultEffects: "ambient",
        span: rule.span,
      };
    }
    const declarations = statements.map((statement) =>
      lowerDecl(asRule(unwrap(statement), "statement"), blockContext)
    );
    return {
      tag: "block",
      declarations,
      result,
      resultEffects,
      span: rule.span,
    };
  }

  fail(
    "BLOT_BAD_EXPRESSION",
    `\`${rule.name}\` is not an expression.`,
    rule.span,
  );
}

/** A `case` arm as written: its pattern, the guard refining it, and its body. */
interface GuardedArm {
  readonly pattern: Pattern;
  readonly guard: Expr | null;
  readonly body: Expr;
}

function lowerCaseGuard(rule: Rule, context: Context): Expr | null {
  const guard = field(rule, "guard");
  if (guard === null) return null;
  return lowerExpression(
    asRule(field(asRule(guard, "case_guard"), "condition"), "condition"),
    context,
  );
}

function lowerArm(rule: Rule, context: Context): GuardedArm {
  return {
    pattern: lowerPattern(asRule(field(rule, "pattern"), "pattern")),
    guard: lowerCaseGuard(rule, context),
    body: lowerValue(asRule(field(rule, "body"), "body"), context),
  };
}

function plainArm(arm: GuardedArm): Arm {
  return { pattern: arm.pattern, body: arm.body };
}

/**
 * A `case` with guarded arms, rewritten into ordinary ones.
 *
 * A guard is a refinement the pattern cannot state, so a guarded arm is taken
 * when the pattern matches *and* the guard holds. A false guard has to reach
 * the arms below, and a `case` has no fall-through — so the arms below become a
 * nullary binding that the guard's `else` calls, and the level left behind
 * decides one guard and nothing else.
 *
 * The arms above the guarded one stay at that level, with their binders erased
 * and their bodies replaced by the same call. They are what keeps the order the
 * arms were written in — `case n of` followed by the arms `5 => "five"` and
 * `m if m > 0 => "positive"`
 * answers `"five"` for 5 — while the body each of them runs is the one the
 * fall-through holds. Every body is therefore written exactly once, at the
 * level that dropped the guard it stood after, and a chain of guards costs a
 * level each rather than a copy of everything below it.
 *
 * What is left when the last guard is gone is the arm matrix with the guarded
 * rows removed, and that residual `case` is where exhaustiveness is decided: a
 * guard may be false, so a guarded arm cannot be the arm that matches, and a
 * row that cannot match must not close a column. Nothing downstream knows a
 * guard existed. Coverage checks the residual, and every guarded level carries
 * a `_` arm that makes it complete on its own.
 */
function lowerGuards(
  target: Expr,
  arms: readonly GuardedArm[],
  span: Span,
): Expr {
  if (arms.every((arm) => arm.guard === null)) {
    return { tag: "case", target, arms: arms.map(plainArm), span };
  }
  // Every level matches the same scrutinee, so it is evaluated once and named.
  // A name is already one evaluation, and keeping it is also what lets an arm
  // narrow the binding the `case` was written over.
  if (target.tag === "var") return guardLevel(target, arms, span, 0);
  const subject = `subject$${span.start}$${span.end}`;
  return {
    tag: "block",
    declarations: [{
      tag: "binding",
      kind: "let",
      tags: [],
      pattern: { tag: "name", name: subject, qualifier: "none", span },
      value: target,
      span,
    }],
    result: guardLevel({ tag: "var", name: subject, span }, arms, span, 0),
    resultEffects: "ambient",
    span,
  };
}

/** One guard removed, with the rest of the arms behind a nullary binding. */
function guardLevel(
  subject: Expr,
  arms: readonly GuardedArm[],
  span: Span,
  depth: number,
): Expr {
  const index = arms.findIndex((arm) => arm.guard !== null);
  if (index === -1) {
    return { tag: "case", target: subject, arms: arms.map(plainArm), span };
  }
  const guarded = arms[index];
  const condition = guarded.guard;
  expect(condition !== null, "a guarded arm without its guard");

  const name = `fallthrough$${span.start}$${span.end}$${depth}`;
  const fallthrough = (): Expr => ({
    tag: "apply",
    fn: { tag: "var", name, span },
    arg: { tag: "unit", span },
    span,
  });

  const level: Arm[] = arms.slice(0, index).map((arm) => ({
    pattern: eraseBinders(arm.pattern),
    body: fallthrough(),
  }));
  level.push({
    pattern: guarded.pattern,
    body: {
      tag: "if",
      branches: [{ condition, consequence: guarded.body }],
      fallback: fallthrough(),
      span,
    },
  });
  // The guarded pattern not matching is the other way down, and it is what
  // makes this level complete without the arms it no longer holds.
  level.push({ pattern: { tag: "wildcard", span }, body: fallthrough() });

  return {
    tag: "block",
    declarations: [{
      tag: "binding",
      kind: "let",
      tags: [],
      pattern: { tag: "name", name, qualifier: "none", span },
      value: {
        tag: "lambda",
        parameter: { tag: "unit", span },
        body: guardLevel(
          subject,
          [...arms.slice(0, index), ...arms.slice(index + 1)],
          span,
          depth + 1,
        ),
        span,
      },
      span,
    }],
    result: { tag: "case", target: subject, arms: level, span },
    resultEffects: "ambient",
    span,
  };
}

/**
 * The same test, binding nothing.
 *
 * An arm kept above a guarded one is there for the order it was written in;
 * its body has moved to the fall-through, so nothing at this level reads what
 * its pattern binds. Erasing the binders is what keeps a linear name from
 * being bound where it can never be spent.
 */
function eraseBinders(pattern: Pattern): Pattern {
  switch (pattern.tag) {
    case "name":
      return { tag: "wildcard", span: pattern.span };
    case "tuple":
    case "array":
      return { ...pattern, elements: pattern.elements.map(eraseBinders) };
    case "constructor":
      if (pattern.payload === null) return pattern;
      return { ...pattern, payload: eraseBinders(pattern.payload) };
    case "shape":
      return {
        ...pattern,
        fields: pattern.fields.map((member) => ({
          ...member,
          pattern: eraseBinders(member.pattern),
        })),
      };
    default:
      return pattern;
  }
}

export { textOf };
