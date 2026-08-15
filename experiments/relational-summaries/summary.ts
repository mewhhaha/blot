import {
  RefinementContext,
  type RefinementProposition,
  type RefinementVariable,
} from "../../src/core/refinement.ts";

export type SummarySlot =
  | { readonly tag: "parameter"; readonly index: number }
  | { readonly tag: "result"; readonly index: number };

export type SummaryProposition =
  | {
    readonly tag: "equal-offset";
    readonly left: SummarySlot;
    readonly right: SummarySlot;
    readonly offset: bigint;
  }
  | {
    readonly tag: "at-least";
    readonly variable: SummarySlot;
    readonly value: bigint;
  }
  | {
    readonly tag: "at-most";
    readonly variable: SummarySlot;
    readonly value: bigint;
  }
  | {
    readonly tag: "less-than";
    readonly left: SummarySlot;
    readonly right: SummarySlot;
  }
  | {
    readonly tag: "difference-at-most";
    readonly left: SummarySlot;
    readonly right: SummarySlot;
    readonly offset: bigint;
  };

export type SummaryResult =
  | { readonly tag: "fresh" }
  | { readonly tag: "alias"; readonly parameter: number };

export interface RelationalSummary {
  readonly tag: "relational-summary";
  readonly schema: 1;
  readonly parameters: number;
  readonly results: readonly SummaryResult[];
  readonly requires: readonly SummaryProposition[];
  readonly ensures: readonly SummaryProposition[];
}

export interface FactSite {
  readonly description: string;
}

interface TrackedFact {
  readonly proposition: RefinementProposition;
  readonly origin: FactSite;
}

interface Invalidation {
  readonly binding: string;
  readonly from: RefinementVariable;
  readonly to: RefinementVariable;
  readonly cause: FactSite;
  readonly facts: readonly TrackedFact[];
}

export interface MissingFact {
  readonly required: RefinementProposition;
  readonly knownAt: readonly FactSite[];
  readonly invalidatedAt: FactSite | null;
}

export type SummaryCall =
  | { readonly tag: "accepted"; readonly results: readonly number[] }
  | { readonly tag: "refused"; readonly missing: MissingFact };

export function parameter(index: number): SummarySlot {
  return { tag: "parameter", index };
}

export function result(index: number): SummarySlot {
  return { tag: "result", index };
}

/**
 * An experimental caller-side `Phi` with binding and diagnostic provenance.
 *
 * Values remain immutable. `rebindFresh` replaces one binding with a fresh
 * identity; an alias that still names the old identity keeps its facts live.
 */
export class RelationalState {
  #nextIdentity: number;
  #context = new RefinementContext();
  #facts: TrackedFact[] = [];
  readonly #bindings = new Map<string, RefinementVariable>();
  readonly #allocated = new Set<RefinementVariable>();
  readonly #invalidations: Invalidation[] = [];
  readonly #successors = new Map<RefinementVariable, RefinementVariable>();

  constructor(firstIdentity = 0) {
    if (!validIdentity(firstIdentity)) {
      throw new Error(
        "the first relational identity must be a non-negative integer",
      );
    }
    this.#nextIdentity = firstIdentity;
  }

  bindFresh(name: string, site: FactSite): RefinementVariable {
    const identity = this.#freshIdentity();
    this.#bind(name, identity, site);
    return identity;
  }

  bind(name: string, identity: RefinementVariable, site: FactSite): void {
    if (!this.#allocated.has(identity)) {
      throw new Error(
        `cannot bind unallocated relational identity ${identity}`,
      );
    }
    this.#bind(name, identity, site);
  }

  alias(name: string, source: string, site: FactSite): RefinementVariable {
    const identity = this.identity(source);
    this.#bind(name, identity, site);
    return identity;
  }

  identity(name: string): RefinementVariable {
    const identity = this.#bindings.get(name);
    if (identity === undefined) {
      throw new Error(`unknown relational binding \`${name}\``);
    }
    return identity;
  }

  rebindFresh(name: string, cause: FactSite): RefinementVariable {
    if (!this.#bindings.has(name)) {
      throw new Error(`cannot rebind unknown relational binding \`${name}\``);
    }
    const identity = this.#freshIdentity();
    this.#bind(name, identity, cause);
    return identity;
  }

