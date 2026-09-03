import type { Span } from "./ast.ts";
import { fail } from "../diagnostic.ts";
import { asRule, fieldList, required, type Rule, tokenOf } from "./cursor.ts";

export type Associativity = "left" | "right" | "none" | "prefix";

export interface Fixity {
  readonly operator: string;
  readonly associativity: Associativity;
  readonly precedence: number;
  readonly target: readonly string[];
  readonly span: Span;
}

/** Reads the complete bounded source fixity header before any expression chain is folded. */
export function declaredFixities(root: Rule): readonly Fixity[] {
  return fieldList(root, "operators").map((cursor) => {
    const rule = asRule(cursor, "fixity_declaration");
    const declaration = tokenOf(required(rule, "associativity")).text;
    const associativity = declaredAssociativity(declaration, rule.span);

    const precedence = Number(tokenOf(required(rule, "precedence")).text);
    if (
      !Number.isSafeInteger(precedence) || precedence < 0 ||
      precedence > 0xffff_ffff
    ) {
      fail(
        "BLOT_BAD_FIXITY",
        "Operator precedence must fit in an unsigned 32-bit integer.",
        rule.span,
      );
    }

    const targetRule = asRule(required(rule, "target"), "qualified_name");
    const rootName = tokenOf(required(targetRule, "root")).text;
    const target = [rootName];
    for (const part of fieldList(targetRule, "rest")) {
      target.push(
        tokenOf(
          required(asRule(part, "qualified_name_part"), "name"),
        ).text,
      );
    }
    return {
      operator: tokenOf(required(rule, "operator")).text,
      associativity,
      precedence,
      target,
      span: rule.span,
    };
  });
}

function declaredAssociativity(
  declaration: string,
  span: Span,
): Associativity {
  if (declaration === "infixl") return "left";
  if (declaration === "infixr") return "right";
  if (declaration === "infix") return "none";
  if (declaration === "prefix") return "prefix";
  return fail(
    "BLOT_BAD_FIXITY",
    `Unknown fixity declaration \`${declaration}\`.`,
    span,
  );
}
