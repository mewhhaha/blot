# Compiler cost model

## 1. Purpose

This model locates work by semantic phase. Repository boundaries, programming
languages, and WebAssembly crossings are implementation details until a profile
shows their cost. Every performance result must preserve the contracts in
[`COMPILER.md`](COMPILER.md).

For source graph `G`, define cold compilation time as

```text
T_compile(G) =
    T_load
  + T_frontend
  + T_elaborate
  + T_check
  + T_safety
  + T_ownership
  + T_stage
  + T_specialize
  + T_hir
  + T_core
  + T_emit
  + T_validate
```

These terms are logical work. A fused implementation measures a combined term
and may subdivide it with internal counters. Serialization, copying, module
instantiation, and host/guest transfer are reported separately when present.

## 2. Benchmark classes

The following boundaries are not interchangeable:

| Class              | Compiler state before measurement                          |
| ------------------ | ---------------------------------------------------------- |
| cold process       | no process, module, parser, or compiler state exists       |
| cold compiler      | process exists; compiler artifact must load or instantiate |
| warm compiler      | compiler exists; no source revision is cached              |
| resident unchanged | exact revision and artifact are cached                     |
| source-only edit   | source changes but semantic AST revision is equal          |
| semantic edit      | lowered module changes and affected phases rerun           |

Every report names the exact benchmark and host inputs, source graph, compiler
artifact and manifest identities, toolchain versions, sample count, aggregation
statistic, and which setup work lies outside the clock. Comparisons require the
same workload/scenario matrix and stable workload paths. Independent runs are
not paired by array index: each candidate target-run median is compared with the
aggregate baseline and must clear the run's noise threshold. Every non-target
candidate-run regression is checked against the aggregate baseline with the same
percentage and noise gates, in addition to the aggregate regression check. A
suite retains every run's raw durations and recomputes both run and aggregate
summaries before comparison. A report establishes artifact provenance and
observation parity before comparing time.

Cold-process timing is an operational wall-clock boundary through child result
collection and exit, so result transport and teardown remain visible after the
completed check. Compiler-only boundaries stop at their named operation.

The semantic startup internal timer ends exactly at the completed check. Its
outer-process total is an adjusted operational estimate that subtracts the
measured syntax-consumer-only internal tail from fresh-process wall time.
Portable-AST export and decode belong to an explicitly named syntax-consumer
total; including them in the semantic total would charge ordinary compilation
for work it does not do. Benchmark provenance is captured before the first
sample and after the final sample, outside every measured boundary; a changed
capture rejects the report so one run cannot mix revisions. Startup provenance
covers the runnable harness, host worktree including relevant untracked files
and tracked deletions, root-plus-prelude source graph, compiler artifact and
manifest, manifest compiler inputs and source identities, compiler build
toolchain, repository commit, Node/V8 versions, platform, architecture, CPU
models/count, and the Node invocation flags. A comparison requires the same
execution environment. A startup report is invalid when its phase matrix is
incomplete or a distribution cannot be recomputed exactly from its raw samples.

The development edit-through-activation report applies the same stable-capture
rule outside its warm samples. Schema 3 identifies the repository commit and the
bytes or deletion state of every tracked and relevant untracked worktree input,
plus the complete measured Deno host harness, including every local file in the
resolved module graph and the installed dependency bytes it executes. It
separately identifies the compiler artifact, manifest, compiler inputs, prelude,
compiler source commit/tree, and Rust toolchain. Its environment records
Deno/V8, platform, architecture, CPU models/count, and hashes of the Deno
executable and exact invocation. A changed capture rejects the run. Compiler
profiling measurements and feature status remain explicit report facts. The
selected production or development-profile distribution supplies one adjacent
manifest, Wasm artifact, and prelude snapshot; those exact validated bytes feed
the measured project and both provenance captures. An absent optional profile on
every build identifies a production compiler; a present profile identifies a
development-profile compiler and contributes every initial and sample memory
checkpoint, including solver cardinalities. Mixed observations or disagreement
with the manifest profile reject the report rather than infer feature status
from binary contents.

