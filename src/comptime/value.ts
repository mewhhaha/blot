// One value domain.
//
// Types are values here, not a separate universe: `1` is an integer and also
// the singleton type inhabited only by `1`, `#Ready | #Failed Text` is a union
// value, and `I32` is a range. That is what removes the type sublanguage from
// the grammar and lets `struct` be prelude source rather than a compiler
// builtin.

import type { Expr, Pattern } from "../syntax/ast.ts";
import type { CoreExpression } from "../core/computation.ts";

export interface Env {
  readonly names: Map<string, Value>;
  readonly parent: Env | null;
  readonly module:
    | {
      readonly identity: object;
      readonly scope: "parameter" | "body" | "inner";
    }
    | null;
}

export type Value =
  | { readonly tag: "int"; readonly value: bigint }
  | { readonly tag: "float"; readonly value: number }
  | { readonly tag: "float32"; readonly value: number }
  | {
    readonly tag: "vector";
    readonly element: SimdElement;
    readonly lanes: readonly number[];
  }
  | {
    readonly tag: "vector-mask";
    readonly element: SimdElement;
    readonly lanes: readonly boolean[];
  }
  | { readonly tag: "opaque-type"; readonly name: string }
  | { readonly tag: "text"; readonly value: string }
  | { readonly tag: "unit" }
  | { readonly tag: "shape"; readonly fields: ReadonlyMap<string, Value> }
  | { readonly tag: "array"; readonly elements: readonly Value[] }
  /** Private type value produced only by `@region.array.type`. */
  | { readonly tag: "region-type"; readonly element: Value }
  /**
   * Compiler-private mutable slice. Multiple scoped children may share `store`,
   * but the ownership checker prevents overlapping capabilities from escaping.
   */
  | {
    readonly tag: "region-array";
    readonly store: { readonly cells: Value[] };
    readonly start: number;
    readonly end: number;
  }
  | {
    readonly tag: "tag";
    readonly name: string;
    readonly payload: Value | null;
  }
  | {
    readonly tag: "closure";
    readonly parameter: Pattern;
    readonly body: Expr;
    readonly env: Env;
    readonly self: string | null;
    readonly source?: Expr;
    readonly imports?: ReadonlyMap<string, Value>;
  }
  | {
    readonly tag: "core-closure";
    readonly parameter: Pattern;
    readonly body: CoreExpression;
    readonly env: Env;
    readonly self: string | null;
  }
  | {
    readonly tag: "primitive";
    readonly name: string;
    readonly arity: number;
    readonly applied: readonly Value[];
  }
  | {
    readonly tag: "native";
    readonly name: string;
    readonly arity: number;
    readonly applied: readonly Value[];
    readonly run: (args: readonly Value[]) => Value;
  }
  | {
    readonly tag: "range";
    readonly low: Value;
    readonly high: Value;
    readonly domain?: "int" | "text" | "float" | "float32";
  }
  | { readonly tag: "union"; readonly members: readonly Value[] }
  | { readonly tag: "unbounded" }
  | {
    readonly tag: "arrow";
    readonly domain: Value;
    readonly codomain: Value;
    readonly effects: readonly Value[];
  }
  | { readonly tag: "type-variable"; readonly id: number }
  | {
    readonly tag: "forall";
    readonly variable: number;
    readonly body: Value;
  }
  | {
    readonly tag: "effect";
    readonly id: number;
    readonly name: string;
    readonly operations: ReadonlyMap<string, Value>;
    readonly host: boolean;
  }
  | { readonly tag: "operation"; readonly effect: Value; readonly name: string }
  | {
    readonly tag: "extended";
    readonly inner: Value;
    readonly members: ReadonlyMap<string, Value>;
  }
  | {
    readonly tag: "sealed";
    readonly name: string;
    readonly inner: Value;
  }
  | {
    readonly tag: "continuation";
    readonly resume: (value: Value) => unknown;
    readonly state: { used: boolean };
  };

const effectExtensions = new Map<number, Value>();

export function registerEffectExtension(
  effect: Value & { readonly tag: "effect" },
  extended: Value,
): void {
  effectExtensions.set(effect.id, extended);
}

export function effectExtension(
  effect: Value & { readonly tag: "effect" },
): Value | undefined {
  return effectExtensions.get(effect.id);
}

export const F32X4_NAME = "F32x4";
export const F32X4_MASK_NAME = "F32x4Mask";
export const I32X4_NAME = "I32x4";
export const I32X4_MASK_NAME = "I32x4Mask";
export const I16X8_NAME = "I16x8";
export const I16X8_MASK_NAME = "I16x8Mask";
export const I8X16_NAME = "I8x16";
export const I8X16_MASK_NAME = "I8x16Mask";

export type SimdElement = "f32" | "i32" | "i16" | "i8";

