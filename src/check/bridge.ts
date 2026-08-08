// Comptime value -> inference type.
//
// This function is what "types are values" costs and what it buys. A `sig` is
// an ordinary expression: it is evaluated by the same evaluator that runs the
// program, and whatever it produces has to become a lattice element before it
// can constrain anything. There is no type-level sublanguage to translate from,
// only values.
//
// Not every value is a type. A closure is not — its type has to be inferred
// from its body, not read off the value — so bridging returns `null` and the
// caller falls back to inference. Returning `null` rather than `⊤` matters:
// silently widening to "anything" would turn a missing case into a passing
// check.

import {
  effectExtension,
  equal,
  inferredTypeOf,
  show,
  type Value,
} from "../comptime/value.ts";
import {
  type Bound,
  type Domain,
  effects as effectRow,
  FLOAT,
  freshRigid,
  fun,
  INT,
  intLiteral,
  record,
  type SimpleType,
  TEXT,
  textLiteral,
  TOP,
  union,
  UNIT,
  variant,
} from "./type.ts";

/** A stable label for an effect, so two effects with one operation name differ. */
export function effectLabel(value: Value & { tag: "effect" }): string {
  return `${value.name}#${value.id}`;
}

/**
 * Labels of effects the host implements.
 *
 * A host effect's row is the program's declared interface — its operations
 * become WebAssembly imports — so it is allowed to reach the module boundary
 * where an ordinary effect nothing handles is an error. Effect ids are globally
 * unique, so one registry is enough.
 */
const hostLabels = new Set<string>();
const effectValues = new Map<string, Value>();

export function isHostEffect(label: string): boolean {
  return hostLabels.has(label);
}

export function bridge(value: Value): SimpleType | null {
  return bridgeValue(value, new Map());
}