The development committed boundary begins before the provider write and ends
when transactional project activation resolves. The activation-only boundary
subtracts the build's nested duration from that same outer activation interval.
RSS is captured at resolution. Changed-unit classification is part of the build
and committed boundaries. The assertion over that classification and the runtime
observation remain mandatory parity checks after both clocks and the RSS sample.

Generated-code execution is a separate boundary from every compiler class above.
A warm generated-execution measurement starts with validated and compiled
WebAssembly modules; compilation, module instantiation, warmup, and observation
validation remain outside the clock. It times calls into an already instantiated
artifact. A report comparing generated artifacts names both source programs,
their artifact hashes and byte sizes, code-generation flags, execution engine
and version, workload inputs, invocation counts, and the same sample statistics.
It establishes observation parity against an independent model before timing.
Host crossings remain in the measurement when they supply dynamic inputs and
must have an explicit baseline rather than being subtracted after the fact.
Artifact-size reports include both complete bytes and marginal bytes relative to
a boundary-matched minimal artifact. The complete size is the shipping cost; the
marginal size answers how much one workload adds without conflating a nullary
host adapter with a first-order function adapter.

Scaling comparisons keep source and generated artifacts fixed while varying a
runtime input. A semantic counterpart must preserve traps as well as returned
values: Rust integer workloads enable overflow checks because Blot `Int` traps
rather than wraps. It must also preserve retention: Rust may reuse a `Vec` only
when Blot carries owned-reuse permission for the corresponding Store. When a
previous Store version remains observable, the Rust comparison must copy as
well. Reports distinguish that required persistent cost from a missed ownership
optimization.

An owned Store allocation retains a private geometric capacity. Each authorized
append is amortized `O(1)`, construction of `n` fixed-size elements is `O(n)`,
and indexed traversal is `O(n)`. Growth at the heap cursor extends in place;
otherwise it moves and copies the initialized prefix only when capacity is
exhausted. A persistent append still allocates and copies its `O(n)` prefix
because an earlier Store version remains observable, so repeated persistent
growth remains `O(n^2)`. Its fresh result may be reused by the next consuming
iteration; a loop seeded from shared or pooled storage therefore pays at most
one persistent copy before switching to amortized owned growth. The lowering
audit follows direct calls transitively from compiler-generated loop functions;
moving a persistent append into a source helper does not remove it from this
check.

A closed scalar, text, product, sum, or sealed `store.literal` contributes
`O(n)` static bytes and no runtime construction steps. A residual literal
performs one `O(n)` allocation and `n` writes. Equal pooled closed literals do
not increase static bytes after the first occurrence. Pooling occurs before
Runtime-HIR serialization, so the literal's producer operations are absent from
every backend artifact.

`@text.join` scans `k` slices once to compute the byte length, allocates once,
and copies `b` bytes in `O(k + b)`. `Text.replace` builds those slices with
geometric Scratch growth, so it does not copy a growing text prefix. Map lookup,
put, and remove share one borrowed linear index scan; put performs at most one
owned Store write or append after the scan, and remove performs one
decomposition after the scan.

## 3. Size parameters

Let:

```text
B = source bytes
T = tokens
N = compact-CST and AST nodes
E = inference bound edges
L = total finite row members examined
V = residual runtime nodes
H_s = settled typed-Core nodes committed during checking
H_p = typed-Core nodes left pending for specialization
Q = emitted WebAssembly instructions and bytes
C = distributed capsule bytes
M = package-owned modules in a capsule
X = logical external package edges
```

