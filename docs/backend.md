# The Backend

```bash
just build examples/compiled.blot   # emits examples/compiled.wasm
just wasm                           # interpreter vs GPU evaluator vs Wasm
```

blot lowers to gpufuck's Functional Surface, which gpufuck resolves and
typechecks on the GPU and compiles to WebAssembly. There is no second backend
and no WAT route.

## Three executions, one language

blot runs the same program three ways, and `just wasm` requires all three to
agree:

|                         |                                                                           |
| ----------------------- | ------------------------------------------------------------------------- |
| the comptime evaluator  | also the runtime, and the thing `comptime` uses — one semantics, no drift |
| gpufuck's GPU evaluator | a cross-check on the lowering                                             |
| the emitted Wasm        | the artifact                                                              |

A lowering can satisfy one and not another, which is why the check is on all
three rather than on whichever is convenient.

## What lowering has to close

gpufuck's Core is deliberately small: unary application, lambdas, `let`,
`let-rec`, `if`, primitive operations, nominal constructors with flat exhaustive
`case`, and an indexed `Store`. Records, lists, and multi-argument functions are
not primitives — the frontend lowers them. Three gaps, and how each closes:

- **Records and tuples become nominal declarations.** One nominal per distinct
  field-name set, so two shapes with the same labels are one type. A tuple is a
  shape with integer labels, so it needs no second mechanism.
- **Unions become nominal declarations too**, one per constructor set, with a
  type parameter per constructor that carries a payload — `#Ready` and
  `#Failed Text` cannot share a field list.
- **`if` wants a boolean.** blot's conditions are `#True | #False`, ordinary
  prelude constructors, so those two tags become Core booleans and a `case` over
  them becomes an `if`.

Unary application costs nothing, which is exactly why blot's single-parameter
rule was worth keeping.

## Inference feeds the backend

A nominal needs the _whole_ field set, and `p.x` does not say what else `p`
holds. Inference does, so it records it: `Checked` carries a map from projection
nodes to field sets and from `case` nodes to constructor sets, keyed by AST node
identity. The backend reads them rather than re-deriving them, because
re-deriving them means a second type checker.

That is also why `load` keeps one cache per process. Two `load` calls returning
two structurally equal trees would silently lose every recorded fact.

### What a shape fact reads

A variable's lower bounds are the records that flowed into it and its upper
bounds are the records the program demanded of it, and those answer different
questions. What flowed in decides, because a value carries exactly the fields of
the record that reached it. Demands speak only when nothing flowed in at all — a
parameter whose caller is outside the module is pinned from above, which is what
gives `(&p) => p.x + p.y` a shape — and then they are unioned, because each
projection writes its own one-field record.

A `let`-bound function is generalized, so the record its callers pass never
reaches the definition-site variable through the bound graph at all. `extrude`
links its copies into that graph; `freshenAbove` must not, because a scheme's
instantiations are exactly what does not constrain each other. The edge from a
definition-site variable to each of its copies is therefore recorded beside the
lattice, in `Instances` — one map per `checkModule` call, never a field on
`Variable`, because `PRIMITIVE_TYPES` holds process-global scheme variables that
outlive every check. `constrain` never reads it, so biunification propagates the
bounds it always did and stays polynomial; the shape walk follows it, and that
is what lets `let get_x = v => v.x;` learn the record its call sites built.

Two _different_ records flowing to one node is not a wider record, it is two
shapes, and the fact says so rather than unioning them. The backend refuses with
`BLOT_SHAPE_DISAGREEMENT`, naming both.

## `const` compiles to nothing

A `const` is a compile-time value and emits no code. A use specializes it: a
`const` holding a type or effect disappears entirely, and one holding a closure
becomes a Core definition — once, by closure identity — only if something calls
it. That is how `+` reaches Wasm at all. `Num.add` is a prelude closure, not a
primitive, and `20 + 22` compiles to a call to one hoisted definition.

Inference records compile-time declaration values by AST expression identity.
The module's final value environment cannot contain a `const` local to a
residual block, but lowering still needs that value to specialize a local
handler or closure. Carrying the value as a fact preserves its effect identity
without evaluating compiler input for a second time.

## What compiles today

Every accepted program in `examples/` reaches gpufuck's CPU compiler. That
catalog covers literals, signed-i64 arithmetic, prelude operators and
comparisons, records and their spreads, tuples, unions and `case` including
literal guards and nested payloads, exact and nested destructuring, arrays and
their spreads, the collection prelude, text operations, granted capabilities,
lambdas and application, `let`, `if`, recursion, imported modules, host effects,
and one-shot handlers including non-tail resume and abort.

Staging runs after blot has checked the source and before lowering. It evaluates
closed runtime fragments, removes compile-time-only result fields, and leaves
effectful or otherwise residual expressions for gpufuck. Runtime result fields
become named Wasm exports; compile-time fields remain in the manifest with no
Wasm name. Runtime fields use Blot Core Wasm ABI 1 rather than gpufuck's private
tagged-value boundary. The structural manifest records canonical function types,
post-return ownership, imports, record fields, variant cases, and seals. Its
exact bytes occur both beside the module and in the `blot:abi` custom section;
[abi.md](abi.md) specifies the byte contract.

