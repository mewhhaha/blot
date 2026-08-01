// Declaration-tag test discovery and execution.
//
// Tests use the CPU evaluator, like `blot check` and `blot eval`. A fresh
// declaration prefix is evaluated for each test so a later shadow cannot
// replace the tagged occurrence and one failed test cannot poison another.

import { BlotError, type Diagnostic } from "./diagnostic.ts";
import { checkFile } from "./check/mod.ts";
import { show } from "./check/print.ts";
import {
  constrain,
  instantiate,
  scheme,
  TypeError_,
} from "./check/constrain.ts";
import { fun, PURE, type SimpleType, UNIT as UNIT_TYPE } from "./check/type.ts";
import {
  apply,
  evaluationRuntime,
  moduleClosure,
  run,
} from "./comptime/eval.ts";
import { UNIT } from "./comptime/value.ts";
import { load, type Loaded } from "./load.ts";
import type { Decl, Expr, Module, Span } from "./syntax/ast.ts";

export type TestOutcome =
  | {
    readonly status: "passed";
    readonly path: string;
    readonly name: string;
    readonly span: Span;
  }
  | {
    readonly status: "failed";
    readonly path: string;
    readonly name: string;
    readonly span: Span;
    readonly diagnostic: Diagnostic;
  };

interface TestDeclaration {
  readonly declaration: Decl & { tag: "binding" };
  readonly index: number;
  readonly name: string;
}

export async function testFile(path: string): Promise<readonly TestOutcome[]> {
  const loaded = await load(path);
  const checked = await checkFile(path);
  const tests = discoverTests(loaded.module, checked.declarationTags, loaded);
  if (tests.length === 0) return [];

  if (loaded.module.parameter !== null) {
    invalidSuite(
      loaded,
      "A file run by `blot test` cannot declare a module parameter.",
      loaded.module.parameter.span,
    );
  }
  if (checked.effects !== "") {
    invalidSuite(
      loaded,
      `A file run by \`blot test\` must initialize without effects, found ${checked.effects.trim()}.`,
      loaded.module.span,
    );
  }

  const outcomes: TestOutcome[] = [];
  for (const test of tests) {
    const tagged = checked.declarationTags.get(test.declaration);
    if (tagged === undefined) {
      throw new Error(
        `test declaration ${test.name} has no resolved tag facts`,
      );
    }
    const type = show(tagged.type);
    if (!acceptsTestContract(tagged.type)) {
      invalidSuite(
        loaded,
        `Test \`${test.name}\` must have type \`() -> ()\`, found ${type}.`,
        test.declaration.span,
      );
    }
    outcomes.push(runTest(loaded, test));
  }
  return outcomes;
}

function acceptsTestContract(type: SimpleType): boolean {
  const copy = instantiate(scheme(type, -1), 0, new Map());
  try {
    constrain(copy, fun(UNIT_TYPE, UNIT_TYPE, PURE));
    return true;
  } catch (error) {
    if (error instanceof TypeError_) return false;
    throw error;
  }
}

function discoverTests(
  module: Module,
  tags: ReadonlyMap<Decl, { readonly tags: readonly { name: string }[] }>,
  loaded: Loaded,
): readonly TestDeclaration[] {
  const tests: TestDeclaration[] = [];
  for (let index = 0; index < module.declarations.length; index += 1) {
    const declaration = module.declarations[index];
    const tagged = tags.get(declaration);
    if (
      tagged !== undefined && tagged.tags.some((tag) => tag.name === "test")
    ) {
      if (declaration.tag !== "binding" || declaration.pattern.tag !== "name") {
        invalidSuite(
          loaded,
          "A `test` tag requires a named top-level `let` or `const` binding.",
          declaration.span,
        );
      }
      tests.push({ declaration, index, name: declaration.pattern.name });
    }
    rejectNestedTests(declaration.value, tags, loaded);
  }
  rejectNestedTests(module.result, tags, loaded);
  return tests;
}

