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
  /** Obligations carried inside this value, including inside aggregates. */
  readonly owned: Produced;
  /** The ownership contract of this function's parameter, when statically known. */
  parameter: Qualifier | null;
  /** Parameter structure substituted when a function returns caller ownership. */
  parameterPattern: Pattern | null;
  /** Obligations returned by one call, when this binding is a known function. */
  result: Produced;
  /** Source value retained for handler and usage-summary specialization. */
  value: Expr | null;
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
  readonly functionResults = new Map<Expr, Produced>();

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
  const result = walk(module.result, scope, analysis, "move");
  if (obligation(result) !== "none") {
    analysis.report(
      "BLOT_LINEAR_RESULT_ESCAPES",
      "The module result still owns a resource, but the module boundary has no ownership contract. Consume it before returning.",
      module.result.span,
    );
  }
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
  declareProduced(pattern, NONE, scope, analysis, false);
}

function declareProduced(
  pattern: Pattern,
  produced: Produced,
  scope: Scope,
  analysis: Analysis,
  parameter: boolean,
): void {
  switch (pattern.tag) {
    case "name": {
      let source: NamePattern | null = null;
      if (parameter) source = pattern;
      const written = writtenObligation(
        pattern.qualifier,
        source,
      );
      let owned = produced;
      if (obligation(owned) === "none") owned = written;
      scope.bindings.set(pattern.name, {
        pattern,
        qualifier: inherited(pattern.qualifier, owned),
        owned,
        parameter: null,
        parameterPattern: null,
        result: NONE,
        value: null,
        moved: null,
        borrows: 0,
        lastUse: null,
      });
      return;
    }
    case "pin":
      use(pattern.name, pattern.span, scope, analysis, "project");
      return;
    case "tuple":
    case "array": {
      let elements: readonly Produced[] = [];
      if (produced.tag === "sequence") elements = produced.elements;
      for (const [index, inner] of pattern.elements.entries()) {
        let element = NONE;
        if (elements[index] !== undefined) element = elements[index];
        declareProduced(inner, element, scope, analysis, parameter);
      }
      reportDiscardedPattern(
        pattern,
        joinProduced(elements.slice(pattern.elements.length)),
        analysis,
      );
      return;
    }
    case "constructor":
      if (pattern.payload !== null) {
        let payload = NONE;
        if (produced.tag === "variant") payload = produced.payload;
        declareProduced(pattern.payload, payload, scope, analysis, parameter);
      } else if (produced.tag === "variant") {
        reportDiscardedPattern(pattern, produced.payload, analysis);
      }
      return;
    case "shape": {
      let fields: ReadonlyMap<string, Produced> = new Map();
      if (produced.tag === "shape") fields = produced.fields;
      for (const field of pattern.fields) {
        let fieldValue = NONE;
        const found = fields.get(field.name);
        if (found !== undefined) fieldValue = found;
        declareProduced(
          field.pattern,
          fieldValue,
          scope,
          analysis,
          parameter,
        );
      }
      const named = new Set(pattern.fields.map((field) => field.name));
      reportDiscardedPattern(
        pattern,
        joinProduced(
          [...fields]
            .filter(([name]) => !named.has(name))
            .map(([, value]) => value),
        ),
        analysis,
      );
      return;
    }
    default:
      return;
  }
}

