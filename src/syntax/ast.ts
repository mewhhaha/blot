// blot's abstract syntax. The concrete grammar is shaped by the GPU profile —
// flat operator chains, `;` and `end` boundaries, a `value` rule that is either
// a lambda or an expression — and none of that survives into this tree. What
// arrives here is already fixity-folded and pattern-classified.

export interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * `!` is consumed exactly once, `?` at most once, `&` borrowed without spending.
 *
 * Affine is not a weaker linear: it is the right rule for a continuation, where
 * not resuming is an abort rather than a leak.
 */
export type Qualifier = "none" | "linear" | "affine" | "borrow";

export type Pattern =
  | {
    readonly tag: "name";
    readonly name: string;
    readonly qualifier: Qualifier;
    readonly span: Span;
  }
  | { readonly tag: "wildcard"; readonly span: Span }
  | { readonly tag: "pin"; readonly name: string; readonly span: Span }
  | { readonly tag: "int"; readonly value: bigint; readonly span: Span }
  | { readonly tag: "float"; readonly value: number; readonly span: Span }
  | { readonly tag: "text"; readonly value: string; readonly span: Span }
  | { readonly tag: "unit"; readonly span: Span }
  | {
    readonly tag: "tuple";
    readonly elements: readonly Pattern[];
    readonly span: Span;
  }
  | {
    readonly tag: "array";
    readonly elements: readonly Pattern[];
    readonly span: Span;
  }
  | {
    readonly tag: "constructor";
    readonly name: string;
    readonly payload: Pattern | null;
    readonly span: Span;
  }
  | {
    readonly tag: "shape";
    readonly fields: readonly ShapePatternField[];
    readonly span: Span;
  };

export interface ShapePatternField {
  readonly name: string;
  readonly pattern: Pattern;
}

export interface ArrayElement {
  readonly spread: boolean;
  readonly value: Expr;
}

export type ShapeMember =
  | { readonly tag: "field"; readonly name: string; readonly value: Expr }
  | { readonly tag: "spread"; readonly value: Expr };

export interface Branch {
  readonly condition: Expr;
  readonly consequence: Expr;
}

export interface Arm {
  readonly pattern: Pattern;
  readonly body: Expr;
}

export type Expr =
  | { readonly tag: "var"; readonly name: string; readonly span: Span }
  | { readonly tag: "int"; readonly value: bigint; readonly span: Span }
  | { readonly tag: "float"; readonly value: number; readonly span: Span }
  | { readonly tag: "text"; readonly value: string; readonly span: Span }
  | { readonly tag: "unit"; readonly span: Span }
  /** An `@`-primitive. The whole compiler surface lives in this namespace. */
  | { readonly tag: "intrinsic"; readonly name: string; readonly span: Span }
  /** A bare constructor, `#Ready`. Applying it attaches a payload. */
  | { readonly tag: "tag"; readonly name: string; readonly span: Span }
  | {
    readonly tag: "apply";
    readonly fn: Expr;
    readonly arg: Expr;
    readonly span: Span;
  }
  | {
    readonly tag: "field";
    readonly target: Expr;
    readonly name: string;
    readonly span: Span;
  }
  | {
    readonly tag: "lambda";
    readonly parameter: Pattern;
    readonly body: Expr;
    /**
     * The caller suspends the argument until the parameter is read. Absent on
     * an ordinary lambda rather than `false`, so the two spell the same tree
     * the Rust middle builds for source that never writes `~`.
     */
    readonly deferred?: boolean;
    readonly span: Span;
  }
  | {
    readonly tag: "array";
    readonly elements: readonly ArrayElement[];
    readonly span: Span;
  }
  | {
    readonly tag: "tuple";
    readonly elements: readonly Expr[];
    readonly span: Span;
  }
  | {
    readonly tag: "shape";
    readonly members: readonly ShapeMember[];
    readonly span: Span;
  }
  | {
    readonly tag: "if";
    readonly branches: readonly Branch[];
    readonly fallback: Expr | null;
    readonly span: Span;
  }
  | {
    readonly tag: "case";
    readonly target: Expr;
    readonly arms: readonly Arm[];
    readonly span: Span;
  }
  | {
    readonly tag: "block";
    readonly declarations: readonly Decl[];
    readonly result: Expr;
    readonly resultEffects: "pure" | "ambient";
    readonly span: Span;
  }
  /** Internal root emitted for a `let rec` or `const rec` binding. */
  | { readonly tag: "rec"; readonly lambda: Expr; readonly span: Span }
  | { readonly tag: "comptime"; readonly body: Expr; readonly span: Span };