`rec` becomes a Core `let-rec`, not a lifted top-level definition. Lifting it
stranded whatever the lambda captured — `fold`'s inner `go` closes over
`values`, and a definition has no enclosing scope for that to come from.

An empty array is `storeEmpty`, which allocates a zero-length `Store a` and lets
the surrounding constraints infer `a`. blot briefly recorded the element type
during checking and wrote a typed placeholder instead; that worked only where
the element was already pinned, so `map` and `filter` did not compile. Asking
for the constructor was the right move over building monomorphization to route
around its absence — gpufuck keeps Core polymorphic on measured grounds.

An import is _inlined_: a module is a function from a record to a record, both
known at compile time, so importing one is lowering its body as a block. The
import boundary exists for authority, not for code generation.

`just wasm` discovers every accepted catalog program and compares all three
executions on the staged runtime result rather than on a selected scalar. A
record crosses the boundary as a constructor, and the field names the backend
synthesized are what turn it back into something comparable. Comparing only
scalars would quietly stop checking every program that returns a record.

Arrays are Core's `Store`. A write returns a _new_ store, so an array literal
threads each element through its own binding — the first version rewrote the
binder in the finished body instead, which quietly dropped every write but the
last. Both backends agreed on the wrong answer; only the interpreter disagreed,
which is the entire argument for checking three executions rather than two.

## Remaining backend boundaries

The remaining restrictions are at boundaries where the compiler needs a concrete
representation:

- A runtime export needs a concrete first-order ABI. Integers, text, unit,
  booleans, records, arrays, variants, seals, and functions over those values
  cross. Types and effects are compile-time values, so staging records and
  erases them instead of inventing a runtime encoding.
- A source handler is specialized only when its effect, nullary computation, and
  clause shape are statically visible. Handling a host effect, dynamically
  choosing a handler, or spreading clauses would require a runtime handler
  representation that gpufuck intentionally does not have.
- A residual structurally polymorphic function must have a concrete record shape
  before it reaches gpufuck. It gets one from the call sites that instantiated
  it, so a `let`-bound projection whose callers agree compiles; callers that
  pass different records are refused by name. Compile-time generic functions are
  specialized at their blot call sites; an unconstrained runtime export is
  rejected instead of being assigned an arbitrary nominal ABI.

Three shape cases still reach gpufuck's own type checker rather than a blot
refusal, and each reports `BLOT_LOWERING_BUG` with an `F2102` from gpufuck:

- **A spread of a value whose type is still a variable.**
  `r => { ...r; .x = 1; }` infers the result `{ .x }` however wide `r` is,
  because `case "shape"` in inference only widens the result when the spread
  member is already a record. The construction the backend emits copies every
  field, so the two disagree. Closing it needs row variables or a deferred
  record type, not a shape fact.
- **A parameter destructured in place**, as in `({ .x = a; }) => a` applied to a
  wider record. A shape pattern's type _is_ a record rather than a variable
  bounded by one, so there is nothing for the value's fields to flow into and
  the pattern's own fields are all the fact can say.
- **A projecting function reached across `@import`.** A dependency is checked
  before its importers exist, so its shape facts are read while no caller has
  instantiated it. The rule holds inside a module and not yet across the module
  graph; closing it means computing the facts once for the whole graph rather
  than once per `checkModule`.

## The module parameter is the module's imports

The entry module's parameter is the program's whole authority — no ambient
filesystem, no ambient clock, nothing to import for more. At this boundary that
authority _is_ the module's imports:

```blot
module init;
…
const _ = init.print message;     // imports { Init }
```

`init` has no runtime representation of its own. Each field the program reaches
for becomes a declared host operation, with the signature inference found for
it, and nothing is passed in. A program that never asked for `print` cannot
reach it.

An operation's result may be unconstrained — nothing observes what `print`
returns — and `()` is what that means at the boundary. An unconstrained
_parameter_ is still refused: the host cannot be handed something no type
determines.

Core carries text without measuring or rendering it, so gpufuck emits
module-local Wasm implementations of `@text.len`, `@text.of_int`, and
`@text.cmp`. They create no ambient `Text` capability. `@text.cmp` computes a
sign and blot rebuilds the three-constructor ordering on this side.

## Host effects are capabilities

An effect the _host_ implements is declared with `@effect.host`, and it becomes
a gpufuck capability — a named record of operations, each carrying the effect it
performs, its parameter type, and its result type. gpufuck turns that into typed
WebAssembly imports.

```blot
const Console = @effect.host { .write = Str -> Unit; };

let report = () => Console.write "compiled";   // () -> () ~ { Console }
```

