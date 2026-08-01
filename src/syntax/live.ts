import type { Decl, Expr, Pattern } from "./ast.ts";
import { patternNames, recursiveGroups } from "./ast.ts";

interface Liveness {
  readonly declarations: ReadonlySet<Decl>;
  readonly dependencies: ReadonlySet<string>;
}

export function liveDeclarations(
  declarations: readonly Decl[],
  result: Expr,
): ReadonlySet<Decl> {
  return declarationLiveness(declarations, freeNames(result)).declarations;
}

function declarationLiveness(
  declarations: readonly Decl[],
  resultDependencies: ReadonlySet<string>,
): Liveness {
  const live = new Set<Decl>();
  const dependencies = new Set(resultDependencies);
  const groups = recursiveGroups(declarations);
  const visitedGroups = new Set<readonly unknown[]>();

  for (let index = declarations.length - 1; index >= 0; index -= 1) {
    const declaration = declarations[index];
    const group = groups.get(declaration);
    if (group !== undefined) {
      if (visitedGroups.has(group)) continue;
      visitedGroups.add(group);
      const names = new Set(group.map((member) => member.name));
      if (![...names].some((name) => dependencies.has(name))) continue;
      for (const member of group) live.add(member.declaration);
      for (const name of names) dependencies.delete(name);
      for (const member of group) {
        addDependencies(dependencies, freeNames(member.declaration.value));
      }
      for (const name of names) dependencies.delete(name);
      continue;
    }

    if (declaration.tag === "open") {
      live.add(declaration);
      addDependencies(dependencies, freeNames(declaration.value));
      continue;
    }
    if (declaration.tag === "shadow") {
      if (!dependencies.has(declaration.name)) continue;
      live.add(declaration);
      dependencies.delete(declaration.name);
      addDependencies(dependencies, freeNames(declaration.value));
      continue;
    }
    if (declaration.kind === "sig") continue;

    const names = patternNames(declaration.pattern);
    const demanded = names.some((name) => dependencies.has(name));
    if (declaration.kind !== "effect" && !demanded) continue;
    live.add(declaration);
    for (const name of names) dependencies.delete(name);
    addDependencies(dependencies, pinnedNames(declaration.pattern));
    addDependencies(dependencies, freeNames(declaration.value));
  }

  return { declarations: live, dependencies };
}

function addDependencies(
  target: Set<string>,
  names: ReadonlySet<string>,
): void {
  for (const name of names) target.add(name);
}

function freeNames(expr: Expr): ReadonlySet<string> {
  const names = new Set<string>();
  collectFreeNames(expr, names);
  return names;
}

function collectFreeNames(expr: Expr, names: Set<string>): void {
  switch (expr.tag) {
    case "var":
      names.add(expr.name);
      return;
    case "apply":
      collectFreeNames(expr.fn, names);
      collectFreeNames(expr.arg, names);
      return;
    case "field":
      collectFreeNames(expr.target, names);
      return;
    case "lambda": {
      const body = new Set(freeNames(expr.body));
      for (const name of patternNames(expr.parameter)) body.delete(name);
      addDependencies(body, pinnedNames(expr.parameter));
      addDependencies(names, body);
      return;
    }
    case "rec":
      collectFreeNames(expr.lambda, names);
      return;
    case "comptime":
      collectFreeNames(expr.body, names);
      return;
    case "tuple":
      for (const element of expr.elements) collectFreeNames(element, names);
      return;
    case "array":
      for (const element of expr.elements) {
        collectFreeNames(element.value, names);
      }
      return;
    case "shape":
      for (const member of expr.members) collectFreeNames(member.value, names);
      return;
    case "if":
      for (const branch of expr.branches) {
        collectFreeNames(branch.condition, names);
        collectFreeNames(branch.consequence, names);
      }
      if (expr.fallback !== null) collectFreeNames(expr.fallback, names);
      return;
    case "case":
      collectFreeNames(expr.target, names);
      for (const arm of expr.arms) {
        const body = new Set(freeNames(arm.body));
        for (const name of patternNames(arm.pattern)) body.delete(name);
        addDependencies(body, pinnedNames(arm.pattern));
        addDependencies(names, body);
      }
      return;
    case "block": {
      const inner = declarationLiveness(
        expr.declarations,
        freeNames(expr.result),
      );
      addDependencies(names, inner.dependencies);
      return;
    }
    default:
      return;
  }
}

function pinnedNames(pattern: Pattern): ReadonlySet<string> {
  const names = new Set<string>();
  const collect = (current: Pattern): void => {
    switch (current.tag) {
      case "pin":
        names.add(current.name);
        return;
      case "tuple":
      case "array":
        for (const element of current.elements) collect(element);
        return;
      case "constructor":
        if (current.payload !== null) collect(current.payload);
        return;
      case "shape":
        for (const field of current.fields) collect(field.pattern);
        return;
      default:
        return;
    }
  };
  collect(pattern);
  return names;
}
