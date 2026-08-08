import type { Expr, Pattern, Qualifier } from "../syntax/ast.ts";
import { patternNames } from "../syntax/ast.ts";
import { freeNames } from "../syntax/live.ts";
import type {
  Analysis,
  Binding,
  NamePattern,
  OwnershipExtraction,
  OwnershipLineage,
  OwnershipPathSegment,
  OwnershipTargetPathSegment,
  Scope,
} from "./check.ts";

/**
 * What obligation, if any, an expression *produced*. Only a closure that
 * captured one does, and the answer has to travel outward: the binding it lands
 * in inherits it whether or not anyone wrote a marker. A closure that captured
 * a linear value owes exactly one call; one that captured only affine values
 * owes at most one.
 */
export type Produced =
  | { readonly tag: "none" }
  | { readonly tag: "borrow"; readonly value: Produced }
  | {
    readonly tag: "leaf";
    readonly qualifier: "affine" | "linear";
    readonly source: NamePattern | null;
    readonly path: readonly OwnershipPathSegment[];
    readonly origins: readonly OwnershipOrigin[];
  }
  | {
    readonly tag: "closure";
    readonly captures: Produced;
    readonly parameter: Pattern;
    readonly result: Produced;
  }
  | { readonly tag: "many"; readonly values: readonly Produced[] }
  | { readonly tag: "sequence"; readonly elements: readonly Produced[] }
  | { readonly tag: "shape"; readonly fields: ReadonlyMap<string, Produced> }
  | { readonly tag: "variant"; readonly payload: Produced }
  | {
    readonly tag: "choice";
    readonly cases: ReadonlyMap<string, Produced>;
  };

export const NONE: Produced = { tag: "none" };

export interface OwnershipOrigin {
  readonly source: NamePattern;
  readonly path: readonly OwnershipPathSegment[];
  readonly extractions: readonly OwnershipExtraction[];
}

export function writtenObligation(
  qualifier: Qualifier,
  source: NamePattern | null,
  origin: NamePattern | null = source,
): Produced {
  if (qualifier === "linear" || qualifier === "affine") {
    const origins: OwnershipOrigin[] = [];
    if (origin !== null) {
      origins.push({ source: origin, path: [], extractions: [] });
    }
    return { tag: "leaf", qualifier, source, path: [], origins };
  }
  return NONE;
}

export function structuralLineage(
  destination: NamePattern,
  produced: Produced,
): readonly OwnershipLineage[] {
  const lineage: OwnershipLineage[] = [];
  const visit = (
    value: Produced,
    targetPath: readonly OwnershipTargetPathSegment[],
  ): void => {
    if (value.tag === "none") return;
    if (value.tag === "leaf") {
      for (const origin of value.origins) {
        if (
          origin.source === destination && origin.extractions.length === 0 &&
          sameTargetPath(origin.path, targetPath)
        ) continue;
        const entry = {
          source: origin.source,
          sourcePath: origin.path,
          targetPath,
          extractions: origin.extractions,
        } satisfies OwnershipLineage;
        if (lineage.some((existing) => sameLineage(existing, entry))) continue;
        lineage.push(entry);
      }
      return;
    }
    if (value.tag === "borrow") {
      visit(value.value, targetPath);
      return;
    }
    if (value.tag === "variant") {
      visit(value.payload, targetPath);
      return;
    }
    if (value.tag === "closure") {
      visit(
        value.captures,
        [...targetPath, { tag: "member", index: 0 }],
      );
      visit(value.result, [...targetPath, { tag: "member", index: 1 }]);
      return;
    }
    if (value.tag === "many") {
      for (const [index, member] of value.values.entries()) {
        visit(member, [...targetPath, { tag: "member", index }]);
      }
      return;
    }
    if (value.tag === "sequence") {
      for (const [index, element] of value.elements.entries()) {
        visit(element, [...targetPath, { tag: "element", index }]);
      }
      return;
    }
    if (value.tag === "shape") {
      for (const [name, field] of value.fields) {
        visit(field, [...targetPath, { tag: "field", name }]);
      }
      return;
    }
    for (const [name, payload] of value.cases) {
      visit(payload, [...targetPath, { tag: "case", name }]);
    }
  };
  visit(produced, []);
  return lineage;
}

export function sameLineage(
  left: OwnershipLineage,
  right: OwnershipLineage,
): boolean {
  if (
    left.source !== right.source ||
    !samePath(left.sourcePath, right.sourcePath) ||
    !sameTargetPath(left.targetPath, right.targetPath) ||
    left.extractions.length !== right.extractions.length
  ) return false;
  return left.extractions.every((extraction, index) => {
    const compared = right.extractions[index];
    return extraction.operation === compared.operation &&
      extraction.part === compared.part &&
      extraction.span.start === compared.span.start &&
      extraction.span.end === compared.span.end;
  });
}

