// The `@` namespace: the entire compiler surface.
//
// Everything else — `struct`, `packed`, `Bool`, `Option`, `fold`, `+`, `==` —
// is prelude source in `src/prelude`. A capability earns a primitive only when
// it cannot be written in blot at all.
//
// Primitives are curried, like every other blot function. The readable
// tuple-taking spellings (`range (low, high)`) are prelude wrappers, which is
// where the ergonomics belong.

import { fail } from "../diagnostic.ts";
import {
  asTuple,
  bool,
  equal,
  F32X4_MASK_NAME,
  F32X4_NAME,
  I16X8_MASK_NAME,
  I16X8_NAME,
  I32X4_MASK_NAME,
  I32X4_NAME,
  I8X16_MASK_NAME,
  I8X16_NAME,
  registerEffectExtension,
  show,
  substituteTypeVariable,
  tupleOf,
  UNIT,
  type Value,
} from "./value.ts";
import { parseJson } from "./json.ts";
import {
  arrayElements,
  float32,
  float32Of,
  floatOf,
  I64_HIGH,
  I64_LOW,
  integerResult,
  intOf,
  type Primitive,
  shapeFields,
  textOf,
} from "./coerce.ts";
import {
  additionalSimdEntries,
  do_splat,
  lanewise,
  vectorMaskOf,
  vectorOf,
} from "./simd.ts";
import {
  compare,
  difference,
  inhabits,
  intersect,
  ordering,
  performs,
  reflect,
  typeOf,
  union,
} from "./reflect.ts";

export type { Primitive };
export { inhabits };

let brands = 0;

export const PRIMITIVE_VALUES: ReadonlyMap<string, Value> = new Map<
  string,
  Value
>([
  ["@type.unbounded", { tag: "unbounded" }],
  // The unit type is the unit value. A singleton type is its inhabitant.
  ["@type.unit", UNIT],
  // The unbounded domains. A range with two open ends cannot say which domain
  // it means, so these name it.
  ["@type.int", {
    tag: "range",
    low: { tag: "int", value: I64_LOW },
    high: { tag: "int", value: I64_HIGH },
    domain: "int",
  }],
  ["@type.text", {
    tag: "range",
    low: { tag: "unbounded" },
    high: { tag: "unbounded" },
    domain: "text",
  }],
  // Four lanes are not an interval, so this is the one type value with no parts
  // rather than a range that would never be asked about its bounds.
  ["@type.f32x4", { tag: "opaque-type", name: F32X4_NAME }],
  ["@type.f32x4_mask", { tag: "opaque-type", name: F32X4_MASK_NAME }],
  ["@type.i32x4", { tag: "opaque-type", name: I32X4_NAME }],
  ["@type.i32x4_mask", { tag: "opaque-type", name: I32X4_MASK_NAME }],
  ["@type.i16x8", { tag: "opaque-type", name: I16X8_NAME }],
  ["@type.i16x8_mask", { tag: "opaque-type", name: I16X8_MASK_NAME }],
  ["@type.i8x16", { tag: "opaque-type", name: I8X16_NAME }],
  ["@type.i8x16_mask", { tag: "opaque-type", name: I8X16_MASK_NAME }],
  // Always open at both ends. A float bound would have to be a real number and
  // nothing in the lattice could use one, so `Float` is the only float type
  // there is.
  ["@type.float32", {
    tag: "range",
    low: { tag: "unbounded" },
    high: { tag: "unbounded" },
    domain: "float32",
  }],
  ["@type.float", {
    tag: "range",
    low: { tag: "unbounded" },
    high: { tag: "unbounded" },
    domain: "float",
  }],
  ["@shape.empty", { tag: "shape", fields: new Map() }],
  ["@array.empty", { tag: "array", elements: [] }],
]);

export const PRIMITIVES: ReadonlyMap<string, Primitive> = new Map<
  string,
  Primitive
