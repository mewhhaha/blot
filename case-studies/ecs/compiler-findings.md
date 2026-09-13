# Compiler findings from the ECS prototypes

The case study exercises the compiler as well as the library design. The
compiler defects below are fixed by the query/message, scheduling, SIMD, and
component-descriptor examples. The remaining representation boundaries are
listed at the end; they do not prevent empty streams or explicitly seeded folds.

## Fixed: one algebra specialization replaced another's body representation

The SIMD transform factory constructs the same ECS with scalar record columns
and with `F32x4` columns. Constructing the scalar instance first and the SIMD
instance second made the scalar kernel fail during emission: its correctly typed
callback returned scalar columns, but an expression fact demanded vector
columns. Reversing the constructor order changed which layout was retained.

Contextual inference had overwritten a shared generic body's call-expression
fact with the latest concrete specialization. It now preserves an existing body
fact while refining the concrete call site. Residual instance checking continues
to collect its own facts. No backend coercion or inferred-layout fallback hides
the mismatch.

The native regression compiles both factory orders and verifies actual Wasm SIMD
instructions. Runtime tests run both ECS implementations on changing arrays over
several frames against an independent matrix model. The fix also regenerates the
checked prelude snapshot.

## Fixed: nested declarations defaulted a callback's F32 literals too early

A generic iterator callback returned an entity record under an F32 result
signature. Checking an internal declaration resolved all pending literals,
including the caller's literal `1`, before that result signature constrained it.
Numeric defaulting now resolves the declaration's own literals. The enclosing
literal remains available for contextual constraints. The transform seed no
longer needs a separately signed `spawn` function; native and runtime tests
exercise its record-valued callback.

## Fixed: wide matrix calls lacked canonical parameter adapters

ABI 4 already specifies parameter blocks for more than 16 flat lanes, but the
compiler still emitted flat export/import signatures and the host refused these
calls. Both now implement the existing layout, including resumable exports and
development links. Parameter order is source order, not lexicographic ordering
of numeric field names. The compiler validates the block before loading values.

Matrix kernels expose direct `product` and `point` calls alongside their batch
interfaces. Tests cover mixed aligned fields, strings, arrays, effect requests,
separate module memories, and malformed pointers. Vectors stay internal to the
matrix implementation; callback starts retain their separate 16-lane policy.

## Conditional SIMD unpacking now passes

The earlier identical-looking array type mismatch no longer reproduces.
[simd/partial-blocks.blot](simd/partial-blocks.blot) retains that conditional
append formulation as an executable regression. Tests compare complete rows for
empty input, every tail length, and multiple blocks. This closes the observed
failure without attributing it to an unisolated earlier compiler change.

Packed components still live in an array of Blot records. Native SIMD alone does
not imply flat world columns, allocation-free updates, or worker execution.

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

## Fixed: handler constructors could not capture runtime values

`@handle (Read, work, supply value)` used to report an unbound `value` while
inspecting the handler, even though it was a declared runtime parameter. Clause
discovery now lets the ordinary evaluator suspend a constructor argument that is
only captured by source clauses. Runtime-dependent clause selection remains
rejected. The discovered clauses keep their defining module and continuation
ownership checks.

[constructed-handler.blot](constructed-handler.blot) exercises the minimal case.
Generated components now expose `supply`, and the main ECS resolver uses
`C.Position.supply row.Position` with the effect still explicit at `@handle`.

## Fixed: merging stateful computations skipped a later row

Adding Velocity and then doubling should turn Positions `[1, 20]` into
`[8, 44]`. The prototype instead produced `[8, 20]` in both executions.
Rechecking a computed closure's captures discarded the effects already inferred
at its call site, and evaluation attached the generic pure result signature.
Call-result caching then reused its first `Unit` result and skipped the work.

Capture rechecking now preserves the original effect contribution, and a
returned closure retains its closed call-site signature. Selecting an imported
closed effectful function also retains its instance's effect identities, so a
merged reader query and its component handlers refer to the same readers. The
[stateful example](stateful.blot) checks varying runtime rows and repeated
invocations against an independent model. Calling the merged computation without
its State handler retains that effect and is rejected during checking.

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
