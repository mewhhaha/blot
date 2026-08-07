import type { Decl, Expr, Module, Pattern, Span } from "./ast.ts";

/**
 * Normalizes surface conveniences that are intentionally absent from Core.
 *
 * Two rules live here:
 *
 * - `@handle (Effect, handler)` is a computation transformer. Applying the
 *   resulting value to a nullary computation produces another nullary
 *   computation containing the ordinary saturated
 *   `@handle (Effect, computation, handler)` call. This makes ordinary `|>`
 *   composition preserve the same inner-to-outer order as the former
 *   `try ... with` surface form without hiding the generative effect identity
 *   behind an ordinary function parameter.
 * - a two-arm `case` over `#True` and `#False` becomes the existing internal
 *   conditional node. `case` is the source value-selection form, while this
 *   keeps the checker's existing branch-refinement machinery and does not add a
 *   second Boolean semantics downstream.
 */
export function elaborateSurface(module: Module): Module {
  return {
    ...module,
    declarations: module.declarations.map(elaborateDeclaration),
    result: elaborateExpression(module.result),
  };
}

function elaborateDeclaration(declaration: Decl): Decl {
  if (declaration.tag === "binding") {
    return {
      ...declaration,
      tags: declaration.tags.map((tag) => ({
        ...tag,
        descriptor: elaborateExpression(tag.descriptor),
      })),
      value: elaborateExpression(declaration.value),
    };
  }
  if (declaration.tag === "shadow") {
    return { ...declaration, value: elaborateExpression(declaration.value) };
  }
  return { ...declaration, value: elaborateExpression(declaration.value) };
}

function elaborateExpression(expression: Expr): Expr {
  switch (expression.tag) {
    case "apply": {
      const fn = elaborateExpression(expression.fn);
      const arg = elaborateExpression(expression.arg);
      if (
        fn.tag === "intrinsic" && fn.name === "@handle" &&
        arg.tag === "tuple" && arg.elements.length === 2
      ) {
        return handlerTransformer(
          arg.elements[0],
          arg.elements[1],
          expression.span,
        );
      }
      return { ...expression, fn, arg };
    }
    case "field":
      return {
        ...expression,
        target: elaborateExpression(expression.target),
      };
    case "lambda":
      return {
        ...expression,
        body: elaborateExpression(expression.body),
      };
    case "rec":
      return {
        ...expression,
        lambda: elaborateExpression(expression.lambda),
      };
    case "comptime":
      return {
        ...expression,
        body: elaborateExpression(expression.body),
      };
    case "array":
      return {
        ...expression,
        elements: expression.elements.map((element) => ({
          ...element,
          value: elaborateExpression(element.value),
        })),
      };
    case "tuple":
      return {
        ...expression,
        elements: expression.elements.map(elaborateExpression),
      };
    case "shape":
      return {
        ...expression,
        members: expression.members.map((member) => ({
          ...member,
          value: elaborateExpression(member.value),
        })),
      };
    case "if":
      return {
        ...expression,
        branches: expression.branches.map((branch) => ({
          condition: elaborateExpression(branch.condition),
          consequence: elaborateExpression(branch.consequence),
        })),
        fallback: expression.fallback === null
          ? null
          : elaborateExpression(expression.fallback),
      };
    case "case": {
      const target = elaborateExpression(expression.target);
      const arms = expression.arms.map((arm) => ({
        pattern: arm.pattern,
        body: elaborateExpression(arm.body),
      }));
      const trueArm = arms.find((arm) => booleanPattern(arm.pattern, "True"));
      const falseArm = arms.find((arm) => booleanPattern(arm.pattern, "False"));
      if (
        arms.length === 2 && trueArm !== undefined && falseArm !== undefined
      ) {
        return {
          tag: "if",
          branches: [{ condition: target, consequence: trueArm.body }],
          fallback: falseArm.body,
          span: expression.span,
        };
      }
      return { ...expression, target, arms };
    }
    case "block":
      return {
        ...expression,
        declarations: expression.declarations.map(elaborateDeclaration),
        result: elaborateExpression(expression.result),
      };
    default:
      return expression;
  }
}

function booleanPattern(
  pattern: Pattern,
  name: "True" | "False",
): boolean {
  return pattern.tag === "constructor" && pattern.name === name &&
    pattern.payload === null;
}

function handlerTransformer(
  effect: Expr,
  handler: Expr,
  span: Span,
): Expr {
  const computationName = `handlerInput$${span.start}$${span.end}`;
  const resultName = `handlerResult$${span.start}$${span.end}`;
  const computation: Expr = {
    tag: "var",
    name: computationName,
    span,
  };
  const saturated: Expr = {
    tag: "apply",
    fn: { tag: "intrinsic", name: "@handle", span },
    arg: {
      tag: "tuple",
      elements: [effect, computation, handler],
      span,
    },
    span,
  };
  const delayed: Expr = {
    tag: "lambda",
    parameter: { tag: "unit", span },
    body: {
      tag: "block",
      declarations: [{
        tag: "binding",
        kind: "effect",
        tags: [],
        pattern: {
          tag: "name",
          name: resultName,
          qualifier: "none",
          span,
        },
        value: saturated,
        span,
      }],
      result: { tag: "var", name: resultName, span },
      resultEffects: "ambient",
      span,
    },
    span,
  };
  return {
    tag: "lambda",
    parameter: {
      tag: "name",
      name: computationName,
      qualifier: "linear",
      span,
    },
    body: delayed,
    span,
  };
}