The desired frontend is `O(B + T + N)` for a fixed grammar plan. Elaboration is
`O(N)` apart from explicit compile-time work. The type solver is polynomial in
the finite bound graph; duplicate edges and visited ordered pairs are processed
once per transaction, while failed union choices add the work of the candidates
actually explored. Runtime validation, Core construction, and emission should be
linear in their artifact sizes.

The live and constraint-arena type views store each finite record, update, and
variant row as one source-ordered vector plus one shared label-to-position
index. Constructing a row is `O(L)` expected work, cloning it is `O(1)`, and one
field or constructor lookup is expected `O(1)`; checking `L` case arms against
an `L`-constructor variant must not scan the complete row for every arm.

The type-mechanics scaling experiment varies one source dimension `N` at a time.
An ordinary declaration chain, one wide structural requirement, `N` independent
polymorphic instantiations, `N` fixed-size predicate refinements, a chain of `N`
generic wrappers, a chain carrying one array-length measure, and `N` independent
structural proof packages should each add `O(N)` AST nodes, finite members,
constraints, or boundary observations. A one-column closed union with `N`
constructors and `N` arms should likewise be linear after constructor-set
normalization. Superlinear wall time is not by itself a complexity proof, but a
stable doubling ratio above two identifies a phase and source family that needs
an internal counter or profile. The reproducible boundary and current evidence
live in
[`experiments/type-scaling/README.md`](../experiments/type-scaling/README.md).

Resident analysis schema 3 reports deterministic counters for unique interned
type nodes, recursive interning attempts, constraints, settle/freshen/union
visits, boundary materializations, closure free-name candidates, values actually
bridged, opened interface fields actually demanded, and peak pending solver
worklist items. These counters are process observations for the current semantic
request, not accumulated history, certificates, or ABI facts. A request that
reuses a checked revision reports no work record. The scaling gate counts
semantic decisions—constraints, boundary materializations, and capture
selection—separately from type-graph work. The wrapper and measure lanes also
gate the sum of unique type nodes, recursive intern attempts, and freshening
visits. The dense multi-subject lane additionally gates settle plus union
visits, so a nearly linear decision count cannot hide a quadratic recursive
solver walk. Other recursive graph visits remain visible because a shared
constant-time visit may still reveal a representation target even when it no
longer dominates wall time. Timing and all counter classes must be reported; one
must not be relabeled as another.

Progressive Runtime-HIR construction visits each settled Core node once and
stores `O(H_s)` compact builder state. Preparation subsequently visits the `H_p`
pending nodes plus the final graph validation, rather than repeating all settled
semantic work. Structural identity hashing is linear in newly interned edges and
is memoized by `TyRepId`; formatting a recursive type is never part of the hot
key path.

Recursive parser state follows the current derivation path. Copying the active
path at every island call adds `O(D^2)` element copies along a depth-`D` chain
without adding information. Stack-disciplined push and pop keeps the same cycle
predicate with `O(D)` path storage. A flat stack is preferred while measured
depth keeps its membership scan cheaper than hashing every island call.

Incremental compact-node reuse computes one maximal unchanged source prefix and
suffix, then performs expected `O(N)` rule/span index work for `N` compact
nodes. It does not rescan every nested node's complete source span. A
syntax-equivalent token edit can skip Baba island execution; lowered-AST reuse
additionally requires unchanged semantic token spellings and positions.

Compile-time evaluation can dominate these bounds because it executes source
programs. Within one staging execution, closed monomorphic empty-effect calls
with closed first-order arguments and results use a bounded result cache keyed
by closure-creation identity and structural argument value. A textbook
overlapping recurrence then pays for each distinct argument once during staging,
while its residual runtime function retains the written algorithm. Its budget
and measured reductions are reported separately from structural compiler
traversal.

Compile-time union values retain one source-ordered member vector behind shared
immutable ownership and a fingerprint-to-member index. Extending an unaliased
union moves that storage and performs expected `O(1)` membership work for
fingerprintable closed literals, constructors, ranges, and nominal values.
Fingerprints select candidates only; exact semantic equality resolves every
collision. An aliased union copies on extension so source immutability remains
observable, and values without a sound fingerprint use exact linear fallback.

