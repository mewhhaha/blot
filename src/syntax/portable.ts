import type {
  Arm,
  Branch,
  Decl,
  DeclarationTag,
  Expr,
  Fixity,
  Module,
  Pattern,
  ShapeMember,
  ShapePatternField,
  Span,
} from "./ast.ts";

export interface PortableModule {
  readonly parameter: number | null;
  readonly fixities: readonly unknown[];
  readonly declarations: readonly number[];
  readonly result: number;
  readonly result_effects: "pure" | "ambient";
  readonly span: Span;
  readonly arena: {
    readonly expressions: readonly unknown[];
    readonly patterns: readonly unknown[];
    readonly declarations: readonly unknown[];
  };
}

export function encodePortableModule(module: Module): PortableModule {
  const expressions: unknown[] = [];
  const patterns: unknown[] = [];
  const declarations: unknown[] = [];
  const expressionIds = new Map<Expr, number>();
  const patternIds = new Map<Pattern, number>();
  const declarationIds = new Map<Decl, number>();

  const patternId = (pattern: Pattern): number => {
    const existing = patternIds.get(pattern);
    if (existing !== undefined) return existing;
    const id = patterns.length;
    patternIds.set(pattern, id);
    patterns.push(null);
    let encoded: unknown;
    switch (pattern.tag) {
      case "name":
        encoded = {
          tag: pattern.tag,
          name: pattern.name,
          qualifier: pattern.qualifier,
          span: pattern.span,
        };
        break;
      case "wildcard":
      case "unit":
        encoded = { tag: pattern.tag, span: pattern.span };
        break;
      case "pin":
        encoded = { tag: pattern.tag, name: pattern.name, span: pattern.span };
        break;
      case "int":
        encoded = {
          tag: pattern.tag,
          value: pattern.value.toString(),
          span: pattern.span,
        };
        break;
      case "float":
      case "text":
        encoded = {
          tag: pattern.tag,
          value: pattern.value,
          span: pattern.span,
        };
        break;
      case "tuple":
      case "array":
        encoded = {
          tag: pattern.tag,
          elements: pattern.elements.map(patternId),
          span: pattern.span,
        };
        break;
      case "constructor": {
        let payload: number | null = null;
        if (pattern.payload !== null) payload = patternId(pattern.payload);
        encoded = {
          tag: pattern.tag,
          name: pattern.name,
          payload,
          span: pattern.span,
        };
        break;
      }
      case "shape":
        encoded = {
          tag: pattern.tag,
          fields: pattern.fields.map((field) => ({
            name: field.name,
            pattern: patternId(field.pattern),
          })),
          span: pattern.span,
        };
        break;
    }
    patterns[id] = encoded;
    return id;
  };

  const expressionId = (expression: Expr): number => {
    const existing = expressionIds.get(expression);
    if (existing !== undefined) return existing;
    const id = expressions.length;
    expressionIds.set(expression, id);
    expressions.push(null);
    let encoded: unknown;
    switch (expression.tag) {
      case "var":
      case "intrinsic":
      case "tag":
        encoded = {
          tag: expression.tag,
          name: expression.name,
          span: expression.span,
        };
        break;
      case "int":
        encoded = {
          tag: expression.tag,
          value: expression.value.toString(),
          span: expression.span,
        };
        break;
      case "float":
      case "text":
        encoded = {
          tag: expression.tag,
          value: expression.value,
          span: expression.span,
        };
        break;
      case "unit":
        encoded = { tag: expression.tag, span: expression.span };
        break;
      case "apply":
        encoded = {
          tag: expression.tag,
          function: expressionId(expression.fn),
          argument: expressionId(expression.arg),
          span: expression.span,
        };
        break;
      case "field":
        encoded = {
          tag: expression.tag,
          target: expressionId(expression.target),
          name: expression.name,
          span: expression.span,
        };
        break;
      case "lambda":
        encoded = {
          tag: expression.tag,
          parameter: patternId(expression.parameter),
          body: expressionId(expression.body),
          span: expression.span,
        };
        break;
      case "array":
        encoded = {
          tag: expression.tag,
          elements: expression.elements.map((element) => ({
            spread: element.spread,
            value: expressionId(element.value),
          })),
          span: expression.span,
        };
        break;
      case "tuple":
        encoded = {
          tag: expression.tag,
          elements: expression.elements.map(expressionId),
          span: expression.span,
        };
        break;
      case "shape":
        encoded = {
          tag: expression.tag,
          members: expression.members.map((member) => {
            if (member.tag === "field") {
              return {
                tag: member.tag,
                name: member.name,
                value: expressionId(member.value),
              };
            }
            return { tag: member.tag, value: expressionId(member.value) };
          }),
          span: expression.span,
        };
        break;
      case "if": {
        let fallback: number | null = null;
        if (expression.fallback !== null) {
          fallback = expressionId(expression.fallback);
        }
        encoded = {
          tag: expression.tag,
          branches: expression.branches.map((branch) => ({
            condition: expressionId(branch.condition),
            consequence: expressionId(branch.consequence),
          })),
          fallback,
          span: expression.span,
        };
        break;
      }
      case "case":
        encoded = {
          tag: expression.tag,
          target: expressionId(expression.target),
          arms: expression.arms.map((arm) => ({
            pattern: patternId(arm.pattern),
            body: expressionId(arm.body),
          })),
          span: expression.span,
        };
        break;
      case "block":
        encoded = {
          tag: expression.tag,
          declarations: expression.declarations.map(declarationId),
          result: expressionId(expression.result),
          result_effects: expression.resultEffects,
          span: expression.span,
        };
        break;
      case "rec":
        encoded = {
          tag: expression.tag,
          lambda: expressionId(expression.lambda),
          span: expression.span,
        };
        break;
      case "comptime":
        encoded = {
          tag: expression.tag,
          body: expressionId(expression.body),
          span: expression.span,
        };
        break;
    }
    expressions[id] = encoded;
    return id;
  };

  const declarationId = (declaration: Decl): number => {
    const existing = declarationIds.get(declaration);
    if (existing !== undefined) return existing;
    const id = declarations.length;
    declarationIds.set(declaration, id);
    declarations.push(null);
    let encoded: unknown;
    switch (declaration.tag) {
      case "binding":
        encoded = {
          tag: declaration.tag,
          kind: declaration.kind,
          tags: declaration.tags.map((tag) => ({
            descriptor: expressionId(tag.descriptor),
            span: tag.span,
          })),
          pattern: patternId(declaration.pattern),
          value: expressionId(declaration.value),
          span: declaration.span,
        };
        break;
      case "shadow":
        encoded = {
          tag: declaration.tag,
          name: declaration.name,
          value: expressionId(declaration.value),
          span: declaration.span,
        };
        break;
      case "open":
        encoded = {
          tag: declaration.tag,
          value: expressionId(declaration.value),
          span: declaration.span,
        };
        break;
    }
    declarations[id] = encoded;
    return id;
  };

  let parameter: number | null = null;
  if (module.parameter !== null) parameter = patternId(module.parameter);
  return {
    parameter,
    fixities: module.fixities.map((fixity) => ({
      operator: fixity.operator,
      associativity: fixity.associativity,
      precedence: fixity.precedence,
      target: fixity.target,
      span: fixity.span,
    })),
    declarations: module.declarations.map(declarationId),
    result: expressionId(module.result),
    result_effects: module.resultEffects,
    span: module.span,
    arena: { expressions, patterns, declarations },
  };
}