function bridgeValue(
  value: Value,
  variables: ReadonlyMap<number, SimpleType>,
): SimpleType | null {
  const inferred = inferredTypeOf(value);
  if (inferred !== undefined) return bridgeValue(inferred, variables);
  switch (value.tag) {
    case "int":
      return intLiteral(value.value);
    case "text":
      return textLiteral(value.value);
    case "float":
      return FLOAT;
    case "unit":
      return UNIT;
    case "unbounded":
      return TOP;

    case "range": {
      const low = value.low.tag === "unbounded" ? null : scalar(value.low);
      const high = value.high.tag === "unbounded" ? null : scalar(value.high);
      const domain = value.domain ?? domainOf(value.low) ??
        domainOf(value.high);
      if (domain === undefined || domain === null) return null;
      return { tag: "range", domain, low, high };
    }

    case "arrow": {
      const domain = bridgeValue(value.domain, variables);
      const codomain = bridgeValue(value.codomain, variables);
      if (domain === null || codomain === null) return null;
      // The row is written or it is empty, and an empty one is the claim that
      // the function performs nothing — not the absence of a claim. A fresh
      // variable here would be the licence version of "says nothing": it
      // satisfies every later constraint, so the effect the body performs would
      // pass the `sig` and then vanish from what the caller is told.
      const labels: string[] = [];
      for (const effect of value.effects) {
        if (effect.tag !== "effect") return null;
        if (effect.host) hostLabels.add(effectLabel(effect));
        labels.push(effectLabel(effect));
      }
      return fun(
        domain,
        codomain,
        effectRow(labels),
        value.deferred === true,
      );
    }

    case "union": {
      const members: SimpleType[] = [];
      const cases = new Map<string, SimpleType>();
      for (const member of value.members) {
        if (member.tag === "tag") {
          const payload = member.payload === null
            ? UNIT
            : bridgeValue(member.payload, variables);
          if (payload === null) return null;
          cases.set(member.name, payload);
          continue;
        }
        const bridged = bridgeValue(member, variables);
        if (bridged === null) return null;
        members.push(bridged);
      }
      if (cases.size > 0) members.push(variant(cases));
      return union(members);
    }

    case "tag": {
      const payload = value.payload === null
        ? UNIT
        : bridgeValue(value.payload, variables);
      if (payload === null) return null;
      return variant([[value.name, payload]]);
    }

    case "shape": {
      const fields: [string, SimpleType][] = [];
      for (const [name, member] of value.fields) {
        const bridged = bridgeValue(member, variables);
        if (bridged === null) return null;
        fields.push([name, bridged]);
      }
      return record(fields);
    }

    case "array": {
      const elements = value.elements.map((element) =>
        bridgeValue(element, variables)
      );
      if (elements.some((element) => element === null)) return null;
      return { tag: "array", element: union(elements as SimpleType[]) };
    }

    // Reaching into an effect names an operation, and performing it is an
    // ordinary call — so an effect's type is a record of functions whose rows
    // carry that effect. This is the whole mechanism behind effect inference.
    case "effect": {
      const label = effectLabel(value);
      effectValues.set(label, effectExtension(value) ?? value);
      if (value.host) hostLabels.add(label);
      const operations: [string, SimpleType][] = [];
      for (const [name, signature] of value.operations) {
        const bridged = bridgeValue(signature, variables);
        if (bridged === null) return null;
        if (bridged.tag === "forall" && bridged.body.tag === "fun") {
          operations.push([
            name,
            {
              ...bridged,
              body: fun(
                bridged.body.param,
                bridged.body.result,
                effectRow([label]),
              ),
            },
          ]);
          continue;
        }
        if (bridged.tag !== "fun") return null;
        operations.push([
          name,
          fun(bridged.param, bridged.result, effectRow([label])),
        ]);
      }
      return record(operations);
    }

    // Transparent: a struct's type is its storage. The members it carries are
    // a compile-time namespace and have no business in the lattice.
    case "extended":
      if (value.inner.tag === "effect") {
        effectValues.set(effectLabel(value.inner), value);
      }
      return bridgeValue(value.inner, variables);

    case "type-variable": {
      const variable = variables.get(value.id);
      if (variable === undefined) return null;
      return variable;
    }

    case "forall": {
      const variable = freshRigid();
      const innerVariables = new Map(variables);
      innerVariables.set(value.variable, variable);
      const body = bridgeValue(value.body, innerVariables);
      if (body === null) return null;
      return { tag: "forall", variables: [variable.id], body };
    }

    // Opaque on both sides, and the name is the whole of the identity — which
    // is why `F32x4` bridges without the lattice learning anything about lanes.
    case "opaque-type":
      return { tag: "opaque", name: value.name };

    case "sealed":
      // A sealed type is identified by its name and its carrier, so the
      // opaque name has to carry both — otherwise `List I32` and `List Str`
      // would bridge to the same invariant type.
      return { tag: "opaque", name: `${value.name}#${show(value.inner)}` };

    // A closure's type comes from its body, not from the value.
    default:
      return null;
  }
}

function scalar(value: Value): bigint | string | null {
  if (value.tag === "int") return value.value;
  if (value.tag === "text") return value.value;
  return null;
}

function domainOf(value: Value): Domain | null {
  if (value.tag === "int") return "int";
  if (value.tag === "text") return "text";
  return null;
}

export { INT, TEXT };

/**
 * The reverse of `bridge`: an inferred type, as a compile-time value.
 *
 * `bridge` exists because a program writes types as values and inference needs
 * them as lattice elements. This goes the other way, and it exists for one
 * reason: `@type.satisfies` hands a predicate the type of an expression, and
 * the type of an expression that is not itself compile-time lives only in the
 * lattice. Without this there is nothing to hand over — `@type.of` cannot do
 * it, because it answers the type of a *value* and so has to evaluate one.
 *
 * Partial on purpose. An inference variable has no compile-time reading, and
 * neither does an effect row or a bound this cannot name, so those answer
 * `null` and the caller reports which type it could not reify. Inventing a
 * value for them is the mistake that made an unconstrained variable mean
 * "satisfies anything" everywhere else in this checker.
 */