export function simdTypeName(element: SimdElement, mask: boolean): string {
  const name = {
    f32: F32X4_NAME,
    i32: I32X4_NAME,
    i16: I16X8_NAME,
    i8: I8X16_NAME,
  }[element];
  if (mask) return `${name}Mask`;
  return name;
}

export const UNIT: Value = { tag: "unit" };
export const TRUE: Value = { tag: "tag", name: "True", payload: null };
export const FALSE: Value = { tag: "tag", name: "False", payload: null };

const inferredTypes = new WeakMap<object, Value>();

export function withInferredType(value: Value, type: Value): Value {
  inferredTypes.set(value, type);
  return value;
}

export function inferredTypeOf(value: Value): Value | undefined {
  return inferredTypes.get(value);
}

export function bool(condition: boolean): Value {
  return condition ? TRUE : FALSE;
}

export function shapeOf(entries: readonly (readonly [string, Value])[]): Value {
  return { tag: "shape", fields: new Map(entries) };
}

export function tupleOf(elements: readonly Value[]): Value {
  return shapeOf(
    elements.map((value, index) => [String(index), value] as const),
  );
}

export function asTuple(value: Value, arity: number): readonly Value[] | null {
  if (value.tag !== "shape" || value.fields.size !== arity) return null;
  const elements: Value[] = [];
  for (let index = 0; index < arity; index += 1) {
    const element = value.fields.get(String(index));
    if (element === undefined) return null;
    elements.push(element);
  }
  return elements;
}

export function childEnv(parent: Env | null): Env {
  let module: Env["module"] = null;
  if (parent !== null && parent.module !== null) {
    module = { identity: parent.module.identity, scope: "inner" };
  }
  return {
    names: new Map(),
    parent,
    module,
  };
}

export function moduleEnv(parent: Env, module: object): Env {
  return {
    names: new Map(),
    parent,
    module: { identity: module, scope: "body" },
  };
}

export function moduleParameterEnv(parent: Env, module: object): Env {
  return {
    names: new Map(),
    parent,
    module: { identity: module, scope: "parameter" },
  };
}

export function lookup(env: Env, name: string): Value | undefined {
  let scope: Env | null = env;
  while (scope !== null) {
    const value = scope.names.get(name);
    if (value !== undefined) return value;
    scope = scope.parent;
  }
  return undefined;
}

export function show(value: Value): string {
  if (value.tag === "int") return value.value.toString();
  if (value.tag === "vector") {
    const lanes = value.lanes.map((lane) =>
      Number.isInteger(lane) ? `${lane}.0` : String(lane)
    );
    return `${value.element}<${lanes.join(" ")}>`;
  }
  if (value.tag === "vector-mask") {
    return `${value.element}-mask<${
      value.lanes.map((lane) => lane ? "#True" : "#False").join(" ")
    }>`;
  }
  if (value.tag === "float32") {
    const shown = Number.isInteger(value.value)
      ? `${value.value}.0`
      : String(value.value);
    return `${shown}f`;
  }
  if (value.tag === "float") {
    if (Number.isFinite(value.value) && Number.isInteger(value.value)) {
      return `${value.value}.0`;
    }
    return String(value.value);
  }
  if (value.tag === "text") return JSON.stringify(value.value);
  if (value.tag === "unit") return "()";
  if (value.tag === "unbounded") return "@type.unbounded";
  if (value.tag === "opaque-type") return value.name;
  if (value.tag === "region-type") return `Region ${show(value.element)}`;
  if (value.tag === "region-array") {
    return `<region ${value.start}..${value.end}>`;
  }
  if (value.tag === "type-variable") return `'t${value.id}`;
  if (value.tag === "forall") {
    return `forall 't${value.variable}. ${show(value.body)}`;
  }
  if (value.tag === "closure" || value.tag === "core-closure") {
    return "<function>";
  }
  if (value.tag === "primitive") return `<${value.name}>`;
  if (value.tag === "native") return `<host ${value.name}>`;
  if (value.tag === "continuation") return "<resume>";
  if (value.tag === "effect") {
    return `<${value.host ? "host effect" : "effect"} ${value.name}>`;
  }
  if (value.tag === "operation") return `<operation ${value.name}>`;
  if (value.tag === "extended") return show(value.inner);
  if (value.tag === "sealed") return `${value.name} ${show(value.inner)}`;
  if (value.tag === "range") {
    const open = value.low.tag === "unbounded";
    const shut = value.high.tag === "unbounded";
    const domain = value.domain !== undefined
      ? value.domain
      : value.low.tag === "text" || value.high.tag === "text"
      ? "text"
      : "int";
    if (open && shut) {
      if (domain === "text") return "Str";
      if (domain === "float") return "F64";
      if (domain === "float32") return "F32";
      return "Int";
    }
    if (
      domain === "text" && value.low.tag === "text" && value.low.value === "" &&
      shut
    ) {
      return "Str";
    }
    const left = open ? "" : show(value.low);
    const right = shut ? "" : show(value.high);
    return `${left}..${right}`;
  }
  if (value.tag === "arrow") {
    const row = value.effects.length === 0
      ? ""
      : ` ~ { ${value.effects.map(effectName).sort().join(", ")} }`;
    return `${show(value.domain)} -> ${show(value.codomain)}${row}`;
  }
  if (value.tag === "union") return value.members.map(show).join(" | ");
  if (value.tag === "tag") {
    return value.payload === null
      ? `#${value.name}`
      : `#${value.name} ${show(value.payload)}`;
  }
  if (value.tag === "array") {
    return `[${value.elements.map(show).join(", ")}]`;
  }
  const tuple = asTuple(value, value.fields.size);
  if (tuple !== null && value.fields.size > 0) {
    return `(${tuple.map(show).join(", ")})`;
  }
  const members = [...value.fields].map(([name, member]) =>
    `.${name} = ${show(member)}`
  );
  return `{ ${members.join("; ")}${members.length === 0 ? "" : ";"} }`;
}