>([
  ["@continuation.cancel", {
    arity: 1,
    run: ([continuation], span) => {
      if (continuation.tag !== "continuation") {
        fail(
          "BLOT_CANCEL_NOT_CONTINUATION",
          `Continuation.cancel expects a handler continuation, found ${
            show(continuation)
          }.`,
          span,
        );
      }
      if (continuation.state.used) {
        fail(
          "BLOT_RESUME_TWICE",
          "This continuation has already been resumed or cancelled.",
          span,
        );
      }
      continuation.state.used = true;
      return UNIT;
    },
  }],
  // --- type algebra ---
  ["@type.range", {
    arity: 2,
    run: ([low, high]) => ({ tag: "range", low, high }),
  }],
  ["@type.union", { arity: 2, run: ([left, right]) => union(left, right) }],
  ["@type.intersect", {
    arity: 2,
    run: ([left, right]) => intersect(left, right),
  }],
  ["@type.diff", {
    arity: 2,
    run: ([left, right], span) => difference(left, right, span),
  }],
  ["@type.defer", {
    arity: 1,
    run: ([inner]) => ({ tag: "deferred-type", inner }),
  }],
  ["@type.arrow", {
    arity: 2,
    run: ([domain, codomain]) => {
      if (domain.tag === "deferred-type") {
        return {
          tag: "arrow",
          domain: domain.inner,
          codomain,
          effects: [],
          deferred: true,
        };
      }
      return {
        tag: "arrow",
        domain,
        codomain,
        effects: [],
      };
    },
  }],
  ["@type.performs", {
    arity: 2,
    run: ([arrow, effects], span) => performs(arrow, effects, span),
  }],
  ["@type.of", { arity: 1, run: ([value]) => typeOf(value) }],
  ["@type.seal", {
    arity: 2,
    run: ([name, inner], span) => ({
      tag: "sealed",
      name: textOf(name, span, "@type.seal"),
      inner,
    }),
  }],
  ["@type.open", {
    arity: 1,
    run: ([value], span) => {
      if (value.tag !== "sealed") {
        fail(
          "BLOT_TYPE",
          `@type.open expects a sealed value, found ${show(value)}.`,
          span,
        );
      }
      return value.inner;
    },
  }],
  // Refusing. The one thing a program cannot express itself: every other
  // primitive computes something, and a diagnostic is the absence of a value.
  // `expect` in the prelude is this plus a condition.
  ["@fail", {
    arity: 1,
    run: ([message], span) => {
      fail(
        "BLOT_REFUSED",
        message.tag === "text" ? message.value : show(message),
        span,
      );
    },
  }],
  ["@type.reflect", { arity: 1, run: ([value]) => reflect(value) }],
  ["@type.equal", {
    arity: 2,
    run: ([left, right]) => bool(equal(left, right)),
  }],
  ["@type.instantiate", {
    arity: 2,
    run: ([quantified, argument], span) => {
      if (quantified.tag !== "forall") {
        fail(
          "BLOT_TYPE_INSTANTIATE",
          `@type.instantiate needs an outer quantified type, found ${
            show(quantified)
          }.`,
          span,
        );
      }
      const instantiated = substituteTypeVariable(
        quantified.body,
        quantified.variable,
        argument,
      );
      if (instantiated === null) {
        fail(
          "BLOT_TYPE_INSTANTIATE",
          `${show(argument)} cannot instantiate an effect-row variable.`,
          span,
        );
      }
      return instantiated;
    },
  }],
  // Attaching a member to a type value. This is what lets `struct` hand back
  // the storage type itself with its constructor and accessors reachable on
  // it, rather than a record beside the type. A duplicate is refused, so a
  // field named `new` collides loudly instead of shadowing the constructor.
  ["@type.attach", {
    arity: 3,
    run: ([target, name, member], span) => {
      const key = textOf(name, span, "@type.attach");
      const members = new Map(
        target.tag === "extended" ? target.members : [],
      );
      if (members.has(key)) {
        fail(
          "BLOT_DUPLICATE_MEMBER",
          `\`${key}\` is already a member of ${show(target)}.`,
          span,
        );
      }
      members.set(key, member);
      const extended: Value = {
        tag: "extended",
        inner: target.tag === "extended" ? target.inner : target,
        members,
      };
      if (extended.inner.tag === "effect") {
        registerEffectExtension(extended.inner, extended);
      }
      return extended;
    },
  }],
  ["@type.members", {
    arity: 1,
    run: ([target]) => ({
      tag: "shape",
      fields: new Map(target.tag === "extended" ? target.members : []),
    }),
  }],
  ["@type.union_of", {
    arity: 1,
    run: ([values], span) => {
      const elements = arrayElements(values, span, "@type.union_of");
      if (elements.length === 0) {
        fail(
          "BLOT_EMPTY_TYPE",
          "@type.union_of has nothing to union: union has no identity element, " +
            "so an empty array is not the empty type.",
          span,
        );
      }
      return elements.reduce(union);
    },
  }],

  // Checked entirely by the checker, which is the only place the subject's
  // type exists. By the time the evaluator sees this the question has been
  // answered, so the value passes through — the same shape `@satisfies` has,
  // for the same reason.
  ["@type.satisfies", {
    arity: 1,
    run: ([pair], span) => {
      const parts = asTuple(pair, 2);
      if (parts === null) {
        fail(
          "BLOT_TYPE",
          "@type.satisfies takes a value and a predicate as one tuple.",
          span,
        );
      }
      return parts[0];
    },
  }],
  ["@satisfies", {
    arity: 2,
    run: ([value, type], span) => {
      if (!inhabits(value, type)) {
        fail(
          "BLOT_DOES_NOT_SATISFY",
          `${show(value)} does not inhabit ${show(type)}.`,
          span,
        );
      }
      return value;
    },
  }],

  // --- shapes ---
  ["@shape.get", {
    arity: 2,
    run: ([shape, name], span) => {
      const key = textOf(name, span, "@shape.get");
      const found = shapeFields(shape, span, "@shape.get").get(key);
      if (found === undefined) {
        fail("BLOT_NO_FIELD", `No field \`${key}\` on ${show(shape)}.`, span);
      }
      return found;
    },
  }],
  ["@shape.set", {
    arity: 3,
    run: ([shape, name, value], span) => {
      const fields = new Map(shapeFields(shape, span, "@shape.set"));
      fields.set(textOf(name, span, "@shape.set"), value);
      return { tag: "shape", fields };
    },
  }],
  ["@shape.remove", {
    arity: 2,
    run: ([shape, name], span) => {
      const fields = new Map(shapeFields(shape, span, "@shape.remove"));
      fields.delete(textOf(name, span, "@shape.remove"));
      return { tag: "shape", fields };
    },
  }],
  ["@shape.names", {
    arity: 1,
    run: ([shape], span) => ({
      tag: "array",
      elements: [...shapeFields(shape, span, "@shape.names").keys()].map((
        name,
      ) => ({
        tag: "text" as const,
        value: name,
      })),
    }),
  }],
  ["@shape.has", {
    arity: 2,
    run: ([shape, name], span) =>
      bool(
        shapeFields(shape, span, "@shape.has").has(
          textOf(name, span, "@shape.has"),
        ),
      ),
  }],

  // --- arrays ---
  ["@array.len", {
    arity: 1,
    run: ([array], span) => ({
      tag: "int",
      value: BigInt(arrayElements(array, span, "@array.len").length),
    }),
  }],
  ["@array.get", {
    arity: 2,
    run: ([array, index], span) => {
      const elements = arrayElements(array, span, "@array.get");
      const position = Number(intOf(index, span, "@array.get"));
      if (position < 0 || position >= elements.length) {
        fail(
          "BLOT_OUT_OF_BOUNDS",
          `Index ${position} is outside an array of ${elements.length}.`,
          span,
        );
      }
      return elements[position];
    },
  }],
  ["@array.set", {
    arity: 3,
    run: ([array, index, value], span) => {
      const elements = [...arrayElements(array, span, "@array.set")];
      const position = Number(intOf(index, span, "@array.set"));
      if (position < 0 || position >= elements.length) {
        fail(
          "BLOT_OUT_OF_BOUNDS",
          `Index ${position} is outside an array of ${elements.length}.`,
          span,
        );
      }
      elements[position] = value;
      return { tag: "array", elements };
    },
  }],
  ["@array.push", {
    arity: 2,
    run: ([array, value], span) => ({
      tag: "array",
      elements: [...arrayElements(array, span, "@array.push"), value],
    }),
  }],
  ["@array.indexed", {
    arity: 1,
    run: ([array], span) => {
      const elements = arrayElements(array, span, "@array.indexed");
      return {
        tag: "shape",
        fields: new Map<string, Value>([
          ["state", { tag: "int", value: 0n }],
          ["step", {
            tag: "native",
            name: "@array.indexed.step",
            arity: 1,
            applied: [],
            run: (arguments_: readonly Value[]) => {
              const index = arguments_[0];
              if (index.tag !== "int") {
                throw new Error("an indexed iterator state is not an integer");
              }
              const position = Number(index.value);
              if (position < 0 || position >= elements.length) {
                return { tag: "tag", name: "None", payload: null };
              }
              return {
                tag: "tag",
                name: "Some",
                payload: tupleOf([
                  tupleOf([index, elements[position]]),
                  { tag: "int", value: index.value + 1n },
                ]),
              };
            },
          }],
        ]),
      };
    },
  }],
  ["@array.take", {
    arity: 2,
    run: ([array, index], span) => {
      const elements = arrayElements(array, span, "@array.take");
      const position = Number(intOf(index, span, "@array.take"));
      if (position < 0 || position >= elements.length) {
        fail(
          "BLOT_OUT_OF_BOUNDS",
          `Index ${position} is outside an array of ${elements.length}.`,
          span,
        );
      }
      return tupleOf([
        elements[position],
        {
          tag: "array",
          elements: elements.filter((_, candidate) => candidate !== position),
        },
      ]);
    },
  }],
  ["@array.split", {
    arity: 2,
    run: ([array, index], span) => {
      const elements = arrayElements(array, span, "@array.split");
      const position = Number(intOf(index, span, "@array.split"));
      if (position < 0 || position >= elements.length) {
        fail(
          "BLOT_OUT_OF_BOUNDS",
          `Index ${position} is outside an array of ${elements.length}.`,
          span,
        );
      }
      return tupleOf([
        { tag: "array", elements: elements.slice(0, position) },
        elements[position],
        { tag: "array", elements: elements.slice(position + 1) },
      ]);
    },
  }],

  // --- integers ---
  ["@int.add", {
    arity: 2,
    run: ([l, r], span, phase) =>
      integerResult(
        intOf(l, span, "@int.add") + intOf(r, span, "@int.add"),
        span,
        "@int.add",
        phase,
      ),
  }],
  ["@int.sub", {
    arity: 2,
    run: ([l, r], span, phase) =>
      integerResult(
        intOf(l, span, "@int.sub") - intOf(r, span, "@int.sub"),
        span,
        "@int.sub",
        phase,
      ),
  }],
  ["@int.mul", {
    arity: 2,
    run: ([l, r], span, phase) =>
      integerResult(
        intOf(l, span, "@int.mul") * intOf(r, span, "@int.mul"),
        span,
        "@int.mul",
        phase,
      ),
  }],
  ["@int.div", {
    arity: 2,
    run: ([l, r], span, phase) => {
      const divisor = intOf(r, span, "@int.div");
      if (divisor === 0n) {
        fail("BLOT_DIVIDE_BY_ZERO", "Division by zero.", span);
      }
      return integerResult(
        intOf(l, span, "@int.div") / divisor,
        span,
        "@int.div",
        phase,
      );
    },
  }],
  ["@int.rem", {
    arity: 2,
    run: ([l, r], s) => {
      const divisor = intOf(r, s, "@int.rem");
      if (divisor === 0n) fail("BLOT_DIVIDE_BY_ZERO", "Remainder by zero.", s);
      return { tag: "int", value: intOf(l, s, "@int.rem") % divisor };
    },
  }],
  ["@int.neg", {
    arity: 1,
    run: ([value], span, phase) =>
      integerResult(
        -intOf(value, span, "@int.neg"),
        span,
        "@int.neg",
        phase,
      ),
  }],
  // One comparison primitive. `Eq` and `Ord` are prelude source over it.
  //
  // Integers only, which is what its name and its declared type both say.
  // `compare` is more general because a range bound may be text, but reaching
  // that generality through here let `"a" == "b"` run while failing to check —
  // the two executions have to agree, and `Text.cmp` is the one for text.
  ["@int.cmp", {
    arity: 2,
    run: ([l, r], s) => {
      if (l.tag !== "int" || r.tag !== "int") {
        fail(
          "BLOT_TYPE",
          `@int.cmp compares two integers, found ${show(l)} and ${
            show(r)
          }. \`Text.cmp\` compares text.`,
          s,
        );
      }
      return ordering(compare(l, r, s, "@int.cmp"));
    },
  }],

  // --- text ---
  ["@text.concat", {
    arity: 2,
    run: ([l, r], s) => ({
      tag: "text",
      value: textOf(l, s, "@text.concat") + textOf(r, s, "@text.concat"),
    }),
  }],
  ["@text.len", {
    arity: 1,
    run: ([v], s) => ({
      tag: "int",
      value: BigInt([...textOf(v, s, "@text.len")].length),
    }),
  }],
  ["@text.cmp", {
    arity: 2,
    run: ([l, r], s) => ordering(compare(l, r, s, "@text.cmp")),
  }],
  ["@text.contains", {
    arity: 2,
    run: ([text, query], span) =>
      bool(
        textOf(text, span, "@text.contains").includes(
          textOf(query, span, "@text.contains"),
        ),
      ),
  }],
  ["@text.of_int", {
    arity: 1,
    run: ([v], s) => ({
      tag: "text",
      value: intOf(v, s, "@text.of_int").toString(),
    }),
  }],

  ["@json.parse", {
    arity: 2,
    run: ([mode, source], span, phase) => {
      if (phase !== "comptime") {
        fail(
          "BLOT_JSON_NOT_COMPTIME",
          "`@json.parse` can only be evaluated at compile time.",
          span,
        );
      }
      if (mode.tag !== "tag" || mode.payload !== null) {
        fail(
          "BLOT_TYPE",
          "`@json.parse` expects `#Widen` or `#Exact` as its inference policy.",
          span,
        );
      }
      const text = shapeFields(source, span, "@json.parse").get("text");
      if (text === undefined) {
        fail("BLOT_TYPE", "`@json.parse` source has no `.text` field.", span);
      }
      const json = textOf(text, span, "@json.parse");
      if (mode.name === "Widen") {
        return parseJson(json, "widen", span);
      }
      if (mode.name === "Exact") {
        return parseJson(json, "exact", span);
      }
      fail(
        "BLOT_TYPE",
        `\`@json.parse\` does not recognize inference policy \`#${mode.name}\`.`,
        span,
      );
    },
  }],

  // --- ownership (given meaning by the linearity pass; identity when running) ---
  ["@linear.own", { arity: 1, run: ([value]) => value }],
  ["@linear.maybe", { arity: 1, run: ([value]) => value }],
  ["@linear.borrow", { arity: 1, run: ([value]) => value }],

  // --- floats ---------------------------------------------------------------
  //
  // Doubles, and no range checks: IEEE 754 says what overflow produces and the
  // answer is an infinity, which is a value the program may go on to use. That
  // is the difference from `@int.add`, where the result would be a number the
  // machine cannot hold.

  ["@float.add", {
    arity: 2,
    run: ([l, r], s) => ({
      tag: "float",
      value: floatOf(l, s, "@float.add") + floatOf(r, s, "@float.add"),
    }),
  }],
  ["@float.sub", {
    arity: 2,
    run: ([l, r], s) => ({
      tag: "float",
      value: floatOf(l, s, "@float.sub") - floatOf(r, s, "@float.sub"),
    }),
  }],
  ["@float.mul", {
    arity: 2,
    run: ([l, r], s) => ({
      tag: "float",
      value: floatOf(l, s, "@float.mul") * floatOf(r, s, "@float.mul"),
    }),
  }],
  // Division by zero is an infinity rather than a diagnostic, unlike
  // `@int.div`. The three executions have to agree, and WebAssembly's `f64.div`
  // does not trap.
  ["@float.div", {
    arity: 2,
    run: ([l, r], s) => ({
      tag: "float",
      value: floatOf(l, s, "@float.div") / floatOf(r, s, "@float.div"),
    }),
  }],
  ["@float.rem", {
    arity: 2,
    run: ([l, r], s) => ({
      tag: "float",
      value: floatOf(l, s, "@float.rem") % floatOf(r, s, "@float.rem"),
    }),
  }],
  ["@float.neg", {
    arity: 1,
    run: ([value], s) => ({
      tag: "float",
      value: -floatOf(value, s, "@float.neg"),
    }),
  }],
  // NaN is unordered against everything including itself, and there is no
  // fourth answer to give. Refusing is the only option that does not claim a
  // relation the format denies — and it is what the emitted code does too,
  // where the unordered case traps. `@int.div` by zero takes the same two
  // shapes: a diagnostic while compiling, a trap while running.
  // The one float question that always has an answer. Ordering refuses NaN, so
  // `@float.cmp x x` cannot be asked to report it, and nothing else in the
  // language can: this is what a primitive is for.
  ["@float.is_nan", {
    arity: 1,
    run: ([value], s) => bool(Number.isNaN(floatOf(value, s, "@float.is_nan"))),
  }],
  ["@float.cmp", {
    arity: 2,
    run: ([l, r], s) => {
      const left = floatOf(l, s, "@float.cmp");
      const right = floatOf(r, s, "@float.cmp");
      if (Number.isNaN(left) || Number.isNaN(right)) {
        fail(
          "BLOT_UNORDERED",
          "@float.cmp cannot order NaN. Test for it before comparing.",
          s,
        );
      }
      if (left < right) return ordering(-1);
      if (left > right) return ordering(1);
      return ordering(0);
    },
  }],
  ["@float.of_int", {
    arity: 1,
    run: ([value], s) => ({
      tag: "float",
      value: Number(intOf(value, s, "@float.of_int")),
    }),
  }],
  // Truncation toward zero, which is what `f64.trunc_sat_s` does. A value with
  // no integer to round to answers zero there, so it answers zero here.
  ["@int.of_float", {
    arity: 1,
    run: ([value], s, phase) => {
      const number = floatOf(value, s, "@int.of_float");
      if (!Number.isFinite(number)) return { tag: "int", value: 0n };
      return integerResult(
        BigInt(Math.trunc(number)),
        s,
        "@int.of_float",
        phase,
      );
    },
  }],
  // --- single precision -----------------------------------------------------
  //
  // The same operations as `@float.*`, rounded to f32 after each one. There is
  // no f32 literal: `@f32.of_float` is the only way to make one, which keeps
  // the grammar at one float token and makes the loss of precision a step the
  // program takes rather than one the lexer performs on it.

  ["@f32.add", {
    arity: 2,
    run: ([l, r], s) =>
      float32(float32Of(l, s, "@f32.add") + float32Of(r, s, "@f32.add")),
  }],
  ["@f32.sub", {
    arity: 2,
    run: ([l, r], s) =>
      float32(float32Of(l, s, "@f32.sub") - float32Of(r, s, "@f32.sub")),
  }],
  ["@f32.mul", {
    arity: 2,
    run: ([l, r], s) =>
      float32(float32Of(l, s, "@f32.mul") * float32Of(r, s, "@f32.mul")),
  }],
  ["@f32.div", {
    arity: 2,
    run: ([l, r], s) =>
      float32(float32Of(l, s, "@f32.div") / float32Of(r, s, "@f32.div")),
  }],
  ["@f32.neg", {
    arity: 1,
    run: ([value], s) => float32(-float32Of(value, s, "@f32.neg")),
  }],
  ["@f32.is_nan", {
    arity: 1,
    run: ([value], s) => bool(Number.isNaN(float32Of(value, s, "@f32.is_nan"))),
  }],
  ["@f32.cmp", {
    arity: 2,
    run: ([l, r], s) => {
      const left = float32Of(l, s, "@f32.cmp");
      const right = float32Of(r, s, "@f32.cmp");
      if (Number.isNaN(left) || Number.isNaN(right)) {
        fail(
          "BLOT_UNORDERED",
          "@f32.cmp cannot order NaN. Test for it before comparing.",
          s,
        );
      }
      if (left < right) return ordering(-1);
      if (left > right) return ordering(1);
      return ordering(0);
    },
  }],
  // Narrowing, so it can lose the value: a double too large for the format
  // becomes an infinity, which is what `f64.demote_f32` does.
  ["@f32.of_float", {
    arity: 1,
    run: ([value], s) => float32(floatOf(value, s, "@f32.of_float")),
  }],
  // Widening, and exact — every f32 is an f64.
  ["@float.of_f32", {
    arity: 1,
    run: ([value], s) => ({
      tag: "float",
      value: float32Of(value, s, "@float.of_f32"),
    }),
  }],

  // --- four lanes -----------------------------------------------------------
  //
  // One register, not four fields. Each of these becomes a single instruction
  // when the backend is asked for `wasm-simd`, and the same arithmetic done
  // one lane at a time when it is not — which is why the results here have to
  // be identical either way, and why every lane rounds to f32 as it lands.

  ["@f32x4.of", {
    arity: 4,
    run: ([a, b, c, d], s) => ({
      tag: "vector",
      element: "f32",
      lanes: [
        float32Of(a, s, "@f32x4.of"),
        float32Of(b, s, "@f32x4.of"),
        float32Of(c, s, "@f32x4.of"),
        float32Of(d, s, "@f32x4.of"),
      ],
    }),
  }],
  ["@f32x4.splat", {
    arity: 1,
    run: ([value], s) => do_splat(float32Of(value, s, "@f32x4.splat")),
  }],
  ["@f32x4.add", {
    arity: 2,
    run: ([l, r], s) =>
      lanewise(
        vectorOf(l, s, "@f32x4.add"),
        vectorOf(r, s, "@f32x4.add"),
        (a, b) => a + b,
      ),
  }],
  ["@f32x4.sub", {
    arity: 2,
    run: ([l, r], s) =>
      lanewise(
        vectorOf(l, s, "@f32x4.sub"),
        vectorOf(r, s, "@f32x4.sub"),
        (a, b) => a - b,
      ),
  }],
  ["@f32x4.mul", {
    arity: 2,
    run: ([l, r], s) =>
      lanewise(
        vectorOf(l, s, "@f32x4.mul"),
        vectorOf(r, s, "@f32x4.mul"),
        (a, b) => a * b,
      ),
  }],
  ["@f32x4.div", {
    arity: 2,
    run: ([l, r], s) =>
      lanewise(
        vectorOf(l, s, "@f32x4.div"),
        vectorOf(r, s, "@f32x4.div"),
        (a, b) => a / b,
      ),
  }],
  ["@f32x4.eq", {
    arity: 2,
    run: ([left, right], span) => {
      const leftLanes = vectorOf(left, span, "@f32x4.eq");
      const rightLanes = vectorOf(right, span, "@f32x4.eq");
      return {
        tag: "vector-mask",
        element: "f32",
        lanes: leftLanes.map((lane, index) => lane === rightLanes[index]),
      };
    },
  }],
  ["@f32x4.less", {
    arity: 2,
    run: ([left, right], span) => {
      const leftLanes = vectorOf(left, span, "@f32x4.less");
      const rightLanes = vectorOf(right, span, "@f32x4.less");
      return {
        tag: "vector-mask",
        element: "f32",
        lanes: leftLanes.map((lane, index) => lane < rightLanes[index]),
      };
    },
  }],
  ["@f32x4.select", {
    arity: 3,
    run: ([mask, whenTrue, whenFalse], span) => {
      const lanes = vectorMaskOf(mask, span, "@f32x4.select");
      const trueLanes = vectorOf(whenTrue, span, "@f32x4.select");
      const falseLanes = vectorOf(whenFalse, span, "@f32x4.select");
      return {
        tag: "vector",
        element: "f32",
        lanes: lanes.map((selected, index) =>
          selected ? trueLanes[index] : falseLanes[index]
        ),
      };
    },
  }],
  ["@f32x4.shuffle", {
    arity: 6,
    run: ([left, right, ...selectors], span) => {
      const lanes = [
        ...vectorOf(left, span, "@f32x4.shuffle"),
        ...vectorOf(right, span, "@f32x4.shuffle"),
      ];
      return {
        tag: "vector",
        element: "f32",
        lanes: selectors.map((selector) => {
          const lane = Number(intOf(selector, span, "@f32x4.shuffle"));
          if (lane >= 0 && lane < lanes.length) return lanes[lane];
          fail(
            "BLOT_TYPE",
            `@f32x4.shuffle expects lane selectors within 0..7, found ${lane}.`,
            span,
          );
        }),
      };
    },
  }],
  // Four named lane reads rather than one taking an index, because the target
  // has four instructions and no way to pick between them at run time.
  // A horizontal sum. Every other operation here is lane-wise, so this is the
  // one that cannot be written over the others without four extracts — which
  // is what it exists instead of.
  ["@f32x4.sum", {
    arity: 1,
    run: ([v], s) => {
      const lanes = vectorOf(v, s, "@f32x4.sum");
      return {
        tag: "float32",
        value: Math.fround(
          Math.fround(Math.fround(lanes[0] + lanes[1]) + lanes[2]) + lanes[3],
        ),
      };
    },
  }],
  ["@f32x4.x", {
    arity: 1,
    run: ([v], s) => ({ tag: "float32", value: vectorOf(v, s, "@f32x4.x")[0] }),
  }],
  ["@f32x4.y", {
    arity: 1,
    run: ([v], s) => ({ tag: "float32", value: vectorOf(v, s, "@f32x4.y")[1] }),
  }],
  ["@f32x4.z", {
    arity: 1,
    run: ([v], s) => ({ tag: "float32", value: vectorOf(v, s, "@f32x4.z")[2] }),
  }],
  ["@f32x4.w", {
    arity: 1,
    run: ([v], s) => ({ tag: "float32", value: vectorOf(v, s, "@f32x4.w")[3] }),
  }],

  ["@branch.likely", { arity: 1, run: ([condition]) => condition }],
  ["@branch.unlikely", { arity: 1, run: ([condition]) => condition }],

  ["@panic", {
    arity: 1,
    run: ([message], span) =>
      fail("BLOT_PANIC", textOf(message, span, "@panic"), span),
  }],
  ...additionalSimdEntries(),
]);

/** `@effect` needs a fresh identity per call, so it is built rather than tabled. */
export function makeEffect(
  name: string,
  operations: ReadonlyMap<string, Value>,
  host: boolean,
): Value {
  return { tag: "effect", id: brands += 1, name, operations, host };
}

export { asTuple };
