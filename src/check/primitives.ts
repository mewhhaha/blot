// Type schemes for the `@` namespace.
//
// The table is short because the namespace is. Everything else — `+`, `==`,
// `struct`, `fold` — is prelude source and gets inferred like any other blot
// code.
//
// `@shape.get`, `@shape.set` and `@shape.remove` are the three whose result no
// entry here can state, because they name their field with a value rather than
// with a literal. The schemes below are what a *partial* application of one of
// them has; a saturated call is typed at its call site by `inferShapeProjection`
// in `infer.ts`, which runs the projection at compile time.
//
// This file used to defend the unconstrained variable in those results as "the
// honest answer", on the grounds that the field is not determined until the name
// is known. The second half is true and the first does not follow. A variable is
// not the absence of a claim: every constraint on one is satisfiable, so it is
// the most permissive element the lattice has, and a `sig` written over one is
// believed rather than checked. `sig z = 0; let z = @shape.get r "a";` checked
// as `0` and evaluated to `7`. The name is known by the time it matters, so the
// call site is where these get their type.

import {
  BOTTOM,
  effects,
  F32X4,
  F32X4_MASK,
  FLOAT,
  FLOAT32,
  freshVar,
  fun,
  I16X8,
  I16X8_MASK,
  I32X4,
  I32X4_MASK,
  I8X16,
  I8X16_MASK,
  INT,
  record,
  type Scheme,
  type SimpleType,
  TEXT,
  tupleType,
  UNIT,
  variant,
} from "./type.ts";
import { scheme } from "./constrain.ts";

const BOOL: SimpleType = variant([["True", UNIT], ["False", UNIT]]);
const ORDERING: SimpleType = variant([
  ["Less", UNIT],
  ["Equal", UNIT],
  ["Greater", UNIT],
]);

/** A type value — what `@type.*` produces. Opaque to inference by design. */
const TYPE: SimpleType = { tag: "opaque", name: "Type" };

/**
 * What `@type.reflect` answers with.
 *
 * Every type-valued payload is a *fresh variable*, not the opaque `Type`. Types
 * are values, so a record of types is a type and so is `42`; there is no type
 * smaller than "any value" that reflection could promise about a payload.
 * Inference therefore learns which case it has — enough to check the `case`
 * arms — and learns nothing about what is inside.
 *
 * A variable is a permission and not an absence, which is the lesson the shape
 * projections above were rewritten for, so these payloads are the same door left
 * open: a `sig` over one is believed. Closing it means giving reflection a
 * call-site rule the way `inferShapeProjection` gives the projections one, and
 * that is a change to `@type.reflect` rather than a wording fix here.
 */
function reflection(fresh: () => SimpleType): SimpleType {
  return variant([
    ["Int", INT],
    ["Text", TEXT],
    ["Unit", UNIT],
    ["Unbounded", UNIT],
    ["Opaque", UNIT],
    ["Forall", UNIT],
    [
      "Tag",
      record([
        ["name", TEXT],
        ["payload", variant([["None", UNIT], ["Some", fresh()]])],
      ]),
    ],
    [
      "Range",
      record([
        ["low", fresh()],
        ["high", fresh()],
        [
          "domain",
          variant([
            ["Int", UNIT],
            ["Text", UNIT],
            ["F64", UNIT],
            ["F32", UNIT],
          ]),
        ],
      ]),
    ],
    ["Union", { tag: "array", element: fresh() }],
    ["Shape", fresh()],
    ["Array", { tag: "array", element: fresh() }],
    [
      "Arrow",
      record([
        ["domain", fresh()],
        ["codomain", fresh()],
        // The row, as the effects themselves. Nothing in blot can take an
        // effect apart — it reflects as `#Opaque` — so what this buys a program
        // is how many there are, which is enough to refuse an arrow that
        // performs rather than guess whether one row contains another.
        ["effects", { tag: "array", element: fresh() }],
        // Which side evaluates the argument. Reflection answers it for every
        // arrow, so a program that decides whether one arrow refines another
        // can see the calling convention the checker compares.
        ["deferred", BOOL],
      ]),
    ],
    ["Sealed", record([["name", TEXT], ["inner", fresh()]])],
  ]);
}

