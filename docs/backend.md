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

## `const` compiles to nothing

A `const` is a compile-time value and emits no code. A use specializes it: a
`const` holding a type disappears entirely, and one holding a closure becomes a
Core definition — once, by closure identity — only if something calls it. That
is how `+` reaches Wasm at all. `Num.add` is a prelude closure, not a primitive,
and `20 + 22` compiles to a call to one hoisted definition.

## What compiles today

Literals, prelude operators and comparisons, records and their spreads, tuples,
unions and `case` including literal guards and nested payloads, destructuring
bindings including array patterns, arrays and their spreads, lambdas and
application, `let`, `if`, recursion through `rec`, `fold` and the collections
built on it, host effects, tail-resumptive handlers, and imported modules.

`rec` becomes a Core `let-rec`, not a lifted top-level definition. Lifting it
stranded whatever the lambda captured — `fold`'s inner `go` closes over
`values`, and a definition has no enclosing scope for that to come from.

An import is _inlined_: a module is a function from a record to a record, both
known at compile time, so importing one is lowering its body as a block. The
import boundary exists for authority, not for code generation.

`just wasm` compares eight programs across all three executions, on their whole
result rather than a scalar — a record crosses the boundary as a constructor,
and the field names the backend synthesized are what turn it back into something
comparable. Comparing only scalars would have quietly stopped checking every
program that returns a record.

Arrays are Core's `Store`. A write returns a _new_ store, so an array literal
threads each element through its own binding — the first version rewrote the
binder in the finished body instead, which quietly dropped every write but the
last. Both backends agreed on the wrong answer; only the interpreter disagreed,
which is the entire argument for checking three executions rather than two.

## What does not

**Polymorphic functions whose `case` has a wildcard arm.** The arms of

```blot
const is_less = o => case o of #Less => True, _ => False end;
```

do not pin the constructor set, and a generic parameter has no bounds to read it
from, so lowering cannot build the Core union. The prelude therefore matches
exhaustively — which is better style anyway — and closing this properly means
monomorphizing per call site.

**A `const` holding a type or an effect cannot cross into Wasm.** That is not a
missing feature: a type has no runtime representation, so a module that returns
one has nothing to compile. The diagnostic says so rather than promising it
later.

**Blot handlers.** `@handle` is not lowered. A handler written in blot has to be
specialized away — inlined into direct-style calls, which one-shot `resume`
makes possible without a continuation object — and that is blot's job, not
gpufuck's. The type checker already refuses an effect nothing handles. gpufuck
deleted its Effect Core precisely because effects belong to the frontend, so
this is handler specialization on blot's side: a handler known at compile time
inlines into direct-style calls, and one-shot `resume` means no continuation
object is needed. The type checker already refuses an effect nothing handles.

**Module parameters.** An entry module that demands one cannot be compiled:
`blot build` has no argument to hand it. For the Wasm target host authority
arrives as `@effect.host` instead, which is typed, declared, and imported —
`init` remains compile-time configuration.

**Arrays.** They map to Core's `Store`, and the ownership facts from
`blot
ownership` are what would choose write-in-place over rebuild. Nothing
consumes them yet.

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

Only integers, text, and `()` cross the boundary today. A shape would need a
nominal on both sides, and inventing one silently would make the import's
contract a guess.

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

Core carries an effect label on a definition and lets a handler _replace_ that
operation lexically; a pure replacement discharges the label. So a blot effect's
operation is an ordinary definition whose body traps — unhandled is exactly what
a trap means — and handling it substitutes a real implementation.

That covers the **tail-resumptive** handlers precisely: the ones whose clause
ends in `resume e`.

```blot
const Counter = @effect { .bump = Int -> Int; };
let doubling = { .bump = (n, ?resume) => resume (n * 2); };
let counted = () => Counter.bump 20 + Counter.bump 1;

@handle (Counter, counted, doubling)   // 42
```

`(n, ?resume) => resume e` is the pure operation `n => e` and nothing more. Tail
position survives a block, an `if`, and a `case`, because each of those has a
tail to rewrite. Resuming anywhere else needs the rest of the computation as a
value, and that is a continuation.

**Handling inlines the computation**, because the evidence is lexical. A closure
has already resolved its operations against the global definitions, so a handler
wrapped around a call to it would replace nothing. Specializing the handler is
not an optimization here — it is what makes it mean anything. The computation
and the handler both have to be written in the module, which is what "a handler
known at compile time" always required.

The handled example compiles to 3,847 bytes with no evidence left at run time:
the operations were replaced and their labels discharged.

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
