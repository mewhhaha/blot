// Linearity and ownership.
//
// This is a flow analysis over the AST, deliberately *not* part of the type
// lattice. Biunification stays polynomial only because ownership is checked
// separately: putting `!` into the lattice would make subtyping decide resource
// use, and the algorithm would stop being the thing that pays for itself.
//
// Two qualifiers, and the difference between them is the whole design:
//
//   * `!x` is **linear**. It must be consumed exactly once on every path. Not
//     once-or-fewer — a resource that is never consumed is a leak, and that is
//     the failure the marker exists to catch.
//   * `?x` is **affine**: at most once. Not a weaker linear but a different
//     rule, and the right one for a continuation — a handler that does not
//     resume is aborting, which is legitimate, while resuming twice is not.
//   * `&x` is a **borrow**. It may be read any number of times and may never be
//     moved, so a borrowing function is one you can call without losing what you
//     passed it.
//
// Alongside the check, the pass records the last use of every binding. The
// backend spends the stronger, per-path linear fact on owned Store updates, so
// the traversal-order last use is not evidence on its own: it is where the walk
// stopped seeing a name, and inside a closure that is not where the binding
// dies. Where the pass cannot date the read it recorded, it says so, and the
// backend has to refuse rather than treat it as a death.
//
// Every fact is keyed by the `name` pattern that introduced the binding, never
// by the binding's name. A name is not an identity: two scopes may bind the
// same one, and the backend inlines an imported module into its importer, so a
// name-keyed fact reports one binding for another as soon as anything merges
// two modules' facts together.

import type {
  Decl,
  Expr,
  Module,
  Pattern,
  Qualifier,
  RecursiveMember,
  Span,
} from "../syntax/ast.ts";
import { liveDeclarations } from "../syntax/live.ts";
import { recursiveGroups } from "../syntax/ast.ts";
import type { Diagnostic } from "../diagnostic.ts";

/** The only pattern that introduces a binding, and therefore the fact key. */
export type NamePattern = Extract<Pattern, { readonly tag: "name" }>;

interface Binding {
  /**
   * The pattern this binding came from. Its node identity keys every fact, and
   * it is where the name and the declaration span are read from — a copy of
   * either would be a second answer waiting to disagree with this one.
   */
  readonly pattern: NamePattern;
  /**
   * Not always `pattern.qualifier`: a binding whose value captured a linear
   * value is linear whether or not anyone wrote `!` on it.
   */
  readonly qualifier: Qualifier;
  /** Where the binding was consumed, if it has been. */
  moved: Span | null;
  /** How many times it was read without being consumed. */
  borrows: number;
  lastUse: Span | null;
}

interface Scope {
  readonly bindings: Map<string, Binding>;
  readonly parent: Scope | null;
  /** A lambda body. Linear values reached from outside it are captured. */
  readonly lambda: boolean;
  /** Outer linear bindings this lambda captured, if it is one. */
  readonly captures: Set<Binding>;
}

export interface Ownership {
  /**
   * The last read of each binding *in traversal order*, keyed by the pattern
   * that bound it.
   *
   * That is weaker than it sounds and the difference decides what may be built
   * on it. Branches are walked one after another from the same incoming state,
   * and only the consumed-or-not state is restored between them, so a read in
   * the last arm overwrites a read in the first even though no execution takes
   * both. This says where the analysis stopped seeing the name, not that the
   * binding is dead everywhere after that point. A reuse rewrite needs the
   * stronger claim and must establish it rather than reading it off here.
   */
  readonly lastUses: ReadonlyMap<NamePattern, Span>;
  /**
   * The bindings whose linear or affine obligation was proved discharged.
   *
   * This one *is* a per-path claim: a linear binding is here only when every
   * path consumed it exactly once, which is what `agree` enforces.
   */
  readonly linear: ReadonlySet<NamePattern>;
  /**
   * The bindings whose `lastUses` entry is the last read *walked* rather than
   * the last read *taken*.
   *
   * A closure's body runs when the closure is called, and nothing in
   * declaration order dates that call — a recursive group is only the sharpest
   * case, since its members call each other in an order the block does not
   * write down. So a binding one closure reads across its own boundary, and
   * something else reads as well, has no last read this pass can name, and
   * anything that would read a death off `lastUses` has to refuse here instead.
   */
  readonly reentrant: ReadonlySet<NamePattern>;
}

