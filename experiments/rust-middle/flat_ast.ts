import type { Module } from "../../src/syntax/ast.ts";

type JsonObject = Record<string, unknown>;

export function materializeFlatModule(value: unknown): Module {
  const module = object(value, "Rust module");
  const arena = object(module.arena, "Rust AST arena");
  const expressions = array(arena.expressions, "Rust expression arena");
  const patterns = array(arena.patterns, "Rust pattern arena");
  const declarations = array(arena.declarations, "Rust declaration arena");

  const pattern = (identifier: unknown): unknown => {
    const node = objectAt(patterns, identifier, "pattern");
    const tag = string(node.tag, "pattern tag");
    if (tag === "tuple" || tag === "array") {
      return {
        ...node,
        elements: array(node.elements, `${tag} elements`).map(pattern),
      };
    }
    if (tag === "constructor") {
      let payload = null;
      if (node.payload !== null) payload = pattern(node.payload);
      return { ...node, payload };
    }
    if (tag === "shape") {
      return {
        ...node,
        fields: array(node.fields, "shape pattern fields").map((fieldValue) => {
          const field = object(fieldValue, "shape pattern field");
          return { ...field, pattern: pattern(field.pattern) };
        }),
      };
    }
    return node;
  };

  const expression = (identifier: unknown): unknown => {
    const node = objectAt(expressions, identifier, "expression");
    const tag = string(node.tag, "expression tag");
    if (tag === "apply") {
      return {
        tag,
        fn: expression(node.function),
        arg: expression(node.argument),
        span: node.span,
      };
    }
    if (tag === "field") {
      return { ...node, target: expression(node.target) };
    }
    if (tag === "lambda") {
      return {
        ...node,
        parameter: pattern(node.parameter),
        body: expression(node.body),
      };
    }
    if (tag === "array") {
      return {
        ...node,
        elements: array(node.elements, "array elements").map((elementValue) => {
          const element = object(elementValue, "array element");
          return { ...element, value: expression(element.value) };
        }),
      };
    }
    if (tag === "tuple") {
      return {
        ...node,
        elements: array(node.elements, "tuple elements").map(expression),
      };
    }
    if (tag === "shape") {
      return {
        ...node,
        members: array(node.members, "shape members").map((memberValue) => {
          const member = object(memberValue, "shape member");
          return { ...member, value: expression(member.value) };
        }),
      };
    }
    if (tag === "if") {
      let fallback = null;
      if (node.fallback !== null) fallback = expression(node.fallback);
      return {
        ...node,
        branches: array(node.branches, "conditional branches").map(
          (branchValue) => {
            const branch = object(branchValue, "conditional branch");
            return {
              condition: expression(branch.condition),
              consequence: expression(branch.consequence),
            };
          },
        ),
        fallback,
      };
    }
    if (tag === "case") {
      return {
        ...node,
        target: expression(node.target),
        arms: array(node.arms, "case arms").map((armValue) => {
          const arm = object(armValue, "case arm");
          return { pattern: pattern(arm.pattern), body: expression(arm.body) };
        }),
      };
    }
    if (tag === "block") {
      return {
        tag,
        declarations: array(node.declarations, "block declarations").map(
          declaration,
        ),
        result: expression(node.result),
        resultEffects: node.result_effects,
        span: node.span,
      };
    }
    if (tag === "rec") {
      return { ...node, lambda: expression(node.lambda) };
    }
    if (tag === "comptime") {
      return { ...node, body: expression(node.body) };
    }
    return node;
  };

  const declaration = (identifier: unknown): unknown => {
    const node = objectAt(declarations, identifier, "declaration");
    const tag = string(node.tag, "declaration tag");
    if (tag === "binding") {
      return {
        ...node,
        tags: array(node.tags, "declaration tags").map((tagValue) => {
          const declarationTag = object(tagValue, "declaration tag");
          return {
            ...declarationTag,
            descriptor: expression(declarationTag.descriptor),
          };
        }),
        pattern: pattern(node.pattern),
        value: expression(node.value),
      };
    }
    if (tag === "shadow" || tag === "open") {
      return { ...node, value: expression(node.value) };
    }
    throw new Error(`Rust returned unknown declaration tag ${tag}`);
  };

  let parameter = null;
  if (module.parameter !== null) parameter = pattern(module.parameter);
  return {
    parameter,
    fixities: array(module.fixities, "Rust fixities"),
    declarations: array(module.declarations, "module declarations").map(
      declaration,
    ),
    result: expression(module.result),
    resultEffects: string(module.result_effects, "module result effects"),
    span: object(module.span, "module span"),
  } as unknown as Module;
}

export function canonicalModule(module: Module): unknown {
  return JSON.parse(JSON.stringify(module, (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    return value;
  }));
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is not text`);
  return value;
}

function objectAt(
  values: unknown[],
  identifier: unknown,
  label: string,
): JsonObject {
  if (!Number.isInteger(identifier)) {
    throw new Error(
      `${label} identifier ${String(identifier)} is not an integer`,
    );
  }
  const value = values[identifier as number];
  if (value === undefined) {
    throw new Error(
      `${label} identifier ${String(identifier)} is out of bounds`,
    );
  }
  return object(value, label);
}
