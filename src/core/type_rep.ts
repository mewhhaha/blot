import type { Bound, Domain, SimpleType } from "../check/type.ts";

export type TyRepId = number;

export type TyRepNode =
  | {
    readonly tag: "variable";
    readonly variable: number;
    readonly lower: readonly TyRepId[];
    readonly upper: readonly TyRepId[];
  }
  | { readonly tag: "rigid"; readonly variable: number }
  | {
    readonly tag: "forall";
    readonly variables: readonly number[];
    readonly body: TyRepId;
  }
  | {
    readonly tag: "range";
    readonly domain: Domain;
    readonly low: Bound;
    readonly high: Bound;
  }
  | { readonly tag: "unit" }
  | {
    readonly tag: "function";
    readonly parameter: TyRepId;
    readonly effects: TyRepId;
    readonly result: TyRepId;
  }
  | { readonly tag: "record"; readonly fields: ReadonlyMap<string, TyRepId> }
  | { readonly tag: "array"; readonly element: TyRepId }
  | { readonly tag: "region"; readonly element: TyRepId }
  | {
    readonly tag: "variant";
    readonly cases: ReadonlyMap<string, TyRepId>;
    readonly open: boolean;
  }
  | { readonly tag: "effects"; readonly labels: ReadonlySet<string> }
  | {
    readonly tag: "open-effects";
    readonly labels: ReadonlySet<string>;
    readonly tail: TyRepId;
  }
  | {
    readonly tag: "open-effects";
    readonly labels: ReadonlySet<string>;
    readonly tail: TyRepId;
  }
  | {
    readonly tag: "open-effects";
    readonly labels: ReadonlySet<string>;
    readonly tail: TyRepId;
  }
  | {
    readonly tag: "open-effects";
    readonly labels: ReadonlySet<string>;
    readonly tail: TyRepId;
  }
  | { readonly tag: "union"; readonly members: readonly TyRepId[] }
  | { readonly tag: "opaque"; readonly name: string }
  | { readonly tag: "top" }
  | { readonly tag: "bottom" };

export interface TyRepTable {
  readonly nodes: readonly TyRepNode[];
}

export class TyRepBuilder {
  readonly #references = new Map<SimpleType, TyRepId>();
  readonly #nodes: TyRepNode[] = [];

  reference(type: SimpleType): TyRepId {
    const existing = this.#references.get(type);
    if (existing !== undefined) return existing;
    const id = this.#nodes.length;
    this.#references.set(type, id);
    this.#nodes.push({ tag: "bottom" });
    this.#nodes[id] = this.node(type);
    return id;
  }

  table(): TyRepTable {
    return { nodes: [...this.#nodes] };
  }

  node(type: SimpleType): TyRepNode {
    switch (type.tag) {
      case "var": {
        return {
          tag: "variable",
          variable: type.id,
          lower: type.lower.map((bound) => this.reference(bound)),
          upper: type.upper.map((bound) => this.reference(bound)),
        };
      }
      case "rigid":
        return { tag: "rigid", variable: type.id };
      case "forall":
        return {
          tag: "forall",
          variables: type.variables,
          body: this.reference(type.body),
        };
      case "range":
        return {
          tag: "range",
          domain: type.domain,
          low: type.low,
          high: type.high,
        };
      case "unit":
        return { tag: "unit" };
      case "fun":
        return {
          tag: "function",
          parameter: this.reference(type.param),
          effects: this.reference(type.effects),
          result: this.reference(type.result),
        };
      case "record":
        return {
          tag: "record",
          fields: new Map(
            [...type.fields].map(([name, field]) =>
              [name, this.reference(field)] as const
            ),
          ),
        };
      case "array":
        return { tag: "array", element: this.reference(type.element) };
      case "region":
        return { tag: "region", element: this.reference(type.element) };
      case "variant":
        return {
          tag: "variant",
          cases: new Map(
            [...type.cases].map(([name, payload]) =>
              [name, this.reference(payload)] as const
            ),
          ),
          open: type.open,
        };
      case "effects":
        return { tag: "effects", labels: new Set(type.labels) };
      case "open-effects":
        return {
          tag: "open-effects",
          labels: new Set(type.labels),
          tail: this.reference(type.tail),
        };
      case "open-effects":
        return {
          tag: "open-effects",
          labels: new Set(type.labels),
          tail: this.reference(type.tail),
        };
      case "open-effects":
        return {
          tag: "open-effects",
          labels: new Set(type.labels),
          tail: this.reference(type.tail),
        };
      case "open-effects":
        return {
          tag: "open-effects",
          labels: new Set(type.labels),
          tail: this.reference(type.tail),
        };
      case "union":
        return {
          tag: "union",
          members: type.members.map((member) => this.reference(member)),
        };
      case "opaque":
        return { tag: "opaque", name: type.name };
      case "top":
        return { tag: "top" };
      case "bottom":
        return { tag: "bottom" };
    }
  }
}
