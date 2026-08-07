import "../comptime/region_primitives.ts";
import { scheme } from "./constrain.ts";
import { PRIMITIVE_TYPES } from "./primitives.ts";
import {
  effects,
  freshVar,
  fun,
  INT,
  type Scheme,
  type SimpleType,
  tupleType,
  UNIT,
  variant,
} from "./type.ts";

const PURE = effects([]);
const TYPE: SimpleType = { tag: "opaque", name: "Type" };

function curried(
  params: readonly SimpleType[],
  result: SimpleType,
): SimpleType {
  let built = result;
  for (let index = params.length - 1; index >= 0; index -= 1) {
    built = fun(params[index], built, PURE);
  }
  return built;
}

function poly(build: (fresh: () => SimpleType) => SimpleType): Scheme {
  const fresh = (): SimpleType => freshVar(1);
  return scheme(build(fresh), 0);
}

function mono(type: SimpleType): Scheme {
  return scheme(type, 0);
}

export const REGION_PRIMITIVE_TYPES: ReadonlyMap<string, Scheme> = new Map([
  ["@region.array.type", mono(curried([TYPE], TYPE))],
  [
    "@region.array.claim",
    poly((fresh) => {
      const element = fresh();
      return curried(
        [{ tag: "array", element }],
        { tag: "region", element },
      );
    }),
  ],
  [
    "@region.array.length",
    poly((fresh) => curried([{ tag: "region", element: fresh() }], INT)),
  ],
  [
    "@region.array.get",
    poly((fresh) => {
      const element = fresh();
      return curried([{ tag: "region", element }, INT], element);
    }),
  ],
  [
    "@region.array.set",
    poly((fresh) => {
      const element = fresh();
      const region: SimpleType = { tag: "region", element };
      return curried([region, INT, element], region);
    }),
  ],
  [
    "@region.array.swap",
    poly((fresh) => {
      const element = fresh();
      const region: SimpleType = { tag: "region", element };
      return curried([region, INT, INT], region);
    }),
  ],
  [
    "@region.array.split",
    poly((fresh) => {
      const element = fresh();
      const region: SimpleType = { tag: "region", element };
      return curried(
        [region, INT],
        variant([
          ["Split", tupleType([region, region])],
          ["SplitOutOfBounds", region],
        ]),
      );
    }),
  ],
  [
    "@region.array.join",
    poly((fresh) => {
      const region: SimpleType = { tag: "region", element: fresh() };
      return curried([region, region], region);
    }),
  ],
  [
    "@region.array.freeze",
    poly((fresh) => {
      const element = fresh();
      return curried(
        [{ tag: "region", element }],
        { tag: "array", element },
      );
    }),
  ],
]);

const table = PRIMITIVE_TYPES as Map<string, Scheme>;
for (const [name, type] of REGION_PRIMITIVE_TYPES) {
  table.set(name, type);
}