export function decodePortableModule(
  encoded: unknown,
  location: string,
): Module {
  const root = record(encoded, location);
  const arena = record(root.arena, `${location} arena`);
  const encodedExpressions = list(
    arena.expressions,
    `${location} expression arena`,
  );
  const encodedPatterns = list(arena.patterns, `${location} pattern arena`);
  const encodedDeclarations = list(
    arena.declarations,
    `${location} declaration arena`,
  );
  const expressions: Array<Expr | undefined> = new Array(
    encodedExpressions.length,
  );
  const patterns: Array<Pattern | undefined> = new Array(
    encodedPatterns.length,
  );
  const declarations: Array<Decl | undefined> = new Array(
    encodedDeclarations.length,
  );
  const activeExpressions = new Set<number>();
  const activePatterns = new Set<number>();
  const activeDeclarations = new Set<number>();

  const pattern = (id: number): Pattern => {
    const index = reference(id, encodedPatterns.length, `${location} pattern`);
    const existing = patterns[index];
    if (existing !== undefined) return existing;
    if (activePatterns.has(index)) {
      throw new Error(`${location} pattern arena contains a cycle at ${index}`);
    }
    activePatterns.add(index);
    const node = record(
      encodedPatterns[index],
      `${location} pattern ${index}`,
    );
    const tag = text(node.tag, `${location} pattern ${index} tag`);
    const span = decodeSpan(node.span, `${location} pattern ${index} span`);
    let decoded: Pattern;
    switch (tag) {
      case "name":
        decoded = {
          tag,
          name: text(node.name, `${location} pattern ${index} name`),
          qualifier: qualifier(
            node.qualifier,
            `${location} pattern ${index} qualifier`,
          ),
          span,
        };
        break;
      case "wildcard":
      case "unit":
        decoded = { tag, span };
        break;
      case "pin":
        decoded = {
          tag,
          name: text(node.name, `${location} pattern ${index} name`),
          span,
        };
        break;
      case "int":
        decoded = {
          tag,
          value: integerValue(node.value, `${location} pattern ${index} value`),
          span,
        };
        break;
      case "float":
        decoded = {
          tag,
          value: finiteNumber(
            node.value,
            `${location} pattern ${index} value`,
          ),
          span,
        };
        break;
      case "text":
        decoded = {
          tag,
          value: text(node.value, `${location} pattern ${index} value`),
          span,
        };
        break;
      case "tuple":
      case "array":
        decoded = {
          tag,
          elements: references(
            node.elements,
            `${location} pattern ${index} elements`,
          ).map(pattern),
          span,
        };
        break;
      case "constructor": {
        let payload: Pattern | null = null;
        if (node.payload !== null) {
          payload = pattern(
            reference(
              node.payload,
              encodedPatterns.length,
              `${location} pattern ${index} payload`,
            ),
          );
        }
        decoded = {
          tag,
          name: text(node.name, `${location} pattern ${index} name`),
          payload,
          span,
        };
        break;
      }
      case "shape":
        decoded = {
          tag,
          fields: list(
            node.fields,
            `${location} pattern ${index} fields`,
          ).map((encodedField, ordinal): ShapePatternField => {
            const field = record(
              encodedField,
              `${location} pattern ${index} field ${ordinal}`,
            );
            return {
              name: text(
                field.name,
                `${location} pattern ${index} field ${ordinal} name`,
              ),
              pattern: pattern(
                reference(
                  field.pattern,
                  encodedPatterns.length,
                  `${location} pattern ${index} field ${ordinal} pattern`,
                ),
              ),
            };
          }),
          span,
        };
        break;
      default:
        throw new Error(`${location} pattern ${index} has unknown tag ${tag}`);
    }
    activePatterns.delete(index);
    patterns[index] = decoded;
    return decoded;
  };

  const expression = (id: number): Expr => {
    const index = reference(
      id,
      encodedExpressions.length,
      `${location} expression`,
    );
    const existing = expressions[index];
    if (existing !== undefined) return existing;
    if (activeExpressions.has(index)) {
      throw new Error(
        `${location} expression arena contains a cycle at ${index}`,
      );
    }
    activeExpressions.add(index);
    const node = record(
      encodedExpressions[index],
      `${location} expression ${index}`,
    );
    const tag = text(node.tag, `${location} expression ${index} tag`);
    const span = decodeSpan(node.span, `${location} expression ${index} span`);
    let decoded: Expr;
    switch (tag) {
      case "var":
      case "intrinsic":
      case "tag":
        decoded = {
          tag,
          name: text(node.name, `${location} expression ${index} name`),
          span,
        };
        break;
      case "int":
        decoded = {
          tag,
          value: integerValue(
            node.value,
            `${location} expression ${index} value`,
          ),
          span,
        };
        break;
      case "float":
        decoded = {
          tag,
          value: finiteNumber(
            node.value,
            `${location} expression ${index} value`,
          ),
          span,
        };
        break;
      case "text":
        decoded = {
          tag,
          value: text(node.value, `${location} expression ${index} value`),
          span,
        };
        break;
      case "unit":
        decoded = { tag, span };
        break;
      case "apply":
        decoded = {
          tag,
          fn: expression(
            reference(
              node.function,
              encodedExpressions.length,
              `${location} expression ${index} function`,
            ),
          ),
          arg: expression(
            reference(
              node.argument,
              encodedExpressions.length,
              `${location} expression ${index} argument`,
            ),
          ),
          span,
        };
        break;
      case "field":
        decoded = {
          tag,
          target: expression(
            reference(
              node.target,
              encodedExpressions.length,
              `${location} expression ${index} target`,
            ),
          ),
          name: text(node.name, `${location} expression ${index} name`),
          span,
        };
        break;
      case "lambda":
        decoded = {
          tag,
          parameter: pattern(
            reference(
              node.parameter,
              encodedPatterns.length,
              `${location} expression ${index} parameter`,
            ),
          ),
          body: expression(
            reference(
              node.body,
              encodedExpressions.length,
              `${location} expression ${index} body`,
            ),
          ),
          span,
        };
        break;
      case "array":
        decoded = {
          tag,
          elements: list(
            node.elements,
            `${location} expression ${index} elements`,
          ).map((encodedElement, ordinal) => {
            const element = record(
              encodedElement,
              `${location} expression ${index} element ${ordinal}`,
            );
            return {
              spread: boolean(
                element.spread,
                `${location} expression ${index} element ${ordinal} spread`,
              ),
              value: expression(
                reference(
                  element.value,
                  encodedExpressions.length,
                  `${location} expression ${index} element ${ordinal} value`,
                ),
              ),
            };
          }),
          span,
        };
        break;
      case "tuple":
        decoded = {
          tag,
          elements: references(
            node.elements,
            `${location} expression ${index} elements`,
          ).map(expression),
          span,
        };
        break;
      case "shape":
        decoded = {
          tag,
          members: list(
            node.members,
            `${location} expression ${index} members`,
          ).map((encodedMember, ordinal): ShapeMember => {
            const member = record(
              encodedMember,
              `${location} expression ${index} member ${ordinal}`,
            );
            const memberTag = text(
              member.tag,
              `${location} expression ${index} member ${ordinal} tag`,
            );
            const value = expression(
              reference(
                member.value,
                encodedExpressions.length,
                `${location} expression ${index} member ${ordinal} value`,
              ),
            );
            if (memberTag === "spread") return { tag: memberTag, value };
            if (memberTag === "field") {
              return {
                tag: memberTag,
                name: text(
                  member.name,
                  `${location} expression ${index} member ${ordinal} name`,
                ),
                value,
              };
            }
            throw new Error(
              `${location} expression ${index} member ${ordinal} has unknown tag ${memberTag}`,
            );
          }),
          span,
        };
        break;
      case "if": {
        let fallback: Expr | null = null;
        if (node.fallback !== null) {
          fallback = expression(
            reference(
              node.fallback,
              encodedExpressions.length,
              `${location} expression ${index} fallback`,
            ),
          );
        }
        decoded = {
          tag,
          branches: list(
            node.branches,
            `${location} expression ${index} branches`,
          ).map((encodedBranch, ordinal): Branch => {
            const branch = record(
              encodedBranch,
              `${location} expression ${index} branch ${ordinal}`,
            );
            return {
              condition: expression(
                reference(
                  branch.condition,
                  encodedExpressions.length,
                  `${location} expression ${index} branch ${ordinal} condition`,
                ),
              ),
              consequence: expression(
                reference(
                  branch.consequence,
                  encodedExpressions.length,
                  `${location} expression ${index} branch ${ordinal} consequence`,
                ),
              ),
            };
          }),
          fallback,
          span,
        };
        break;
      }
      case "case":
        decoded = {
          tag,
          target: expression(
            reference(
              node.target,
              encodedExpressions.length,
              `${location} expression ${index} target`,
            ),
          ),
          arms: list(
            node.arms,
            `${location} expression ${index} arms`,
          ).map((encodedArm, ordinal): Arm => {
            const arm = record(
              encodedArm,
              `${location} expression ${index} arm ${ordinal}`,
            );
            return {
              pattern: pattern(
                reference(
                  arm.pattern,
                  encodedPatterns.length,
                  `${location} expression ${index} arm ${ordinal} pattern`,
                ),
              ),
              body: expression(
                reference(
                  arm.body,
                  encodedExpressions.length,
                  `${location} expression ${index} arm ${ordinal} body`,
                ),
              ),
            };
          }),
          span,
        };
        break;
      case "block":
        decoded = {
          tag,
          declarations: references(
            node.declarations,
            `${location} expression ${index} declarations`,
          ).map(declaration),
          result: expression(
            reference(
              node.result,
              encodedExpressions.length,
              `${location} expression ${index} result`,
            ),
          ),
          resultEffects: resultEffects(
            node.result_effects,
            `${location} expression ${index} result effects`,
          ),
          span,
        };
        break;
      case "rec":
        decoded = {
          tag,
          lambda: expression(
            reference(
              node.lambda,
              encodedExpressions.length,
              `${location} expression ${index} lambda`,
            ),
          ),
          span,
        };
        break;
      case "comptime":
        decoded = {
          tag,
          body: expression(
            reference(
              node.body,
              encodedExpressions.length,
              `${location} expression ${index} body`,
            ),
          ),
          span,
        };
        break;
      default:
        throw new Error(
          `${location} expression ${index} has unknown tag ${tag}`,
        );
    }
    activeExpressions.delete(index);
    expressions[index] = decoded;
    return decoded;
  };

  const declaration = (id: number): Decl => {
    const index = reference(
      id,
      encodedDeclarations.length,
      `${location} declaration`,
    );
    const existing = declarations[index];
    if (existing !== undefined) return existing;
    if (activeDeclarations.has(index)) {
      throw new Error(
        `${location} declaration arena contains a cycle at ${index}`,
      );
    }
    activeDeclarations.add(index);
    const node = record(
      encodedDeclarations[index],
      `${location} declaration ${index}`,
    );
    const tag = text(node.tag, `${location} declaration ${index} tag`);
    const span = decodeSpan(node.span, `${location} declaration ${index} span`);
    let decoded: Decl;
    switch (tag) {
      case "binding":
        decoded = {
          tag,
          kind: declarationKind(
            node.kind,
            `${location} declaration ${index} kind`,
          ),
          tags: list(
            node.tags,
            `${location} declaration ${index} tags`,
          ).map((encodedTag, ordinal): DeclarationTag => {
            const declarationTag = record(
              encodedTag,
              `${location} declaration ${index} tag ${ordinal}`,
            );
            return {
              descriptor: expression(
                reference(
                  declarationTag.descriptor,
                  encodedExpressions.length,
                  `${location} declaration ${index} tag ${ordinal} descriptor`,
                ),
              ),
              span: decodeSpan(
                declarationTag.span,
                `${location} declaration ${index} tag ${ordinal} span`,
              ),
            };
          }),
          pattern: pattern(
            reference(
              node.pattern,
              encodedPatterns.length,
              `${location} declaration ${index} pattern`,
            ),
          ),
          value: expression(
            reference(
              node.value,
              encodedExpressions.length,
              `${location} declaration ${index} value`,
            ),
          ),
          span,
        };
        break;
      case "shadow":
        decoded = {
          tag,
          name: text(node.name, `${location} declaration ${index} name`),
          value: expression(
            reference(
              node.value,
              encodedExpressions.length,
              `${location} declaration ${index} value`,
            ),
          ),
          span,
        };
        break;
      case "open":
        decoded = {
          tag,
          value: expression(
            reference(
              node.value,
              encodedExpressions.length,
              `${location} declaration ${index} value`,
            ),
          ),
          span,
        };
        break;
      default:
        throw new Error(
          `${location} declaration ${index} has unknown tag ${tag}`,
        );
    }
    activeDeclarations.delete(index);
    declarations[index] = decoded;
    return decoded;
  };

  let parameter: Pattern | null = null;
  if (root.parameter !== null) {
    parameter = pattern(
      reference(
        root.parameter,
        encodedPatterns.length,
        `${location} parameter`,
      ),
    );
  }
  const module: Module = {
    parameter,
    fixities: list(root.fixities, `${location} fixities`).map(
      (encodedFixity, ordinal): Fixity => {
        const fixity = record(
          encodedFixity,
          `${location} fixity ${ordinal}`,
        );
        return {
          operator: text(
            fixity.operator,
            `${location} fixity ${ordinal} operator`,
          ),
          associativity: associativity(
            fixity.associativity,
            `${location} fixity ${ordinal} associativity`,
          ),
          precedence: unsignedInteger(
            fixity.precedence,
            `${location} fixity ${ordinal} precedence`,
          ),
          target: list(fixity.target, `${location} fixity ${ordinal} target`)
            .map(
              (segment, targetOrdinal) =>
                text(
                  segment,
                  `${location} fixity ${ordinal} target ${targetOrdinal}`,
                ),
            ),
          span: decodeSpan(fixity.span, `${location} fixity ${ordinal} span`),
        };
      },
    ),
    declarations: references(
      root.declarations,
      `${location} declarations`,
    ).map(declaration),
    result: expression(
      reference(root.result, encodedExpressions.length, `${location} result`),
    ),
    resultEffects: resultEffects(
      root.result_effects,
      `${location} result effects`,
    ),
    span: decodeSpan(root.span, `${location} span`),
  };
  for (let index = 0; index < encodedExpressions.length; index += 1) {
    expression(index);
  }
  for (let index = 0; index < encodedPatterns.length; index += 1) {
    pattern(index);
  }
  for (let index = 0; index < encodedDeclarations.length; index += 1) {
    declaration(index);
  }
  return module;
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, location: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  return value;
}