export function sameTargetPath(
  left: readonly OwnershipTargetPathSegment[],
  right: readonly OwnershipTargetPathSegment[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const compared = right[index];
    if (segment.tag !== compared.tag) return false;
    if (segment.tag === "field" && compared.tag === "field") {
      return segment.name === compared.name;
    }
    if (segment.tag === "case" && compared.tag === "case") {
      return segment.name === compared.name;
    }
    return (segment.tag === "element" || segment.tag === "member") &&
      (compared.tag === "element" || compared.tag === "member") &&
      segment.tag === compared.tag && segment.index === compared.index;
  });
}

export function obligation(produced: Produced): "none" | "affine" | "linear" {
  if (produced.tag === "none") return "none";
  if (produced.tag === "borrow") return "none";
  if (produced.tag === "leaf") return produced.qualifier;
  if (produced.tag === "closure") return obligation(produced.captures);
  if (produced.tag === "variant") return obligation(produced.payload);
  if (produced.tag === "choice") {
    return obligation({ tag: "many", values: [...produced.cases.values()] });
  }
  let members: readonly Produced[] = [];
  if (produced.tag === "many") members = produced.values;
  if (produced.tag === "sequence") members = produced.elements;
  if (produced.tag === "shape") members = [...produced.fields.values()];
  let result: "none" | "affine" | "linear" = "none";
  for (const member of members) {
    const inner = obligation(member);
    if (inner === "linear") return "linear";
    if (inner === "affine") result = "affine";
  }
  return result;
}

export function containsBorrow(produced: Produced): boolean {
  if (produced.tag === "borrow") return true;
  if (produced.tag === "none" || produced.tag === "leaf") return false;
  if (produced.tag === "closure") {
    return containsBorrow(produced.captures) || containsBorrow(produced.result);
  }
  if (produced.tag === "variant") return containsBorrow(produced.payload);
  if (produced.tag === "choice") {
    return [...produced.cases.values()].some(containsBorrow);
  }
  if (produced.tag === "many") return produced.values.some(containsBorrow);
  if (produced.tag === "sequence") {
    return produced.elements.some(containsBorrow);
  }
  return [...produced.fields.values()].some(containsBorrow);
}

export function relevant(produced: Produced): boolean {
  return obligation(produced) !== "none" || containsBorrow(produced);
}

export function borrowed(produced: Produced): Produced {
  if (produced.tag === "borrow") return produced;
  return { tag: "borrow", value: produced };
}

export function combine(left: Produced, right: Produced): Produced {
  if (!relevant(left)) return right;
  if (!relevant(right)) return left;
  const values: Produced[] = [];
  if (left.tag === "many") values.push(...left.values);
  else values.push(left);
  if (right.tag === "many") values.push(...right.values);
  else values.push(right);
  return { tag: "many", values };
}

export function joinProduced(values: readonly Produced[]): Produced {
  let result: Produced = NONE;
  for (const value of values) result = combine(result, value);
  return result;
}

