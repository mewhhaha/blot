# Experimental staged-core contract

## Status and authority

This document specifies the **opt-in laboratory only**, implemented by
`compiler/src/staged/` and its separate native CLI crate in
`experiments/staged-core/native/`. It is not a second production Blot mode and
grants no production certificate, Runtime-HIR, ABI, cache or effect authority.
`LANGUAGE.md` and the production `COMPILER.md` pass graph remain unchanged. A
parseable laboratory program may be rejected by the production compiler, which
does not admit `@staged.*` as language primitives.

The prototype uses the same Baba frontend, including single-colon annotations
and source fixities, and reuses only its resolved AST representation. It does
not invoke production checking, evaluation, residualization, or emission.

## 1. Admitted pure fragment

Bindings, unary eager functions, tuples/unit/name/wildcard parameter patterns,
structural records and projection, scoped local bindings, simple lowered
conditionals, integer/text literals and annotations are checked independently.
The fragment uses rank-one HM-style generalization with open record rows;
expected annotations add ordinary unification constraints. Occurs and kind
checks prevent infinite types and row/value confusion. This is not algebraic
subtyping, higher-rank inference, or effect inference.

Published schemes bind all unbound variables in a completed definition. Local
let generalization excludes variables free in its lexical environment. Shared
immutable types are interned by complete structural equality; a hash match alone
never establishes equality. Unification and published storage are separate.

There are no implicit names. A program may write `const Int = @staged.int`.
Runtime integers in this laboratory are **signed wrapping 64-bit words**, not an
assertion that every production Blot integer has that representation. Text is
static-only. Functions and aggregates may exist internally at runtime, but only
scalar function exports are currently admitted.

Unknown names, incompatible types, invalid Type/Code bridge results and illegal
phase crossings return `Source` failures with source spans. Syntactically valid
forms outside the fragment return `Unsupported`. Work/depth/retention exhaustion
returns `Limit`, not a source rejection. A failed private compiler invariant or
invalid emitted binary returns `Invariant`, not a fabricated source failure.
Failures are not cached as accepted definitions or artifacts. Successfully
checked dependencies from a failed request may remain as individually validated
queries; the next request still validates their current dependencies.

## 2. Explicit static boundaries

`@staged.static e` checks `e`, evaluates checked core with no runtime local
bindings available, and lifts its closed immutable result. A known runtime call
is not implicitly executed. A type annotation separately demands a Type value.
No arbitrary type function is inverted to infer an argument.

Static primitives are `@staged.record`, `@type.arrow`, `@staged.getter`,
`@staged.fresh` and `@staged.iterate`. Scalar primitives (`add`, `sub`, `mul`,
`eq`, `lt`) and literal type/Boolean primitives share checked interpretations
between stages. Negative iteration counts are source failures; finite iteration
calls a typed step closure with the accumulator. The common work budget applies
on every iteration and on cache hits, so memoization does not create an
unbounded loop outside the limit mechanism.

A record-type bridge requires an actual closed record of Type values. A typed
accessor generator requires a closed record schema and an existing field. It
constructs a private typed core function with the schema's actual payload type.
A record resembling a code object is never accepted as code.

`@staged.quote e` is admitted inside a static demand and checks `e` as runtime
code with an empty local scope. Global symbols remain explicit dependencies.
`@staged.splice e` requires a genuine Code value, imports its checked type
scheme and refers to the immutable checked root. It does not parse or re-infer
that root's source. Local slots cannot escape quotation. The current
closed-quotation restriction is deliberate; this is not yet the proposed general
scoped-code API.

Static evaluation reads only immutable inputs, local captures and explicitly
resolved global definitions. It has no filesystem, network, clock, host
capability, source effect, or mutable resource authority.

## 3. Identity, caching and invalidation

Session-owned immutable type/term/value handles denote structurally interned
nodes. Mutable inference cells never escape through a published handle.
Diagnostic offsets are not semantic node identities. Large type display is
bounded and may be abbreviated; display is never equality evidence.

A named-definition key records its exact declaration/signature source and source
fixity header, plus the observed interface dependencies. Globals resolve to
stable session symbols, including shadowing occurrences. Ordinary runtime calls
observe an interface and symbol, not the implementation's construction history.

