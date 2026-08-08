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
import { freeNames, liveDeclarations } from "../syntax/live.ts";
import { recursiveGroups } from "../syntax/ast.ts";
import type { Diagnostic } from "../diagnostic.ts";
import type { Produced } from "./produced.ts";
import {
  analysisBinding,
  borrowed,
  combine,
  containsBorrow,
  functionContract,
  joinAlternatives,
  joinProduced,
  NONE,
  obligation,
  ownershipLeaves,
  ownershipTransparent,
  parameterAcceptsBorrow,
  parameterAcceptsOwnership,
  parameterOwnership,
  patternQualifier,
  relevant,
  sameProduced,
  structuralLineage,
  substituteParameters,
  writtenObligation,
} from "./produced.ts";

/** The only pattern that introduces a binding, and therefore the fact key. */
export type NamePattern = Extract<Pattern, { readonly tag: "name" }>;

export interface Binding {
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
  owned: Produced;
  /** A child path has moved while the whole value remains unavailable. */
  partial: boolean;
  /** The ownership contract of this function's parameter, when statically known. */
  parameter: Qualifier | null;
  /** Symbolic ownership positions the parameter contract consumes. */
  parameterInput: Produced;
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

export interface Scope {
  readonly bindings: Map<string, Binding>;
  readonly parent: Scope | null;
  /** A lambda body. Linear values reached from outside it are captured. */
  readonly lambda: boolean;
  /** Outer linear bindings this lambda captured, if it is one. */
  readonly captures: Set<Binding>;
  /** Outer bindings this lambda reaches only through a borrowed view. */
  readonly borrowedCaptures: Set<Binding>;
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
  /** Every source occurrence that consumes the binding on some checked path. */
  readonly consumptions: ReadonlyMap<NamePattern, readonly Span[]>;
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
  /** Structural paths by which an owning binding received earlier obligations. */
  readonly lineage: ReadonlyMap<NamePattern, readonly OwnershipLineage[]>;
}

export type OwnershipPathSegment =
  | { readonly tag: "field"; readonly name: string }
  | { readonly tag: "element"; readonly index: number };

export type OwnershipTargetPathSegment =
  | OwnershipPathSegment
  | { readonly tag: "case"; readonly name: string }
  | { readonly tag: "member"; readonly index: number };

export interface OwnershipExtraction {
  readonly operation: "@array.take" | "@array.split";
  readonly part: number;
  readonly span: Span;
}

export interface OwnershipLineage {
  readonly source: NamePattern;
  readonly sourcePath: readonly OwnershipPathSegment[];
  readonly targetPath: readonly OwnershipTargetPathSegment[];
  readonly extractions: readonly OwnershipExtraction[];
}

export interface LinearResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly ownership: Ownership;
}

export class Analysis {
  readonly diagnostics: Diagnostic[] = [];
  readonly lastUses = new Map<NamePattern, Span>();
  readonly linear = new Set<NamePattern>();
  readonly consumptions = new Map<NamePattern, Span[]>();
  /** Where each binding was read, by the offset the read started at. */
  readonly reads = new Map<NamePattern, Set<number>>();
  /** The bindings some closure reached from outside its own body. */
  readonly crossed = new Set<NamePattern>();
  readonly lineage = new Map<NamePattern, readonly OwnershipLineage[]>();
  readonly functionResults = new Map<Expr, Produced>();
  /** Certified recursive callees and the captures transferred by their call. */
  readonly recursiveTransfers = new Map<NamePattern, readonly string[]>();
  /** One closure in a recursive SCC takes ownership of each shared capture. */
  readonly recursiveCaptureClaims = new Set<NamePattern>();
  /** A certified SCC is one owned knot; calling an entry consumes the knot. */
  readonly recursiveGroupBindings = new Map<NamePattern, readonly Binding[]>();
  /** Usage summaries inferred for unannotated, ownership-transparent lambdas. */
  readonly inferredParameters = new Map<Pattern, Qualifier>();
  /** Path-sensitive parameter ownership inferred beside the qualifier. */
  readonly inferredParameterInputs = new Map<Pattern, Produced>();

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
  return {
    bindings: new Map(),
    parent,
    lambda,
    captures: new Set(),
    borrowedCaptures: new Set(),
  };
}