export function joinAlternatives(values: readonly Produced[]): Produced {
  if (values.length === 0) return NONE;
  if (values.every((value) => value.tag === "none")) return NONE;
  // Alternatives that agree are one outcome, not several. A `case` whose arms
  // all return the same Region authority must join to that single authority,
  // or a downstream freeze would read agreement as a partial split.
  const first = values[0];
  if (values.every((value) => sameProduced(value, first))) return first;
  if (values.every((value) => value.tag === "sequence")) {
    const sequences = values.map((value) => {
      if (value.tag !== "sequence") throw new Error("expected a sequence");
      return value.elements;
    });
    const length = sequences[0].length;
    if (sequences.every((elements) => elements.length === length)) {
      const elements: Produced[] = [];
      for (let index = 0; index < length; index += 1) {
        elements.push(joinAlternatives(sequences.map((each) => each[index])));
      }
      return { tag: "sequence", elements };
    }
  }
  if (values.every((value) => value.tag === "shape")) {
    const shapes = values.map((value) => {
      if (value.tag !== "shape") throw new Error("expected a shape");
      return value.fields;
    });
    const names = [...shapes[0].keys()];
    if (
      shapes.every((fields) =>
        fields.size === names.length && names.every((name) => fields.has(name))
      )
    ) {
      const fields = new Map<string, Produced>();
      for (const name of names) {
        const alternatives: Produced[] = [];
        for (const shape of shapes) {
          const field = shape.get(name);
          if (field === undefined) {
            throw new Error(`ownership shape lost field \`${name}\``);
          }
          alternatives.push(field);
        }
        fields.set(
          name,
          joinAlternatives(alternatives),
        );
      }
      return { tag: "shape", fields };
    }
  }
  if (values.every((value) => value.tag === "variant")) {
    return {
      tag: "variant",
      payload: joinAlternatives(values.map((value) => {
        if (value.tag !== "variant") throw new Error("expected a variant");
        return value.payload;
      })),
    };
  }
  if (values.every((value) => value.tag === "choice")) {
    const names = new Set<string>();
    for (const value of values) {
      if (value.tag !== "choice") throw new Error("expected a choice");
      for (const name of value.cases.keys()) names.add(name);
    }
    const cases = new Map<string, Produced>();
    for (const name of names) {
      const alternatives: Produced[] = [];
      for (const value of values) {
        if (value.tag !== "choice") throw new Error("expected a choice");
        const payload = value.cases.get(name);
        if (payload !== undefined) alternatives.push(payload);
      }
      cases.set(name, joinAlternatives(alternatives));
    }
    return { tag: "choice", cases };
  }
  if (values.every((value) => value.tag === "closure")) {
    const closures = values.map((value) => {
      if (value.tag !== "closure") throw new Error("expected a closure");
      return value;
    });
    const parameter = closures[0].parameter;
    if (
      closures.every((closure) =>
        sameParameterUse(closure.parameter, parameter)
      )
    ) {
      return {
        tag: "closure",
        captures: joinAlternatives(
          closures.map((closure) =>
            renameParameters(closure.captures, closure.parameter, parameter)
          ),
        ),
        parameter,
        result: joinAlternatives(
          closures.map((closure) =>
            renameParameters(closure.result, closure.parameter, parameter)
          ),
        ),
      };
    }
  }
  return joinProduced(values);
}

export function sameParameterUse(left: Pattern, right: Pattern): boolean {
  if (left.tag !== right.tag) return false;
  if (left.tag === "name" && right.tag === "name") {
    return left.qualifier === right.qualifier;
  }
  if (
    (left.tag === "tuple" || left.tag === "array") &&
    (right.tag === "tuple" || right.tag === "array")
  ) {
    if (left.elements.length !== right.elements.length) return false;
    return left.elements.every((element, index) =>
      sameParameterUse(element, right.elements[index])
    );
  }
  if (left.tag === "constructor" && right.tag === "constructor") {
    if (left.name !== right.name) return false;
    if (left.payload === null || right.payload === null) {
      return left.payload === right.payload;
    }
    return sameParameterUse(left.payload, right.payload);
  }
  if (left.tag === "shape" && right.tag === "shape") {
    if (left.fields.length !== right.fields.length) return false;
    return left.fields.every((field) => {
      const found = right.fields.find((candidate) =>
        candidate.name === field.name
      );
      if (found === undefined) return false;
      return sameParameterUse(field.pattern, found.pattern);
    });
  }
  if (left.tag === "int" && right.tag === "int") {
    return left.value === right.value;
  }
  if (left.tag === "float" && right.tag === "float") {
    return Object.is(left.value, right.value);
  }
  if (left.tag === "text" && right.tag === "text") {
    return left.value === right.value;
  }
  if (left.tag === "pin" && right.tag === "pin") {
    return left.name === right.name;
  }
  return true;
}

export function renameParameters(
  produced: Produced,
  from: Pattern,
  to: Pattern,
): Produced {
  if (from.tag === "name" && to.tag === "name") {
    return renameParameter(produced, from, to);
  }
  if (
    (from.tag === "tuple" || from.tag === "array") &&
    (to.tag === "tuple" || to.tag === "array")
  ) {
    let renamed = produced;
    for (const [index, element] of from.elements.entries()) {
      const target = to.elements[index];
      if (target === undefined) continue;
      renamed = renameParameters(renamed, element, target);
    }
    return renamed;
  }
  if (from.tag === "constructor" && to.tag === "constructor") {
    if (from.payload === null || to.payload === null) return produced;
    return renameParameters(produced, from.payload, to.payload);
  }
  if (from.tag === "shape" && to.tag === "shape") {
    let renamed = produced;
    for (const field of from.fields) {
      const target = to.fields.find((candidate) =>
        candidate.name === field.name
      );
      if (target === undefined) continue;
      renamed = renameParameters(renamed, field.pattern, target.pattern);
    }
    return renamed;
  }
  return produced;
}

