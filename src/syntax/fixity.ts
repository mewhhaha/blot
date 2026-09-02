// Precedence resolution.
//
// The grammar parses expressions as flat `operand (OPERATOR operand)*` chains
// so that the contracted grammar has no residual recursion — precedence is a
// semantic recipe, not a grammar shape. This is where the chain becomes a tree.
//
// The table is needed only here, never by the parser. Standard entries are
// generated from the source declarations at the top of the prelude; declarations
// in the current module override them before any expression is folded.

import type { Expr, Span } from "./ast.ts";
import { fail } from "../diagnostic.ts";
import { generatedFixities } from "./fixities.generated.ts";
import { type Associativity, type Fixity } from "./source_fixity.ts";
export {
  type Associativity,
  declaredFixities,
  type Fixity,
} from "./source_fixity.ts";

const NOWHERE: Span = { start: 0, end: 0 };

function entry(
  operator: string,
  associativity: Associativity,
  precedence: number,
  target: string,
): Fixity {
  // An intrinsic is one token, dots included; only a qualified name splits.
  let path = [target];
  if (!target.startsWith("@")) path = target.split(".");
  return {
    operator,
    associativity,
    precedence,
    target: path,
    span: NOWHERE,
  };
}

/** Derived from the source fixity header in `src/prelude/prelude.blot`. */
export const STANDARD_FIXITIES: readonly Fixity[] = [
  ...generatedFixities.map((fixity) => {
    return entry(
      fixity.operator,
      fixity.associativity,
      fixity.precedence,
      fixity.target,
    );
  }),
];

function fixityForm(fixity: Fixity): "prefix" | "infix" {
  if (fixity.associativity === "prefix") return "prefix";
  return "infix";
}

export interface FixityTable {
  infix(operator: string): Fixity | undefined;
  prefix(operator: string): Fixity | undefined;
}

export function resolveFixities(
  declared: readonly Fixity[] = [],
): readonly Fixity[] {
  const declaredKeys = new Set<string>();
  for (const fixity of declared) {
    const form = fixityForm(fixity);
    const key = `${form}:${fixity.operator}`;
    if (declaredKeys.has(key)) {
      fail(
        "BLOT_DUPLICATE_FIXITY",
        `The ${form} operator \`${fixity.operator}\` is declared more than once.`,
        fixity.span,
      );
    }
    declaredKeys.add(key);
  }

  const active = new Map<string, Fixity>();
  for (const fixity of [...STANDARD_FIXITIES, ...declared]) {
    const form = fixityForm(fixity);
    active.set(`${form}:${fixity.operator}`, fixity);
  }
  return [...active.values()];
}

export function buildFixityTable(
  declared: readonly Fixity[] = [],
): FixityTable {
  const infix = new Map<string, Fixity>();
  const prefix = new Map<string, Fixity>();

  for (const fixity of resolveFixities(declared)) {
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
        `No source fixity is declared for the infix operator \`${step.operator}\`.`,
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
