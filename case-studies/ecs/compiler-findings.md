# Compiler findings from the ECS prototypes

The case study exercises the compiler as well as the library design. The
compiler defects below are fixed by the query/message and scheduling extensions.
The remaining effect findings were observed at `ab2cfc8`; their workarounds
remain explicit in the runnable study.

## Fixed: local signatures could not depend on a constructor's type argument

The system generator needs `const Step = Row -> Row` followed by
`let step :: Step`. While checking the still-generic constructor, evaluating
that signature reported `BLOT_UNBOUND` before Row was available. Such a
signature now remains a specialization obligation when its missing value belongs
to a declared generic binding. An actually undeclared name still fails. The
concrete body must satisfy its signature even when its constructed result is
unused.

The scheduler can consequently derive signed read, patch, and row boundaries
inside ordinary Blot functions. Public runtime exports still use concrete
signatures; this does not solve every open record-update inference problem.

## Fixed: callback specialization discarded accompanying type values

Passing `(Type, callback)` took a contextual inference path that retained the
callback's inferred type but discarded the argument's available compile-time
value. A requirement such as `@satisfies callback (Type -> Type)` could remain
deferred even at a concrete call, accepting an invalid unused callback.

That path now retains known argument values without changing the runtime phase
of source parameters. System definition tests reject undeclared reads, wrong
patch types, and host effects during checking, with source spans from the
defining module. A reflection predicate also rejects additional write fields.

## Fixed: a cached empty view leaked into another system definition

Defining a system with no reads, then one that reads Position, falsely reported
that `{}` lacked Position. Declaration caching treated a reusable result value
as evidence that its expression was independent of its environment. The first
empty `Read` record was reused in a different invocation of the constructor.

Environment-independent entries are now restricted to top-level declarations of
parameterless modules. Local declarations retain their environment identity even
when their result is an integer, empty record, or another reusable value. Both
checker evaluation and captured evaluator bindings enforce that rule.

## Fixed: a fresh patch inherited the wider input record's layout

A function can consume an Age-only view of an Entity and construct a fresh
Age-only patch. Call-specialization representation facts incorrectly used the
wider Entity argument to prescribe the patch's layout too. The backend then
attempted to turn the fresh patch into an Entity before applying its update.

Closed result types now determine their own representations; argument facts fill
unresolved variables. The standalone
[`record_view_results.blot`](../../examples/record_view_results.blot) exercises
fresh integer and text results after wider record inputs, including runtime
arguments in the Wasm tests. Region specialization retains its storage rules.

## Fixed: empty arrays of variants could not be emitted as constants

An empty schedule has a typed `[Batch]` report, where Batch is a Systems/Barrier
variant. Constant lowering treated the empty array's element _type_ as though it
were an element _value_, and refused the union. Empty arrays now obtain their
element representation from the checked type using the existing representative
value mechanism. Nested empty arrays and the empty plan retain their declared
ABI layouts while emitting no elements.

## Fixed: conditional array updates lost ownership between branches

The message index needs a conditional update of a loop-carried array:

```blot
for index in Iter.range (0, count):
  heads := case index % 2 == 0 of
    #True => Array.expect_set (heads, 0, index)
    #False => heads
```

This initially reported `BLOT_LINEAR_CONSUMED_TWICE` even though the arms are
exclusive. The lowered fold's accumulator field became known as an array while
checking the first arm. Branch snapshots only covered bindings already known to
be affine or linear, so the newly discovered consumed state leaked into the
second arm.

The ownership pass now snapshots every visible binding and restores its
qualifier as well as its live ownership tree before checking another arm.
Function input requirements accumulate independently from the live tree: moving
a projected field or rebinding its successor cannot erase the fact that the
function required its authority on entry. Explicitly consuming calls also
propagate their destructive requirement to that symbolic parameter path.

The regression checks both `case` and standalone `if` updates, rejects an actual
double move, runs 100,000 iterations in emitted Wasm, and requires the resulting
Store writes to use `owned-reuse`. This last check caught a second failure after
the false diagnostic was removed: accepting the source alone had still left
copying writes in Runtime HIR.

## Fixed: empty array joins and shared delivery snapshots

Mapping an array can return a fresh empty array or a fresh populated array.
Their join previously lost the single outer Store authority, making an explicit
`freeze` fail. The join now keeps that authority while retaining the populated
alternative's element obligations. A shared alternative is never upgraded, and
linear elements cannot be discarded through the empty alternative.

Passing a record of shared arrays beside a consuming argument also triggered a
false ownership error. Argument validation now checks each parameter position
independently: a non-consuming position accepts the shared delivery snapshot,
while a consuming position still refuses a shared Store. The checker also
retains array type facts nested inside records and tuples, so a generic query
contract can refine element shareability from its concrete argument.

The arena is a native compiler preparation regression, and the Node tests run
its emitted Wasm against explicit expected state transitions. Separate delivery
tests compare FIFO routing and unknown destinations against a host model.

## Fixed: generated methods could lose a deferred type requirement

