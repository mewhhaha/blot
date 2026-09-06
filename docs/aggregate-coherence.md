# Products, arrays, and calls: coherence review

## Status and recommendation

This is a design review and a proposal for clearer documentation, accompanied by
focused regression tests. It is not a second language specification. This PR
changes no syntax, source semantics, ownership rules, Rust compiler code,
generated artifact, or public ABI. `LANGUAGE.md` and the existing specification
contracts continue to govern accepted programs.

Reviewed main: `4ca2337bbef0ad8662d9fdc1f76840db6f26427c`.

**Keep `(a, b)` as a first-class inline product, `[a, b]` as an array, and every
ordinary function application unary. Make product representation a uniform
backend contract, not a favor granted to destructured function parameters.**

Here, _inline_ means that the product itself does not require a separate heap
object in the direct internal representation. It does not mean function
inlining, a promise of machine registers, or that evaluating its fields is free.
The motivating intent is a cheap inline aggregate rather than a heap-backed
collection.

The current implementation is closer to this model than its terminology makes
apparent. Calling `(a, b)` a tuple does not, by itself, introduce an allocation.
The useful distinction is **product versus collection**, not **tuple versus fast
argument pack**.

## Overall assessment

The architectural direction is worth preserving. There is one semantic compiler
in Rust/Wasm, one Baba syntax contract, unary application, structural products,
ordinary type values, and ownership analysis separate from algebraic subtyping.
The rule that surface conveniences elaborate into existing forms is especially
valuable: a convenient spelling need not introduce another runtime concept. See
[AGENTS.md](../AGENTS.md) and the [compiler specification](../spec/COMPILER.md).

The weakness is the explanation connecting those layers. A reader must currently
assemble the aggregate model from the language reference, examples, Runtime HIR,
the emitter, and the public ABI. That makes a general representation rule look
like an optimization that repairs an otherwise expensive source convention.