A resident deterministic nullary module result is evaluated once per semantic
revision when its closed interface exposes no generative effect identity.
Importers then share that result by structural reference; reopening a large
module must not replay its declarations or copy every exported field. Installing
its persistent snapshot decodes each lexical environment once and evaluates only
the module's result expression over that environment. It does not replay the
declaration sequence or duplicate a closure signature per value.

Reverse invalidation structurally fingerprints a recursively complete immutable
result. If the result is absent or contains a process-local closure, deferred
environment, function choice, Region authority, rejoin witness, or residual
runtime value, a fixed-size semantic-revision identity replaces graph
serialization. Complete first-order boundaries can still stop propagation after
a private edit; graph-private boundaries conservatively recheck their importers
instead of paying for an incomplete or recursively sized fingerprint.

After invalidation, development splitting still traces the complete reachable
call graph and reload edges. It materializes, serializes, ABI-closes, and emits
only units whose retained source membership intersects the checked impact cone
or whose exact function/link partition changed. For `U` configured units, `E`
reachable call edges, and changed unit artifacts of total size `A_c`, an edit
pays `O(E + U)` classification plus `O(A_c)` unit preparation rather than
serializing every unit artifact.

The snapshot's immutable flat-type arena is validated in place and moved into
the installed interface. A snapshot revision uses its manifest-validated digest
directly, so installation does not serialize the AST merely to compute the
source-inspection digest. Installation inflates the result, effects, and
optional parameter that form the public boundary. A private expression type or
closure signature is inflated, freshened, reified, and memoized only when
evaluation first requests that source-expression fact. Snapshot installation
therefore does not recursively expand private facts that the installed
computation never observes.

For a resident module `m`, let `A_m` be the size of the canonical phase input
for that module and `d_m` its number of direct dependency/include edges. Once
child revisions are known, constructing `m`'s recursive revision identity should
cost `O(A_m + d_m)` and store one fixed-size digest. A parent references each
child by that digest. Embedding a child's complete serialized key instead would
make parents repeatedly copy transitive key material; on chains it repeats each
descendant in every ancestor and on diamonds it repeats shared subgraphs per
path. That cost carries no semantic information and is therefore duplicate
compiler work.

After the first synchronization of an immutable loaded node, its local payload
and direct-configuration digests are resident facts. A warm graph revision pays
`O(A_m + d_m)` only for replaced or rebound nodes and `O(1)` digest lookup for
each retained node. Rehashing every retained source byte would make an isolated
edit scale with total workspace size before semantic invalidation begins.

Published semantic boundaries follow the same rule inside a resident session.
The producing module compares its complete canonical bytes, but a parent stores
only a collision-free fixed-size session identity for each direct dependency. No
parent copies the dependency's serialized type or compile-time value graph.

For reachable closure values with total inspected summary-body size `B`,
deriving relational summaries is `O(B)` per fresh value graph and memoized
lookup is `O(1)` by closure identity. Instantiation is constant time for the
current unary affine fragment. A summary benchmark must use checked Blot modules
and report cold derivation separately from repeated lookup; a synthetic
fact-graph replay is evidence about solver scaling, not end-to-end compiler
speed.

A difference entailment with `S` distinct required source nodes performs `S`
single-source relaxations, each bounded by `O(VE)`, rather than an all-pairs
closure. Projecting one dead refinement identity deduplicates its incident
edges, retains nonincident facts, and composes its `P` predecessor bounds with
its `Q` successor bounds in `O(E + P Q)` work. It emits no transitive paths
among unrelated live nodes. Projection occurs only when a rebinding removes the
last visible alias, and benchmarks report both retained fact count and wall
time.