export function renameParameter(
  produced: Produced,
  from: NamePattern | null,
  to: NamePattern | null,
): Produced {
  if (from === null || to === null || from === to) return produced;
  if (produced.tag === "none") return produced;
  if (produced.tag === "borrow") {
    return {
      tag: "borrow",
      value: renameParameter(produced.value, from, to),
    };
  }
  if (produced.tag === "leaf") {
    if (produced.source !== from) return produced;
    return {
      ...produced,
      source: to,
      origins: produced.origins.map((origin) => {
        if (origin.source !== from) return origin;
        return { ...origin, source: to };
      }),
    };
  }
  if (produced.tag === "closure") {
    return {
      tag: "closure",
      captures: renameParameter(produced.captures, from, to),
      parameter: produced.parameter,
      result: renameParameter(produced.result, from, to),
    };
  }
  if (produced.tag === "many") {
    return {
      tag: "many",
      values: produced.values.map((value) => renameParameter(value, from, to)),
    };
  }
  if (produced.tag === "sequence") {
    return {
      tag: "sequence",
      elements: produced.elements.map((element) =>
        renameParameter(element, from, to)
      ),
    };
  }
  if (produced.tag === "shape") {
    return {
      tag: "shape",
      fields: new Map(
        [...produced.fields].map(([name, field]) => [
          name,
          renameParameter(field, from, to),
        ]),
      ),
    };
  }
  if (produced.tag === "choice") {
    return {
      tag: "choice",
      cases: new Map(
        [...produced.cases].map(([name, payload]) => [
          name,
          renameParameter(payload, from, to),
        ]),
      ),
    };
  }
  return {
    tag: "variant",
    payload: renameParameter(produced.payload, from, to),
  };
}

export function patternQualifier(pattern: Pattern): Qualifier | null {
  if (pattern.tag !== "name") return null;
  return pattern.qualifier;
}

export interface FunctionContract {
  readonly parameter: Qualifier | null;
  readonly input: Produced;
  readonly pattern: Pattern | null;
  readonly result: Produced;
}

export const NO_FUNCTION_CONTRACT: FunctionContract = {
  parameter: null,
  input: NONE,
  pattern: null,
  result: NONE,
};

export function functionContract(
  expr: Expr,
  produced: Produced,
  scope: Scope,
  analysis: Analysis,
): FunctionContract {
  if (produced.tag === "closure") {
    return {
      parameter: inferredParameterQualifier(produced.parameter, analysis),
      input: parameterOwnership(produced.parameter, analysis),
      pattern: produced.parameter,
      result: produced.result,
    };
  }
  if (expr.tag === "lambda") {
    const result = analysis.functionResults.get(expr);
    let knownResult = NONE;
    if (result !== undefined) knownResult = result;
    return {
      parameter: inferredParameterQualifier(expr.parameter, analysis),
      input: parameterOwnership(expr.parameter, analysis),
      pattern: expr.parameter,
      result: knownResult,
    };
  }
  if (expr.tag === "rec" && expr.lambda.tag === "lambda") {
    const result = analysis.functionResults.get(expr.lambda);
    let knownResult = NONE;
    if (result !== undefined) knownResult = result;
    return {
      parameter: inferredParameterQualifier(expr.lambda.parameter, analysis),
      input: parameterOwnership(expr.lambda.parameter, analysis),
      pattern: expr.lambda.parameter,
      result: knownResult,
    };
  }
  if (expr.tag !== "var") return NO_FUNCTION_CONTRACT;
  const binding = analysisBinding(scope, expr.name);
  if (binding === null) return NO_FUNCTION_CONTRACT;
  return {
    parameter: binding.parameter,
    input: binding.parameterInput,
    pattern: binding.parameterPattern,
    result: binding.result,
  };
}

export function inferredParameterQualifier(
  pattern: Pattern,
  analysis: Analysis,
): Qualifier | null {
  const written = patternQualifier(pattern);
  if (written !== null && written !== "none") return written;
  const inferred = analysis.inferredParameters.get(pattern);
  if (inferred === undefined) return null;
  return inferred;
}

export function parameterOwnership(
  pattern: Pattern,
  analysis: Analysis,
): Produced {
  if (pattern.tag === "name") {
    const inferred = analysis.inferredParameterInputs.get(pattern);
    if (inferred !== undefined) return inferred;
    return writtenObligation(pattern.qualifier, pattern);
  }
  if (pattern.tag === "tuple" || pattern.tag === "array") {
    return {
      tag: "sequence",
      elements: pattern.elements.map((element) =>
        parameterOwnership(element, analysis)
      ),
    };
  }
  if (pattern.tag === "shape") {
    return {
      tag: "shape",
      fields: new Map(pattern.fields.map((field) => [
        field.name,
        parameterOwnership(field.pattern, analysis),
      ])),
    };
  }
  if (pattern.tag === "constructor" && pattern.payload !== null) {
    return {
      tag: "variant",
      payload: parameterOwnership(pattern.payload, analysis),
    };
  }
  return NONE;
}