This is why blot needs no raw import form: you declare an effect, and the
boundary follows from its operation types. It is also why a host effect's row is
allowed to reach the module boundary, where an ordinary one nothing handles is
an error — the row _is_ the program's declared interface, and `blot build`
prints it as the module's imports.

Both executions answer the same declared effects: `blot eval` bridges them to
the same grants `blot build` hands the compiled module. `just wasm` compares the
printed transcripts as well as the results, because an effectful program's
output is as much of its meaning as its return value.

Host effects use the same full first-order boundary as exports: integers, text,
unit, booleans, concrete records, arrays, variants, and seals. The manifest
names every structural component, so the host never has to guess a nominal
layout.

## Recovering a constructor set without monomorphizing

A wildcard arm leaves the scrutinee's constructor set open, which is common
inside a polymorphic function: `case o of #Less => …, _ => …` says nothing about
`#Equal`. Core needs the whole set to name the nominal, so the obvious fix is to
duplicate the definition per instantiation — and that is the fix gpufuck's own
measurements argue against.

The set is already written down elsewhere.
`const Message = #Ready | #Progress Int` _is_ a constructor set, so lowering
harvests every compile-time union in scope and looks the arms up in them, the
same membership lookup that already resolves which union a bare `#Ready` belongs
to. An ambiguous tag — one two unions both declare — is refused rather than
guessed.

## What a pattern becomes

Core dispatches on a constructor and nothing else, so the rest of blot's
patterns become what they always described:

| pattern                             | Core                                                           |
| ----------------------------------- | -------------------------------------------------------------- |
| `#Progress 0` next to `#Progress n` | one arm, with the literal as a guard inside it                 |
| `case value of -1 => …, 1 => …`     | a chain of equality tests; there is no union to dispatch on    |
| `#Pair (left, right)`               | one binder, then the `case` a compound binding already becomes |
| `let [a, b] = xs`                   | reads by index, since a `Store` has no constructor             |

An array literal with a spread is _built_ rather than allocated: start empty,
push each written element, and copy each spread with a local recursive loop.
`let-rec` is what makes the loop expressible.

## Handlers are evidence

gpufuck has no runtime effect or handler representation. blot therefore
specializes `@handle` with a selective CPS transform before Core exists.
Ordinary expressions stay in direct style. At a handled operation, lowering
passes the operation argument and an affine continuation representing the rest
of the computation to the matching clause.

```blot
const Counter = @effect { .bump = Int -> Int; };
let doubling = { .bump = (n, ?resume) => resume (n * 2); };
let counted = () => Counter.bump 20 + Counter.bump 1;

@handle (Counter, counted, doubling)   // 42
```

Calling `resume` continues from the operation and can use its eventual result in
any expression. Omitting it aborts the rest of the computation. The affine
qualifier is the static proof that a clause cannot resume twice; no runtime
one-shot check is needed.

**Handling inlines the computation**, because the evidence is lexical. A closure
has already resolved its operations against the global definitions, so a handler
wrapped around a call to it would replace nothing. Specializing the handler is
not an optimization here — it is what makes it mean anything. The computation
and the handler both have to be written in the module, which is what "a handler
known at compile time" always required.

`try program then do ... end` adds no backend path. CST lowering turns each
bound two-argument `@handle (effect, handler)` step into a named nullary
computation containing the ordinary three-argument call, then emits one final
three-argument call that executes the composition.

## Names, and what may not be mangled

An effect's identity is its own, not its spelling: `@effect` mints a fresh one
every time, so two effects may share a name. Core definitions are therefore
named by identity — a name less unique than the memo that guards it is a
duplicate definition waiting for two effects to collide.

A **capability** name is the exception. It is the host-facing contract — the
host supplies `init.Console` by that name — so it cannot be made unique behind
the programmer's back. Two distinct host effects claiming it are ambiguous at
the boundary, and `BLOT_AMBIGUOUS_CAPABILITY` says so rather than merging their
operations.

## When gpufuck disagrees

gpufuck re-runs Hindley-Milner on what blot emits. blot's algebraic-subtyping
result is the authority, so a rejection there is a **lowering bug**, never a
type-system disagreement to resolve in gpufuck's favour. The diagnostic says so,
because the alternative is a bug report filed against the wrong project.

## Width subtyping is specialized before Core

blot's records are structurally width-subtyped: `value => value.x` infers a
function that accepts any record with `.x`. gpufuck's records are nominal and
invariant, so an open structural type cannot be handed over unchanged.

Compile-time generics close that type at each blot call site.
`examples/generics.blot` specializes the same projection for both a two-field
and a three-field record, and the resulting functions lower against two concrete
nominals. A runtime export instead needs to state the concrete boundary:

```blot
const Point = { .x = Int; .y = Int; };
sig project = Point -> Int;
let project = point => point.x;

return { .project = project; };
```

That signature is not an annotation the function body needs; it is the
first-order Wasm contract. Exporting the unconstrained structural function is
refused with `BLOT_EXPORT_NOT_FIRST_ORDER`, because choosing one nominal shape
would narrow the source type silently.