/** A snapshot of which linear bindings are consumed, for comparing branches. */
interface BindingState {
  readonly moved: Span | null;
  readonly owned: Produced;
  readonly partial: boolean;
}

function snapshot(scope: Scope): Map<Binding, BindingState> {
  const state = new Map<Binding, BindingState>();
  let current: Scope | null = scope;
  while (current !== null) {
    for (const binding of current.bindings.values()) {
      if (spendable(binding.qualifier)) {
        state.set(binding, {
          moved: binding.moved,
          owned: binding.owned,
          partial: binding.partial,
        });
      }
    }
    current = current.parent;
  }
  return state;
}

function restore(state: Map<Binding, BindingState>): void {
  for (const [binding, value] of state) {
    binding.moved = value.moved;
    binding.owned = value.owned;
    binding.partial = value.partial;
  }
}

export function checkLinearity(module: Module): LinearResult {
  const analysis = new Analysis();
  const scope = childScope(null);

  if (module.parameter !== null) {
    declare(module.parameter, scope, analysis);
  }
  walkDeclarations(module.declarations, module.result, scope, analysis);
  const result = walk(module.result, scope, analysis, "move");
  if (containsBorrow(result)) {
    analysis.report(
      "BLOT_BORROW_RESULT_ESCAPES",
      "The module result contains a borrowed view. A borrow is valid only for an immediate borrowing call or projection and cannot cross the module boundary.",
      module.result.span,
    );
  }
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
      consumptions: analysis.consumptions,
      reentrant,
      lineage: analysis.lineage,
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
        pattern,
      );
      let owned = produced;
      if (!relevant(owned)) owned = written;
      const lineage = structuralLineage(pattern, owned);
      if (lineage.length > 0) analysis.lineage.set(pattern, lineage);
      scope.bindings.set(pattern.name, {
        pattern,
        qualifier: inherited(pattern.qualifier, owned),
        owned,
        partial: false,
        parameter: null,
        parameterInput: NONE,
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
        if (produced.tag === "choice") {
          const selected = produced.cases.get(pattern.name);
          if (selected !== undefined) payload = selected;
        }
        declareProduced(pattern.payload, payload, scope, analysis, parameter);
      } else if (produced.tag === "variant") {
        reportDiscardedPattern(pattern, produced.payload, analysis);
      } else if (produced.tag === "choice") {
        const selected = produced.cases.get(pattern.name);
        if (selected !== undefined) {
          reportDiscardedPattern(pattern, selected, analysis);
        }
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

  const recursiveTransfer = analysis.recursiveTransfers.get(binding.pattern);
  if (recursiveTransfer !== undefined) {
    for (const capture of recursiveTransfer) {
      use(capture, span, scope, analysis, "move");
    }
    return binding.owned;
  }

  const recursiveGroup = analysis.recursiveGroupBindings.get(binding.pattern);
  if (recursiveGroup !== undefined) {
    for (const member of recursiveGroup) consume(member, span, analysis);
    return binding.owned;
  }

  if (binding.qualifier === "borrow" && kind === "move") {
    analysis.report(
      "BLOT_BORROW_MOVED",
      `\`${name}\` is borrowed and cannot be moved. A borrowing function is one its caller can still use afterwards.`,
      span,
    );
    return NONE;
  }

  if (
    capturedBy !== null && (binding.qualifier === "borrow" || kind === "borrow")
  ) {
    capturedBy.borrowedCaptures.add(binding);
    capturedBy.bindings.set(name, {
      pattern: binding.pattern,
      qualifier: "borrow",
      owned: binding.owned,
      partial: binding.partial,
      parameter: binding.parameter,
      parameterInput: binding.parameterInput,
      parameterPattern: binding.parameterPattern,
      result: binding.result,
      value: binding.value,
      moved: null,
      borrows: 0,
      lastUse: null,
    });
    return use(name, span, scope, analysis, kind);
  }

  if (kind === "borrow" || binding.qualifier === "borrow") {
    binding.borrows += 1;
    return borrowed(binding.owned);
  }

  if (!spendable(binding.qualifier)) {
    binding.borrows += 1;
    return NONE;
  }

  if (binding.partial) {
    analysis.report(
      "BLOT_LINEAR_PARTIAL_REUSE",
      `\`${name}\` has a moved field and cannot be used as a whole value. Move or borrow only fields that remain live.`,
      span,
    );
    consume(binding, span, analysis);
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
      partial: binding.partial,
      parameter: binding.parameter,
      parameterInput: binding.parameterInput,
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
      const produced = walk(declaration.value, scope, analysis, "move");
      if (containsBorrow(produced)) {
        analysis.report(
          "BLOT_BORROW_STORED",
          "An `open` declaration cannot retain a borrowed view.",
          declaration.span,
        );
      }
      if (obligation(produced) !== "none") {
        escapes(declaration.span, analysis);
      }
      continue;
    }
    if (declaration.tag === "shadow") {
      const produced = walk(declaration.value, scope, analysis, "move");
      if (containsBorrow(produced)) {
        analysis.report(
          "BLOT_BORROW_STORED",
          "A stable rebinding cannot retain a borrowed view.",
          declaration.span,
        );
      }
      if (obligation(produced) !== "none") {
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
    if (containsBorrow(produced)) {
      analysis.report(
        "BLOT_BORROW_STORED",
        "This declaration stores a borrowed view. Pass the borrow directly to a borrowing parameter or project it immediately instead.",
        declaration.span,
      );
    }
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
        binding.parameterInput = contract.input;
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
  if (containsBorrow(produced)) return "borrow";
  return written;
}

function patternBinds(pattern: Pattern): boolean {
  if (pattern.tag === "name") return true;
  if (pattern.tag === "tuple" || pattern.tag === "array") {
    return pattern.elements.some(patternBinds);
  }
  if (pattern.tag === "constructor") {
    if (pattern.payload === null) return false;
    return patternBinds(pattern.payload);
  }
  if (pattern.tag === "shape") {
    return pattern.fields.some((field) => patternBinds(field.pattern));
  }
  return false;
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

  const recursiveMembers = recursiveCycleNames(members);
  const recursiveCaptures = certifiedRecursiveCaptures(
    members,
    recursiveMembers,
    scope,
  );
  if (recursiveCaptures === null) {
    analysis.report(
      "BLOT_RECURSIVE_OWNERSHIP_UNPROVED",
      `Recursive group \`${
        members.map((member) => member.name).join("`, `")
      }\` captures a spendable value but does not transfer it through exactly one ownership-tail recursive call on each recursive path.`,
      members[0].lambda.span,
    );
  }

  declareGroup(members, settled, scope, analysis);
  if (recursiveCaptures !== null && recursiveCaptures.length > 0) {
    const bindings = members.filter((member) =>
      recursiveMembers.has(member.name)
    ).map((member) => {
      const binding = scope.bindings.get(member.name);
      if (binding === undefined) {
        throw new Error(`recursive group omitted binding \`${member.name}\``);
      }
      return binding;
    });
    for (const member of members) {
      if (!recursiveMembers.has(member.name)) continue;
      analysis.recursiveTransfers.set(member.pattern, recursiveCaptures);
      analysis.recursiveGroupBindings.set(member.pattern, bindings);
    }
  }
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
  for (const member of members) {
    analysis.recursiveTransfers.delete(member.pattern);
  }
}

/**
 * The first recursive ownership proof is intentionally narrow: a recursive
 * edge must be in ownership-tail position, and every reference to an SCC
 * member must be such an edge. The ordinary branch checker then proves that a
 * base path consumes each linear capture while an edge transfers it.
 */
function certifiedRecursiveCaptures(
  members: readonly RecursiveMember[],
  recursiveMembers: ReadonlySet<string>,
  scope: Scope,
): readonly string[] | null {
  if (recursiveMembers.size === 0) return [];
  const captures = new Set<string>();
  for (const member of members) {
    if (!recursiveMembers.has(member.name)) continue;
    for (const name of freeNames(member.lambda)) {
      if (recursiveMembers.has(name)) continue;
      const binding = analysisBinding(scope, name);
      if (binding !== null && spendable(binding.qualifier)) captures.add(name);
    }
  }
  if (captures.size === 0) return [];
  for (const member of members) {
    if (!recursiveMembers.has(member.name)) continue;
    if (
      !recursiveCallsAreOwnershipTail(
        member.lambda.body,
        recursiveMembers,
        true,
      )
    ) {
      return null;
    }
  }
  return [...captures];
}

function recursiveCycleNames(
  members: readonly RecursiveMember[],
): ReadonlySet<string> {
  const names = new Set(members.map((member) => member.name));
  const edges = new Map<string, readonly string[]>();
  for (const member of members) {
    edges.set(
      member.name,
      [...freeNames(member.lambda)].filter((name) => names.has(name)),
    );
  }
  const recursive = new Set<string>();
  for (const member of members) {
    const pending = [...(edges.get(member.name) ?? [])];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const next = pending.pop();
      if (next === undefined || visited.has(next)) continue;
      if (next === member.name) {
        recursive.add(member.name);
        break;
      }
      visited.add(next);
      pending.push(...(edges.get(next) ?? []));
    }
  }
  return recursive;
}

function recursiveCallsAreOwnershipTail(
  expr: Expr,
  groupNames: ReadonlySet<string>,
  tail: boolean,
): boolean {
  if (expr.tag === "var") return !groupNames.has(expr.name);
  if (
    expr.tag === "int" || expr.tag === "float" || expr.tag === "text" ||
    expr.tag === "unit" || expr.tag === "intrinsic" || expr.tag === "tag"
  ) return true;
  if (expr.tag === "apply") {
    const application = appliedExpression(expr);
    if (
      application.callee.tag === "var" &&
      groupNames.has(application.callee.name)
    ) {
      if (!tail) return false;
      return application.args.every((argument) =>
        recursiveCallsAreOwnershipTail(argument, groupNames, false)
      );
    }
    return recursiveCallsAreOwnershipTail(expr.fn, groupNames, false) &&
      recursiveCallsAreOwnershipTail(expr.arg, groupNames, false);
  }
  if (expr.tag === "field") {
    return recursiveCallsAreOwnershipTail(expr.target, groupNames, false);
  }
  if (expr.tag === "lambda") {
    return recursiveCallsAreOwnershipTail(expr.body, groupNames, false);
  }
  if (expr.tag === "rec") {
    return recursiveCallsAreOwnershipTail(expr.lambda, groupNames, false);
  }
  if (expr.tag === "comptime") {
    return recursiveCallsAreOwnershipTail(expr.body, groupNames, false);
  }
  if (expr.tag === "tuple") {
    return expr.elements.every((element) =>
      recursiveCallsAreOwnershipTail(element, groupNames, false)
    );
  }
  if (expr.tag === "array") {
    return expr.elements.every((element) =>
      recursiveCallsAreOwnershipTail(element.value, groupNames, false)
    );
  }
  if (expr.tag === "shape") {
    return expr.members.every((member) =>
      recursiveCallsAreOwnershipTail(member.value, groupNames, false)
    );
  }
  if (expr.tag === "if") {
    if (
      !expr.branches.every((branch) =>
        recursiveCallsAreOwnershipTail(branch.condition, groupNames, false) &&
        recursiveCallsAreOwnershipTail(branch.consequence, groupNames, tail)
      )
    ) return false;
    if (expr.fallback === null) return true;
    return recursiveCallsAreOwnershipTail(expr.fallback, groupNames, tail);
  }
  if (expr.tag === "case") {
    return recursiveCallsAreOwnershipTail(expr.target, groupNames, false) &&
      expr.arms.every((arm) =>
        recursiveCallsAreOwnershipTail(arm.body, groupNames, tail)
      );
  }
  for (const declaration of expr.declarations) {
    if (!recursiveCallsAreOwnershipTail(declaration.value, groupNames, false)) {
      return false;
    }
  }
  return recursiveCallsAreOwnershipTail(expr.result, groupNames, tail);
}

function appliedExpression(
  expr: Expr & { readonly tag: "apply" },
): { readonly callee: Expr; readonly args: readonly Expr[] } {
  const args: Expr[] = [];
  let callee: Expr = expr;
  while (callee.tag === "apply") {
    args.unshift(callee.arg);
    callee = callee.fn;
  }
  return { callee, args };
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
    const probe = new Analysis();
    declareGroup(members, settled, scope, probe);
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
  analysis: Analysis,
): void {
  for (const [index, member] of members.entries()) {
    scope.bindings.set(member.name, {
      pattern: member.pattern,
      qualifier: settled[index],
      owned: writtenObligation(settled[index], null, member.pattern),
      parameter: patternQualifier(member.lambda.parameter),
      parameterInput: parameterOwnership(member.lambda.parameter, analysis),
      parameterPattern: member.lambda.parameter,
      result: NONE,
      value: member.declaration.value,
      moved: null,
      partial: false,
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
  readonly borrowedCaptures: readonly Binding[];
  readonly states: readonly (readonly [Binding, BindingState])[];
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
      borrowedCaptures: [...current.borrowedCaptures],
      states: bindings.map(([, binding]) =>
        [binding, {
          moved: binding.moved,
          owned: binding.owned,
          partial: binding.partial,
        }] as const
      ),
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
    entry.scope.borrowedCaptures.clear();
    for (const binding of entry.borrowedCaptures) {
      entry.scope.borrowedCaptures.add(binding);
    }
    for (const [binding, state] of entry.states) {
      binding.moved = state.moved;
      binding.owned = state.owned;
      binding.partial = state.partial;
    }
  }
}

function trustedBorrowOperation(expr: Expr, scope: Scope): boolean {
  const application = applicationSpine(expr);
  if (application.callee.tag === "intrinsic") {
    const name = application.callee.name;
    return name.startsWith("@int.") ||
      name.startsWith("@float.") ||
      name.startsWith("@f32.") ||
      name.startsWith("@f32x4.") ||
      name.startsWith("@text.") ||
      name === "@array.len" ||
      name === "@shape.has";
  }
  if (application.callee.tag !== "field") return false;
  if (application.callee.target.tag !== "var") return false;
  const namespace = application.callee.target.name;
  if (namespace === "Num" || namespace === "Text") {
    return analysisBinding(scope, namespace) === null;
  }
  if (namespace !== "Array" && namespace !== "Arena") return false;
  if (analysisBinding(scope, namespace) !== null) return false;
  return application.callee.name === "get" ||
    application.callee.name === "length";
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
        return walk(expr.arg, scope, analysis, "borrow");
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
          const effect = walk(arguments_[0], scope, analysis, "move");
          const computation = walk(arguments_[1], scope, analysis, "move");
          requireContinuationOwnership(
            staticExpression(arguments_[2], scope),
            obligation(computation),
            analysis,
          );
          const handler = walk(arguments_[2], scope, analysis, "move");
          const handled = [effect, computation, handler];
          for (const [index, produced] of handled.entries()) {
            if (!containsBorrow(produced)) continue;
            analysis.report(
              "BLOT_BORROW_ARGUMENT_ESCAPES",
              "`@handle` cannot retain a borrowed effect, computation, or handler.",
              arguments_[index].span,
            );
          }
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

      const cancelsContinuation = application.callee.tag === "intrinsic" &&
          application.callee.name === "@continuation.cancel" ||
        application.callee.tag === "field" &&
          application.callee.target.tag === "var" &&
          application.callee.target.name === "Continuation" &&
          application.callee.name === "cancel" &&
          analysisBinding(scope, "Continuation") === null;
      if (cancelsContinuation && application.args.length === 1) {
        walk(application.args[0], scope, analysis, "move");
        return NONE;
      }

      if (application.callee.tag === "intrinsic") {
        const name = application.callee.name;
        if (
          (name === "@array.take" || name === "@array.split") &&
          application.args.length === 2
        ) {
          const array = walk(application.args[0], scope, analysis, "move");
          walk(application.args[1], scope, analysis, "move");
          const failure = array;
          if (name === "@array.take") {
            let selected = extractionParts(
              array,
              "@array.take",
              2,
              expr.span,
            );
            if (
              array.tag === "sequence" && application.args[1].tag === "int"
            ) {
              const position = Number(application.args[1].value);
              const found = array.elements[position];
              if (found !== undefined) {
                selected = [
                  found,
                  {
                    tag: "sequence",
                    elements: array.elements.filter((_, index) =>
                      index !== position
                    ),
                  },
                ];
              }
            }
            return {
              tag: "choice",
              cases: new Map([
                ["Taken", { tag: "sequence", elements: selected }],
                ["TakeOutOfBounds", failure],
              ]),
            };
          }
          const separated = extractionParts(
            array,
            "@array.split",
            3,
            expr.span,
          );
          return {
            tag: "choice",
            cases: new Map([
              ["Split", { tag: "sequence", elements: separated }],
              ["SplitOutOfBounds", failure],
            ]),
          };
        }
        if (name === "@array.get" && application.args.length === 2) {
          const array = walk(application.args[0], scope, analysis, "project");
          walk(application.args[1], scope, analysis, "move");
          let contents = array;
          if (contents.tag === "borrow") contents = contents.value;
          if (
            contents.tag === "sequence" && obligation(contents) !== "none"
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
      if (containsBorrow(argument)) {
        const accepted = parameterAcceptsBorrow(
          contract.pattern,
          argument,
        ) || trustedBorrowOperation(expr.fn, scope);
        if (!accepted) {
          analysis.report(
            "BLOT_BORROW_ARGUMENT_ESCAPES",
            "This argument contains a borrowed view, but the called function does not promise to borrow that position. Pass it directly to a parameter marked with `&`.",
            expr.arg.span,
          );
        }
      }
      if (argumentOwnership !== "none") {
        const accepted = parameterAcceptsOwnership(
          contract.pattern,
          argument,
          contract.parameter,
          contract.input,
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
      const projected = projectOwnedPath(expr, scope, analysis, kind);
      if (projected !== null) return projected;
      const target = walk(expr.target, scope, analysis, "project");
      if (target.tag === "borrow") {
        if (target.value.tag !== "shape") return target;
        const field = target.value.fields.get(expr.name);
        if (field === undefined) return borrowed(NONE);
        return borrowed(field);
      }
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
      let parameterOwnership = NONE;
      if (
        expr.parameter.tag === "name" && expr.parameter.qualifier === "none"
      ) {
        const inferred = ownershipTransparent(
          expr.body,
          expr.parameter,
          scope,
          analysis,
        );
        if (inferred !== null) {
          analysis.inferredParameters.set(expr.parameter, "linear");
          analysis.inferredParameterInputs.set(expr.parameter, inferred);
          parameterOwnership = inferred;
        }
      }
      declareProduced(
        expr.parameter,
        parameterOwnership,
        inner,
        analysis,
        true,
      );
      const recursiveCaptures = new Set(
        [...analysis.recursiveTransfers.values()].flatMap((names) => names),
      );
      for (const capture of recursiveCaptures) {
        installRecursiveCapture(capture, inner, analysis);
      }
      const result = walk(expr.body, inner, analysis, "move");
      if (containsBorrow(result)) {
        analysis.report(
          "BLOT_BORROW_RESULT_ESCAPES",
          "This function returns a borrowed view. Consume the view with an immediate read-only operation before returning.",
          expr.body.span,
        );
      }
      analysis.functionResults.set(expr, result);
      closeScope(inner, analysis);
      // Each captured value is spent once, here, into the closure. What the
      // closure owes from now on is one call.
      let produced: Produced = NONE;
      for (const captured of inner.captures) {
        consume(captured, expr.span, analysis);
        produced = combine(produced, captured.owned);
      }
      for (const captured of inner.borrowedCaptures) {
        produced = combine(produced, borrowed(captured.owned));
      }
      if (relevant(produced)) {
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
      const outcomes: Map<Binding, BindingState>[] = [];
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
      const outcomes: Map<Binding, BindingState>[] = [];
      const produced: Produced[] = [];
      for (const arm of expr.arms) {
        restore(before);
        const inner = childScope(scope);
        if (containsBorrow(target) && patternBinds(arm.pattern)) {
          analysis.report(
            "BLOT_BORROW_STORED",
            "This pattern stores part of a borrowed view. Project or inspect the borrow without binding any of its components.",
            arm.pattern.span,
          );
        }
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

function projectOwnedPath(
  expression: Expr & { tag: "field" },
  scope: Scope,
  analysis: Analysis,
  kind: Use,
): Produced | null {
  const path: string[] = [];
  let root: Expr = expression;
  while (root.tag === "field") {
    path.unshift(root.name);
    root = root.target;
  }
  if (root.tag !== "var") return null;
  const found = analysis.lookup(scope, root.name);
  if (found === null || found.capturedBy !== null) return null;
  const binding = found.binding;
  if (!spendable(binding.qualifier) || binding.owned.tag !== "shape") {
    return null;
  }
  if (binding.moved !== null) {
    consume(binding, expression.span, analysis);
    return NONE;
  }

  const projected = removeOwnedPath(binding.owned, path);
  if (projected === null) return null;
  analysis.lastUses.set(binding.pattern, expression.span);
  binding.lastUse = expression.span;
  const reads = analysis.reads.get(binding.pattern);
  if (reads === undefined) {
    analysis.reads.set(binding.pattern, new Set([expression.span.start]));
  } else {
    reads.add(expression.span.start);
  }
  if (kind === "borrow") {
    binding.borrows += 1;
    return borrowed(projected.selected);
  }
  if (!relevant(projected.selected)) return projected.selected;

  binding.owned = projected.remaining;
  binding.partial = true;
  if (!relevant(binding.owned)) consume(binding, expression.span, analysis);
  return projected.selected;
}

interface OwnedProjection {
  readonly selected: Produced;
  readonly remaining: Produced;
}

function removeOwnedPath(
  produced: Produced,
  path: readonly string[],
): OwnedProjection | null {
  if (path.length === 0 || produced.tag !== "shape") return null;
  const selected = produced.fields.get(path[0]);
  if (selected === undefined) return null;
  const fields = new Map(produced.fields);
  if (path.length === 1) {
    fields.set(path[0], NONE);
    return { selected, remaining: { tag: "shape", fields } };
  }
  const nested = removeOwnedPath(selected, path.slice(1));
  if (nested === null) return null;
  fields.set(path[0], nested.remaining);
  return {
    selected: nested.selected,
    remaining: { tag: "shape", fields },
  };
}

function installRecursiveCapture(
  name: string,
  scope: Scope,
  analysis: Analysis,
): void {
  const found = analysis.lookup(scope, name);
  if (found === null || found.capturedBy !== scope) return;
  const binding = found.binding;
  if (!analysis.recursiveCaptureClaims.has(binding.pattern)) {
    analysis.recursiveCaptureClaims.add(binding.pattern);
    scope.captures.add(binding);
  }
  scope.bindings.set(name, {
    pattern: binding.pattern,
    qualifier: binding.qualifier,
    owned: binding.owned,
    parameter: binding.parameter,
    parameterInput: binding.parameterInput,
    parameterPattern: binding.parameterPattern,
    result: binding.result,
    value: binding.value,
    moved: null,
    partial: false,
    borrows: 0,
    lastUse: null,
  });
}

function extractionParts(
  source: Produced,
  operation: OwnershipExtraction["operation"],
  count: number,
  span: Span,
): Produced[] {
  const qualifier = obligation(source);
  if (qualifier === "none") return Array.from({ length: count }, () => NONE);
  const origins = ownershipLeaves(source).flatMap((leaf) => leaf.origins);
  return Array.from({ length: count }, (_, part) => ({
    tag: "leaf" as const,
    qualifier,
    source: null,
    path: [],
    origins: origins.map((origin) => ({
      ...origin,
      extractions: [
        ...origin.extractions,
        { operation, part, span },
      ],
    })),
  }));
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
  const sites = analysis.consumptions.get(binding.pattern);
  if (sites === undefined) {
    analysis.consumptions.set(binding.pattern, [span]);
    return;
  }
  if (
    !sites.some((site) => site.start === span.start && site.end === span.end)
  ) sites.push(span);
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
  outcomes: readonly Map<Binding, BindingState>[],
  before: Map<Binding, BindingState>,
  span: Span,
  analysis: Analysis,
): void {
  if (outcomes.length === 0) return;
  const merged = new Map<Binding, BindingState>();

  for (const [binding] of before) {
    const prior = before.get(binding);
    if (prior === undefined) throw new Error("ownership snapshot lost binding");
    const states = outcomes.map((outcome) => outcome.get(binding) ?? prior);
    const some = states.some((state) => state.moved !== null);
    const every = states.every((state) => state.moved !== null);
    // Affine branches need not agree: spending on one path and not another is
    // still at most once.
    if (some && !every && binding.qualifier === "linear") {
      analysis.report(
        "BLOT_LINEAR_BRANCH_DISAGREEMENT",
        `\`${binding.pattern.name}\` is linear and is consumed on some branches but not others.`,
        span,
      );
    }
    const first = states[0];
    const disagree = states.some((state) =>
      state.partial !== first.partial || !sameProduced(state.owned, first.owned)
    );
    if (disagree && binding.qualifier === "linear") {
      analysis.report(
        "BLOT_LINEAR_BRANCH_DISAGREEMENT",
        `\`${binding.pattern.name}\` has different live fields on continuing branches.`,
        span,
      );
    }
    let chosen = first;
    if (some) {
      const consumed = states.find((state) => state.moved !== null);
      if (consumed !== undefined) chosen = consumed;
    }
    merged.set(binding, chosen);
  }

  restore(merged);
}