function rejectNestedTests(
  expression: Expr,
  tags: ReadonlyMap<Decl, { readonly tags: readonly { name: string }[] }>,
  loaded: Loaded,
): void {
  visitNestedDeclarations(expression, (declaration) => {
    const tagged = tags.get(declaration);
    if (
      tagged !== undefined && tagged.tags.some((tag) => tag.name === "test")
    ) {
      invalidSuite(
        loaded,
        "A `test` tag is discoverable only on a top-level named binding.",
        declaration.span,
      );
    }
  });
}

function visitNestedDeclarations(
  expression: Expr,
  visit: (declaration: Decl) => void,
): void {
  switch (expression.tag) {
    case "apply":
      visitNestedDeclarations(expression.fn, visit);
      visitNestedDeclarations(expression.arg, visit);
      return;
    case "field":
      visitNestedDeclarations(expression.target, visit);
      return;
    case "lambda":
      visitNestedDeclarations(expression.body, visit);
      return;
    case "rec":
      visitNestedDeclarations(expression.lambda, visit);
      return;
    case "comptime":
      visitNestedDeclarations(expression.body, visit);
      return;
    case "tuple":
      for (const element of expression.elements) {
        visitNestedDeclarations(element, visit);
      }
      return;
    case "array":
      for (const element of expression.elements) {
        visitNestedDeclarations(element.value, visit);
      }
      return;
    case "shape":
      for (const member of expression.members) {
        visitNestedDeclarations(member.value, visit);
      }
      return;
    case "if":
      for (const branch of expression.branches) {
        visitNestedDeclarations(branch.condition, visit);
        visitNestedDeclarations(branch.consequence, visit);
      }
      if (expression.fallback !== null) {
        visitNestedDeclarations(expression.fallback, visit);
      }
      return;
    case "case":
      visitNestedDeclarations(expression.target, visit);
      for (const arm of expression.arms) {
        visitNestedDeclarations(arm.body, visit);
      }
      return;
    case "block":
      for (const declaration of expression.declarations) {
        visit(declaration);
        visitNestedDeclarations(declaration.value, visit);
      }
      visitNestedDeclarations(expression.result, visit);
      return;
    default:
      return;
  }
}

function runTest(loaded: Loaded, test: TestDeclaration): TestOutcome {
  if (loaded.closure.tag !== "closure") {
    throw new Error(`test module ${loaded.path} did not load as a closure`);
  }
  const result: Expr = {
    tag: "var",
    name: test.name,
    span: test.declaration.pattern.span,
  };
  const prefix: Module = {
    ...loaded.module,
    parameter: null,
    declarations: loaded.module.declarations.slice(0, test.index + 1),
    result,
  };
  let imports = loaded.closure.imports;
  if (imports === undefined) imports = new Map();
  try {
    const testValue = run(
      apply(
        moduleClosure(prefix, loaded.closure.env, imports),
        UNIT,
        test.declaration.span,
        evaluationRuntime(imports, "runtime"),
      ),
    );
    const returned = run(
      apply(
        testValue,
        UNIT,
        test.declaration.span,
        evaluationRuntime(imports, "runtime"),
      ),
    );
    if (returned.tag !== "unit") {
      throw new Error(
        `test ${test.name} returned a non-unit value after checking`,
      );
    }
    return {
      status: "passed",
      path: loaded.path,
      name: test.name,
      span: test.declaration.span,
    };
  } catch (error) {
    if (!(error instanceof BlotError)) throw error;
    return {
      status: "failed",
      path: loaded.path,
      name: test.name,
      span: test.declaration.span,
      diagnostic: error.diagnostic,
    };
  }
}

function invalidSuite(loaded: Loaded, message: string, span: Span): never {
  throw new BlotError(
    { code: "BLOT_BAD_TEST", message, span },
    { path: loaded.path, source: loaded.source },
  );
}