const PURE = effects([]);

/** Curried, like every blot function. `a -> b -> c`, not `(a, b) -> c`. */
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

/** Builds a scheme whose quantified variables live one level above ground. */
function poly(build: (fresh: () => SimpleType) => SimpleType): Scheme {
  const fresh = (): SimpleType => freshVar(1);
  return scheme(build(fresh), 0);
}

function mono(type: SimpleType): Scheme {
  return scheme(type, 0);
}

type PrimitiveTypeEntry = readonly [string, Scheme];

function integerSimdTypes(
  prefix: "i32x4" | "i16x8" | "i8x16",
  vector: SimpleType,
  mask: SimpleType,
  multiply: boolean,
  extendedComparisons: boolean,
): PrimitiveTypeEntry[] {
  const entries: PrimitiveTypeEntry[] = [];
  let lane: SimpleType = {
    tag: "range",
    domain: "int",
    low: -0x80000000n,
    high: 0x7fffffffn,
  };
  if (prefix === "i16x8") {
    lane = { tag: "range", domain: "int", low: -0x8000n, high: 0x7fffn };
  }
  if (prefix === "i8x16") {
    lane = { tag: "range", domain: "int", low: -0x80n, high: 0x7fn };
  }
  const unary = ["not"];
  const binary = [
    "add",
    "sub",
    "and",
    "or",
    "xor",
    "min_s",
    "min_u",
    "max_s",
    "max_u",
  ];
  const comparisons = ["eq", "lt_s", "lt_u"];
  if (multiply) binary.push("mul");
  if (extendedComparisons) {
    comparisons.push("ne", "gt_s", "gt_u", "le_s", "le_u", "ge_s", "ge_u");
  }
  entries.push(
    [`@${prefix}.splat`, mono(curried([lane], vector))],
    [`@${prefix}.splat_wrapping`, mono(curried([INT], vector))],
  );
  unary.forEach((name) =>
    entries.push([`@${prefix}.${name}`, mono(curried([vector], vector))])
  );
  binary.forEach((name) =>
    entries.push([
      `@${prefix}.${name}`,
      mono(curried([vector, vector], vector)),
    ])
  );
  comparisons.forEach((name) =>
    entries.push([`@${prefix}.${name}`, mono(curried([vector, vector], mask))])
  );
  ["shl", "shr_s", "shr_u"].forEach((name) =>
    entries.push([`@${prefix}.${name}`, mono(curried([vector, INT], vector))])
  );
  entries.push([
    `@${prefix}.select`,
    mono(curried([mask, vector, vector], vector)),
  ]);
  ["mask_bitmask", "mask_all", "mask_any"].forEach((name) =>
    entries.push([`@${prefix}.${name}`, mono(curried([mask], INT))])
  );
  return entries;
}

function additionalSimdTypes(): PrimitiveTypeEntry[] {
  const entries: PrimitiveTypeEntry[] = [];
  const i32: SimpleType = {
    tag: "range",
    domain: "int",
    low: -0x80000000n,
    high: 0x7fffffffn,
  };
  entries.push(
    ["@i32x4.of", mono(curried([i32, i32, i32, i32], I32X4))],
    ["@i32x4.of_wrapping", mono(curried([INT, INT, INT, INT], I32X4))],
    [
      "@i32x4.lane",
      mono(curried([
        I32X4,
        { tag: "range", domain: "int", low: 0n, high: 3n },
      ], INT)),
    ],
  );
  [0, 1, 2, 3].forEach((lane) => {
    entries.push(
      [`@i32x4.lane${lane}`, mono(curried([I32X4], INT))],
      [`@i32x4.with_lane${lane}`, mono(curried([I32X4, i32], I32X4))],
      [
        `@i32x4.with_lane${lane}_wrapping`,
        mono(curried([I32X4, INT], I32X4)),
      ],
    );
  });
  entries.push(
    ...integerSimdTypes("i32x4", I32X4, I32X4_MASK, true, true),
    ...integerSimdTypes("i16x8", I16X8, I16X8_MASK, true, true),
    ...integerSimdTypes("i8x16", I8X16, I8X16_MASK, false, true),
  );
  return entries;
}

