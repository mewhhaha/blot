# Specification map

Blot separates source-language meaning, focused static judgments, compiler pass
contracts, target representation, and operational implementation notes. The
separation is useful only when the precedence between them is explicit.

## Authority order

1. [`grammar.baba`](../grammar.baba) decides concrete parse acceptance.
2. [`COHERENCE.md`](COHERENCE.md) owns cross-document invariants and explicit
   corrections where previously published rules disagree.
3. [`LANGUAGE.md`](../LANGUAGE.md) decides the remaining accepted-source
   behavior.
4. A focused specification owns the exact judgment in its domain, subject to the
   cross-document coherence contract.
5. [`PAPER.md`](PAPER.md) is the integrated semantic model and theorem map; it
   does not define a second language.

A subordinate document's broader authority claim is read subject to this order.
When a conflict is repaired in its originating document, the corresponding entry
in `COHERENCE.md` should be removed rather than preserved as permanent parallel
semantics.

## Documents

| Document                                                        | Authority                                                              |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`COHERENCE.md`](COHERENCE.md)                                  | Cross-spec invariants, precedence, and adversarially found corrections |
| [`LANGUAGE.md`](../LANGUAGE.md)                                 | Normative source behavior not corrected by `COHERENCE.md`              |
| [`PAPER.md`](PAPER.md)                                          | Integrated semantic model and theorem map                              |
| [`CORE_SEMANTICS.md`](CORE_SEMANTICS.md)                        | Demand, application, identities, modules, handlers, and progress       |
| [`COMPILER.md`](COMPILER.md)                                    | Compiler-wide judgments, pass contracts, and fact ownership            |
| [`QCORE.md`](QCORE.md)                                          | Shadow QCore arena, structural certificates, scopes, rows, and grades  |
| [`QCORE_TYPING.md`](QCORE_TYPING.md)                            | Executable pure-QCore typing and conversion shadow                     |
| [`TYPECHECKING.md`](TYPECHECKING.md)                            | Declarative subtyping, inference, staging facts, and solver invariants |
| [`PREDICATE_REFINEMENTS.md`](PREDICATE_REFINEMENTS.md)          | Implemented pure predicates normalized into canonical types            |
| [`AFFINE_ITERATION.md`](AFFINE_ITERATION.md)                    | Affine iterator semantics, Store identity, and lowering acceptance     |
| [`FRONTEND.md`](FRONTEND.md)                                    | Source, compact-CST, fixed-operator, and elaboration contracts         |
| [`EXPLICIT_DO_BLOCKS.md`](EXPLICIT_DO_BLOCKS.md)                | Explicit statement-block and return-scope surface contract             |
| [`STAGING.md`](STAGING.md)                                      | Compile-time evaluation, specialization, and representation closure    |
| [`SAFETY.md`](SAFETY.md)                                        | Coverage, relational proofs, and ownership certificates                |
| [`PARTITIONED_CAPABILITIES.md`](PARTITIONED_CAPABILITIES.md)    | Generic partitioned-authority proof algebra                            |
| [`OWNED_REGIONS.md`](OWNED_REGIONS.md)                          | Store-region provenance, split/join witnesses, and production gates    |
| [`OWNED_VALUES.md`](OWNED_VALUES.md)                            | Owned-until-shared Stores, borrowing, freezing, and explicit copies    |
| [`SCRATCH.md`](SCRATCH.md)                                      | Affine initialized-prefix builders and allocation recycling            |
| [`OWNED_ORDERED_MAPS.md`](OWNED_ORDERED_MAPS.md)                | Ordered-map representation, protocol invariant, and cost model         |
| [`REUSE.md`](REUSE.md)                                          | Declaration-tag Store-reuse assertions and Runtime-HIR certificates    |
| [`RUNTIME.md`](RUNTIME.md)                                      | Runtime HIR, semantic ABI relation, and target validation              |
| [`docs/abi.md`](../docs/abi.md)                                 | Normative Core Wasm ABI 2 bytes and caller ownership                   |
| [`docs/wasm-target-profile.md`](../docs/wasm-target-profile.md) | Operational V8/Wasm 3 feature profile and engine matrix                |
| [`CORRECTNESS.md`](CORRECTNESS.md)                              | Pass adequacy and the whole-compiler correctness obligation            |
| [`INCREMENTAL.md`](INCREMENTAL.md)                              | Revision identity, invalidation, and certified cache reuse             |
| [`PACKAGES.md`](PACKAGES.md)                                    | Package resolution, portable module capsules, and source fallback      |
| [`COST_MODEL.md`](COST_MODEL.md)                                | Work model, benchmark boundaries, and optimization acceptance          |

`docs/abi.md` is the one normative document under `docs/`: its ABI 2 layout,
lifting/lowering, and ownership rules are incorporated by reference from
`RUNTIME.md`. Its section named **Runtime target status** remains operational
and cannot weaken an ABI rule for an artifact the compiler accepts.

Other files under [`docs/`](../docs/) describe current commands, implementation
status, historical reviews, and measured limitations. A disagreement between
such a note and the authority stack above is an implementation or documentation
gap, not another semantic mode.

The specification files name proof obligations; they do not claim mechanization
merely by using theorem language. Tests, differential evaluation, certificate
replay, Runtime-HIR validation, Wasm validation, and the current Lean model each
provide evidence only for the boundary they actually encode.