export type OwnershipAliases = ReadonlyMap<
  string,
  readonly OwnershipPathSegment[]
>;

export function ownershipTransparent(
  expr: Expr,
  parameter: NamePattern,
  scope: Scope,
  analysis: Analysis,
): Produced | null {
  return transparentOwnership(
    expr,
    parameter,
    new Map([[parameter.name, []]]),
    scope,
    analysis,
  );
}

export function transparentOwnership(
  expr: Expr,
  parameter: NamePattern,
  aliases: OwnershipAliases,
  scope: Scope,
  analysis: Analysis,
): Produced | null {
  const path = ownershipAliasPath(expr, aliases);
  if (path !== null) return ownershipAtPath(parameter, path);
  if (
    expr.tag === "int" || expr.tag === "float" || expr.tag === "text" ||
    expr.tag === "unit" || expr.tag === "intrinsic" || expr.tag === "tag" ||
    expr.tag === "var" || expr.tag === "field"
  ) return null;
  if (expr.tag === "apply") {
    if (expr.fn.tag === "tag") {
      return transparentOwnership(
        expr.arg,
        parameter,
        aliases,
        scope,
        analysis,
      );
    }
    if (mentionsOwnershipAlias(expr.fn, aliases)) return null;
    const argument = transparentOwnership(
      expr.arg,
      parameter,
      aliases,
      scope,
      analysis,
    );
    if (argument === null) return null;
    const contract = functionContract(expr.fn, NONE, scope, analysis);
    if (!returnsConsumedParameter(contract)) return null;
    return argument;
  }
  if (expr.tag === "lambda") {
    const shadowed = patternNames(expr.parameter).some((name) =>
      aliases.has(name)
    );
    if (shadowed) return null;
    return transparentOwnership(expr.body, parameter, aliases, scope, analysis);
  }
  if (expr.tag === "rec" || expr.tag === "comptime") return null;
  if (expr.tag === "tuple") {
    return oneTransparent(expr.elements, parameter, aliases, scope, analysis);
  }
  if (expr.tag === "array") {
    return oneTransparent(
      expr.elements.map((element) => element.value),
      parameter,
      aliases,
      scope,
      analysis,
    );
  }
  if (expr.tag === "shape") {
    return oneTransparent(
      expr.members.map((member) => member.value),
      parameter,
      aliases,
      scope,
      analysis,
    );
  }
  if (expr.tag === "if") {
    if (
      expr.branches.some((branch) =>
        mentionsOwnershipAlias(branch.condition, aliases)
      )
    ) return null;
    const alternatives = expr.branches.map((branch) =>
      transparentOwnership(
        branch.consequence,
        parameter,
        aliases,
        scope,
        analysis,
      )
    );
    if (expr.fallback === null) return null;
    alternatives.push(
      transparentOwnership(
        expr.fallback,
        parameter,
        aliases,
        scope,
        analysis,
      ),
    );
    return agreeingOwnership(alternatives);
  }
  if (expr.tag === "case") {
    const target = ownershipAliasPath(expr.target, aliases);
    if (target === null) return null;
    return agreeingOwnership(expr.arms.map((arm) => {
      const inner = new Map(aliases);
      bindOwnershipAliases(arm.pattern, target, inner);
      return transparentOwnership(
        arm.body,
        parameter,
        inner,
        scope,
        analysis,
      );
    }));
  }

  const inner = new Map(aliases);
  for (const declaration of expr.declarations) {
    if (declaration.tag === "open" || declaration.tag === "shadow") return null;
    if (declaration.kind === "sig") continue;
    const value = ownershipAliasPath(declaration.value, inner);
    if (value === null) return null;
    bindOwnershipAliases(declaration.pattern, value, inner);
  }
  return transparentOwnership(
    expr.result,
    parameter,
    inner,
    scope,
    analysis,
  );
}

export function oneTransparent(
  expressions: readonly Expr[],
  parameter: NamePattern,
  aliases: OwnershipAliases,
  scope: Scope,
  analysis: Analysis,
): Produced | null {
  let carried: Produced | null = null;
  for (const expression of expressions) {
    const found = transparentOwnership(
      expression,
      parameter,
      aliases,
      scope,
      analysis,
    );
    if (found !== null) {
      if (carried !== null) return null;
      carried = found;
      continue;
    }
    if (mentionsOwnershipAlias(expression, aliases)) return null;
  }
  return carried;
}

