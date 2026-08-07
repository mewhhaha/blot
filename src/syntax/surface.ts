import type { Decl, Expr, Module, Pattern, Span } from "./ast.ts";

/**
 * Normalizes surface conveniences that are intentionally absent from Core.
 *
 * Two rules live here:
 *
 * - `@handle (Effect, handler)` is a computation transformer. Applying the
 *   resulting value to a nullary computation produces another nullary
 *   computation containing the ordinary saturated
 *   `@handle (Effect, computation, handler)` call. A `|>` whose right operand
 *   is one of these steps is written directly as that saturated computation,
 *   so an owned computation neither passes through generic `Fn.pipe` nor
 *   through the transformer's own parameter.
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
      const piped = pipedHandlerStep(expression);
      if (piped !== null) return piped;
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

/**
 * Lowers `computation |> @handle (Effect, handler)` to the handled computation
 * itself rather than to a call of the transformer below.
 *
 * The two spellings would otherwise disagree about ownership. A transformer
 * consumes its computation exactly once, so its parameter is owned, and a
 * handled computation that owns a resource requires `!resume` of every clause.
 * Passing the piped computation through that parameter would impose the
 * requirement on every pipeline, including one whose computation owns nothing.
 * Substituting it instead lets `@handle` see the written computation, so the
 * requirement follows from what the program owns.
 */
function pipedHandlerStep(expression: Expr): Expr | null {
  if (expression.tag !== "apply") return null;
  if (expression.fn.tag !== "apply" || !isFnPipe(expression.fn.fn)) return null;
  const step = expression.arg;
  if (step.tag !== "apply") return null;
  if (step.fn.tag !== "intrinsic" || step.fn.name !== "@handle") return null;
  if (step.arg.tag !== "tuple" || step.arg.elements.length !== 2) return null;
  return handledComputation(
    elaborateExpression(step.arg.elements[0]),
    elaborateExpression(expression.fn.arg),
    elaborateExpression(step.arg.elements[1]),
    expression.span,
  );
}

function isFnPipe(expression: Expr): boolean {
  return expression.tag === "field" && expression.name === "pipe" &&
    expression.target.tag === "var" && expression.target.name === "Fn";
}

function handlerTransformer(
  effect: Expr,
  handler: Expr,
  span: Span,
): Expr {
  const computationName = `handlerInput$${span.start}$${span.end}`;
  const computation: Expr = {
    tag: "var",
    name: computationName,
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
    body: handledComputation(effect, computation, handler, span),
    span,
  };
}

function handledComputation(
  effect: Expr,
  computation: Expr,
  handler: Expr,
  span: Span,
): Expr {
  const resultName = `handlerResult$${span.start}$${span.end}`;
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
  return {
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
}
