// Biunification.
//
// `constrain(lhs, rhs)` records that `lhs` flows into `rhs`. It never unifies:
// a variable accumulates lower and upper bounds, and a constraint against a
// variable is propagated to the bounds already recorded. That is what keeps the
// algorithm polynomial and what makes every program have a principal type
// without a single annotation.
//
// Levels and extrusion give `let`-polymorphism. A variable created inside a
// binding lives at a deeper level; when it escapes into a shallower one it is
// copied down rather than captured, so generalization needs no free-variable
// scan.

import {
  admitsOmission,
  boundAbove,
  boundBelow,
  checkpointInferenceIdentities,
  evidenceOf,
  freshRigid,
  freshVar,
  type Level,
  levelOf,
  restoreInferenceIdentities,
  type Scheme,
  type SimpleType,
  type Typing,
  type Variable,
} from "./type.ts";
import { showRange } from "./print.ts";

export class TypeError_ extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "TypeError_";
  }
}

function mismatch(lhs: SimpleType, rhs: SimpleType): never {
  throw new TypeError_(`${describe(lhs)} is not ${describe(rhs)}`);
}

/** A short shape name, for messages that have not been coalesced yet. */
function describe(type: SimpleType): string {
  switch (type.tag) {
    case "var":
      return "an inferred type";
    case "rigid":
      return `the rigid type 's${type.id}`;
    case "forall":
      return "a polymorphic type";
    case "range":
      // A range is ground, so naming it needs nothing from a finished
      // inference — and naming it is the point: `0..` says which bound `-1`
      // fell outside of, where "an integer" does not.
      return `\`${showRange(type.domain, type.low, type.high)}\``;
    case "unit":
      return "()";
    case "fun":
      return "a function";
    case "record":
      return `a shape with ${
        [...type.fields.keys()].map((n) => `.${n}`).join(", ")
      }`;
    case "array":
      return "an array";
    case "variant": {
      const shown = [...type.cases.keys()].map((n) => `#${n}`).join(" | ");
      if (type.open) return `${shown} | ..`;
      return shown;
    }
    case "effects":
      return `<${[...type.labels].join(", ")}>`;
    case "opaque":
      // `F32x4` is a name the reader can write; a seal's is not — it bridges
      // to `${name}#${carrier}` (see `bridge.ts`), which is a compiler-local
      // identity. Quoting only the ones without a `#` keeps the backticks
      // meaning "you can write this".
      if (type.name.includes("#")) return type.name;
      return `\`${type.name}\``;
    case "union":
      return type.members.map(describe).join(" | ");
    case "top":
      return "anything";
    case "bottom":
      return "nothing";
  }
}

class ConstraintCache {
  readonly #pairs = new Map<SimpleType, Set<SimpleType>>();

  constructor(readonly parent: ConstraintCache | null = null) {}