  assume(proposition: RefinementProposition, origin: FactSite): void {
    if (!validConcreteProposition(proposition)) {
      throw new Error("cannot assume an invalid relational proposition");
    }
    for (const identity of propositionVariables(proposition)) {
      if (!this.#allocated.has(identity)) {
        throw new Error(`unallocated relational identity ${identity}`);
      }
    }
    if (!this.#context.assume(proposition)) {
      throw new Error("relational assumptions are inconsistent");
    }
    this.#facts.push({ proposition, origin });
  }

  entails(proposition: RefinementProposition): boolean {
    if (!validConcreteProposition(proposition)) return false;
    for (const identity of propositionVariables(proposition)) {
      if (!this.#allocated.has(identity)) return false;
    }
    return this.#context.entails(proposition);
  }

  call(
    summary: RelationalSummary,
    parameters: readonly RefinementVariable[],
    origin: FactSite,
  ): SummaryCall {
    const error = validateSummary(summary);
    if (error !== null) throw new Error(error);
    if (parameters.length !== summary.parameters) {
      throw new Error(
        `relational summary expected ${summary.parameters} parameters, received ${parameters.length}`,
      );
    }
    for (const identity of parameters) {
      if (!this.#allocated.has(identity)) {
        throw new Error(`unallocated relational identity ${identity}`);
      }
    }

    const absent = summary.requires
      .map((required) => instantiate(required, parameters, []))
      .find((required) => !this.#context.entails(required));
    if (absent !== undefined) {
      return { tag: "refused", missing: this.explain(absent) };
    }

    let nextIdentity = this.#nextIdentity;
    const results: RefinementVariable[] = [];
    for (const output of summary.results) {
      if (output.tag === "alias") {
        const identity = parameters[output.parameter];
        if (identity === undefined) {
          throw new Error("validated relational alias has no parameter");
        }
        results.push(identity);
        continue;
      }
      results.push(nextIdentity);
      nextIdentity += 1;
    }

    const ensured = summary.ensures.map((proposition) =>
      instantiate(proposition, parameters, results)
    );
    const context = this.#context.clone();
    for (const proposition of ensured) {
      if (!context.assume(proposition)) {
        throw new Error("relational summary contradicts the caller's facts");
      }
    }

    this.#nextIdentity = nextIdentity;
    for (const identity of results) this.#allocated.add(identity);
    this.#context = context;
    for (const proposition of ensured) {
      this.#facts.push({ proposition, origin });
    }
    return { tag: "accepted", results };
  }

  explain(required: RefinementProposition): MissingFact {
    if (this.entails(required)) {
      return { required, knownAt: [], invalidatedAt: null };
    }
    for (let index = this.#invalidations.length - 1; index >= 0; index -= 1) {
      const invalidation = this.#invalidations[index];
      const context = new RefinementContext();
      const origins: FactSite[] = [];
      for (const fact of invalidation.facts) {
        const translated = mapProposition(
          fact.proposition,
          (identity) => this.#currentIdentity(identity),
        );
        if (!context.assume(translated)) continue;
        if (
          !origins.some((origin) =>
            origin.description === fact.origin.description
          )
        ) origins.push(fact.origin);
      }
      if (context.entails(required)) {
        return {
          required,
          knownAt: origins,
          invalidatedAt: invalidation.cause,
        };
      }
    }
    return { required, knownAt: [], invalidatedAt: null };
  }

  #freshIdentity(): RefinementVariable {
    const identity = this.#nextIdentity;
    this.#nextIdentity += 1;
    this.#allocated.add(identity);
    return identity;
  }

  #bind(name: string, identity: RefinementVariable, site: FactSite): void {
    const previous = this.#bindings.get(name);
    if (previous === undefined || previous === identity) {
      this.#bindings.set(name, identity);
      return;
    }

    const incident = this.#facts.filter((fact) =>
      propositionVariables(fact.proposition).includes(previous)
    );
    this.#bindings.set(name, identity);
    this.#successors.set(previous, identity);
    this.#invalidations.push({
      binding: name,
      from: previous,
      to: identity,
      cause: site,
      facts: incident,
    });

    const oldIdentityRemains = [...this.#bindings.values()].some((bound) =>
      bound === previous
    );
    if (oldIdentityRemains) return;
    this.#facts = this.#facts.filter((fact) =>
      !propositionVariables(fact.proposition).includes(previous)
    );
    this.#rebuildContext();
  }

  #rebuildContext(): void {
    const context = new RefinementContext();
    for (const fact of this.#facts) {
      if (!context.assume(fact.proposition)) {
        throw new Error("retained relational facts became inconsistent");
      }
    }
    this.#context = context;
  }

  #currentIdentity(identity: RefinementVariable): RefinementVariable {
    const seen = new Set<RefinementVariable>();
    let current = identity;
    while (true) {
      if (seen.has(current)) {
        throw new Error("relational identity successors contain a cycle");
      }
      seen.add(current);
      const successor = this.#successors.get(current);
      if (successor === undefined) return current;
      current = successor;
    }
  }
}