export function ownershipAliasPath(
  expr: Expr,
  aliases: OwnershipAliases,
): readonly OwnershipPathSegment[] | null {
  if (expr.tag === "var") return aliases.get(expr.name) ?? null;
  if (expr.tag !== "field") return null;
  const target = ownershipAliasPath(expr.target, aliases);
  if (target === null) return null;
  return [...target, { tag: "field", name: expr.name }];
}

export function bindOwnershipAliases(
  pattern: Pattern,
  path: readonly OwnershipPathSegment[],
  aliases: Map<string, readonly OwnershipPathSegment[]>,
): void {
  if (pattern.tag === "name") {
    aliases.set(pattern.name, path);
    return;
  }
  if (pattern.tag === "tuple" || pattern.tag === "array") {
    for (const [index, element] of pattern.elements.entries()) {
      bindOwnershipAliases(
        element,
        [...path, { tag: "element", index }],
        aliases,
      );
    }
    return;
  }
  if (pattern.tag === "shape") {
    for (const field of pattern.fields) {
      bindOwnershipAliases(
        field.pattern,
        [...path, { tag: "field", name: field.name }],
        aliases,
      );
    }
    return;
  }
  if (pattern.tag === "constructor" && pattern.payload !== null) {
    bindOwnershipAliases(pattern.payload, path, aliases);
  }
}

export function ownershipAtPath(
  parameter: NamePattern,
  path: readonly OwnershipPathSegment[],
): Produced {
  let result: Produced = {
    tag: "leaf",
    qualifier: "linear",
    source: parameter,
    path,
    origins: [{ source: parameter, path, extractions: [] }],
  };
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const segment = path[index];
    if (segment.tag === "field") {
      result = { tag: "shape", fields: new Map([[segment.name, result]]) };
      continue;
    }
    const elements = Array.from({ length: segment.index + 1 }, () => NONE);
    elements[segment.index] = result;
    result = { tag: "sequence", elements };
  }
  return result;
}

export function mentionsOwnershipAlias(
  expr: Expr,
  aliases: OwnershipAliases,
): boolean {
  for (const name of aliases.keys()) {
    if (freeNames(expr).has(name)) return true;
  }
  return false;
}

export function agreeingOwnership(
  values: readonly (Produced | null)[],
): Produced | null {
  if (values.length === 0 || values[0] === null) return null;
  const first = values[0];
  if (first === null) return null;
  if (values.some((value) => value === null || !sameProduced(value, first))) {
    return null;
  }
  return first;
}

export function returnsConsumedParameter(contract: FunctionContract): boolean {
  if (contract.parameter !== "linear") return false;
  return sameOwnershipLeaves(contract.input, contract.result);
}

export function sameOwnershipLeaves(left: Produced, right: Produced): boolean {
  const leftLeaves = ownershipLeaves(left);
  const rightLeaves = ownershipLeaves(right);
  if (leftLeaves.length !== rightLeaves.length) return false;
  return leftLeaves.every((leaf, index) => {
    const compared = rightLeaves[index];
    return leaf.source === compared.source &&
      samePath(leaf.path, compared.path);
  });
}

export function ownershipLeaves(
  produced: Produced,
): readonly Extract<Produced, { readonly tag: "leaf" }>[] {
  if (produced.tag === "none" || produced.tag === "borrow") return [];
  if (produced.tag === "leaf") return [produced];
  if (produced.tag === "closure") {
    return [
      ...ownershipLeaves(produced.captures),
      ...ownershipLeaves(produced.result),
    ];
  }
  if (produced.tag === "variant") return ownershipLeaves(produced.payload);
  if (produced.tag === "choice") {
    return [...produced.cases.values()].flatMap(ownershipLeaves);
  }
  if (produced.tag === "many") return produced.values.flatMap(ownershipLeaves);
  if (produced.tag === "sequence") {
    return produced.elements.flatMap(ownershipLeaves);
  }
  return [...produced.fields.values()].flatMap(ownershipLeaves);
}

export function samePath(
  left: readonly OwnershipPathSegment[],
  right: readonly OwnershipPathSegment[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const compared = right[index];
    if (segment.tag !== compared.tag) return false;
    if (segment.tag === "field" && compared.tag === "field") {
      return segment.name === compared.name;
    }
    return segment.tag === "element" && compared.tag === "element" &&
      segment.index === compared.index;
  });
}