export interface LinearResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly ownership: Ownership;
}

class Analysis {
  readonly diagnostics: Diagnostic[] = [];
  readonly lastUses = new Map<NamePattern, Span>();
  readonly linear = new Set<NamePattern>();
  /** Where each binding was read, by the offset the read started at. */
  readonly reads = new Map<NamePattern, Set<number>>();
  /** The bindings some closure reached from outside its own body. */
  readonly crossed = new Set<NamePattern>();

  report(code: string, message: string, span: Span): void {
    this.diagnostics.push({ code, message, span });
  }

  /**
   * Finds a binding, and reports the outermost lambda crossed on the way — the
   * one that would capture it. Captures chain: a use two lambdas deep is
   * captured by the outer lambda from the defining scope, then by the inner one
   * from the outer, and resolving one link at a time builds that chain.
   */
  lookup(
    scope: Scope,
    name: string,
  ): { binding: Binding; capturedBy: Scope | null } | null {
    let current: Scope | null = scope;
    let capturedBy: Scope | null = null;
    while (current !== null) {
      const found = current.bindings.get(name);
      if (found !== undefined) return { binding: found, capturedBy };
      if (current.lambda) capturedBy = current;
      current = current.parent;
    }
    return null;
  }
}

function childScope(parent: Scope | null, lambda = false): Scope {
  return { bindings: new Map(), parent, lambda, captures: new Set() };
}

/** A snapshot of which linear bindings are consumed, for comparing branches. */
function snapshot(scope: Scope): Map<Binding, Span | null> {
  const state = new Map<Binding, Span | null>();
  let current: Scope | null = scope;
  while (current !== null) {
    for (const binding of current.bindings.values()) {
      if (spendable(binding.qualifier)) state.set(binding, binding.moved);
    }
    current = current.parent;
  }
  return state;
}

function restore(state: Map<Binding, Span | null>): void {
  for (const [binding, moved] of state) binding.moved = moved;
}

export function checkLinearity(module: Module): LinearResult {
  const analysis = new Analysis();
  const scope = childScope(null);

  if (module.parameter !== null) {
    declare(module.parameter, scope, analysis);
  }
  walkDeclarations(module.declarations, module.result, scope, analysis);
  walk(module.result, scope, analysis, "move");
  closeScope(scope, analysis);

  const reentrant = new Set<NamePattern>();
  for (const [pattern, reads] of analysis.reads) {
    // One read is one read wherever it stands: if a closure holds the only one,
    // calling the closure is the only way to reach the binding, and the pass
    // already proves how often that happens. Two put the order in question.
    if (reads.size > 1 && analysis.crossed.has(pattern)) reentrant.add(pattern);
  }

  // A captured value is shadowed inside the closure that took it, so it is
  // proved twice — once in each scope. That is bookkeeping, not two values, and
  // the shadow carries the same pattern, so keying by identity records one.
  return {
    diagnostics: analysis.diagnostics,
    ownership: {
      lastUses: analysis.lastUses,
      linear: analysis.linear,
      reentrant,
    },
  };
}

/** Every linear binding in a scope must be consumed before the scope ends. */
function closeScope(scope: Scope, analysis: Analysis): void {
  for (const binding of scope.bindings.values()) {
    if (!spendable(binding.qualifier)) continue;
    // Affine owes nothing: not resuming is an abort, not a leak.
    if (binding.qualifier === "affine") {
      if (binding.moved !== null) analysis.linear.add(binding.pattern);
      continue;
    }
    if (binding.moved === null) {
      analysis.report(
        "BLOT_LINEAR_NOT_CONSUMED",
        `\`${binding.pattern.name}\` is linear and is never consumed. A linear value must be used exactly once; drop the \`!\` if it need not be.`,
        binding.pattern.span,
      );
      continue;
    }
    analysis.linear.add(binding.pattern);
  }
}

