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

## 3. Size parameters

Let:

```text
B = source bytes
T = tokens
N = compact-CST and AST nodes
E = inference bound edges
L = total finite row members examined
V = residual runtime nodes
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

Recursive parser state follows the current derivation path. Copying the active
path at every island call adds `O(D^2)` element copies along a depth-`D` chain
without adding information. Stack-disciplined push and pop keeps the same cycle
predicate with `O(D)` path storage. A flat stack is preferred while measured
depth keeps its membership scan cheaper than hashing every island call.

Compile-time evaluation can dominate these bounds because it executes source
programs. Its budget and measured reductions are reported separately from
structural compiler traversal.

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
- an unchanged top-level declaration prefix retains deterministic values across
  a later semantic edit while the checker derives the new revision;
- a complete checked compile-time environment may feed staging;
- `prepare` and `compile` share Runtime HIR;
- ABI layout planning feeds both manifest and adapters;
- validation does not re-infer source types; and
- an unchanged revision returns its certified artifact.

If a later phase appears to need the same traversal, first decide whether the
earlier artifact omitted a necessary certificate. Moving work between
TypeScript, Rust, gpupaper, or Wasm without removing it is not itself an
optimization.

## 6. Prelude economics

The prelude is an ordinary, comparatively large source module imported by most
programs. Its cost is governed by the same phase terms, not by a special
semantic rule. A resident or distributed certified snapshot may remove repeated
frontend, checking, and staging work under [`INCREMENTAL.md`](INCREMENTAL.md).

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
reproduction commands live in [`docs/rust-middle.md`](../docs/rust-middle.md).

## 7. Optimization acceptance

An optimization is accepted only when:

1. diagnostics and inferred principal types agree;
2. safety and ownership certificates replay;
3. Runtime HIR and ABI policy agree;
4. reference, conformance, and WebAssembly observations agree;
5. the benchmark includes the work claimed by its name; and
6. the profile attributes the improvement to a removed or cheaper cost term.

A faster result that changes a trap, effect trace, manifest, accepted program,
or cache invalidation boundary implements a different compiler judgment.
