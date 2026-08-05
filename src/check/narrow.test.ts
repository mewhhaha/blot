// The recogniser, against real compile-time values.
//
// The prelude's table is pinned as strings on purpose. Recognition is a property
// of the function's body, so a refactor of `Ord` that preserves its meaning can
// still switch narrowing off — and if it does, that must show up here as a diff
// rather than as user programs quietly losing a proof they had.
//
// The refusals are pinned for the opposite reason: each one is a value that
// looks like a comparison and is not, and accepting any of them would let the
// checker prove a false fact.

import { assertEquals } from "@std/assert";
import { checkFile } from "./mod.ts";
import { lookup, type Value } from "../comptime/value.ts";
import {
  complement,
  mirror,
  type Ordering,
  recognise,
  region,
} from "./narrow.ts";
import { show } from "./print.ts";

const scratch = await Deno.makeTempDir();

/** The operators this file interrogates, as one module's compile-time values. */
const FIXTURE = `open @import "blot:prelude" ();

const Sneaky = { .right = 0; };

const Probes = {
  // The prelude shapes, reached by name below rather than restated here.

  // Every free occurrence of a parameter is inside the one comparison, but
  // \`open\` binds \`right\` from a compile-time value, so no node in the body
  // carries the name. This function is \`fn a => fn b => a == 0\`.
  .opened = fn left => fn right => do
    open Sneaky;
    break is_equal (@int.cmp left right);
  end;

  // \`left\` occurs once as a \`var\`, but a binder rebinds it first.
  .rebound = fn left => fn right => do
    let left = 5;
    break is_equal (@int.cmp left right);
  end;

  // Reversed arguments are still one comparison of both parameters.
  .reversed = fn l => fn r => is_equal (@int.cmp r l);

  // The same equality, spelled with two comparisons. Refused: the occurrence
  // count is what licenses the factorization, and this body has four.
  .twice = fn l => fn r => if is_less (@int.cmp l r)
      then False
      else not (is_less (@int.cmp r l))
    end;

  // Hand-written, in terms of the intrinsic rather than the prelude's helpers.
  .handwritten = fn l => fn r => case @int.cmp l r of
    #Equal => True,
    #Less => False,
    #Greater => False
  end;

  .constantly = fn a => fn b => True;
  .never = fn a => fn b => False;
  // A parameter used outside the comparison.
  .leaks = fn l => fn r => if is_equal (@int.cmp l r) then l == l else False end;
  // The right domain, the wrong answer type.
  .ordering = fn l => fn r => @int.cmp l r;
  // Unary.
  .unary = fn l => is_equal (@int.cmp l l);
  // Refuses on one probe. \`blot check\` must survive it.
  .refusing = fn l => fn r => if is_less (@int.cmp l r) then @fail "no" else True end;
};
return 0;
`;

const path = `${scratch}/probes.blot`;
await Deno.writeTextFile(path, FIXTURE);
const checked = await checkFile(path);

function operator(root: string, name: string): Value {
  const namespace = lookup(checked.values, root);
  if (namespace === undefined || namespace.tag !== "shape") {
    throw new Error(`\`${root}\` is not a compile-time record`);
  }
  const found = namespace.fields.get(name);
  if (found === undefined) throw new Error(`\`${root}.${name}\` is missing`);
  return found;
}

function derived(root: string, name: string): string {
  const answers = recognise(operator(root, name));
  if (answers === null) return "refused";
  return [...answers].join(" ");
}

function pins(root: string, name: string, expected: string): void {
  Deno.test(`\`${root}.${name}\` derives ${expected}`, () => {
    assertEquals(derived(root, name), expected);
  });
}

// The prelude's table. Read as: `Ord.le` answers `#True` when its arguments
// compare less or equal, which is what `<=` had better mean.
pins("Ord", "eq", "equal");
pins("Ord", "ne", "less greater");
pins("Ord", "lt", "less");
pins("Ord", "le", "less equal");
pins("Ord", "gt", "greater");
pins("Ord", "ge", "equal greater");
pins("Eq", "eq", "equal");
pins("Eq", "ne", "less greater");

// Not comparisons. `cmp` answers an ordering rather than a boolean; `min` and
// `max` answer one of their arguments.
pins("Ord", "cmp", "refused");
pins("Ord", "min", "refused");
pins("Ord", "max", "refused");
pins("Num", "add", "refused");
pins("Logic", "and", "refused");

// Recognition reads the body, not the name: a comparison written by hand in a
// module that never heard of `Ord` is recognised, and a function called `.eq`
// that is not one is not.
pins("Probes", "handwritten", "equal");
pins("Probes", "reversed", "equal");
pins("Probes", "opened", "refused");
pins("Probes", "rebound", "refused");
pins("Probes", "twice", "refused");
pins("Probes", "constantly", "refused");
pins("Probes", "never", "refused");
pins("Probes", "leaks", "refused");
pins("Probes", "ordering", "refused");
pins("Probes", "unary", "refused");
pins("Probes", "refusing", "refused");

Deno.test("a non-function is not a comparison", () => {
  assertEquals(recognise({ tag: "int", value: 1n }), null);
});

function orderings(...names: Ordering[]): ReadonlySet<Ordering> {
  return new Set(names);
}

function regionOf(...names: Ordering[]): string {
  return show(region(orderings(...names), 10n));
}

// Each region is exact rather than approximate, because integers are discrete
// and `Bound` is inclusive: "less than 10" is the range ending at 9.
Deno.test("one ordering is one range", () => {
  assertEquals(regionOf("less"), "..9");
  assertEquals(regionOf("equal"), "10");
  assertEquals(regionOf("greater"), "11..");
});

// Adjacent orderings merge, so `<=` narrows to one piece rather than two.
Deno.test("adjacent orderings merge into one range", () => {
  assertEquals(regionOf("less", "equal"), "..10");
  assertEquals(regionOf("equal", "greater"), "10..");
  assertEquals(regionOf("less", "equal", "greater"), "Int");
});

// `/=` is the only shape with a gap, and it is the reason a region may have two
// pieces. Two is the maximum, which is what bounds `d` nested conditions at
// `d + 1` pieces rather than `2^d`.
Deno.test("a gap gives exactly two pieces", () => {
  assertEquals(regionOf("less", "greater"), "..9 | 11..");
});

Deno.test("no ordering is the empty set", () => {
  assertEquals(show(region(orderings(), 10n)), "⊥");
});

// The complement is taken here, on three elements, and never on a type. That is
// what keeps a complement out of both polarities of the lattice.
Deno.test("complement is taken on the orderings", () => {
  assertEquals([...complement(orderings("equal"))].join(" "), "less greater");
  assertEquals([...complement(orderings("less"))].join(" "), "equal greater");
  assertEquals([...complement(orderings("less", "equal", "greater"))], []);
});

// `1 < n` is `n > 1`. Mirroring is a bijection on the three orderings, so
// mirroring before complementing and after agree.
Deno.test("mirroring swaps less and greater", () => {
  assertEquals([...mirror(orderings("less"))].join(" "), "greater");
  assertEquals(
    [...mirror(orderings("less", "equal"))].join(" "),
    "equal greater",
  );
  const mirrored = mirror(complement(orderings("less")));
  const complemented = complement(mirror(orderings("less")));
  assertEquals([...mirrored].join(" "), [...complemented].join(" "));
});