function declare(pattern: Pattern, scope: Scope, analysis: Analysis): void {
  switch (pattern.tag) {
    case "name":
      scope.bindings.set(pattern.name, {
        pattern,
        qualifier: pattern.qualifier,
        moved: null,
        borrows: 0,
        lastUse: null,
      });
      return;
    case "tuple":
    case "array":
      for (const inner of pattern.elements) declare(inner, scope, analysis);
      return;
    case "constructor":
      if (pattern.payload !== null) declare(pattern.payload, scope, analysis);
      return;
    case "shape":
      for (const field of pattern.fields) {
        declare(field.pattern, scope, analysis);
      }
      return;
    default:
      return;
  }
}

/**
 * How a name is reached.
 *
 *   * `move` — the value travels somewhere that keeps it: an argument, a shape
 *     member, a result. A linear value is spent; a borrowed one may not go.
 *   * `project` — the value's structure is read, as in `p.x`. A linear value is
 *     still spent, because what is left of it cannot be used again; a borrowed
 *     one is fine, since reading is what a borrow is for.
 *   * `borrow` — written `&x`, and the only thing that does not spend a linear
 *     value.
 */
type Use = "move" | "borrow" | "project";

function use(
  name: string,
  span: Span,
  scope: Scope,
  analysis: Analysis,
  kind: Use,
): void {
  const found = analysis.lookup(scope, name);
  if (found === null) return;
  const { binding, capturedBy } = found;

  analysis.lastUses.set(binding.pattern, span);
  binding.lastUse = span;
  const reads = analysis.reads.get(binding.pattern);
  if (reads === undefined) {
    analysis.reads.set(binding.pattern, new Set([span.start]));
  } else {
    reads.add(span.start);
  }
  // A capture resolves through this function twice, once against the outer
  // binding and once against the shadow it just installed, so the boundary is
  // recorded on the way in and the offset set absorbs the second visit.
  if (capturedBy !== null) analysis.crossed.add(binding.pattern);

  if (binding.qualifier === "borrow" && kind === "move") {
    analysis.report(
      "BLOT_BORROW_MOVED",
      `\`${name}\` is borrowed and cannot be moved. A borrowing function is one its caller can still use afterwards.`,
      span,
    );
    return;
  }

  if (!spendable(binding.qualifier) || kind === "borrow") {
    binding.borrows += 1;
    return;
  }

  // Capturing a linear value does not refuse it and does not spend it here.
  // The obligation *moves into the closure*: the closure becomes linear, and
  // whoever holds it owes exactly one call. Inside the body the captured value
  // is an ordinary linear binding, so using it twice per call is still caught.
  if (capturedBy !== null) {
    capturedBy.captures.add(binding);
    capturedBy.bindings.set(name, {
      pattern: binding.pattern,
      qualifier: binding.qualifier,
      moved: null,
      borrows: 0,
      lastUse: null,
    });
    use(name, span, scope, analysis, kind);
    return;
  }

  consume(binding, span, analysis);
}

/** Linear and affine both spend; they differ only in whether spending is owed. */
function spendable(qualifier: Qualifier): boolean {
  return qualifier === "linear" || qualifier === "affine";
}

function walkDeclarations(
  declarations: readonly Decl[],
  result: Expr,
  scope: Scope,
  analysis: Analysis,
): void {
  const groups = recursiveGroups(declarations);
  const live = liveDeclarations(declarations, result);
  for (const declaration of declarations) {
    if (!live.has(declaration)) continue;
    // `open` spreads a compile-time record, and a compile-time record cannot
    // hold a linear value — there is no run time for it to be consumed in. So
    // the expression is walked for what *it* consumes and nothing is declared.
    if (declaration.tag === "open") {
      if (walk(declaration.value, scope, analysis, "move") !== "none") {
        escapes(declaration.span, analysis);
      }
      continue;
    }
    if (declaration.tag === "shadow") {
      if (walk(declaration.value, scope, analysis, "move") !== "none") {
        escapes(declaration.span, analysis);
      }
      continue;
    }
    // A `sig` computes nothing at run time and consumes nothing.
    if (declaration.kind === "sig") continue;
    const group = groups.get(declaration);
    if (group !== undefined) {
      // The members of one group share the array, so the first of them is the
      // one that walks it and the rest have already been walked with it.
      if (group[0].declaration === declaration) {
        walkRecursiveGroup(group, scope, analysis);
      }
      continue;
    }
    const produced = walk(declaration.value, scope, analysis, "move");
    declare(declaration.pattern, scope, analysis);
    if (produced !== "none" && declaration.pattern.tag === "name") {
      const binding = scope.bindings.get(declaration.pattern.name);
      if (binding !== undefined) {
        scope.bindings.set(declaration.pattern.name, {
          ...binding,
          qualifier: inherited(binding.qualifier, produced),
        });
      }
    }
  }
}