function effectName(value: Value): string {
  if (value.tag === "effect") return value.name;
  return show(value);
}

export function rangeDomainOf(
  value: Value & { tag: "range" },
): "int" | "text" | "float" | "float32" {
  if (value.domain !== undefined) return value.domain;
  if (value.low.tag === "text" || value.high.tag === "text") return "text";
  return "int";
}

export function equal(left: Value, right: Value): boolean {
  if (left === right) return true;
  if (left.tag === "extended") return equal(left.inner, right);
  if (right.tag === "extended") return equal(left, right.inner);
  if (left.tag !== right.tag) return false;
  if (left.tag === "int" && right.tag === "int") {
    return left.value === right.value;
  }
  if (left.tag === "vector" && right.tag === "vector") {
    return left.element === right.element &&
      left.lanes.every((lane, index) => Object.is(lane, right.lanes[index]));
  }
  if (left.tag === "vector-mask" && right.tag === "vector-mask") {
    return left.element === right.element &&
      left.lanes.every((lane, index) => lane === right.lanes[index]);
  }
  if (left.tag === "float32" && right.tag === "float32") {
    return Object.is(left.value, right.value);
  }
  if (left.tag === "float" && right.tag === "float") {
    return Object.is(left.value, right.value);
  }
  if (left.tag === "text" && right.tag === "text") {
    return left.value === right.value;
  }
  if (left.tag === "unit" || left.tag === "unbounded") return true;
  if (left.tag === "tag" && right.tag === "tag") {
    if (left.name !== right.name) return false;
    if (left.payload === null || right.payload === null) {
      return left.payload === right.payload;
    }
    return equal(left.payload, right.payload);
  }
  if (left.tag === "array" && right.tag === "array") {
    return left.elements.length === right.elements.length &&
      left.elements.every((element, index) =>
        equal(element, right.elements[index])
      );
  }
  if (left.tag === "region-type" && right.tag === "region-type") {
    return equal(left.element, right.element);
  }
  if (left.tag === "region-array" && right.tag === "region-array") {
    return left.store === right.store && left.start === right.start &&
      left.end === right.end;
  }
  if (left.tag === "shape" && right.tag === "shape") {
    if (left.fields.size !== right.fields.size) return false;
    for (const [name, member] of left.fields) {
      const other = right.fields.get(name);
      if (other === undefined || !equal(member, other)) return false;
    }
    return true;
  }
  if (left.tag === "range" && right.tag === "range") {
    if (rangeDomainOf(left) !== rangeDomainOf(right)) return false;
    return equal(left.low, right.low) && equal(left.high, right.high);
  }
  if (left.tag === "arrow" && right.tag === "arrow") {
    return equal(left.domain, right.domain) &&
      equal(left.codomain, right.codomain) &&
      left.effects.length === right.effects.length &&
      left.effects.every((effect) =>
        right.effects.some((other) => equal(effect, other))
      );
  }
  if (left.tag === "type-variable" && right.tag === "type-variable") {
    return left.id === right.id;
  }
  if (left.tag === "forall" && right.tag === "forall") {
    return left.variable === right.variable && equal(left.body, right.body);
  }
  if (left.tag === "union" && right.tag === "union") {
    return left.members.length === right.members.length &&
      left.members.every((member) =>
        right.members.some((other) => equal(member, other))
      );
  }
  if (left.tag === "opaque-type" && right.tag === "opaque-type") {
    return left.name === right.name;
  }
  if (left.tag === "sealed" && right.tag === "sealed") {
    return left.name === right.name && equal(left.inner, right.inner);
  }
  if (left.tag === "effect" && right.tag === "effect") {
    return left.id === right.id;
  }
  return false;
}
