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

import "./region_primitives.ts";
import {
  effectExtension,
  equal,
  inferredTypeOf,
  type Value,
} from "../comptime/value.ts";
import {
  BOTTOM,
  type Bound,
  type Domain,
  effects as effectRow,
  FLOAT,
  freshRigid,
  fun,
  INT,
  intLiteral,
  openEffects,
  record,
  type SimpleType,
  TEXT,
  textLiteral,
  TOP,
  UNIT,
  variant,
} from "./type.ts";
import { closedTypeFingerprint, normalizeClosedUnion } from "./setops.ts";

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
      const labels: string[] = [];
      for (const effect of value.effects) {
        if (effect.tag !== "effect") return null;
        if (effect.host) hostLabels.add(effectLabel(effect));
        labels.push(effectLabel(effect));
      }
      let row: SimpleType = effectRow(labels);
      if (value.effectTail !== undefined) {
        const tail = variables.get(value.effectTail);
        if (tail === undefined) return null;
        row = openEffects(labels, tail);
      }
      return fun(domain, codomain, row, value.deferred === true);
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
      return normalizeClosedUnion(members);
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
      return {
        tag: "array",
        element: elements.length === 0
          ? BOTTOM
          : normalizeClosedUnion(elements as SimpleType[]),
      };
    }

    case "region-type": {
      const element = bridgeValue(value.element, variables);
      if (element === null) return null;
      return { tag: "region", element };
    }

    case "region-rejoin":
      return { tag: "opaque", name: "Rejoin" };

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

    case "opaque-type":
      return { tag: "opaque", name: value.name };

    case "sealed": {
      const carrier = bridgeValue(value.inner, variables);
      if (carrier === null) return null;
      return {
        tag: "opaque",
        name: `seal(${JSON.stringify(value.name)},${
          closedTypeFingerprint(carrier)
        })`,
      };
    }

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

export function reify(type: SimpleType): Value | null {
  switch (type.tag) {
    case "unit":
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

    case "region":
      return null;

    case "variant": {
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
      if (type.lower.length !== 1) return null;
      return reify(type.lower[0]);
    }

    default:
      return null;
  }
}

function reifiedEffectLabels(
  type: SimpleType,
  seen: Set<number>,
): string[] {
  if (type.tag === "effects") return [...type.labels];
  if (type.tag === "open-effects") {
    return [...type.labels, ...reifiedEffectLabels(type.tail, seen)];
  }
  if (type.tag !== "var" || seen.has(type.id)) return [];
  seen.add(type.id);
  return type.lower.flatMap((bound) => reifiedEffectLabels(bound, seen));
}

function reifyBound(bound: Bound, domain: Domain): Value | null {
  if (typeof bound === "bigint") return { tag: "int", value: bound };
  if (typeof bound === "string") return { tag: "text", value: bound };
  void domain;
  return null;
}
