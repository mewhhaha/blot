// Precedence resolution.
//
// The grammar parses expressions as flat `operand (OPERATOR operand)*` chains
// so that the contracted grammar has no residual recursion — precedence is a
// semantic recipe, not a grammar shape. This is where the chain becomes a tree.
//
// The table is needed only here, never by the parser, so a built-in default set
// costs nothing structurally. Without it every file would have to restate the
// fixity of `+` before it could use it. The table is fixed language data.

import type { Expr, Span } from "./ast.ts";
import { fail } from "../diagnostic.ts";
import { generatedFixities } from "./fixities.generated.ts";

const NOWHERE: Span = { start: 0, end: 0 };

export type Associativity = "left" | "right" | "none" | "prefix";

export interface Fixity {
  readonly operator: string;
  readonly associativity: Associativity;
  readonly precedence: number;
  readonly target: readonly string[];
  readonly control: "and" | "or" | undefined;
  readonly span: Span;
}

function entry(
  operator: string,
  associativity: Associativity,
  precedence: number,
  target: string,
  control: "and" | "or" | undefined,
): Fixity {
  // An intrinsic is one token, dots included; only a qualified name splits.
  const path = target.startsWith("@") ? [target] : target.split(".");
  return {
    operator,
    associativity,
    precedence,
    target: path,
    control,
    span: NOWHERE,
  };
}

/**
 * Everything here is an ordinary blot declaration in `src/prelude`. None of it
 * is built into the compiler; only the precedence is.
 */
export const DEFAULT_FIXITIES: readonly Fixity[] = [
  ...generatedFixities.map((fixity) => {
    let control: "and" | "or" | undefined;
    if ("control" in fixity) control = fixity.control;
    return entry(
      fixity.operator,
      fixity.associativity,
      fixity.precedence,
      fixity.target,
      control,
    );
  }),
];

export interface FixityTable {
  infix(operator: string): Fixity | undefined;
  prefix(operator: string): Fixity | undefined;
}

export function buildFixityTable(): FixityTable {
  const infix = new Map<string, Fixity>();
  const prefix = new Map<string, Fixity>();

  for (const fixity of DEFAULT_FIXITIES) {
    if (fixity.associativity === "prefix") {
      prefix.set(fixity.operator, fixity);
    } else {
      infix.set(fixity.operator, fixity);
    }
  }

  return {
    infix: (operator) => infix.get(operator),
    prefix: (operator) => prefix.get(operator),
  };
}

/** Turns a fixity target such as `Int.add` or `@type.union` into a callee. */
export function targetExpr(fixity: Fixity, span: Span): Expr {
  const [root, ...rest] = fixity.target;
  let result: Expr = root.startsWith("@")
    ? { tag: "intrinsic", name: root, span }
    : { tag: "var", name: root, span };
  for (const name of rest) {
    result = { tag: "field", target: result, name, span };
  }
  return result;
}

export interface ChainStep {
  readonly operator: string;
  readonly right: Expr;
  readonly span: Span;
}

/**
 * Operator-precedence fold over the flat chain.
 *
 * Infix application is curried: `a + b` becomes `Int.add a b`, not
 * `Int.add (a, b)`. Currying is what makes `Int.add 2` a usable value, which is
 * what makes `20 |> Int.add 2` work at all, and it is the reading a language
 * with one parameter per function should have.
 */
export function foldChain(
  first: Expr,
  steps: readonly ChainStep[],
  table: FixityTable,
): Expr {
  let position = 0;

  const lookup = (step: ChainStep): Fixity => {
    const fixity = table.infix(step.operator);
    if (fixity === undefined) {
      fail(
        "BLOT_UNKNOWN_OPERATOR",
        `\`${step.operator}\` is not in Blot's fixed operator vocabulary. Use a named function call.`,
        step.span,
      );
    }
    return fixity;
  };

  const climb = (left: Expr, minimum: number): Expr => {
    let result = left;
    while (position < steps.length) {
      const step = steps[position];
      const fixity = lookup(step);
      if (fixity.precedence < minimum) break;
      position += 1;

      let right = step.right;
      while (position < steps.length) {
        const next = lookup(steps[position]);
        const bindsTighter = next.precedence > fixity.precedence ||
          (next.precedence === fixity.precedence &&
            next.associativity === "right");
        if (!bindsTighter) break;
        right = climb(right, next.precedence);
      }

      if (
        fixity.associativity === "none" && position < steps.length &&
        lookup(steps[position]).precedence === fixity.precedence
      ) {
        fail(
          "BLOT_NON_ASSOCIATIVE_CHAIN",
          `\`${step.operator}\` is non-associative, so it cannot be chained with \`${
            steps[position].operator
          }\` at the same precedence. Parenthesize one side.`,
          steps[position].span,
        );
      }

      const span = { start: result.span.start, end: right.span.end };
      if (fixity.control === "and") {
        result = {
          tag: "if",
          branches: [{ condition: result, consequence: right }],
          fallback: { tag: "tag", name: "False", span: step.span },
          span,
        };
        continue;
      }
      if (fixity.control === "or") {
        result = {
          tag: "if",
          branches: [{
            condition: result,
            consequence: { tag: "tag", name: "True", span: step.span },
          }],
          fallback: right,
          span,
        };
        continue;
      }
      const callee = targetExpr(fixity, step.span);
      result = {
        tag: "apply",
        fn: { tag: "apply", fn: callee, arg: result, span },
        arg: right,
        span,
      };
    }
    return result;
  };

  const folded = climb(first, 0);
  expectConsumed(position, steps);
  return folded;
}

function expectConsumed(position: number, steps: readonly ChainStep[]): void {
  if (position !== steps.length) {
    fail(
      "BLOT_UNRESOLVED_CHAIN",
      "The operator chain could not be fully resolved.",
      steps[position].span,
    );
  }
}