A method such as `fn value => @satisfies value Payload` cannot evaluate Payload
while its type constructor is still generic. The checker previously fell through
to an unconstrained primitive result. An array-returning method could then
appear structurally settled and avoid specialization entirely, accepting a wrong
payload.

Deferral now preserves the subject type and records the requirement. Calls to
closures containing `@satisfies` specialize even when their ordinary result is
already structural, so the captured type is checked. This applies across module
boundaries and to methods returning arrays. Regressions reject wrong message
payloads and wrong component types on selected tables. Diagnostics from a
specialized body retain its defining module, so their spans point to the source
that actually failed.

`const selected = Query.table (Row, predicate)` constructs the schema-specific
query before `selected` receives `(rows, select)`. That makes the compile-time
choice explicit and keeps the selected row requirement available at the runtime
call.

## Fixed: recursive iterator results settled to an inner branch's layout

The filtering iterator's inner case joins a recursive call with `Some value`;
its outer case also returns `None`. Repeated arena ticks exposed a compiler
invariant failure because the inner join had already fixed the recursive result
to a sum containing only Some.

Settlement now uses the checked codomain and fills its missing payload
representations from the finite result. Constructor matching traverses nested
unions, and the complete checked constructor set determines the layout. Later
branches coerce into that fixed layout. The regression compiles two arena ticks
with runtime input, retaining all three world snapshots for summaries.

## A constructed handler cannot currently capture a runtime argument

Saving this source and running `pnpm blot check <path>` reports
`BLOT_UNBOUND: value is not in scope` at `supply value`:

```blot
open import "blot:prelude"
const Read = @effect { .get = Unit -> Int; }
const supply = fn value => { .get = fn ((), ?resume) => resume value; }
const run :: Int -> Int
const run = fn value => @handle (Read, fn () => Read.get (), supply value)
return run
```

Writing the clause directly in the `@handle` call works. Constructed handlers
with compile-time answers also work, as demonstrated by
[`schema_effects.blot`](../../examples/schema_effects.blot). The ECS resolver
therefore keeps its runtime captures in literal clauses.

## Merging stateful computations can skip work on a later row

This prototype checks successfully. Both evaluation and emitted Wasm produce
Positions `[8, 20]`; sequentially adding Velocity and doubling should produce
`[8, 44]`. Replacing the `merge` call with a directly written computation that
sequences `move` and `double` produces the expected result in the evaluator.

```blot
open import "blot:prelude"
const Row = { .Position = Int; .Velocity = Int; }
const State = @effect { .get = Unit -> Row; .set = Row -> Unit; }
const state = {
  .get = fn ((), ?resume) => fn row => do:
    use next <- resume (@satisfies row Row)
    return next row
  ;
  .set = fn (row, ?resume) => fn previous => do:
    use next <- resume ()
    return next row
  ;
  .return = fn () => fn row => row;
}
const merge = fn (left, right) => fn () => do:
  use left ()
  use right ()
  return ()
const move = fn () => do:
  use row <- State.get ()
  use State.set { .Position = row.Position + row.Velocity; .Velocity = row.Velocity; }
  return ()
const double = fn () => do:
  use row <- State.get ()
  use State.set { .Position = row.Position * 2; .Velocity = row.Velocity; }
  return ()
const movement = merge (move, double)
let apply :: Int -> [Row]
let apply = fn position => map (
  [{ .Position = position; .Velocity = 3; }, { .Position = 20; .Velocity = 2; }],
  fn row => (@handle (State, movement, state)) row
)
return { .default = apply 1; .apply = apply; }
```

The case study instead merges pure `Entity -> Entity` stages after resolving
their reader queries. Tests compare multiple rows and repeated ticks against an
independent model, rather than relying only on agreement between the evaluator
and Wasm.

## Returning an optional iterator closure still hits a target boundary

An initial `inbox` returned `None` for an invalid address and `Some iterator`
for a valid one. Using the captured iterator through `Iter.fold_with` reached a
Runtime-HIR refusal:
`<function> has no first-order runtime type while lowering
@array.get`. The
runnable API exposes `expect_inbox` with an explicit valid-address precondition
and returns the iterator directly. Unknown message destinations remain ordinary
values available through `undelivered`.

This is a remaining closure representation limitation, not a reason to require
nonempty streams. Empty inboxes, empty tables, and empty combined folds all have
ordinary values and explicit seeds.

## Concrete row transformation boundaries still need signatures

A generic `{ ...row; .Health = value; }` receiver can leave an open
record-update result and later produce an incompatible array element layout. The
arena uses concrete signatures for the fighter, medic, and sleeper receive
stages, just as the particle study does for its row transformations. Their
bodies share the health fold and use the generated component replacements. This
remains a pain point when building a completely generic schema-driven schedule.

Generated iterators similarly need a visible function result at their module
boundary. `attacks` and `heals` name `Stream.Iterator (Int, Mail.Envelope)` in
their signatures so their step functions remain staged. Without those signatures
the current compiler can attempt to outline an iterator as a first-order record
and refuse its function field.