There are also documentation maintenance warning signs. For example,
[`LANGUAGE.md` section 6.5](../LANGUAGE.md#65-recursion) still shows an
expression-bodied `if`, while the
[cross-spec correction](../spec/COHERENCE.md#12-explicit-statement-values)
requires an explicit `do:` scope for statement forms. The
[cost model](../spec/COST_MODEL.md) places a broad residual-literal allocation
sentence immediately after discussing scalars, products, sums, and Stores. That
sentence should not be read as charging every residual product a heap object.
These are reasons to repair the originating descriptions, not to add more
permanent exception documents.

This review is focused on aggregate and call coherence. It is not a complete
soundness, security, or performance audit of the compiler.

## What the repository actually does

### Source meaning

[`LANGUAGE.md` section 6.1](../LANGUAGE.md#61-unit-arrays-tuples-and-shapes)
defines a tuple as a shape with positional field names `"0"`, `"1"`, and so on.
A tuple is an ordinary value: it can be bound, projected, returned, nested, and
matched. [`examples/data.blot`](../examples/data.blot) explicitly rejects a
stored-tuple versus transient-pack distinction.

Square brackets already have a different, definite meaning: a homogeneous array.
Homogeneous means one element constraint for every position; it does not require
every element to have the same singleton type. An array can have a union element
type. In a type-value expression, `[Int, Text]` computes `[Int | Text]`, not a
two-field product. Array length is not encoded in that type.

[`LANGUAGE.md` section 6.3](../LANGUAGE.md#63-functions-and-application) defines
one parameter pattern per lambda. Thus:

```blot
let subtract = fn pair => pair.0 - pair.1
let pair = (41, 9)
return subtract pair
```

has the same tuple argument model as:

```blot
let subtract = fn (left, right) => left - right
return subtract (41, 9)
```

The second lambda uses a destructuring pattern. It is not a different kind of
function with a privileged, allocation-free parameter list. Neither form means
`subtract 41 9`: juxtaposed application associates left, so that spelling calls
a function and then applies its result.

### Internal representation

In [`compiler/src/backend.rs`](../compiler/src/backend.rs),
`RuntimeTypeLayouts::flattened` recursively concatenates the representations of
all fields of a `RuntimeType::Product`. That function does not inspect whether
the source lambda used a tuple pattern or named its argument.

The same emitter implements `product.make` by assigning operand locals into the
result's flattened locals, and `product.project` by selecting the appropriate
local range. Function parameters, internal results, block arguments, and local
values use this representation machinery. There is no obligatory tuple heap
allocation at construction that only a parameter-pattern optimization removes.

For the directly represented fragment, the model is approximately:

```text
layout(Unit)              = []
layout(Int)               = [i64]
layout(Product(T0, T1))   = layout(T0) ++ layout(T1)
layout(Store(T))          = [i32 pointer, i32 length]
layout(Indirect(T))       = [i32 pointer]
```

This is a description of target representation, not a new source type system.
See [Runtime HIR](../spec/RUNTIME.md) for the complete relation and
admissibility rules. The evaluator's own `Value::Shape` bookkeeping in
[`compiler/src/value.rs`](../compiler/src/value.rs) is not evidence of a tuple
allocation in the generated program.

### Storage and boundary costs still exist

Products do not eliminate the costs of their components. Constructing text or a
nonempty dynamic array may allocate; copying many flattened fields takes work; a
Wasm engine may spill locals. Recursive representations and some runtime
closure-choice captures require explicit indirection. A simple known capture in
the test does not establish that every escaping closure is allocation-free.

An array's immutable value semantics are implemented with Store storage and
ownership-authorized reuse. Conversely, "array" does not mean "always allocates
at this source occurrence": the empty array is allocation-free and closed
literals can be pooled.

The public ABI is another real boundary. ABI 2 flattens parameters but uses
canonical indirect result storage where its result-lowering rules require it. An
internal tuple result can therefore be inline even when exporting that value
requires a caller-facing result buffer. That buffer is not evidence that tuples
have different source meanings in parameter and result positions. Preserve
[`docs/abi.md`](abi.md); do not change ABI bytes or signatures under the name of
syntax cleanup.

## Recommended coherent model

| Source form           | Meaning                                              | Representation expectation                                          |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| `(a, b)`              | Fixed-arity positional product; separate field types | Direct internal product layout, without a separate tuple object     |
| `{ .x = a; .y = b; }` | Named structural product                             | The same product layout mechanism                                   |
| `[a, b]`              | Array with one element constraint and runtime length | Store-backed collection, subject to empty, pooling, and reuse rules |
| `f (a, b)`            | Unary application to a product                       | No parameter-pattern-dependent boxing rule                          |
| `f a b`               | Two unary applications                               | Currying, not automatic tuple expansion                             |

Keep `()` as unit and `(a)` as grouping. This proposal does not introduce a
one-element tuple or new trailing-comma syntax.

A product should have the same source meaning when it is bound before a call,
returned from a helper, placed in another product, selected by a branch, or
captured by an ordinary closure. Those transformations must not require a
special parameter pattern to recover a direct product representation. Where a
real storage boundary requires indirection, name that boundary and its cost.

For demanded strict expressions, members still evaluate in source order and
function position before its argument. Flattening must preserve traps, effects,
and ownership transfers; it is not permission to drop a field computation merely
because its final value is not projected. Ownership of a product follows its
fields. Calling it inline must never imply that a linear field becomes copyable.

Conversions should be ordinary, explicit computations. For example, converting a
homogeneous pair to an array constructs `[pair.0, pair.1]`. Do not silently
convert an array into a tuple because a callee happens to use a tuple pattern. A
pair of differently typed values belongs in a product; an array of such pairs
can still have one homogeneous product element type.

### Why not restore two tuple-like syntaxes?

Making parentheses a transient argument pack and square brackets a stored tuple
would require a second account of binding, returning, nesting, capture,
reflection, and ownership. Either packs cease to be ordinary values, undermining
the unary-function story, or they become another product value distinguished
mostly by representation.

Making square brackets mean both a heterogeneous tuple and a homogeneous array
would also need a disambiguation rule. Expected-type-dependent meaning would be
particularly costly in a language where types are ordinary values and `[A]`
already has a compositional meaning. Replacing that contract is a breaking
language redesign, not a delimiter swap.

Both designs are possible research directions, but neither is needed to obtain
the useful original goal: cheap fixed-size aggregates that remain cheap outside
the syntactic call site. Prefer the existing single product model and expose its
representation honestly.

## What this PR establishes

[`src/node/inline_products.test.ts`](../src/node/inline_products.test.ts) uses
the real Rust/Wasm compiler and host-supplied runtime arguments. It exercises
direct and named tuple parameters, a bound alias, nested tuple/record values,
both branches of a product choice, a known closure capture, a recursive helper
returning a product, and a mixed `F64`/`Int` product.

The HIR assertions require a residual direct call and an internal product
result, and reject Store or indirect operations in this product-only program.
This prevents the test from succeeding solely because every helper and every
value disappeared during staging.

The generated Wasm must return the expected scalars without modifying or growing
linear memory. The test fills memory with a sentinel and compares its bytes
after each call: page-count-only checks would miss transient allocations whose
heap cursor is restored at the export boundary. Scalar public results keep
canonical indirect-result buffers outside this test's claim. Two rejection cases
separately pin that arrays and tuples do not implicitly substitute for one
another.

These are focused regression observations, not a timing benchmark, a proof of
zero machine instructions, or an allocation claim about arbitrary closures,
recursive data, array elements, and public aggregate results.

### Validation provenance

The focused command is:

```sh
node --import tsx --test src/node/inline_products.test.ts
```

Local execution passed **13 tests, 0 failures** using Node 22.16.0 and the
published workspace for `e60b49dac2ae5100fb3e0b5ec46b343f9ff5a060`, from Actions
run `33986435635`. The workspace carries its matching compiler manifest, Wasm,
prelude snapshot, and dependencies; no artifact-integrity check was disabled.

The new tests also passed alongside `src/node/pipeline.test.ts` and
`src/node/v8_wasm.test.ts`: **35 tests, 0 failures** in that same workspace. A
focused strict TypeScript check with the repository's compiler dependencies and
an ES2023 target passed, as did `git diff --check`. Deno formatting and the full
Rust/integration suite were not run locally.

`compiler/src/backend.rs` is unchanged between that workspace and reviewed main.
Other compiler files changed, so this result is not a claim that the tests were
run against main's complete compiler or that the full repository suite passed.
The normal PR CI must validate the proposed branch with its own rebuilt
compiler. No CI gate is weakened in this PR.

## Follow-through after agreeing on the model

1. Repair the authoritative explanations together: add the source/representation
   distinction to `LANGUAGE.md` sections 6.1 and 6.3; state the shared product
   layout rule in `spec/RUNTIME.md`; scope residual-allocation wording in
   `spec/COST_MODEL.md` to the operations that actually materialize storage.
   Update introductory examples to say "inline product", not "tuple allocation
   eliminated for parameters". Remove obsolete cross-document corrections when
   their originating examples are fixed.
2. Extend coverage at the real boundaries: product values in arrays, linear and
   borrowed product fields, runtime closure-choice captures, import wrappers,
   SIMD fields, wider products, and canonical public product results. Assert
   source observations separately from each boundary's allowed storage costs.
3. When a cost regression appears, fix the shared representation/lowering path.
   Do not add a tuple-pattern-only fast path, a prelude-name exemption, an
   implicit array conversion, or a second semantic implementation to hide it.

No syntax migration is recommended. The proposed change is to make a uniform
product model explicit and durable, rather than making programmers discover
which function-parameter spellings happen to be cheap.