For a Runtime-HIR function with `H` blocks and `D` executed block transitions,
the fallback dispatcher emits `O(H)` branch targets and executes one indexed
`br_table` per transition, for `O(D)` dispatch operations rather than `O(D H)`
block-identity comparisons. A non-reconvergent acyclic function emits its direct
structured path with no dispatcher, and a reducible entry cycle executes one
structured path per iteration. Unfolding shared acyclic joins can increase
emitted `Q`, so eligibility budgets duplicate visits while unique linear blocks
do not consume that budget; excess duplication preserves the dispatcher. HIR
removal of known boolean and sum round-trips reduces both the expansion and the
executed administrative steps without changing source work. For closed sums this
removal applies to the canonical integer switch over the constructor tag, not a
reconstructed chain of equality conditionals.

Runtime-HIR normalization propagates operation uses, aliases, block liveness,
and affected control-flow folds through dependency worklists. Exact type,
signature, and function-body interning adds work proportional to their closed
structural size plus call-graph partition refinement and publishes only
compacted identifiers. A function body is alpha-normalized and serialized once.
Ordered call positions form deterministic transition labels; inverse-edge
partition splitting queues the smaller new class, bounding refinement by the
call edges that can distinguish a class rather than by body-size times recursive
color rounds. Recursive runtime types use the same ordered inverse-edge
partition judgment. Type compaction is followed by one fixed-point inverse
representation fold and dead-producer sweep; this prevents equivalent recursive
types from leaving allocation and load round-trips in the published module.
WebAssembly local allocation performs reverse-CFG worklist
liveness, constructs one conservative interval per SSA definition, and
linear-scans intervals within equal physical representations. It stores
`O(V + H)` range and queue state beyond the block-liveness facts rather than an
explicit pairwise interference graph; the sort and active-interval queue cost
`O(V log V)`. The emitted local count remains bounded by simultaneously live
intervals rather than total SSA definitions. A proved iteration allocation
region restores one cursor per backedge, so temporary allocation within a loop
is bounded by the largest iteration instead of the sum across iterations.

Cold capsule loading hashes and decompresses `O(C)`, validates the `M` bundled
flat ASTs, and resolves the `X` external edges through installed manifests. It
avoids reading and processing package-owned sources through the frontend, but it
deliberately does not claim to avoid checking. A benchmark that calls this a
compiled-interface cache is therefore mislabeled; that name becomes valid only
when a later schema carries and validates the closed certificates specified in
[`PACKAGES.md`](PACKAGES.md).

## 4. Representation targets

Hot compiler structures should be flat append-only arenas with integer
identities. The goal is predictable linear scans, cheap equality, and bounded
rollback:

```text
TypeId, VarId, LabelId, NodeId, CertificateId : u32
```

Finite rows are sorted and interned. Constraint propagation uses an explicit
worklist and journalled transactions rather than whole-graph clones. Persistent
environments share unchanged lexical parents. These layouts enable scalar cache
locality first; SIMD is justified only when a contiguous finite-set scan remains
a measured dominant cost.

The live Rust type view may remain recursive where pass code benefits from
structural matching, but its immutable recursive edges and finite member lists
must be shared. A clone then preserves the existing graph rather than rebuilding
it. Interned `TypeId` remains authoritative for mutable constraint adjacency;
the shared view does not introduce another equality or inference judgment.

Opening an immutable compile-time record is represented by a shared field table
plus a target-to-source index. For `F` opened names and recursively sized values
of total size `S`, constructing the scope costs `O(F log F)` name-index work and
`O(F)` indices, not `O(S)` recursive value and type cloning. Lookup retains the
same lexical result by the open-frame lemma in
[`TYPECHECKING.md`](TYPECHECKING.md).

Parallelism begins at independent module or declaration-group boundaries. One
connected mutable inference graph remains sequential unless a different solver
comes with a proof of the same principal result. Parallel overhead is not paid
for graphs without simultaneous ready work.

