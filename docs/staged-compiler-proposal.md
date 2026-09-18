# Proposal: an inference-rich, explicitly staged compiler

## Status and decision

This is the architecture direction for PR #172's 100 ms investigation. It is a
**proposal, not the implemented language or a performance result**. The existing
Rust/Wasm compiler and the normative contracts in `LANGUAGE.md` and `spec/`
remain authoritative. The existing optimization experiments remain measurable
changes in their own right; they do not implement this architecture.

Keep strong compile-time execution, first-class type values, generated types,
reflection, higher-order compile-time functions, inferred generics, and typed
code generation. Rebuild the boundary between these capabilities and ordinary
runtime compilation:

> Work should scale with distinct definitions, relevant constraints, distinct
> static computations, and generated code, not with paths through captured
> environments or the history of constructing an abstraction.

Using an abstraction should consume its checked interface and implementation,
not reconstruct why the abstraction exists. The immediate next architectural
step is a small, opt-in prototype that tests that contract, not an unmeasured
whole-compiler replacement or another general environment cache.

The separately implemented surface-syntax decision is **one colon for typing**:
`let value: Int`, `const f: Int -> Int`, and `fn (value: Int) -> Int => value`.
The former double-colon annotation is not an alias. Existing `:=` rebinding,
`do:` and statement suites, and `->` result annotations retain their meanings.
This notation change does not itself implement any of the proposals below.

## 1. Separate three questions

**Typing** decides whether an operation is valid and records its type, effects,
and obligations. **Required static execution** computes a value, type, layout,
or generated program from available inputs. **Optimization** chooses optional
constant evaluation, inlining, or specialization while preserving meaning.

Ordinary compilation must not require aggressive optimization. Ordinary
inference must not discover its rules by repeatedly executing source factories.
A successful generator must produce a durable checked artifact that later passes
can consume without replaying construction or rediscovering dependencies.

The historical
[identity investigation](../experiments/compiler-bench/complete-compilation/SHARING_RESULTS.md)
found millions of evidence visits for hundreds of residual keys. This motivates
compact semantic artifacts; it is not an attribution of all remaining latency on
the latest compiler. Small emitted code alone is not proof of waste: an explicit
static computation can legitimately be expensive and emit a constant.

## 2. Inference and arbitrary type computation are different operations

`evaluate F(Int)` is forward execution. `solve F(?T) = Int` is not generally a
unification rule: an arbitrary function can be non-injective, partial, or reveal
nothing about its input. Support powerful forward type programs without
promising unrestricted backward inference through them.

The proposed inference core combines local type-and-effect constraints,
bidirectional expected-type propagation, structural records and variants, and
parametric generalization. Inference variables live in mutable solver arenas. A
completed definition publishes an immutable type scheme and typed body; generic
parameters are explicit binders, not unresolved mutable solver cells.

Target conveniences include inferred function parameters/results/effects, open
record rows, useful unions and refinements, higher-order callback inference, and
controlled higher-kinded applications. Higher-rank polymorphism, ambiguous
higher-kinded relationships, and difficult dependent relationships may require
annotations or witnesses. Specify the supported fragment before promising
principal types or complexity bounds for the combined system. Ownership remains
a separate flow analysis, not another unrestricted search in the type lattice.

A type computation blocked on unknown static inputs becomes a suspended
obligation with explicit dependencies. Wake it when those inputs settle; do not
repeatedly execute it with placeholders or enumerate arbitrary candidate inputs.
Report unresolved ambiguity at a useful source location. Keep ordinary
unification distinct from user computation and from proof search.

Automatic refinements should have a specified inexpensive fragment. Stronger
claims can use explicit checked proofs. Fuel or resource exhaustion is a
compiler-limit result, never evidence that a program is invalid or a license to
accept it without checking.

## 3. One source language; explicit semantic levels

Keep types as values in the ordinary source namespace. Two elaborated semantic
levels do not require two source languages or a second type namespace.

At the compile-time level, code manipulates immutable data, type handles,
schemas, compile-time closures, and scoped typed-code fragments. At the runtime
level, code has explicit typing and representation requirements, control flow,
closures, effects, and memory operations. Runtime unknowns cannot determine a
compile-time type, layout, effect descriptor, or public ABI shape.