Static evaluation additionally records every actual global implementation read.
Successful pure calls may cache a result under exact callable and argument value
handles plus those transitive dependencies. A hit validates and replays its
observations, including into an enclosing generator. Updating a helper through
an unchanged interface still invalidates its static consumers. A body edit with
unchanged interface does not recheck ordinary runtime callers.

`@staged.fresh ()` allocates an opaque nominal type. Any enclosing static call
which executes a fresh allocation is excluded from the pure-call memo. Two
written generative requests remain distinct. An unchanged definition query may
reuse the already established occurrence. These names are laboratory-local: they
are not production effect atoms or a persistent cross-session identity API.

Failed name resolution aborts the request and is not memoized. Introducing a
missing name then retries normally. This covers negative-name recovery, **not**
a general query-language fallback with cached absence; such reflection is not
admitted yet. Module imports and cross-process query persistence are absent.

Each compile reparses the complete source and validates retained definition
queries. A real edit is not a whole-artifact cache hit. A reset releases all
interners, name maps, definitions, memoized static calls and emitted fragments.
Unreachable semantic nodes may otherwise remain until reset or a limit; this is
bounded retention, not fine-grained garbage collection.

## 4. Runtime representation and experimental emission

The checked core, not a source closure environment, crosses the laboratory's
emission boundary. This boundary has no production Runtime-HIR authority.
Private constructors and unification establish its input; the final module also
passes `wasmparser` validation before returning success.

Internal functions use `(environment: i32, argument: i64) -> i64` and an
immutable function table. Closures consist of a function slot and explicit
captured local values. A parametric function has one code body across runtime
arguments; closures sharing a body can hold different runtime environments.
Immutable tuple and record values use a uniform word layout; records carry
field-label tags so open-row code can project without per-type specialization.
This convention is not a zero-overhead performance promise.

Function fragments hold symbolic references to core functions, globals and field
labels. Each final assembly resolves current Wasm indices. Initialization orders
actual global dependencies, not historical symbol numbering. Reusing a fragment
after declaration insertion/deletion cannot retain stale relocations.

Exported functions admit closed unary Int64, Bool or Unit inputs/results. Unit
has no external Wasm parameter/result; Bool uses i32 zero/one and rejects other
input values. Int64 uses i64. Memory, table and allocator globals are not
exported; there are no host imports. Scratch allocations during a successful
scalar export are reclaimed at its return. A trap may leave that call's scratch
unreclaimed; no recovery guarantee is made for a trapped instance. The memory
maximum is 16 MiB; exhaustion traps. No pointers, closures, resources or
aggregate authority cross the external ABI.

Artifacts carry the explicit `blot.staged.experimental` marker and are **not**
canonical production Blot artifacts. They have no production ABI manifest. They
must not be installed in a production compiler distribution or used as a
shortcut past effects, ownership, provenance or representation validation.

## 5. Work, limits and measurement

Default limits are 262,144 UTF-16 source units, 2,000,000 charged work units,
128 recursive checking/evaluation depth, 500,000 retained semantic nodes, and
128 MiB of charged retained payload/cache storage. The existing frontend retains
its own limits. Cache admission is bounded at 1,024 static calls and 4,096 body
dependencies per entry; declining cache admission does not decline execution.

Storage charging counts node/payload/cache content, not allocator capacities,
transient inference/parser space, process RSS, or an exact heap upper bound.
Storage is checked at request boundaries and periodically during static
execution; one batch may overshoot a charged limit before reporting exhaustion.
Work counters are a specified engineering instrument, not an instruction count,
time limit, or asymptotic theorem for the full language. Host process deadlines
remain independent of these bounds.

`checked_definitions` / `reused_definitions` count named top-level definition
queries. Export expressions are always checked separately. `static_calls`
excludes cache hits, which have their own counter; it also excludes simple Type
reads. `static_steps` includes those evaluations. `emitted_functions` and
`reused_functions` count checked-core function/primitive fragments, not export
adapters, allocator/field helpers, initialization, relocation, final assembly or
binary validation. Retained-node/storage fields describe the session after the
request; they are not peak memory measurements.

The native CLI's complete interval includes frontend work, invalidation/query
validation, inference, required static execution, lowering, relocation, module
assembly and Wasm structural validation. Input/output filesystem work and JSON
printing are outside it; initialization is reported separately. The optional
edited input must differ. The emitted execution harness separately compares
edited behavior and failures with fresh compilation. Native toy timings must not
be advertised as Deno-hosted application latency or the 100 ms `gdev` result.