type PublishedProposition =
  | {
    readonly tag: "equal-offset";
    readonly left: SummarySlot;
    readonly right: SummarySlot;
    readonly offset: string;
  }
  | {
    readonly tag: "at-least";
    readonly variable: SummarySlot;
    readonly value: string;
  }
  | {
    readonly tag: "at-most";
    readonly variable: SummarySlot;
    readonly value: string;
  }
  | {
    readonly tag: "less-than";
    readonly left: SummarySlot;
    readonly right: SummarySlot;
  }
  | {
    readonly tag: "difference-at-most";
    readonly left: SummarySlot;
    readonly right: SummarySlot;
    readonly offset: string;
  };

export interface PublishedRelationalSummary {
  readonly tag: "relational-summary";
  readonly schema: 1;
  readonly parameters: number;
  readonly results: readonly SummaryResult[];
  readonly requires: readonly PublishedProposition[];
  readonly ensures: readonly PublishedProposition[];
}

export function publishRelationalSummary(
  summary: RelationalSummary,
): PublishedRelationalSummary {
  const error = validateSummary(summary);
  if (error !== null) throw new Error(error);
  return {
    tag: "relational-summary",
    schema: 1,
    parameters: summary.parameters,
    results: summary.results.map((output) => ({ ...output })),
    requires: summary.requires.map(publishProposition).sort(comparePublished),
    ensures: summary.ensures.map(publishProposition).sort(comparePublished),
  };
}

export function loadRelationalSummary(
  value: unknown,
): RelationalSummary | null {
  if (!record(value)) return null;
  if (value.tag !== "relational-summary" || value.schema !== 1) return null;
  if (!count(value.parameters) || !Array.isArray(value.results)) return null;
  if (!Array.isArray(value.requires) || !Array.isArray(value.ensures)) {
    return null;
  }

  const results: SummaryResult[] = [];
  for (const output of value.results) {
    if (!record(output)) return null;
    if (output.tag === "fresh") {
      results.push({ tag: "fresh" });
      continue;
    }
    if (output.tag !== "alias" || !count(output.parameter)) return null;
    results.push({ tag: "alias", parameter: output.parameter });
  }

  const requires: SummaryProposition[] = [];
  for (const proposition of value.requires) {
    const loaded = loadProposition(proposition);
    if (loaded === null) return null;
    requires.push(loaded);
  }
  const ensures: SummaryProposition[] = [];
  for (const proposition of value.ensures) {
    const loaded = loadProposition(proposition);
    if (loaded === null) return null;
    ensures.push(loaded);
  }

  const loaded: RelationalSummary = {
    tag: "relational-summary",
    schema: 1,
    parameters: value.parameters,
    results,
    requires,
    ensures,
  };
  if (validateSummary(loaded) !== null) return null;
  return loaded;
}

function validateSummary(summary: RelationalSummary): string | null {
  if (summary.tag !== "relational-summary" || summary.schema !== 1) {
    return "unsupported relational summary schema";
  }
  if (!count(summary.parameters)) return "invalid relational parameter count";
  for (const output of summary.results) {
    if (output.tag === "fresh") continue;
    if (!count(output.parameter) || output.parameter >= summary.parameters) {
      return "relational result aliases an unknown parameter";
    }
  }
  for (const proposition of summary.requires) {
    if (!validSummaryProposition(proposition, summary)) {
      return "invalid relational precondition";
    }
    if (summaryVariables(proposition).some((slot) => slot.tag === "result")) {
      return "relational preconditions cannot mention results";
    }
  }
  for (const proposition of summary.ensures) {
    if (!validSummaryProposition(proposition, summary)) {
      return "invalid relational postcondition";
    }
  }
  return null;
}