/**
 * The qualifier a binding ends up with.
 *
 * A closure that captured a linear value is linear itself, whether or not
 * anyone wrote `!`. The obligation was not created there, only relocated, so it
 * would be wrong to make the programmer restate it — and wrong to keep a
 * written marker that describes a weaker obligation than the one being held.
 */
function inherited(written: Qualifier, produced: Produced): Qualifier {
  if (produced === "none") return written;
  return produced;
}

/**
 * A recursive group, whose names are in scope in every member's body.
 *
 * An ordinary declaration is walked before its name exists, which is right for
 * a binding nothing before it can mention. A group's members mention each
 * other, so a member walked that way meets a name the scope has never heard of
 * and its uses go uncounted — a linear sibling then looks unconsumed however
 * many times the group spends it.
 *
 * Declaring the names first does not fix that on its own, because a member's
 * qualifier is not written on its pattern: it is discovered from its body, and
 * a sibling that holds a member discovered linear is linear in turn. So the
 * qualifiers are settled first against a throwaway analysis, and the group is
 * then walked once for real against them.
 */
function walkRecursiveGroup(
  members: readonly RecursiveMember[],
  scope: Scope,
  analysis: Analysis,
): void {
  const settled = members.map((member) => member.pattern.qualifier);
  // A closure becomes linear only by holding something linear. With nothing
  // spendable within reach there is nothing for a member to hold, so every
  // attempt would settle on what was written and the group is walked once.
  if (reachesSpendable(scope) || settled.some(spendable)) {
    settleQualifiers(members, settled, scope);
  }

  declareGroup(members, settled, scope);
  for (const [index, member] of members.entries()) {
    const produced = walk(member.declaration.value, scope, analysis, "move");
    if (inherited(settled[index], produced) !== settled[index]) {
      throw new Error(
        `recursive group member \`${member.name}\` produced a ${produced} obligation the settled qualifiers did not carry`,
      );
    }
  }
}

/**
 * Raises the group's qualifiers until walking its bodies stops raising them.
 *
 * Each attempt starts from the scope the group started from, because a walk
 * consumes and the next attempt must not inherit what the last one spent.
 */
function settleQualifiers(
  members: readonly RecursiveMember[],
  settled: Qualifier[],
  scope: Scope,
): void {
  // Each member's qualifier is a function of its siblings' over a lattice two
  // steps deep, so the search is short and bounded. Running past the bound is
  // not a program to refuse — it is this function disagreeing with its own
  // lattice, and a diagnostic would report the mistake as the programmer's.
  const attempts = 2 * members.length + 2;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const undo = checkpoint(scope);
    declareGroup(members, settled, scope);
    const probe = new Analysis();
    let raised = false;
    for (const [index, member] of members.entries()) {
      const produced = walk(member.declaration.value, scope, probe, "move");
      const qualifier = inherited(member.pattern.qualifier, produced);
      if (qualifier !== settled[index]) {
        settled[index] = qualifier;
        raised = true;
      }
    }
    rewind(undo);
    if (!raised) return;
  }
  throw new Error(
    `the qualifiers of the recursive group binding \`${
      members.map((member) => member.name).join("`, `")
    }\` did not settle`,
  );
}

