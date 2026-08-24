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

Every report names the source graph, compiler artifact hash, sample count,
aggregation statistic, and which setup work lies outside the clock. It reports
artifact equality or observation parity before timing comparisons.

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

For an affine arena whose node payload does not allocate between appends, the
latest Store allocation ends at the scratch heap cursor. Each authorized append
therefore extends the allocation by one fixed-size node in `O(1)`, construction
of `n` nodes is `O(n)`, and indexed traversal is `O(n)`. If a node payload
allocates first or another live allocation follows the Store, growth may move
and copy the existing `O(n)` prefix; the benchmark must expose that fallback
rather than describing every arena workload as linear.

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

Resident analysis schema 2 reports deterministic counters for unique interned
type nodes, recursive interning attempts, constraints, settle/freshen/union
visits, boundary materializations, closure free-name candidates, values
actually bridged, and peak pending solver worklist items. These counters are
process observations, not certificates and not ABI facts. The scaling gate
counts semantic decisions—constraints, boundary
materializations, and capture selection—separately from recursive graph visits.
The latter remain visible in the report because a shared constant-time visit may
still reveal a representation target even when it no longer dominates wall time.
Timing and both counter classes must be reported; one must not be relabeled as
the other.

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

Compile-time evaluation can dominate these bounds because it executes source
programs. Its budget and measured reductions are reported separately from
structural compiler traversal.

For a resident module `m`, let `A_m` be the size of the canonical phase input
for that module and `d_m` its number of direct dependency/include edges. Once
child revisions are known, constructing `m`'s recursive revision identity should
cost `O(A_m + d_m)` and store one fixed-size digest. A parent references each
child by that digest. Embedding a child's complete serialized key instead would
make parents repeatedly copy transitive key material; on chains it repeats each
descendant in every ancestor and on diamonds it repeats shared subgraphs per
path. That cost carries no semantic information and is therefore duplicate
compiler work.

For reachable closure values with total inspected summary-body size `B`,
deriving relational summaries is `O(B)` per fresh value graph and memoized
lookup is `O(1)` by closure identity. Instantiation is constant time for the
current unary affine fragment. A summary benchmark must use checked Blot modules
and report cold derivation separately from repeated lookup; a synthetic
fact-graph replay is evidence about solver scaling, not end-to-end compiler
speed.

Projecting one dead refinement identity from `V` graph nodes and `E` difference
edges costs `O(VE)` with the current repeated-relaxation closure and may emit
`O(V^2)` canonical remaining bounds. It is therefore performed only when a
rebinding removes the last visible alias, and benchmarks report both retained
fact count and wall time.

For a Runtime-HIR function with `H` blocks and `D` executed block transitions,
the fallback dispatcher can perform `O(D H)` block-identity comparisons. A
reducible entry cycle instead executes one structured path per iteration and no
dispatcher comparisons. Unfolding shared acyclic joins can increase emitted `Q`,
so eligibility includes a fixed expansion budget and otherwise preserves the
dispatcher. HIR removal of known boolean and sum round-trips reduces both the
expansion and the executed administrative steps without changing source work.

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

The progressive-HIR benchmark reports checking, pending-node completion,
whole-graph validation, emission, and phase-boundary heap high-water marks as
separate counters for unchanged, source-only, and semantic edits. A win requires
the combined check-plus-prepare median to improve with identical Runtime HIR and
artifact observations; relabeling the same work is rejected. The measured
baseline and artifact hash are recorded in
[`experiments/progressive-hir-performance.md`](../experiments/progressive-hir-performance.md).

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