export function substituteParameter(
  produced: Produced,
  parameter: Pattern | null,
  argument: Produced,
): Produced {
  if (parameter === null || produced.tag === "none") return produced;
  if (parameter.tag !== "name") return produced;
  if (produced.tag === "borrow") {
    return {
      tag: "borrow",
      value: substituteParameter(produced.value, parameter, argument),
    };
  }
  if (produced.tag === "leaf") {
    if (produced.source === parameter) {
      return ownershipAtArgumentPath(argument, produced.path);
    }
    return produced;
  }
  if (produced.tag === "closure") {
    return {
      tag: "closure",
      captures: substituteParameter(produced.captures, parameter, argument),
      parameter: produced.parameter,
      result: substituteParameter(produced.result, parameter, argument),
    };
  }
  if (produced.tag === "many") {
    return {
      tag: "many",
      values: produced.values.map((value) =>
        substituteParameter(value, parameter, argument)
      ),
    };
  }
  if (produced.tag === "sequence") {
    return {
      tag: "sequence",
      elements: produced.elements.map((element) =>
        substituteParameter(element, parameter, argument)
      ),
    };
  }
  if (produced.tag === "shape") {
    return {
      tag: "shape",
      fields: new Map(
        [...produced.fields].map(([name, field]) => [
          name,
          substituteParameter(field, parameter, argument),
        ]),
      ),
    };
  }
  if (produced.tag === "choice") {
    return {
      tag: "choice",
      cases: new Map(
        [...produced.cases].map(([name, payload]) => [
          name,
          substituteParameter(payload, parameter, argument),
        ]),
      ),
    };
  }
  return {
    tag: "variant",
    payload: substituteParameter(produced.payload, parameter, argument),
  };
}

export function ownershipAtArgumentPath(
  argument: Produced,
  path: readonly OwnershipPathSegment[],
): Produced {
  let selected = argument;
  for (const segment of path) {
    if (segment.tag === "field") {
      if (selected.tag !== "shape") return NONE;
      const field = selected.fields.get(segment.name);
      if (field === undefined) return NONE;
      selected = field;
      continue;
    }
    if (selected.tag !== "sequence") return NONE;
    const element = selected.elements[segment.index];
    if (element === undefined) return NONE;
    selected = element;
  }
  return selected;
}

export function substituteParameters(
  produced: Produced,
  parameter: Pattern | null,
  argument: Produced,
): Produced {
  if (parameter === null) return produced;
  if (parameter.tag === "name") {
    return substituteParameter(produced, parameter, argument);
  }
  if (
    (parameter.tag === "tuple" || parameter.tag === "array") &&
    argument.tag === "sequence"
  ) {
    let substituted = produced;
    for (const [index, element] of parameter.elements.entries()) {
      const value = argument.elements[index];
      if (value === undefined) continue;
      substituted = substituteParameters(substituted, element, value);
    }
    return substituted;
  }
  if (parameter.tag === "constructor" && argument.tag === "variant") {
    return substituteParameters(produced, parameter.payload, argument.payload);
  }
  if (parameter.tag === "shape" && argument.tag === "shape") {
    let substituted = produced;
    for (const field of parameter.fields) {
      const value = argument.fields.get(field.name);
      if (value === undefined) continue;
      substituted = substituteParameters(substituted, field.pattern, value);
    }
    return substituted;
  }
  return produced;
}

export function parameterAcceptsOwnership(
  parameter: Pattern | null,
  argument: Produced,
  inferred: Qualifier | null = null,
  input: Produced = NONE,
): boolean {
  const ownership = obligation(argument);
  if (ownership === "none") return true;
  if (parameter === null) return false;
  if (parameter.tag === "name") {
    let qualifier = parameter.qualifier;
    if (qualifier === "none" && inferred !== null) qualifier = inferred;
    if (qualifier === "linear") {
      if (input.tag === "none" || input.tag === "leaf") return true;
      return ownershipInputAccepts(input, argument);
    }
    return qualifier === "affine" && ownership === "affine";
  }
  if (
    (parameter.tag === "tuple" || parameter.tag === "array") &&
    argument.tag === "sequence"
  ) {
    if (parameter.elements.length !== argument.elements.length) return false;
    return parameter.elements.every((element, index) =>
      parameterAcceptsOwnership(element, argument.elements[index])
    );
  }
  if (parameter.tag === "constructor" && argument.tag === "variant") {
    return parameterAcceptsOwnership(parameter.payload, argument.payload);
  }
  if (parameter.tag === "shape" && argument.tag === "shape") {
    for (const [name, value] of argument.fields) {
      const field = parameter.fields.find((candidate) =>
        candidate.name === name
      );
      if (field === undefined) {
        if (obligation(value) === "linear") return false;
        continue;
      }
      if (!parameterAcceptsOwnership(field.pattern, value)) return false;
    }
    return true;
  }
  return false;
}