/** The group's names, all at once, so that every body sees every one of them. */
function declareGroup(
  members: readonly RecursiveMember[],
  settled: readonly Qualifier[],
  scope: Scope,
): void {
  for (const [index, member] of members.entries()) {
    scope.bindings.set(member.name, {
      pattern: member.pattern,
      qualifier: settled[index],
      moved: null,
      borrows: 0,
      lastUse: null,
    });
  }
}

/** Is there anything in reach for a closure to become linear by holding? */
function reachesSpendable(scope: Scope): boolean {
  let current: Scope | null = scope;
  while (current !== null) {
    for (const binding of current.bindings.values()) {
      if (spendable(binding.qualifier)) return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Everything a walk can leave behind in the scopes it could see.
 *
 * Settling walks the same bodies more than once, and a walk marks bindings
 * moved and rewrites a capturing scope's own bindings with the shadows it took.
 * None of that may survive into the next attempt or into the walk that counts,
 * so the whole visible chain is written down rather than the moves alone.
 */
interface Undo {
  readonly scope: Scope;
  readonly bindings: readonly (readonly [string, Binding])[];
  readonly captures: readonly Binding[];
  readonly moved: readonly (readonly [Binding, Span | null])[];
}

function checkpoint(scope: Scope): readonly Undo[] {
  const undo: Undo[] = [];
  let current: Scope | null = scope;
  while (current !== null) {
    const bindings = [...current.bindings];
    undo.push({
      scope: current,
      bindings,
      captures: [...current.captures],
      moved: bindings.map(([, binding]) => [binding, binding.moved] as const),
    });
    current = current.parent;
  }
  return undo;
}

function rewind(undo: readonly Undo[]): void {
  for (const entry of undo) {
    entry.scope.bindings.clear();
    for (const [name, binding] of entry.bindings) {
      entry.scope.bindings.set(name, binding);
    }
    entry.scope.captures.clear();
    for (const binding of entry.captures) entry.scope.captures.add(binding);
    for (const [binding, moved] of entry.moved) binding.moved = moved;
  }
}

/**
 * What obligation, if any, an expression *produced*. Only a closure that
 * captured one does, and the answer has to travel outward: the binding it lands
 * in inherits it whether or not anyone wrote a marker. A closure that captured
 * a linear value owes exactly one call; one that captured only affine values
 * owes at most one.
 */
type Produced = "none" | "affine" | "linear";

function walk(
  expr: Expr,
  scope: Scope,
  analysis: Analysis,
  kind: Use,
): Produced {
  switch (expr.tag) {
    case "var":
      use(expr.name, expr.span, scope, analysis, kind);
      return "none";

    case "apply": {
      // `&x` and `!x` reach here as prefix-operator applications, and they are
      // the two places the intent is written down rather than inferred.
      if (expr.fn.tag === "intrinsic" && expr.fn.name === "@linear.borrow") {
        walk(expr.arg, scope, analysis, "borrow");
        return "none";
      }
      if (expr.fn.tag === "intrinsic" && expr.fn.name === "@linear.own") {
        return walk(expr.arg, scope, analysis, "move");
      }
      // Applying a linear closure right where it was built discharges it: the
      // one call it owed is this one.
      walk(expr.fn, scope, analysis, "project");
      // An argument is moved into the call unless it was explicitly borrowed.
      const argument = walk(expr.arg, scope, analysis, "move");
      if (argument !== "none") escapes(expr.arg.span, analysis);
      return "none";
    }

    case "field":
      walk(expr.target, scope, analysis, "project");
      return "none";

    case "lambda": {
      const inner = childScope(scope, true);
      declare(expr.parameter, inner, analysis);
      walk(expr.body, inner, analysis, "move");
      closeScope(inner, analysis);
      // Each captured value is spent once, here, into the closure. What the
      // closure owes from now on is one call.
      let produced: Produced = "none";
      for (const captured of inner.captures) {
        consume(captured, expr.span, analysis);
        if (captured.qualifier === "linear") produced = "linear";
        else if (produced === "none") produced = "affine";
      }
      return produced;
    }

    case "rec":
      return walk(expr.lambda, scope, analysis, kind);

    case "comptime":
      return walk(expr.body, scope, analysis, kind);

    case "tuple":
      for (const element of expr.elements) {
        if (walk(element, scope, analysis, "move") !== "none") {
          escapes(element.span, analysis);
        }
      }
      return "none";

    case "array":
      for (const element of expr.elements) {
        if (walk(element.value, scope, analysis, "move") !== "none") {
          escapes(element.value.span, analysis);
        }
      }
      return "none";

    case "shape":
      for (const member of expr.members) {
        if (walk(member.value, scope, analysis, "move") !== "none") {
          escapes(member.value.span, analysis);
        }
      }
      return "none";

    case "if": {
      // Every branch starts from the same state and must end in the same one:
      // a value consumed on one path and not another is consumed neither
      // exactly once nor never.
      const before = snapshot(scope);
      const outcomes: Map<Binding, Span | null>[] = [];
      for (const branch of expr.branches) {
        walk(branch.condition, scope, analysis, "project");
      }
      for (const branch of expr.branches) {
        restore(before);
        walk(branch.consequence, scope, analysis, kind);
        outcomes.push(snapshot(scope));
      }
      if (expr.fallback !== null) {
        restore(before);
        walk(expr.fallback, scope, analysis, kind);
        outcomes.push(snapshot(scope));
      }
      agree(outcomes, before, expr.span, analysis);
      return "none";
    }

    case "case": {
      walk(expr.target, scope, analysis, "project");
      const before = snapshot(scope);
      const outcomes: Map<Binding, Span | null>[] = [];
      for (const arm of expr.arms) {
        restore(before);
        const inner = childScope(scope);
        declare(arm.pattern, inner, analysis);
        walk(arm.body, inner, analysis, kind);
        closeScope(inner, analysis);
        outcomes.push(snapshot(scope));
      }
      agree(outcomes, before, expr.span, analysis);
      return "none";
    }

    case "block": {
      const inner = childScope(scope);
      walkDeclarations(expr.declarations, expr.result, inner, analysis);
      const result = walk(expr.result, inner, analysis, kind);
      closeScope(inner, analysis);
      return result;
    }

    default:
      return "none";
  }
}

/** Spends a binding once, with the same checks an ordinary use gets. */
function consume(binding: Binding, span: Span, analysis: Analysis): void {
  if (binding.moved !== null) {
    analysis.report(
      "BLOT_LINEAR_CONSUMED_TWICE",
      `\`${binding.pattern.name}\` is ${
        binding.qualifier === "affine" ? "at-most-once" : "linear"
      } and was already consumed.`,
      span,
    );
    return;
  }
  binding.moved = span;
}

/**
 * A linear closure put somewhere blot cannot follow.
 *
 * Binding it to a name works — the binding becomes linear and is checked. So
 * does calling it immediately. Storing it in a shape or an array would make
 * that structure linear, and blot does not track linear structures yet, so it
 * says so rather than losing the obligation quietly.
 */
function escapes(span: Span, analysis: Analysis): void {
  analysis.report(
    "BLOT_LINEAR_CLOSURE_ESCAPES",
    "This closure captured a linear value, so it is linear itself. blot does not yet track a structure that owns one — bind it to a name or call it here.",
    span,
  );
}

/** Branches must agree about what they consumed. */
function agree(
  outcomes: readonly Map<Binding, Span | null>[],
  before: Map<Binding, Span | null>,
  span: Span,
  analysis: Analysis,
): void {
  if (outcomes.length === 0) return;
  const merged = new Map<Binding, Span | null>();

  for (const [binding] of before) {
    const consumed = outcomes.map((outcome) => outcome.get(binding) ?? null);
    const some = consumed.some((moved) => moved !== null);
    const every = consumed.every((moved) => moved !== null);
    // Affine branches need not agree: spending on one path and not another is
    // still at most once.
    if (some && !every && binding.qualifier === "linear") {
      analysis.report(
        "BLOT_LINEAR_BRANCH_DISAGREEMENT",
        `\`${binding.pattern.name}\` is linear and is consumed on some branches but not others.`,
        span,
      );
    }
    merged.set(
      binding,
      some ? consumed.find((moved) => moved !== null) ?? null : null,
    );
  }

  restore(merged);
}