function text(value: unknown, location: string): string {
  if (typeof value !== "string") throw new Error(`${location} must be text`);
  return value;
}

function boolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${location} must be a boolean`);
  }
  return value;
}

function finiteNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${location} must be a finite number`);
  }
  return value;
}

function unsignedInteger(value: unknown, location: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${location} must be a non-negative safe integer`);
  }
  return value as number;
}

function reference(value: unknown, length: number, location: string): number {
  const id = unsignedInteger(value, location);
  if (id >= length) {
    throw new Error(`${location} ${id} is outside arena length ${length}`);
  }
  return id;
}

function references(value: unknown, location: string): readonly number[] {
  return list(value, location).map((reference, ordinal) =>
    unsignedInteger(reference, `${location} ${ordinal}`)
  );
}

function decodeSpan(value: unknown, location: string): Span {
  const span = record(value, location);
  const start = unsignedInteger(span.start, `${location} start`);
  const end = unsignedInteger(span.end, `${location} end`);
  if (end < start) throw new Error(`${location} ends before it starts`);
  return { start, end };
}

function integerValue(value: unknown, location: string): bigint {
  const encoded = text(value, location);
  if (!/^-?(0|[1-9][0-9]*)$/.test(encoded)) {
    throw new Error(`${location} is not a canonical integer`);
  }
  return BigInt(encoded);
}

function qualifier(
  value: unknown,
  location: string,
): "none" | "linear" | "affine" | "borrow" {
  if (
    value === "none" || value === "linear" || value === "affine" ||
    value === "borrow"
  ) return value;
  throw new Error(`${location} has unknown value ${String(value)}`);
}

function associativity(
  value: unknown,
  location: string,
): "left" | "right" | "none" | "prefix" {
  if (
    value === "left" || value === "right" || value === "none" ||
    value === "prefix"
  ) return value;
  throw new Error(`${location} has unknown value ${String(value)}`);
}

function declarationKind(
  value: unknown,
  location: string,
): "let" | "effect" | "const" | "sig" {
  if (
    value === "let" || value === "effect" || value === "const" ||
    value === "sig"
  ) return value;
  throw new Error(`${location} has unknown value ${String(value)}`);
}

function resultEffects(
  value: unknown,
  location: string,
): "pure" | "ambient" {
  if (value === "pure" || value === "ambient") return value;
  throw new Error(`${location} has unknown value ${String(value)}`);
}