export function ownershipInputAccepts(
  input: Produced,
  argument: Produced,
): boolean {
  if (obligation(argument) === "none") return true;
  if (input.tag === "leaf") return true;
  if (input.tag === "shape" && argument.tag === "shape") {
    for (const [name, value] of argument.fields) {
      if (obligation(value) === "none") continue;
      const expected = input.fields.get(name);
      if (expected === undefined || !ownershipInputAccepts(expected, value)) {
        return false;
      }
    }
    return true;
  }
  if (input.tag === "sequence" && argument.tag === "sequence") {
    for (const [index, value] of argument.elements.entries()) {
      if (obligation(value) === "none") continue;
      const expected = input.elements[index];
      if (expected === undefined || !ownershipInputAccepts(expected, value)) {
        return false;
      }
    }
    return true;
  }
  if (input.tag === "variant" && argument.tag === "variant") {
    return ownershipInputAccepts(input.payload, argument.payload);
  }
  return false;
}

export function parameterAcceptsBorrow(
  parameter: Pattern | null,
  argument: Produced,
): boolean {
  if (!containsBorrow(argument)) return true;
  if (parameter === null) return false;
  if (argument.tag === "borrow") {
    return parameter.tag === "name" && parameter.qualifier === "borrow";
  }
  if (
    (parameter.tag === "tuple" || parameter.tag === "array") &&
    argument.tag === "sequence"
  ) {
    if (parameter.elements.length !== argument.elements.length) return false;
    return parameter.elements.every((element, index) =>
      parameterAcceptsBorrow(element, argument.elements[index])
    );
  }
  if (parameter.tag === "constructor" && argument.tag === "variant") {
    if (parameter.payload === null) return !containsBorrow(argument.payload);
    return parameterAcceptsBorrow(parameter.payload, argument.payload);
  }
  if (parameter.tag === "shape" && argument.tag === "shape") {
    for (const [name, value] of argument.fields) {
      if (!containsBorrow(value)) continue;
      const field = parameter.fields.find((candidate) =>
        candidate.name === name
      );
      if (field === undefined) return false;
      if (!parameterAcceptsBorrow(field.pattern, value)) return false;
    }
    return true;
  }
  return false;
}

export function analysisBinding(scope: Scope, name: string): Binding | null {
  let current: Scope | null = scope;
  while (current !== null) {
    const binding = current.bindings.get(name);
    if (binding !== undefined) return binding;
    current = current.parent;
  }
  return null;
}

export function sameProduced(left: Produced, right: Produced): boolean {
  if (left === right) return true;
  if (left.tag !== right.tag) return false;
  if (left.tag === "none" && right.tag === "none") return true;
  if (left.tag === "leaf" && right.tag === "leaf") {
    return left.qualifier === right.qualifier && left.source === right.source &&
      samePath(left.path, right.path) &&
      sameOrigins(left.origins, right.origins);
  }
  if (left.tag === "borrow" && right.tag === "borrow") {
    return sameProduced(left.value, right.value);
  }
  if (left.tag === "shape" && right.tag === "shape") {
    if (left.fields.size !== right.fields.size) return false;
    for (const [name, value] of left.fields) {
      const compared = right.fields.get(name);
      if (compared === undefined || !sameProduced(value, compared)) {
        return false;
      }
    }
    return true;
  }
  if (left.tag === "sequence" && right.tag === "sequence") {
    return left.elements.length === right.elements.length &&
      left.elements.every((value, index) =>
        sameProduced(value, right.elements[index])
      );
  }
  if (left.tag === "variant" && right.tag === "variant") {
    return sameProduced(left.payload, right.payload);
  }
  return false;
}

export function sameOrigins(
  left: readonly OwnershipOrigin[],
  right: readonly OwnershipOrigin[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((origin, index) => {
    const compared = right[index];
    if (
      origin.source !== compared.source ||
      !samePath(origin.path, compared.path) ||
      origin.extractions.length !== compared.extractions.length
    ) return false;
    return origin.extractions.every((extraction, extractionIndex) => {
      const expected = compared.extractions[extractionIndex];
      return extraction.operation === expected.operation &&
        extraction.part === expected.part &&
        extraction.span.start === expected.span.start &&
        extraction.span.end === expected.span.end;
    });
  });
}