function validSummaryProposition(
  proposition: SummaryProposition,
  summary: RelationalSummary,
): boolean {
  return summaryVariables(proposition).every((slot) => {
    if (!count(slot.index)) return false;
    if (slot.tag === "parameter") return slot.index < summary.parameters;
    return slot.index < summary.results.length;
  });
}

function summaryVariables(
  proposition: SummaryProposition,
): readonly SummarySlot[] {
  if (proposition.tag === "at-least" || proposition.tag === "at-most") {
    return [proposition.variable];
  }
  return [proposition.left, proposition.right];
}

function instantiate(
  proposition: SummaryProposition,
  parameters: readonly RefinementVariable[],
  results: readonly RefinementVariable[],
): RefinementProposition {
  const identity = (slot: SummarySlot): RefinementVariable => {
    let found: RefinementVariable | undefined;
    if (slot.tag === "parameter") found = parameters[slot.index];
    if (slot.tag === "result") found = results[slot.index];
    if (found === undefined) {
      throw new Error("relational summary slot was not instantiated");
    }
    return found;
  };

  switch (proposition.tag) {
    case "at-least":
    case "at-most":
      return {
        tag: proposition.tag,
        variable: identity(proposition.variable),
        value: proposition.value,
      };
    case "equal-offset":
    case "difference-at-most":
      return {
        tag: proposition.tag,
        left: identity(proposition.left),
        right: identity(proposition.right),
        offset: proposition.offset,
      };
    case "less-than":
      return {
        tag: "less-than",
        left: identity(proposition.left),
        right: identity(proposition.right),
      };
  }
}

function publishProposition(
  proposition: SummaryProposition,
): PublishedProposition {
  switch (proposition.tag) {
    case "at-least":
    case "at-most":
      return {
        tag: proposition.tag,
        variable: { ...proposition.variable },
        value: proposition.value.toString(),
      };
    case "equal-offset":
    case "difference-at-most":
      return {
        tag: proposition.tag,
        left: { ...proposition.left },
        right: { ...proposition.right },
        offset: proposition.offset.toString(),
      };
    case "less-than":
      return {
        tag: "less-than",
        left: { ...proposition.left },
        right: { ...proposition.right },
      };
  }
}

function loadProposition(value: unknown): SummaryProposition | null {
  if (!record(value) || typeof value.tag !== "string") return null;
  if (value.tag === "at-least" || value.tag === "at-most") {
    const variable = loadSlot(value.variable);
    const number = loadBigInt(value.value);
    if (variable === null || number === null) return null;
    return { tag: value.tag, variable, value: number };
  }
  const left = loadSlot(value.left);
  const right = loadSlot(value.right);
  if (left === null || right === null) return null;
  if (value.tag === "less-than") return { tag: "less-than", left, right };
  if (value.tag !== "equal-offset" && value.tag !== "difference-at-most") {
    return null;
  }
  const offset = loadBigInt(value.offset);
  if (offset === null) return null;
  return { tag: value.tag, left, right, offset };
}

function loadSlot(value: unknown): SummarySlot | null {
  if (!record(value) || !count(value.index)) return null;
  if (value.tag === "parameter") {
    return { tag: "parameter", index: value.index };
  }
  if (value.tag === "result") return { tag: "result", index: value.index };
  return null;
}

function loadBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(value)) {
    return null;
  }
  const parsed = BigInt(value);
  if (parsed.toString() !== value) return null;
  return parsed;
}

function comparePublished(
  left: PublishedProposition,
  right: PublishedProposition,
): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function propositionVariables(
  proposition: RefinementProposition,
): readonly RefinementVariable[] {
  if (proposition.tag === "at-least" || proposition.tag === "at-most") {
    return [proposition.variable];
  }
  return [proposition.left, proposition.right];
}

function mapProposition(
  proposition: RefinementProposition,
  map: (identity: RefinementVariable) => RefinementVariable,
): RefinementProposition {
  switch (proposition.tag) {
    case "at-least":
    case "at-most":
      return {
        ...proposition,
        variable: map(proposition.variable),
      };
    case "equal-offset":
    case "difference-at-most":
    case "less-than":
      return {
        ...proposition,
        left: map(proposition.left),
        right: map(proposition.right),
      };
  }
}

function validConcreteProposition(
  proposition: RefinementProposition,
): boolean {
  return propositionVariables(proposition).every(validIdentity);
}

function validIdentity(identity: number): boolean {
  return Number.isSafeInteger(identity) && identity >= 0;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
