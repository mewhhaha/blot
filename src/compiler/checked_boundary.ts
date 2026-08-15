import { createHash } from "node:crypto";
import type { Loaded } from "./frontend.ts";
import type { Decl, Expr, Pattern } from "../syntax/ast.ts";
import { liveDeclarations } from "../syntax/live.ts";
import { encodePortableModule } from "../syntax/portable.ts";

/**
 * Hashes every checked source node except an isolated dead literal declaration.
 * Omitting anything broader would require a stronger inference-deadness proof.
 */
export function checkedSourceFingerprint(loaded: Loaded): string {
  const forgotten = provablyIsolatedDeadDeclarations(loaded);
  const declarations = loaded.module.declarations.filter((declaration) =>
    !forgotten.has(declaration)
  );
  const sliced = { ...loaded.module, declarations };
  return digest(
    JSON.stringify(withoutSourceLocations(encodePortableModule(sliced))),
  );
}

function provablyIsolatedDeadDeclarations(loaded: Loaded): ReadonlySet<Decl> {
  const declarations = loaded.module.declarations;
  const live = liveDeclarations(declarations, loaded.module.result);
  const referenced = moduleReferencedNames(loaded);
  const forgotten = new Set<Decl>();
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    if (
      declaration === undefined || live.has(declaration) ||
      !literalDeadCandidate(declaration)
    ) continue;
    const previous = declarations[index - 1];
    if (
      previous !== undefined && previous.tag === "binding" &&
      previous.kind === "sig"
    ) continue;
    if (referenced.has(declaration.pattern.name)) continue;
    forgotten.add(declaration);
  }
  return forgotten;
}

function literalDeadCandidate(
  declaration: Decl,
): declaration is Extract<Decl, { readonly tag: "binding" }> & {
  readonly pattern: Extract<Pattern, { readonly tag: "name" }>;
} {
  if (declaration.tag !== "binding" || declaration.kind !== "const") {
    return false;
  }
  if (
    declaration.tags.length !== 0 || declaration.pattern.tag !== "name" ||
    declaration.pattern.qualifier !== "none"
  ) return false;
  return declaration.value.tag === "int" ||
    declaration.value.tag === "float" ||
    declaration.value.tag === "text" ||
    declaration.value.tag === "unit";
}

function moduleReferencedNames(loaded: Loaded): ReadonlySet<string> {
  const names = new Set<string>();
  addPatternReferences(loaded.module.parameter, names);
  for (const fixity of loaded.module.fixities) {
    for (const segment of fixity.target) names.add(segment);
  }
  for (const declaration of loaded.module.declarations) {
    addDeclarationReferences(declaration, names);
  }
  addExpressionReferences(loaded.module.result, names);
  return names;
}

function addDeclarationReferences(declaration: Decl, names: Set<string>): void {
  if (declaration.tag === "binding") {
    for (const tag of declaration.tags) {
      addExpressionReferences(tag.descriptor, names);
    }
    addPatternReferences(declaration.pattern, names);
  }
  addExpressionReferences(declaration.value, names);
}

function addPatternReferences(
  pattern: Pattern | null,
  names: Set<string>,
): void {
  if (pattern === null) return;
  switch (pattern.tag) {
    case "pin":
      names.add(pattern.name);
      return;
    case "tuple":
    case "array":
      for (const element of pattern.elements) {
        addPatternReferences(element, names);
      }
      return;
    case "constructor":
      addPatternReferences(pattern.payload, names);
      return;
    case "shape":
      for (const field of pattern.fields) {
        addPatternReferences(field.pattern, names);
      }
      return;
    default:
      return;
  }
}

function addExpressionReferences(expr: Expr, names: Set<string>): void {
  switch (expr.tag) {
    case "var":
      names.add(expr.name);
      return;
    case "apply":
      addExpressionReferences(expr.fn, names);
      addExpressionReferences(expr.arg, names);
      return;
    case "field":
      addExpressionReferences(expr.target, names);
      return;
    case "lambda":
      addPatternReferences(expr.parameter, names);
      addExpressionReferences(expr.body, names);
      return;
    case "array":
      for (const element of expr.elements) {
        addExpressionReferences(element.value, names);
      }
      return;
    case "tuple":
      for (const element of expr.elements) {
        addExpressionReferences(element, names);
      }
      return;
    case "shape":
      for (const member of expr.members) {
        addExpressionReferences(member.value, names);
      }
      return;
    case "if":
      for (const branch of expr.branches) {
        addExpressionReferences(branch.condition, names);
        addExpressionReferences(branch.consequence, names);
      }
      if (expr.fallback !== null) addExpressionReferences(expr.fallback, names);
      return;
    case "case":
      addExpressionReferences(expr.target, names);
      for (const arm of expr.arms) {
        addPatternReferences(arm.pattern, names);
        addExpressionReferences(arm.body, names);
      }
      return;
    case "block":
      for (const declaration of expr.declarations) {
        addDeclarationReferences(declaration, names);
      }
      addExpressionReferences(expr.result, names);
      return;
    case "rec":
      addExpressionReferences(expr.lambda, names);
      return;
    case "comptime":
      addExpressionReferences(expr.body, names);
      return;
    default:
      return;
  }
}

function withoutSourceLocations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSourceLocations);
  if (value === null || typeof value !== "object") return value;
  const entries: [string, unknown][] = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === "span") continue;
    entries.push([key, withoutSourceLocations(child)]);
  }
  return Object.fromEntries(entries);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