export const PRIMITIVE_TYPES: ReadonlyMap<string, Scheme> = new Map<
  string,
  Scheme
>([
  // --- integers ---
  ["@int.add", mono(curried([INT, INT], INT))],
  ["@int.sub", mono(curried([INT, INT], INT))],
  ["@int.mul", mono(curried([INT, INT], INT))],
  ["@int.div", mono(curried([INT, INT], INT))],
  ["@int.rem", mono(curried([INT, INT], INT))],
  ["@int.neg", mono(curried([INT], INT))],
  // One comparison primitive; `Eq` and `Ord` are prelude source over it.
  ["@int.cmp", mono(curried([INT, INT], ORDERING))],

  // --- floats ---
  //
  // `Float` is one type: every float range is open at both ends, so unlike the
  // integer primitives these say nothing about the value they produce beyond
  // its domain.
  ["@float.add", mono(curried([FLOAT, FLOAT], FLOAT))],
  ["@float.sub", mono(curried([FLOAT, FLOAT], FLOAT))],
  ["@float.mul", mono(curried([FLOAT, FLOAT], FLOAT))],
  ["@float.div", mono(curried([FLOAT, FLOAT], FLOAT))],
  ["@float.rem", mono(curried([FLOAT, FLOAT], FLOAT))],
  ["@float.neg", mono(curried([FLOAT], FLOAT))],
  ["@float.is_nan", mono(curried([FLOAT], BOOL))],
  ["@float.cmp", mono(curried([FLOAT, FLOAT], ORDERING))],
  ["@float.of_int", mono(curried([INT], FLOAT))],
  ["@int.of_float", mono(curried([FLOAT], INT))],

  // --- single precision ---
  //
  // A distinct type, so a program cannot mix the two precisions by accident
  // and a lane's width is visible in the signature that carries it.
  ["@f32.add", mono(curried([FLOAT32, FLOAT32], FLOAT32))],
  ["@f32.sub", mono(curried([FLOAT32, FLOAT32], FLOAT32))],
  ["@f32.mul", mono(curried([FLOAT32, FLOAT32], FLOAT32))],
  ["@f32.div", mono(curried([FLOAT32, FLOAT32], FLOAT32))],
  ["@f32.neg", mono(curried([FLOAT32], FLOAT32))],
  ["@f32.cmp", mono(curried([FLOAT32, FLOAT32], ORDERING))],
  ["@f32.is_nan", mono(curried([FLOAT32], BOOL))],
  ["@f32.of_float", mono(curried([FLOAT], FLOAT32))],
  ["@float.of_f32", mono(curried([FLOAT32], FLOAT))],

  // --- four lanes ---
  ["@f32x4.of", mono(curried([FLOAT32, FLOAT32, FLOAT32, FLOAT32], F32X4))],
  ["@f32x4.splat", mono(curried([FLOAT32], F32X4))],
  ["@f32x4.add", mono(curried([F32X4, F32X4], F32X4))],
  ["@f32x4.sub", mono(curried([F32X4, F32X4], F32X4))],
  ["@f32x4.mul", mono(curried([F32X4, F32X4], F32X4))],
  ["@f32x4.div", mono(curried([F32X4, F32X4], F32X4))],
  ["@f32x4.eq", mono(curried([F32X4, F32X4], F32X4_MASK))],
  ["@f32x4.less", mono(curried([F32X4, F32X4], F32X4_MASK))],
  ["@f32x4.select", mono(curried([F32X4_MASK, F32X4, F32X4], F32X4))],
  ["@f32x4.shuffle", mono(curried([F32X4, F32X4, INT, INT, INT, INT], F32X4))],
  ["@f32x4.sum", mono(curried([F32X4], FLOAT32))],
  ["@f32x4.x", mono(curried([F32X4], FLOAT32))],
  ["@f32x4.y", mono(curried([F32X4], FLOAT32))],
  ["@f32x4.z", mono(curried([F32X4], FLOAT32))],
  ["@f32x4.w", mono(curried([F32X4], FLOAT32))],
  ...additionalSimdTypes(),

  // --- branch layout metadata ---
  ["@branch.likely", mono(curried([BOOL], BOOL))],
  ["@branch.unlikely", mono(curried([BOOL], BOOL))],

  // --- text ---
  ["@text.concat", mono(curried([TEXT, TEXT], TEXT))],
  ["@text.len", mono(curried([TEXT], INT))],
  ["@text.cmp", mono(curried([TEXT, TEXT], ORDERING))],
  ["@text.contains", mono(curried([TEXT, TEXT], BOOL))],
  ["@text.of_int", mono(curried([INT], TEXT))],
  [
    "@json.parse",
    poly((fresh) => {
      const source = record([
        ["specifier", TEXT],
        ["path", TEXT],
        ["text", TEXT],
      ]);
      return curried(
        [variant([["Widen", UNIT], ["Exact", UNIT]]), source],
        fresh(),
      );
    }),
  ],

  // --- arrays ---
  ["@array.empty", poly((fresh) => ({ tag: "array", element: fresh() }))],
  [
    "@array.len",
    poly((fresh) => curried([{ tag: "array", element: fresh() }], INT)),
  ],
  [
    "@array.get",
    poly((fresh) => {
      const element = fresh();
      return curried([{ tag: "array", element }, INT], element);
    }),
  ],
  [
    "@array.set",
    poly((fresh) => {
      const element = fresh();
      const array: SimpleType = { tag: "array", element };
      return curried([array, INT, element], array);
    }),
  ],
  [
    "@array.push",
    poly((fresh) => {
      const element = fresh();
      const array: SimpleType = { tag: "array", element };
      return curried([array, element], array);
    }),
  ],
  [
    "@array.take",
    poly((fresh) => {
      const element = fresh();
      const array: SimpleType = { tag: "array", element };
      return curried([array, INT], tupleType([element, array]));
    }),
  ],
  [
    "@array.split",
    poly((fresh) => {
      const element = fresh();
      const array: SimpleType = { tag: "array", element };
      return curried([array, INT], tupleType([array, element, array]));
    }),
  ],
  [
    "@array.indexed",
    poly((fresh) => {
      const element = fresh();
      const stepResult = variant([
        ["None", UNIT],
        ["Some", tupleType([tupleType([INT, element]), INT])],
      ]);
      return curried(
        [{
          tag: "array",
          element,
        }],
        record([
          ["state", INT],
          ["step", curried([INT], stepResult)],
        ]),
      );
    }),
  ],

  // --- shapes ---
  //
  // The three projections are typed at their call sites; these schemes are only
  // what a partial application of one has. See the note at the top of the file.
  ["@shape.empty", mono(record([]))],
  ["@shape.get", poly((fresh) => curried([fresh(), TEXT], fresh()))],
  ["@shape.set", poly((fresh) => curried([fresh(), TEXT, fresh()], fresh()))],
  ["@shape.remove", poly((fresh) => curried([fresh(), TEXT], fresh()))],
  [
    "@shape.names",
    poly((fresh) => curried([fresh()], { tag: "array", element: TEXT })),
  ],
  ["@shape.has", poly((fresh) => curried([fresh(), TEXT], BOOL))],

  // --- types are values, and a type value is opaque to inference ---
  ["@type.unbounded", mono(TYPE)],
  ["@type.int", mono(TYPE)],
  ["@type.text", mono(TYPE)],
  ["@type.unit", mono(UNIT)],
  // Type algebra operates on values, because types *are* values: `1 | 2` unions
  // two integers and `#Ready | #Failed Text` unions two constructors. Requiring
  // `Type` on the operands would reject exactly the programs the design exists
  // to allow. Precision comes from bridging the computed value at the `sig`,
  // not from constraining the operands here.
  ["@type.range", poly((fresh) => curried([fresh(), fresh()], TYPE))],
  ["@type.refine", poly((fresh) => curried([fresh(), fresh()], TYPE))],
  ["@type.equal", poly((fresh) => curried([fresh(), fresh()], BOOL))],
  ["@type.instantiate", poly((fresh) => curried([fresh(), fresh()], TYPE))],
  ["@type.probe", poly((fresh) => curried([fresh()], TYPE))],
  ["@type.union", poly((fresh) => curried([fresh(), fresh()], TYPE))],
  ["@type.intersect", poly((fresh) => curried([fresh(), fresh()], TYPE))],
  ["@type.diff", poly((fresh) => curried([fresh(), fresh()], TYPE))],
  ["@type.defer", poly((fresh) => curried([fresh()], TYPE))],
  ["@type.arrow", poly((fresh) => curried([fresh(), fresh()], TYPE))],
  ["@type.performs", poly((fresh) => curried([fresh(), fresh()], TYPE))],
  ["@type.of", poly((fresh) => curried([fresh()], TYPE))],
  ["@type.seal", poly((fresh) => curried([TEXT, fresh()], TYPE))],
  ["@type.open", poly((fresh) => curried([fresh()], fresh()))],
  // `@fail` never returns, so its result is whatever the context needs.
  ["@fail", poly((fresh) => curried([TEXT], fresh()))],
  [
    "@type.reflect",
    (() => {
      const input = freshVar(1);
      return scheme(
        curried(
          [input],
          reflection(() => freshVar(1, "reflection")),
        ),
        0,
      );
    })(),
  ],
  // Attaching a member returns the same type value. Inference sees straight
  // through the namespace, so the result is the target unchanged.
  ["@type.attach", poly((fresh) => curried([fresh(), TEXT, fresh()], TYPE))],
  ["@type.members", poly((fresh) => curried([fresh()], fresh()))],
  [
    "@type.union_of",
    poly((fresh) => curried([{ tag: "array", element: fresh() }], TYPE)),
  ],
  [
    "@forall",
    poly((fresh) => {
      const body = fresh();
      return curried([body], body);
    }),
  ],
  // Typed at its application site by `inferSpecial`: a canonical type
  // constrains the subject, while a predicate inspects its closed inferred type.
  [
    "@satisfies",
    poly((fresh) => {
      const value = fresh();
      return curried([value, fresh()], value);
    }),
  ],

  // --- ownership; the linearity pass gives these meaning ---
  [
    "@continuation.cancel",
    poly((fresh) => fun(fresh(), UNIT, effects(["@continuation.cancel"]))),
  ],
  [
    "@linear.own",
    poly((fresh) => {
      const value = fresh();
      return curried([value], value);
    }),
  ],
  [
    "@linear.maybe",
    poly((fresh) => {
      const value = fresh();
      return curried([value], value);
    }),
  ],
  [
    "@linear.borrow",
    poly((fresh) => {
      const value = fresh();
      return curried([value], value);
    }),
  ],

  ["@panic", mono(curried([TEXT], BOTTOM))],
  [
    "@include",
    poly((fresh) => {
      const result = fresh();
      const source = record([
        ["specifier", TEXT],
        ["path", TEXT],
        ["text", TEXT],
      ]);
      return curried([TEXT, fun(source, result, PURE)], result);
    }),
  ],
  ["@import", poly((fresh) => curried([TEXT], fresh()))],
]);

export { BOOL, ORDERING, TYPE };
