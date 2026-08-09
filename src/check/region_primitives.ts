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
/**
 * The recombination witness minted by a successful split. Opaque and
 * element-free: the pairing between a witness and its two parts lives in the
 * ownership analysis, never in the type lattice.
 */
const REJOIN: SimpleType = { tag: "opaque", name: "Rejoin" };

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
  ["@region.type", mono(curried([TYPE], TYPE))],
  ["@region.rejoin", mono(TYPE)],
  [
    "@region.claim",
    poly((fresh) => {
      const element = fresh();
      return curried(
        [{ tag: "array", element }],
        { tag: "region", element },
      );
    }),
  ],
  [
    "@region.length",
    poly((fresh) => curried([{ tag: "region", element: fresh() }], INT)),
  ],
  [
    "@region.get",
    poly((fresh) => {
      const element = fresh();
      return curried(
        [{ tag: "region", element }, INT],
        variant([
          ["Some", element],
          ["None", UNIT],
        ]),
      );
    }),
  ],
  [
    "@region.set",
    poly((fresh) => {
      const element = fresh();
      const region: SimpleType = { tag: "region", element };
      return curried(
        [region, INT, element],
        variant([
          ["Updated", region],
          ["SetOutOfBounds", region],
        ]),
      );
    }),
  ],
  [
    "@region.swap",
    poly((fresh) => {
      const element = fresh();
      const region: SimpleType = { tag: "region", element };
      return curried(
        [region, INT, INT],
        variant([
          ["Updated", region],
          ["SwapOutOfBounds", region],
        ]),
      );
    }),
  ],
  [
    "@region.split",
    poly((fresh) => {
      const element = fresh();
      const region: SimpleType = { tag: "region", element };
      return curried(
        [region, INT],
        variant([
          ["Split", tupleType([region, region, REJOIN])],
          ["SplitOutOfBounds", region],
        ]),
      );
    }),
  ],
  [
    "@region.join",
    poly((fresh) => {
      const region: SimpleType = { tag: "region", element: fresh() };
      return curried([REJOIN, region, region], region);
    }),
  ],
  [
    "@region.freeze",
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