## 5. Avoided duplicate work

The compiler performs each semantic derivation once:

- checking records facts that lowering consumes;
- checking commits Runtime-HIR nodes whose complete premises are already closed;
- an unchanged top-level declaration prefix retains deterministic values across
  a later semantic edit while the checker derives the new revision;
- a complete checked compile-time environment may feed staging;
- `prepare` and `compile` share Runtime HIR;
- ABI layout planning feeds both manifest and adapters;
- validation does not re-infer source types;
- an unchanged revision returns its certified artifact; and
- recursive revision keys retain only fixed-size child digests rather than
  reserializing transitive dependency keys in every importer.

If a later phase appears to need the same traversal, first decide whether the
earlier artifact omitted a necessary certificate. Moving work between
TypeScript, Rust, an external oracle, or Wasm without removing it is not itself
an optimization.

The maintained compiler benchmark reports checking, analysis, Runtime-HIR
preparation, and emission as separate boundaries for unchanged, source-only, and
semantic edits. A win requires exact public observations and deterministic work
with no significant regression at another boundary; relabeling the same work is
rejected. The benchmark contract and reproduction commands are recorded in
[`experiments/compiler-bench/README.md`](../experiments/compiler-bench/README.md).

## 6. Prelude economics

The prelude is an ordinary, comparatively large source module imported by most
programs. Its cost is governed by the same phase terms, not by a special
semantic rule. A resident or distributed certified snapshot may remove repeated
frontend, checking, and staging work under [`INCREMENTAL.md`](INCREMENTAL.md).

For a closed nullary leaf of check cost `C_m`, the resident-leaf rule pays `C_m`
once per module revision rather than once per edited importer. A cache hit still
pays fresh importer specialization work; it removes only the leaf's own
inference, evaluation, ownership, and locally settled fact work. The leaf
restriction keeps the first implementation from hiding transitive work in a
nominally constant cache lookup.

Current measurements are observations, not specification constants. Before the
prebuilt snapshot, five independent nine-sample runs on 2026-08-04 placed the
full Rust/Wasm compiler at a 73.6 ms fresh-process cold median, a 0.280 ms
unchanged resident-check median, and a 14.4 ms semantic-edit median. An
alternating same-process comparison with a compiler-embedded snapshot measured
complete `examples/storage.blot` compilation at 20.20 ms including Wasm
instantiation, versus 51.33 ms with the same prelude loaded from source. After
moving the same snapshot beside the compiler artifact, five independent
nine-sample warmed-engine runs measured 22.59 ms end to end, including 3.79 ms
of instantiation. The representation removes frontend and checking work for the
trusted prelude while retaining its once-per-session compile-time evaluation and
one artifact read. The profile did not show a dominant finite-row scan, so it
did not justify explicit SIMD in the solver. Operational numbers and
reproduction commands live in [`docs/compiler.md`](../docs/compiler.md).

## 7. Optimization acceptance

An optimization is accepted only when:

1. diagnostics and inferred principal types agree;
2. safety and ownership certificates replay;
3. Runtime HIR and ABI policy agree;
4. reference, conformance, and WebAssembly observations agree;
5. the benchmark includes the work claimed by its name; and
6. the profile attributes the improvement to a removed or cheaper cost term.

Sorting benchmarks additionally distinguish one-Store permutation, cached-entry
Stores, initialized stable-scatter destinations, and affine Scratch capacity. An
allocation claim counts element capacity, not merely Runtime-HIR operation
sites. Timing is reported but is not an absolute CI threshold.

Generated-code comparisons additionally use the same target boundary. Native
Rust and Rust WebAssembly answer different questions; the Rust counterparts in
the Wasm execution benchmark are compiled to `wasm32-unknown-unknown` and run in
the same warmed engine as Blot.

A faster result that changes a trap, effect trace, manifest, accepted program,
or cache invalidation boundary implements a different compiler judgment.