export type DeclKind = "let" | "effect" | "const" | "sig";

export interface DeclarationTag {
  readonly descriptor: Expr;
  readonly span: Span;
}

export type Decl =
  | {
    readonly tag: "binding";
    readonly kind: DeclKind;
    readonly tags: readonly DeclarationTag[];
    readonly pattern: Pattern;
    readonly value: Expr;
    readonly span: Span;
  }
  | {
    readonly tag: "shadow";
    readonly name: string;
    readonly value: Expr;
    readonly span: Span;
  }
  /** Spreads a compile-time record's fields into scope. */
  | {
    readonly tag: "open";
    readonly value: Expr;
    readonly span: Span;
  };

export type Associativity = "left" | "right" | "none" | "prefix";

export interface Fixity {
  readonly operator: string;
  readonly associativity: Associativity;
  readonly precedence: number;
  /** Dotted path, e.g. `Num.add` or `@type.union`. */
  readonly target: readonly string[];
  readonly span: Span;
}

export interface Module {
  /** Bound by `module <pattern>;`. The entry module's whole authority. */
  readonly parameter: Pattern | null;
  readonly fixities: readonly Fixity[];
  readonly declarations: readonly Decl[];
  readonly result: Expr;
  readonly resultEffects: "pure" | "ambient";
  readonly span: Span;
}

/** One member of a recursive group: a recursive lambda bound to one name. */
export interface RecursiveMember {
  readonly declaration: Decl & { readonly tag: "binding" };
  readonly name: string;
  readonly pattern: Extract<Pattern, { readonly tag: "name" }>;
  readonly lambda: Expr & { readonly tag: "lambda" };
}

/**
 * The recursive groups a declaration list contains, keyed by every member of
 * each. Members of one group share the returned array, so a caller recognises
 * the first by identity.
 *
 * A group is a run of adjacent recursive bindings of the same kind. Three
 * passes need the same answer — the checker puts the names in scope, the
 * evaluator lets their closures share one environment, and the backend emits
 * one Core `let-rec-group` — and a rule each derived for itself would be three
 * rules free to disagree about which declarations belong together.
 *
 * A `sig` neither joins a run nor ends one. It constrains the binding that has
 * to follow it immediately, so a `sig` between two members is one member's own
 * signature and separates nothing.
 */
export function recursiveGroups(
  declarations: readonly Decl[],
): ReadonlyMap<Decl, readonly RecursiveMember[]> {
  const groups = new Map<Decl, readonly RecursiveMember[]>();
  let members: RecursiveMember[] = [];
  const close = (): void => {
    if (members.length > 0) {
      for (const member of members) groups.set(member.declaration, members);
      members = [];
    }
  };
  for (const declaration of declarations) {
    if (declaration.tag === "binding" && declaration.kind === "sig") continue;
    const member = recursiveMember(declaration);
    if (member === null) {
      close();
      continue;
    }
    // A `let` and a `const` bound together would put a compile-time closure
    // and a runtime one in the same knot, which is the capture rule's whole
    // subject. Changing kind starts a new run instead of being an error,
    // because two adjacent bindings of different kinds usually have nothing to
    // do with each other.
    const previous = members[members.length - 1];
    if (
      previous !== undefined &&
      previous.declaration.kind !== member.declaration.kind
    ) {
      close();
    }
    members.push(member);
  }
  close();
  return groups;
}

function recursiveMember(declaration: Decl): RecursiveMember | null {
  if (declaration.tag !== "binding") return null;
  if (declaration.kind === "sig") return null;
  // A recursive value that is not a lambda, or is bound through a compound
  // pattern, is an error every pass already reports where it stands. Leaving
  // it out of the group keeps that report rather than replacing it with a
  // grouping message.
  if (declaration.value.tag !== "rec") return null;
  if (declaration.value.lambda.tag !== "lambda") return null;
  if (declaration.pattern.tag !== "name") return null;
  return {
    declaration,
    name: declaration.pattern.name,
    pattern: declaration.pattern,
    lambda: declaration.value.lambda,
  };
}

/** Every name a pattern binds, in the order it binds them. */
export function patternNames(pattern: Pattern): readonly string[] {
  switch (pattern.tag) {
    case "name":
      return [pattern.name];
    case "wildcard":
    case "pin":
    case "int":
    case "float":
    case "text":
    case "unit":
      return [];
    case "tuple":
    case "array":
      return pattern.elements.flatMap(patternNames);
    case "constructor":
      if (pattern.payload === null) return [];
      return patternNames(pattern.payload);
    case "shape":
      return pattern.fields.flatMap((field) => patternNames(field.pattern));
  }
}