export function reify(type: SimpleType): Value | null {
  switch (type.tag) {
    case "unit":
      // `UNIT` in this file is the lattice's; the value domain has its own.
      return { tag: "unit" };
    case "top":
      return { tag: "unbounded" };

    case "range": {
      const low = type.low === null
        ? { tag: "unbounded" as const }
        : reifyBound(type.low, type.domain);
      const high = type.high === null
        ? { tag: "unbounded" as const }
        : reifyBound(type.high, type.domain);
      if (low === null || high === null) return null;
      // A singleton is the literal, not a range from a value to itself. That
      // is how a program writes it, and a predicate compares what it was given
      // against what its caller wrote — `Is { .value = 12; }` against a range
      // of twelve to twelve is a mismatch nobody could see.
      if (low.tag !== "unbounded" && equal(low, high)) return low;
      return { tag: "range", low, high, domain: type.domain };
    }

    case "record": {
      const fields = new Map<string, Value>();
      for (const [name, member] of type.fields) {
        const reified = reify(member);
        if (reified === null) return null;
        fields.set(name, reified);
      }
      return { tag: "shape", fields };
    }

    case "array": {
      const element = reify(type.element);
      if (element === null) return null;
      return { tag: "array", elements: [element] };
    }

    case "variant": {
      // An open variant is "these constructors and possibly others", which no
      // union of tags can say. Refusing is what keeps a predicate from reading
      // a partial set as the whole one.
      if (type.open) return null;
      const members: Value[] = [];
      for (const [name, payload] of type.cases) {
        const reified = reify(payload);
        if (reified === null) return null;
        members.push({
          tag: "tag",
          name,
          payload: reified.tag === "unit" ? null : reified,
        });
      }
      return { tag: "union", members };
    }

    case "fun": {
      const domain = reify(type.param);
      const codomain = reify(type.result);
      if (domain === null || codomain === null) return null;
      const labels = reifiedEffectLabels(type.effects, new Set());
      const effects: Value[] = [];
      for (const label of labels) {
        const effect = effectValues.get(label);
        if (effect === undefined) return null;
        effects.push(effect);
      }
      if (type.deferred === true) {
        return { tag: "arrow", domain, codomain, effects, deferred: true };
      }
      return { tag: "arrow", domain, codomain, effects };
    }

    case "union": {
      const members: Value[] = [];
      for (const member of type.members) {
        const reified = reify(member);
        if (reified === null) return null;
        members.push(reified);
      }
      return { tag: "union", members };
    }

    case "var": {
      // A binding's type is a variable whose lower bounds are what flowed into
      // it, so one bound is the type the value has. Several would be a join
      // this cannot name, and none means nothing has flowed in yet — both are
      // refusals rather than guesses, because a predicate given the wrong type
      // answers confidently about a program that does not exist.
      if (type.lower.length !== 1) return null;
      return reify(type.lower[0]);
    }

    // A rigid, a `forall`, an effect row, an opaque, and bottom. None of them
    // is a value a program could have written, so none is a value a predicate
    // can be handed.
    default:
      return null;
  }
}

function reifiedEffectLabels(
  type: SimpleType,
  seen: Set<number>,
): string[] {
  if (type.tag === "effects") return [...type.labels];
  if (type.tag !== "var" || seen.has(type.id)) return [];
  seen.add(type.id);
  return type.lower.flatMap((bound) => reifiedEffectLabels(bound, seen));
}

function reifyBound(bound: Bound, domain: Domain): Value | null {
  if (typeof bound === "bigint") return { tag: "int", value: bound };
  if (typeof bound === "string") return { tag: "text", value: bound };
  // A length bound names an array a program cannot name back, and a float
  // range is open at both ends by construction, so a closed one is a bug
  // rather than something to translate.
  void domain;
  return null;
}