function reportDiscardedPattern(
  pattern: Pattern,
  produced: Produced,
  analysis: Analysis,
): void {
  if (obligation(produced) !== "linear") return;
  analysis.report(
    "BLOT_LINEAR_PATTERN_DISCARDS",
    "This pattern discards part of a linear value. Bind every linear component and consume it exactly once.",
    pattern.span,
  );
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
): Produced {
  const found = analysis.lookup(scope, name);
  if (found === null) return NONE;
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
    return NONE;
  }

  if (!spendable(binding.qualifier) || kind === "borrow") {
    binding.borrows += 1;
    return NONE;
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
      owned: binding.owned,
      parameter: binding.parameter,
      parameterPattern: binding.parameterPattern,
      result: binding.result,
      value: binding.value,
      moved: null,
      borrows: 0,
      lastUse: null,
    });
    return use(name, span, scope, analysis, kind);
  }

  consume(binding, span, analysis);
  return binding.owned;
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
      if (
        obligation(walk(declaration.value, scope, analysis, "move")) !== "none"
      ) {
        escapes(declaration.span, analysis);
      }
      continue;
    }
    if (declaration.tag === "shadow") {
      if (
        obligation(walk(declaration.value, scope, analysis, "move")) !== "none"
      ) {
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
    declareProduced(declaration.pattern, produced, scope, analysis, false);
    if (declaration.pattern.tag === "name") {
      const binding = scope.bindings.get(declaration.pattern.name);
      if (binding !== undefined) {
        const contract = functionContract(
          declaration.value,
          produced,
          scope,
          analysis,
        );
        binding.parameter = contract.parameter;
        binding.parameterPattern = contract.pattern;
        binding.result = contract.result;
        binding.value = declaration.value;
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
  const carried = obligation(produced);
  if (written === "linear" || carried === "linear") return "linear";
  if (written === "affine" || carried === "affine") return "affine";
  return written;
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
    const binding = scope.bindings.get(member.name);
    if (binding !== undefined) {
      const result = analysis.functionResults.get(member.lambda);
      if (result === undefined) binding.result = NONE;
      else binding.result = result;
    }
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
      owned: writtenObligation(settled[index], null),
      parameter: patternQualifier(member.lambda.parameter),
      parameterPattern: member.lambda.parameter,
      result: NONE,
      value: member.declaration.value,
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
type Produced =
  | { readonly tag: "none" }
  | {
    readonly tag: "leaf";
    readonly qualifier: "affine" | "linear";
    readonly source: NamePattern | null;
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
  | { readonly tag: "variant"; readonly payload: Produced };

const NONE: Produced = { tag: "none" };

function writtenObligation(
  qualifier: Qualifier,
  source: NamePattern | null,
): Produced {
  if (qualifier === "linear" || qualifier === "affine") {
    return { tag: "leaf", qualifier, source };
  }
  return NONE;
}

function obligation(produced: Produced): "none" | "affine" | "linear" {
  if (produced.tag === "none") return "none";
  if (produced.tag === "leaf") return produced.qualifier;
  if (produced.tag === "closure") return obligation(produced.captures);
  if (produced.tag === "variant") return obligation(produced.payload);
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

function combine(left: Produced, right: Produced): Produced {
  const leftQualifier = obligation(left);
  const rightQualifier = obligation(right);
  if (leftQualifier === "none") return right;
  if (rightQualifier === "none") return left;
  const values: Produced[] = [];
  if (left.tag === "many") values.push(...left.values);
  else values.push(left);
  if (right.tag === "many") values.push(...right.values);
  else values.push(right);
  return { tag: "many", values };
}

function joinProduced(values: readonly Produced[]): Produced {
  let result: Produced = NONE;
  for (const value of values) result = combine(result, value);
  return result;
}

function joinAlternatives(values: readonly Produced[]): Produced {
  if (values.length === 0) return NONE;
  if (values.every((value) => value.tag === "none")) return NONE;
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

function sameParameterUse(left: Pattern, right: Pattern): boolean {
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

function renameParameters(
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

function renameParameter(
  produced: Produced,
  from: NamePattern | null,
  to: NamePattern | null,
): Produced {
  if (from === null || to === null || from === to) return produced;
  if (produced.tag === "none") return produced;
  if (produced.tag === "leaf") {
    if (produced.source !== from) return produced;
    return { ...produced, source: to };
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
  return {
    tag: "variant",
    payload: renameParameter(produced.payload, from, to),
  };
}

function patternQualifier(pattern: Pattern): Qualifier | null {
  if (pattern.tag !== "name") return null;
  return pattern.qualifier;
}

function namePattern(pattern: Pattern): NamePattern | null {
  if (pattern.tag !== "name") return null;
  return pattern;
}

interface FunctionContract {
  readonly parameter: Qualifier | null;
  readonly pattern: Pattern | null;
  readonly result: Produced;
}

const NO_FUNCTION_CONTRACT: FunctionContract = {
  parameter: null,
  pattern: null,
  result: NONE,
};

function functionContract(
  expr: Expr,
  produced: Produced,
  scope: Scope,
  analysis: Analysis,
): FunctionContract {
  if (produced.tag === "closure") {
    return {
      parameter: patternQualifier(produced.parameter),
      pattern: produced.parameter,
      result: produced.result,
    };
  }
  if (expr.tag === "lambda") {
    const result = analysis.functionResults.get(expr);
    let knownResult = NONE;
    if (result !== undefined) knownResult = result;
    return {
      parameter: patternQualifier(expr.parameter),
      pattern: expr.parameter,
      result: knownResult,
    };
  }
  if (expr.tag === "rec" && expr.lambda.tag === "lambda") {
    const result = analysis.functionResults.get(expr.lambda);
    let knownResult = NONE;
    if (result !== undefined) knownResult = result;
    return {
      parameter: patternQualifier(expr.lambda.parameter),
      pattern: expr.lambda.parameter,
      result: knownResult,
    };
  }
  if (expr.tag !== "var") return NO_FUNCTION_CONTRACT;
  const binding = analysisBinding(scope, expr.name);
  if (binding === null) return NO_FUNCTION_CONTRACT;
  return {
    parameter: binding.parameter,
    pattern: binding.parameterPattern,
    result: binding.result,
  };
}

function substituteParameter(
  produced: Produced,
  parameter: Pattern | null,
  argument: Produced,
): Produced {
  if (parameter === null || produced.tag === "none") return produced;
  if (parameter.tag !== "name") return produced;
  if (produced.tag === "leaf") {
    if (produced.source === parameter) return argument;
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
  return {
    tag: "variant",
    payload: substituteParameter(produced.payload, parameter, argument),
  };
}

function substituteParameters(
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

function parameterAcceptsOwnership(
  parameter: Pattern | null,
  argument: Produced,
): boolean {
  const ownership = obligation(argument);
  if (ownership === "none") return true;
  if (parameter === null) return false;
  if (parameter.tag === "name") {
    if (parameter.qualifier === "linear") return true;
    return parameter.qualifier === "affine" && ownership === "affine";
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

function trustedScalarOperation(
  expr: Expr,
  argument: Produced,
  scope: Scope,
): boolean {
  const application = applicationSpine(expr);
  if (application.callee.tag === "intrinsic") return true;
  if (application.callee.tag !== "field") return false;
  if (application.callee.target.tag !== "var") return false;
  const namespace = application.callee.target.name;
  if (namespace !== "Num" && namespace !== "Array") return false;
  if (analysisBinding(scope, namespace) !== null) return false;
  if (argument.tag === "leaf") return true;
  if (argument.tag !== "sequence") return false;
  return argument.elements.every((element) =>
    element.tag === "none" || element.tag === "leaf"
  );
}

function analysisBinding(scope: Scope, name: string): Binding | null {
  let current: Scope | null = scope;
  while (current !== null) {
    const binding = current.bindings.get(name);
    if (binding !== undefined) return binding;
    current = current.parent;
  }
  return null;
}

function staticExpression(expr: Expr, scope: Scope): Expr {
  if (expr.tag !== "var") return expr;
  const binding = analysisBinding(scope, expr.name);
  if (binding === null || binding.value === null) return expr;
  return binding.value;
}

interface ApplicationSpine {
  readonly callee: Expr;
  readonly args: readonly Expr[];
}

function applicationSpine(expr: Expr): ApplicationSpine {
  const args: Expr[] = [];
  let callee = expr;
  while (callee.tag === "apply") {
    args.unshift(callee.arg);
    callee = callee.fn;
  }
  return { callee, args };
}

function handleArguments(
  args: readonly Expr[],
): readonly [Expr, Expr, Expr] | null {
  if (args.length === 3) return [args[0], args[1], args[2]];
  if (
    args.length === 1 && args[0].tag === "tuple" &&
    args[0].elements.length === 3
  ) {
    return [args[0].elements[0], args[0].elements[1], args[0].elements[2]];
  }
  return null;
}

function requireContinuationOwnership(
  handler: Expr,
  computation: "none" | "affine" | "linear",
  analysis: Analysis,
): void {
  if (computation !== "linear") return;
  if (handler.tag !== "shape") {
    analysis.report(
      "BLOT_LINEAR_HANDLER_UNKNOWN",
      "This handled computation owns a linear resource, so its handler clauses must be statically known and resume exactly once.",
      handler.span,
    );
    return;
  }
  for (const member of handler.members) {
    if (member.tag !== "field" || member.name === "return") continue;
    const clause = member.value;
    let resume: Pattern | null = null;
    if (clause.tag === "lambda" && clause.parameter.tag === "tuple") {
      if (clause.parameter.elements[1] !== undefined) {
        resume = clause.parameter.elements[1];
      }
    }
    if (
      resume !== null && resume.tag === "name" &&
      resume.qualifier === "linear"
    ) continue;
    analysis.report(
      "BLOT_LINEAR_HANDLER_MAY_ABORT",
      `Handler clause \`.${member.name}\` may abort a continuation that owns a linear resource. Bind it as \`!resume\` and resume exactly once.`,
      clause.span,
    );
  }
}

function walk(
  expr: Expr,
  scope: Scope,
  analysis: Analysis,
  kind: Use,
): Produced {
  switch (expr.tag) {
    case "var":
      return use(expr.name, expr.span, scope, analysis, kind);

    case "apply": {
      // `&x` and `!x` reach here as prefix-operator applications, and they are
      // the two places the intent is written down rather than inferred.
      if (expr.fn.tag === "intrinsic" && expr.fn.name === "@linear.borrow") {
        walk(expr.arg, scope, analysis, "borrow");
        return NONE;
      }
      if (expr.fn.tag === "intrinsic" && expr.fn.name === "@linear.own") {
        return walk(expr.arg, scope, analysis, "move");
      }
      if (expr.fn.tag === "tag") {
        return {
          tag: "variant",
          payload: walk(expr.arg, scope, analysis, "move"),
        };
      }

      const application = applicationSpine(expr);
      if (
        application.callee.tag === "intrinsic" &&
        application.callee.name === "@handle"
      ) {
        const arguments_ = handleArguments(application.args);
        if (arguments_ !== null) {
          walk(arguments_[0], scope, analysis, "move");
          const computation = walk(arguments_[1], scope, analysis, "move");
          requireContinuationOwnership(
            staticExpression(arguments_[2], scope),
            obligation(computation),
            analysis,
          );
          const handler = walk(arguments_[2], scope, analysis, "move");
          if (obligation(handler) !== "none") {
            analysis.report(
              "BLOT_LINEAR_HANDLER_CAPTURE",
              "A handler clause captures an owned value. Its operation may run zero or many times, so move that resource through the handled computation instead.",
              arguments_[2].span,
            );
          }
          return NONE;
        }
      }

      if (application.callee.tag === "intrinsic") {
        const name = application.callee.name;
        if (name === "@array.get" && application.args.length === 2) {
          const array = walk(application.args[0], scope, analysis, "project");
          walk(application.args[1], scope, analysis, "move");
          if (
            array.tag === "sequence" && obligation(array) !== "none"
          ) {
            analysis.report(
              "BLOT_LINEAR_ARRAY_READ",
              "Reading an array element would copy an owned value. Destructure the array to consume its elements, or borrow an element through a borrowing operation.",
              expr.span,
            );
          }
          return NONE;
        }
        if (name === "@array.set" && application.args.length === 3) {
          const array = walk(application.args[0], scope, analysis, "move");
          walk(application.args[1], scope, analysis, "move");
          const value = walk(application.args[2], scope, analysis, "move");
          if (
            array.tag === "sequence" && obligation(array) !== "none"
          ) {
            analysis.report(
              "BLOT_LINEAR_ARRAY_REPLACE",
              "Replacing an element in an owned array could discard the previous obligation. Destructure it before replacing an owned element.",
              expr.span,
            );
          }
          return combine(array, value);
        }
        if (name === "@array.push" && application.args.length === 2) {
          const array = walk(application.args[0], scope, analysis, "move");
          const value = walk(application.args[1], scope, analysis, "move");
          if (array.tag === "sequence") {
            return {
              tag: "sequence",
              elements: [...array.elements, value],
            };
          }
          if (obligation(value) !== "none") {
            analysis.report(
              "BLOT_LINEAR_ARRAY_PUSH_UNKNOWN",
              "Appending an owned value to an array of unknown length would lose its consuming position. Build or split an array whose elements the ownership checker can account for.",
              expr.span,
            );
          }
          return combine(array, value);
        }
      }

      // Applying a linear closure right where it was built discharges it: the
      // one call it owed is this one.
      const callee = walk(expr.fn, scope, analysis, "project");
      // An argument is moved into the call unless it was explicitly borrowed.
      const argument = walk(expr.arg, scope, analysis, "move");
      const argumentOwnership = obligation(argument);
      const contract = functionContract(expr.fn, callee, scope, analysis);
      if (argumentOwnership !== "none") {
        const accepted = parameterAcceptsOwnership(
          contract.pattern,
          argument,
        ) || trustedScalarOperation(expr.fn, argument, scope);
        if (!accepted) {
          analysis.report(
            "BLOT_LINEAR_ARGUMENT_NOT_OWNED",
            "This argument owns a resource, but the called function does not promise to consume its parameter exactly once. Bind that parameter with `!`, or pass a borrow instead.",
            expr.arg.span,
          );
        }
      }
      return substituteParameters(
        contract.result,
        contract.pattern,
        argument,
      );
    }

    case "field": {
      const target = walk(expr.target, scope, analysis, "project");
      if (target.tag !== "shape") return target;
      let selected = NONE;
      const found = target.fields.get(expr.name);
      if (found !== undefined) selected = found;
      const remaining = [...target.fields]
        .filter(([name]) => name !== expr.name)
        .map(([, value]) => value);
      if (obligation(joinProduced(remaining)) === "linear") {
        analysis.report(
          "BLOT_LINEAR_PARTIAL_MOVE",
          `Projecting \`.${expr.name}\` would discard another owned field. Destructure the record so every owned field is consumed.`,
          expr.span,
        );
      }
      return selected;
    }

    case "lambda": {
      const inner = childScope(scope, true);
      declareProduced(expr.parameter, NONE, inner, analysis, true);
      const result = walk(expr.body, inner, analysis, "move");
      analysis.functionResults.set(expr, result);
      closeScope(inner, analysis);
      // Each captured value is spent once, here, into the closure. What the
      // closure owes from now on is one call.
      let produced: Produced = NONE;
      for (const captured of inner.captures) {
        consume(captured, expr.span, analysis);
        produced = combine(produced, captured.owned);
      }
      const qualifier = obligation(produced);
      if (qualifier !== "none") {
        return {
          tag: "closure",
          captures: produced,
          parameter: expr.parameter,
          result,
        };
      }
      return produced;
    }

    case "rec":
      return walk(expr.lambda, scope, analysis, kind);

    case "comptime":
      return walk(expr.body, scope, analysis, kind);

    case "tuple":
      return {
        tag: "sequence",
        elements: expr.elements.map((element) =>
          walk(element, scope, analysis, "move")
        ),
      };

    case "array": {
      const elements = expr.elements.map((element) =>
        walk(element.value, scope, analysis, "move")
      );
      const result: Produced = {
        tag: "sequence",
        elements,
      };
      if (
        expr.elements.some((element) => element.spread) &&
        obligation(result) !== "none"
      ) {
        analysis.report(
          "BLOT_LINEAR_ARRAY_SPREAD",
          "An array spread makes owned element positions unknown. Split the owned input explicitly before constructing the result.",
          expr.span,
        );
      }
      return result;
    }

    case "shape": {
      const fields = new Map<string, Produced>();
      let spread: Produced = NONE;
      for (const member of expr.members) {
        const produced = walk(member.value, scope, analysis, "move");
        if (member.tag === "field") fields.set(member.name, produced);
        else spread = combine(spread, produced);
      }
      const result: Produced = { tag: "shape", fields };
      if (
        expr.members.some((member) => member.tag === "spread") &&
        obligation(combine(spread, result)) !== "none"
      ) {
        analysis.report(
          "BLOT_LINEAR_SHAPE_SPREAD",
          "A record spread makes owned field provenance ambiguous. Destructure the owned input and construct every owned field explicitly.",
          expr.span,
        );
      }
      if (obligation(spread) !== "none") return combine(spread, result);
      return result;
    }

    case "if": {
      // Every branch starts from the same state and must end in the same one:
      // a value consumed on one path and not another is consumed neither
      // exactly once nor never.
      const before = snapshot(scope);
      const outcomes: Map<Binding, Span | null>[] = [];
      const produced: Produced[] = [];
      for (const branch of expr.branches) {
        walk(branch.condition, scope, analysis, "project");
      }
      for (const branch of expr.branches) {
        restore(before);
        produced.push(walk(branch.consequence, scope, analysis, kind));
        outcomes.push(snapshot(scope));
      }
      if (expr.fallback !== null) {
        restore(before);
        produced.push(walk(expr.fallback, scope, analysis, kind));
        outcomes.push(snapshot(scope));
      }
      agree(outcomes, before, expr.span, analysis);
      return joinAlternatives(produced);
    }

    case "case": {
      const target = walk(expr.target, scope, analysis, "project");
      const before = snapshot(scope);
      const outcomes: Map<Binding, Span | null>[] = [];
      const produced: Produced[] = [];
      for (const arm of expr.arms) {
        restore(before);
        const inner = childScope(scope);
        declareProduced(arm.pattern, target, inner, analysis, false);
        produced.push(walk(arm.body, inner, analysis, kind));
        closeScope(inner, analysis);
        outcomes.push(snapshot(scope));
      }
      agree(outcomes, before, expr.span, analysis);
      return joinAlternatives(produced);
    }

    case "block": {
      const inner = childScope(scope);
      walkDeclarations(expr.declarations, expr.result, inner, analysis);
      const result = walk(expr.result, inner, analysis, kind);
      closeScope(inner, analysis);
      return result;
    }

    default:
      return NONE;
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

/** An owned value entered a declaration form that cannot bind its obligation. */
function escapes(span: Span, analysis: Analysis): void {
  analysis.report(
    "BLOT_LINEAR_CLOSURE_ESCAPES",
    "This declaration form cannot retain an owned runtime value. Bind it with a pattern that carries the obligation, or consume it before this boundary.",
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