  has(lhs: SimpleType, rhs: SimpleType): boolean {
    if (this.#pairs.get(lhs)?.has(rhs) === true) return true;
    if (this.parent === null) return false;
    return this.parent.has(lhs, rhs);
  }

  add(lhs: SimpleType, rhs: SimpleType): void {
    const rights = this.#pairs.get(lhs);
    if (rights === undefined) {
      this.#pairs.set(lhs, new Set([rhs]));
      return;
    }
    rights.add(rhs);
  }

  fork(): ConstraintCache {
    return new ConstraintCache(this);
  }
}

type BoundInsertion = {
  readonly variable: Variable;
  readonly direction: "lower" | "upper";
};

type ConstraintState = {
  readonly cache: ConstraintCache;
  readonly insertions: BoundInsertion[];
};

export function constrain(
  lhs: SimpleType,
  rhs: SimpleType,
): void {
  constrainWithState(lhs, rhs, {
    cache: new ConstraintCache(),
    insertions: [],
  });
}

function constrainWithState(
  lhs: SimpleType,
  rhs: SimpleType,
  state: ConstraintState,
): void {
  if (lhs === rhs) return;
  if (state.cache.has(lhs, rhs)) return;
  // Recursion is admitted rather than rejected: revisiting a pair means the
  // constraint is already being proved, which is what makes recursive types
  // fall out instead of tripping an occurs check.
  if (lhs.tag === "var" || rhs.tag === "var") {
    state.cache.add(lhs, rhs);
  }

  if (rhs.tag === "top" || lhs.tag === "bottom") return;

  if (lhs.tag === "forall") {
    constrainWithState(instantiateForall(lhs, levelOf(rhs)), rhs, state);
    return;
  }

  if (rhs.tag === "forall") {
    constrainWithState(lhs, skolemize(rhs), state);
    return;
  }

  if (lhs.tag === "rigid" && rhs.tag === "rigid" && lhs.id === rhs.id) {
    return;
  }

  if (lhs.tag === "fun" && rhs.tag === "fun") {
    if ((lhs.deferred ?? false) !== (rhs.deferred ?? false)) {
      mismatch(lhs, rhs);
    }
    constrainWithState(rhs.param, lhs.param, state);
    constrainWithState(lhs.result, rhs.result, state);
    constrainWithState(lhs.effects, rhs.effects, state);
    return;
  }

  if (lhs.tag === "record" && rhs.tag === "record") {
    // Width subtyping: a wider value satisfies a narrower requirement. This is
    // the whole of what a `duck` contract needed to be.
    for (const [name, required] of rhs.fields) {
      const present = lhs.fields.get(name);
      if (present === undefined) {
        if (admitsOmission(required)) continue;
        throw new TypeError_(
          `no field \`.${name}\` on ${describe(lhs)}`,
        );
      }
      constrainWithState(present, required, state);
    }
    return;
  }

  if (lhs.tag === "array" && rhs.tag === "array") {
    constrainWithState(lhs.element, rhs.element, state);
    return;
  }

  if (lhs.tag === "variant" && rhs.tag === "variant") {
    // Fewer cases is a subtype: `#Ready` fits wherever `#Ready | #Failed` does.
    for (const [name, payload] of lhs.cases) {
      const accepted = rhs.cases.get(name);
      if (accepted === undefined) {
        // An open requirement names the constructors it reads and admits the
        // rest, which is exactly what an arm matching everything leaves behind.
        if (rhs.open) continue;
        throw new TypeError_(
          `\`#${name}\` is not one of ${describe(rhs)}`,
        );
      }
      constrainWithState(payload, accepted, state);
    }
    if (lhs.open && !rhs.open) {
      throw new TypeError_(
        `${describe(lhs)} may carry a constructor outside ${describe(rhs)}`,
      );
    }
    return;
  }

  if (lhs.tag === "effects" && rhs.tag === "effects") {
    // Fewer effects is a subtype, by the same reasoning as variants. This one
    // line is the entirety of effect-row inference.
    for (const label of lhs.labels) {
      if (!rhs.labels.has(label)) {
        throw new TypeError_(`effect \`${label}\` is not handled`);
      }
    }
    return;
  }

  if (lhs.tag === "range" && rhs.tag === "range") {
    if (lhs.domain !== rhs.domain) mismatch(lhs, rhs);
    if (!boundBelow(rhs.low, lhs.low) || !boundAbove(lhs.high, rhs.high)) {
      throw new TypeError_(
        `${describe(lhs)} is outside ${describe(rhs)}`,
      );
    }
    return;
  }

  if (lhs.tag === "union") {
    for (const member of lhs.members) {
      constrainWithState(member, rhs, state);
    }
    return;
  }

  if (lhs.tag === "unit" && rhs.tag === "unit") return;
  if (lhs.tag === "opaque" && rhs.tag === "opaque" && lhs.name === rhs.name) {
    return;
  }

  if (lhs.tag === "var" && levelOf(rhs) <= lhs.level) {
    insertBound(lhs, "upper", rhs, state);
    for (const bound of [...lhs.lower]) {
      constrainWithState(bound, rhs, state);
    }
    return;
  }

  if (rhs.tag === "var" && levelOf(lhs) <= rhs.level) {
    insertBound(rhs, "lower", lhs, state);
    for (const bound of [...rhs.upper]) {
      constrainWithState(lhs, bound, state);
    }
    return;
  }

  if (rhs.tag === "union") {
    for (const member of rhs.members) {
      const insertionCount = state.insertions.length;
      const identityCheckpoint = checkpointInferenceIdentities();
      try {
        constrainWithState(lhs, member, {
          cache: state.cache.fork(),
          insertions: state.insertions,
        });
        return;
      } catch (error) {
        if (!(error instanceof TypeError_)) throw error;
        rollbackBounds(state.insertions, insertionCount);
        restoreInferenceIdentities(identityCheckpoint);
      }
    }
    throw new TypeError_(`${describe(lhs)} is not one of ${describe(rhs)}`);
  }

  // One side is a variable from a deeper level. Copy the other side down so the
  // constraint is recorded where the variable can see it.
  if (lhs.tag === "var") {
    constrainWithState(
      lhs,
      extrude(rhs, false, lhs.level, new Map(), state),
      state,
    );
    return;
  }
  if (rhs.tag === "var") {
    constrainWithState(
      extrude(lhs, true, rhs.level, new Map(), state),
      rhs,
      state,
    );
    return;
  }

  mismatch(lhs, rhs);
}

function insertBound(
  variable: Variable,
  direction: "lower" | "upper",
  bound: SimpleType,
  state: ConstraintState,
): void {
  variable[direction].push(bound);
  state.insertions.push({ variable, direction });
}

function rollbackBounds(
  insertions: BoundInsertion[],
  insertionCount: number,
): void {
  while (insertions.length > insertionCount) {
    const insertion = insertions.pop();
    if (insertion === undefined) {
      throw new Error("a rollback checkpoint preceded every bound insertion");
    }
    const removed = insertion.variable[insertion.direction].pop();
    if (removed === undefined) {
      throw new Error("a journalled bound insertion must still be present");
    }
  }
}

/** Copies a type down to `level`, freshening the variables that were deeper. */
function extrude(
  type: SimpleType,
  polarity: boolean,
  level: Level,
  seen: Map<Variable, Variable>,
  state: ConstraintState,
): SimpleType {
  if (levelBelow(type, level)) return type;

  switch (type.tag) {
    case "var": {
      const existing = seen.get(type);
      if (existing !== undefined) return existing;
      const evidence = evidenceOf(type);
      const copy = freshVar(level, evidence === null ? undefined : evidence);
      seen.set(type, copy);
      if (polarity) {
        insertBound(type, "upper", copy, state);
        for (const bound of type.lower) {
          insertBound(
            copy,
            "lower",
            extrude(bound, polarity, level, seen, state),
            state,
          );
        }
      } else {
        insertBound(type, "lower", copy, state);
        for (const bound of type.upper) {
          insertBound(
            copy,
            "upper",
            extrude(bound, polarity, level, seen, state),
            state,
          );
        }
      }
      return copy;
    }
    case "fun":
      return {
        tag: "fun",
        param: extrude(type.param, !polarity, level, seen, state),
        effects: extrude(type.effects, polarity, level, seen, state),
        result: extrude(type.result, polarity, level, seen, state),
        deferred: type.deferred,
      };
    case "forall":
      return {
        tag: "forall",
        variables: type.variables,
        body: extrude(type.body, polarity, level, seen, state),
      };
    case "record":
      return {
        tag: "record",
        fields: new Map(
          [...type.fields].map((
            [n, t],
          ) => [n, extrude(t, polarity, level, seen, state)]),
        ),
      };
    case "variant":
      return {
        tag: "variant",
        open: type.open,
        cases: new Map(
          [...type.cases].map((
            [n, t],
          ) => [n, extrude(t, polarity, level, seen, state)]),
        ),
      };
    case "array":
      return {
        tag: "array",
        element: extrude(type.element, polarity, level, seen, state),
      };
    default:
      return type;
  }
}

function levelBelow(type: SimpleType, level: Level): boolean {
  switch (type.tag) {
    case "var":
      return type.level <= level;
    case "fun":
      return levelBelow(type.param, level) && levelBelow(type.effects, level) &&
        levelBelow(type.result, level);
    case "forall":
      return levelBelow(type.body, level);
    case "record":
      return [...type.fields.values()].every((t) => levelBelow(t, level));
    case "variant":
      return [...type.cases.values()].every((t) => levelBelow(t, level));
    case "array":
      return levelBelow(type.element, level);
    default:
      return true;
  }
}

/**
 * Where each definition-site variable's instantiation copies went.
 *
 * `extrude` links its copies into the bound graph — `type.upper.push(copy)` —
 * so a constraint recorded on the copy is visible from the original. It is the
 * only copier that can: a `let`-bound scheme's whole point is that its
 * instantiations do not constrain each other, so `freshenAbove` must leave the
 * definition-site variable alone. That leaves the backend with no way to learn
 * what a generalized projection was actually applied to.
 *
 * The edge is recorded here instead, beside the lattice rather than in it.
 * `constrain` never reads this map, so biunification propagates exactly the
 * bounds it propagated before and stays polynomial; only fact collection walks
 * it, and only to answer "what shapes reached this node".
 *
 * One map per program checked, held in its `Staging`: a dependency's
 * definition-site variable and its importer's instantiation of it have to be
 * one edge, or a field set read inside the dependency could not find the record
 * the importer built. Hanging the edge off the `Variable` instead would attach
 * unbounded growth to `PRIMITIVE_TYPES`, whose scheme variables are
 * process-global and outlive every check — and would let one program's records
 * be seen while checking another's.
 */
export type Instances = Map<Variable, Variable[]>;

export function instantiate(
  typing: Typing,
  level: Level,
  instances: Instances,
): SimpleType {
  if (typing.tag !== "scheme") return typing;
  return freshenAbove(typing.body, typing.level, level, new Map(), instances);
}

export function scheme(body: SimpleType, level: Level): Scheme {
  return { tag: "scheme", level, body };
}

function freshenAbove(
  type: SimpleType,
  limit: Level,
  level: Level,
  freshenedTypes: Map<SimpleType, SimpleType>,
  instances: Instances,
): SimpleType {
  if (levelBelow(type, limit)) return type;
  const existing = freshenedTypes.get(type);
  if (existing !== undefined) return existing;

  switch (type.tag) {
    case "var": {
      const evidence = evidenceOf(type);
      const copy = freshVar(level, evidence === null ? undefined : evidence);
      freshenedTypes.set(type, copy);
      // Not a bound. The copy is where this use's constraints land, and the
      // edge is what lets a fact read at the definition find them again.
      const recorded = instances.get(type);
      if (recorded === undefined) instances.set(type, [copy]);
      else recorded.push(copy);
      copy.lower.push(
        ...type.lower.map((b) =>
          freshenAbove(b, limit, level, freshenedTypes, instances)
        ),
      );
      copy.upper.push(
        ...type.upper.map((b) =>
          freshenAbove(b, limit, level, freshenedTypes, instances)
        ),
      );
      return copy;
    }
    case "fun": {
      const freshened: SimpleType = {
        tag: "fun",
        param: freshenAbove(
          type.param,
          limit,
          level,
          freshenedTypes,
          instances,
        ),
        effects: freshenAbove(
          type.effects,
          limit,
          level,
          freshenedTypes,
          instances,
        ),
        result: freshenAbove(
          type.result,
          limit,
          level,
          freshenedTypes,
          instances,
        ),
        deferred: type.deferred,
      };
      freshenedTypes.set(type, freshened);
      return freshened;
    }
    case "forall": {
      const freshened: SimpleType = {
        tag: "forall",
        variables: type.variables,
        body: freshenAbove(
          type.body,
          limit,
          level,
          freshenedTypes,
          instances,
        ),
      };
      freshenedTypes.set(type, freshened);
      return freshened;
    }
    case "record": {
      const freshened: SimpleType = {
        tag: "record",
        fields: new Map(
          [...type.fields].map((
            [n, t],
          ) => [
            n,
            freshenAbove(t, limit, level, freshenedTypes, instances),
          ]),
        ),
      };
      freshenedTypes.set(type, freshened);
      return freshened;
    }
    case "variant": {
      const freshened: SimpleType = {
        tag: "variant",
        open: type.open,
        cases: new Map(
          [...type.cases].map((
            [n, t],
          ) => [
            n,
            freshenAbove(t, limit, level, freshenedTypes, instances),
          ]),
        ),
      };
      freshenedTypes.set(type, freshened);
      return freshened;
    }
    case "array": {
      const freshened: SimpleType = {
        tag: "array",
        element: freshenAbove(
          type.element,
          limit,
          level,
          freshenedTypes,
          instances,
        ),
      };
      freshenedTypes.set(type, freshened);
      return freshened;
    }
    default:
      return type;
  }
}

export function instantiateForall(
  type: SimpleType & { tag: "forall" },
  level: Level,
): SimpleType {
  const replacements = new Map<number, SimpleType>();
  for (const variable of type.variables) {
    replacements.set(variable, freshVar(level));
  }
  return substituteRigid(type.body, replacements);
}

function skolemize(
  type: SimpleType & { tag: "forall" },
): SimpleType {
  const replacements = new Map<number, SimpleType>();
  for (const variable of type.variables) {
    replacements.set(variable, freshRigid());
  }
  return substituteRigid(type.body, replacements);
}

function substituteRigid(
  type: SimpleType,
  replacements: ReadonlyMap<number, SimpleType>,
): SimpleType {
  switch (type.tag) {
    case "rigid": {
      const replacement = replacements.get(type.id);
      if (replacement === undefined) return type;
      return replacement;
    }
    case "forall": {
      const innerReplacements = new Map(replacements);
      for (const variable of type.variables) innerReplacements.delete(variable);
      return {
        tag: "forall",
        variables: type.variables,
        body: substituteRigid(type.body, innerReplacements),
      };
    }
    case "fun":
      return {
        tag: "fun",
        param: substituteRigid(type.param, replacements),
        effects: substituteRigid(type.effects, replacements),
        result: substituteRigid(type.result, replacements),
        deferred: type.deferred,
      };
    case "record":
      return {
        tag: "record",
        fields: new Map(
          [...type.fields].map(([name, member]) => [
            name,
            substituteRigid(member, replacements),
          ]),
        ),
      };
    case "array":
      return {
        tag: "array",
        element: substituteRigid(type.element, replacements),
      };
    case "variant":
      return {
        tag: "variant",
        open: type.open,
        cases: new Map(
          [...type.cases].map(([name, payload]) => [
            name,
            substituteRigid(payload, replacements),
          ]),
        ),
      };
    case "union":
      return {
        tag: "union",
        members: type.members.map((member) =>
          substituteRigid(member, replacements)
        ),
      };
    default:
      return type;
  }
}