A pure function may execute at compile time when demanded. A runtime call does
not become required compile-time execution simply because its arguments happen
to be known. Optional evaluation has a budget and preserves demand, traps,
divergence, evaluation order, ownership, and generative identity.

### First-class compiler objects and typed generation

A type constructor should return a validated type object directly. Likewise,
effect descriptors, layouts, and generated definitions need explicit compiler
representations and validation bridges. Avoid repeatedly reflecting ordinary
source records or closure environments back into these objects.

A generator for a codec should produce scoped typed code for the requested codec
interface. The internal artifact tracks both type and binding scope; splices
cannot introduce escaping variables or forge checking evidence. Prefer this
route for reflection and derivation. Syntax macros can still produce syntax, but
that output must undergo elaboration and checking.

Generated typed code may still require cheap well-formedness, bridge, ownership,
and backend validation. "Already typed" does not authorize bypassing those
boundaries or trusting arbitrary plugin-supplied objects. Concrete
specialization can introduce new obligations; record and discharge them
explicitly.

### A direct compile-time execution engine

Start with typed bytecode or similarly direct instructions, explicit capture
slots, and operations for types and scoped code. Compile static library code
once instead of repeatedly interpreting its surface syntax. Permit recursion,
loops, and local mutable builders, then freeze published results into immutable
objects. Specify which computations can appear in definitional equality; general
partial programs must finish producing a required type before it is used, not
become an unrestricted automatic equality procedure.

No ambient filesystem, network, clock, or random authority is implicit. External
inputs are explicit revisioned dependencies. Native, Wasm, and JIT execution are
later measured implementation choices; none repairs unnecessary semantic work.

## 4. Separately checkable abstractions

Distinguish **parametric functions** from **reflective generators**. A generic
algorithm is checked against abstract parameters and interface witnesses, once
per definition revision or mutually recursive group. Calling it supplies type
arguments and witnesses rather than rechecking its source algorithm.

A generator that inspects fields of a known type may emit a specialized
implementation. Execute that generator for distinct relevant static inputs, with
explicit dependency tracking. Do not force every generic function through
reflection just because reflection is available.

Provide a correct generic runtime calling convention, ordinary runtime closures,
and dictionaries where needed. A closure is code plus its runtime environment:
different captured runtime values should not require separately compiled bodies.
Optional specialization can remove dispatch overhead for hot paths. This is a
real runtime-speed/code-size/compile-time tradeoff, not a promise that all
generic code is automatically zero-overhead.

A specialization key should contain a checked body identity, explicit static
arguments, required implementation witnesses, representation choices, and target
policy. It should not contain an entire transitive interpreter environment.
Equal witness types do not imply equal witness implementations; equal layouts do
not imply equal semantic types. Effect handlers and resumptions need explicit
environment relations rather than hidden caller-frame dependencies.

## 5. Compact semantic graphs and identity

Use shared immutable published type nodes: primitives, parameters, functions,
rows, constructor applications, nominal identities, and explicit recursive
forms. Canonical handle equality can identify the same node; different handles
still need the language's permitted conversion/subtyping rules. Interning is not
a solution to arbitrary semantic equivalence.

Preserve graph sharing in normalization, substitution, and lowering. Avoid eager
union/intersection distribution and recursive-alias expansion. Use explicit
substitution environments where they avoid repeatedly copying whole type trees.
Measure both visited nodes and retained storage; a cache that stores every
flattened prefix can exchange a time pathology for quadratic memory.

Separate structural identity, explicit nominal/generative identity, and
diagnostic provenance. An explanation stack must not automatically become the
semantic key of everything constructed along that stack. Nominal and generative
operations need explicit declaration/instantiation identities.

A pure generative factory may publish a checked template with abstract fresh
names. Each legitimate instantiation supplies distinct names. Reusing a template
must not coalesce those names, source effects, capabilities, mutable regions, or
module occurrences. The exact stable-occurrence and revision rules require a new
specification and differential tests before replacing current semantics.

Compile-time closures should contain code identity and explicit captured inputs.
Name resolution identifies dependencies once; executing a closure should not
rediscover them by repeatedly walking mutable lexical ancestry. A common factory
result can be a generated module with named types, typed definitions, constants,
and explicit parameters, rather than an opaque bag of interpreter closures.

## 6. Semantic incrementality

Proposed query boundaries include:

```text
interface(definition)
typed_body(definition)
evaluate_static(function, static_arguments)
generated_module(generator, static_arguments)
layout(type, target)
lower_body(typed_body, representation)
emit_function(lowered_body, target)
```

Queries record the inputs actually observed. A changed source input need not
change its semantic result: reevaluate affected work and stop invalidating
consumers when the result is unchanged. Ordinary callers depend on a callee's
interface and symbol; callers that inline or specialize it also depend on its
implementation. Reflection depends on the fields/declarations it observes.
Failed lookups must track absence, because adding a declaration changes a
fallback decision. Errors and source origins must remain revision-correct too.

Editing runtime arithmetic should not rerun an unchanged schema generator.
Editing a schema must invalidate all dependent generated code and layouts. A
static helper implementation change with unchanged output need not invalidate
consumers of that output. Inferred interfaces are convenient but must become
stable artifacts once inferred.

Assign reusable identities while immutable objects are constructed. Do not
serialize the captured world before every cache lookup. Persistent storage needs
stable encodings and collision-safe validation; in-process work can use retained
handles. Invalidation, dependency validation, memory, and key construction all
belong in the performance accounting.

Reuse emitted function fragments and lower only affected bodies, while retaining
final module validation and canonical ABI checks. Relocations, symbol indexing,
and whole-module assembly may still cost time and must be measured explicitly.

## 7. Targets and milestones

Keep separate targets for a first complete compilation and a resident
compilation of a meaningful edit. Neither substitutes initialization,
preparation-only work, or an unchanged artifact-cache hit for compiling the
program. Prioritize 100 ms edited compilation while continuing to remove
pathological cold work.

A useful accounting model is source processing + constraint solving + required
static execution + generated-code work + emission + administration. Tie work to
actual distinct inputs and artifacts. Arbitrary static programs can run for a
long time or generate huge output; 100 ms is a representative-workload target,
not a universal language guarantee. Fix hardware, runtime, source snapshot,
measurement boundary, and optimization mode before judging it.

**M0 — specification and baseline.** This proposal records the direction. Retain
all existing positive, mixed, and negative results. The separate single-colon
migration changes notation only. No architecture-speed claim follows from it.

**M1 — independent experimental core.** Implement the smallest explicitly
staged, inference-rich core sufficient for a computed schema, typed codec/query
generator, higher-order generic algorithm with inferred effects, runtime
closure, and a generative abstraction. Use Baba for any surface parser. Keep the
existing compiler as production authority; the prototype is an opt-in
experiment, not a silent fallback or a second production checker.

**M2 — executable and editable vertical slice.** Emit runnable Wasm, validate
it, and compare fresh and real-edited outputs and diagnostics. Establish stable
query boundaries and precise invalidation before expanding surface
compatibility.

**M3 — migration decision.** Only after work bounds and latency demonstrate the
intended scaling, decide which semantics, artifact schemas, calling conventions,
and language features to migrate. Specify compatibility breaks and update the
normative language/compiler contracts with their implementation. Do not describe
unimplemented proposal features as current capabilities.

### Prototype acceptance matrix

| Experiment                                    | Required behavior                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Many calls to a parametric generic            | Check its generic source body once per definition revision/group, not once per call.       |
| Repeated pure generator request               | Reuse an artifact only when relevant static inputs and observed dependencies agree.        |
| Different runtime captures                    | Share code; preserve distinct environments and observable behavior.                        |
| Shared type diamond                           | Visit stored graph nodes; avoid tree expansion during normalization/substitution/lowering. |
| Local runtime-body edit                       | Do not rerun unrelated static generators or recheck unrelated bodies.                      |
| Schema edit or newly introduced lookup result | Invalidate affected artifacts and agree with a fresh compilation.                          |
| Generative instantiation twice                | Share templates only; preserve distinct legitimate identities.                             |
| Invalid or resource-exhausting program        | Preserve source diagnostics versus limit diagnostics; never accept through a fast path.    |

Report initialization, cold and edited full compilation, invalidation, emitted
bytes, peak/retained memory, work counters, and output checks separately. Test
multiple workloads rather than optimizing one private application alone. A fast
development backend may omit expensive optional optimization, never required
type/effect/ownership checks or static obligations. This is the next experiment
to build, not a result already achieved.
