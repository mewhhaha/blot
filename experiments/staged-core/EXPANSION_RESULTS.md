# Recursive collections, scoped staging and bounded frontend reuse

## Result and scope

This increment builds on PR #172's `84d63aa` isolated Rust prototype. It adds
executable semantics and two optimizations to the existing shared frontend. It
is **not a production replacement and does not compile the private
application**. The 100 ms application target and the complete proposed
architecture remain unmet. Existing production entry points, Cargo
configuration, grammar, prelude snapshot and CI workflows are unchanged. The
shared Rust frontend/rebinding implementation **does** change and is validated
with the production compiler.

The largest public generated workload has **162,389 source bytes, 2,048 exported
caller bodies**, recursive comptime, reflected schemas, generated accessors,
immutable arrays, variant cases and polymorphic code. Its final native prototype
batch has a **99.316 ms edited median**, but spans **94.504–182.450 ms**; this
is not a worst-case 100 ms guarantee. Cold compilation has a **207.039 ms
median**. These observations must not be represented as `gdev` performance or
compared with earlier production/Wasm-hosted timings.

## Implemented semantics

- Named recursion is monomorphic while checking its self-reference, then
  generalizes for ordinary uses. The checked-core evaluator executes static tail
  transfers iteratively; emitted tail positions use Wasm tail-call instructions.
- Homogeneous immutable arrays, open-row variants and constructor cases work at
  both stages. Indexing returns `#Some`/`#None`, including for negative indices.
  Persistent push preserves aliases; fold callback arguments remain independent.
- Record-field reflection and computed array/record schemas operate on actual
  Type values, retaining shared graphs and nominal identities.
- Scoped checked-code builders construct lambdas, applications, conditionals,
  projections and aggregates. Unique bound slots cannot escape through splicing;
  actual checked types validate applications. Ordinary runtime values do not
  become static merely because a type query observes their types.
- Definition-local blocked `typeof`, static execution, splice and annotation
  obligations wait for their actual type/job dependencies. They resolve once or
  request a signature at the definition boundary. There is no arbitrary inverse
  type-function evaluation or publication of unresolved generic obligations.
- Function fragments and global/field relocations follow current semantic
  traversal order, not historical arena allocation IDs. Edited/fresh output is
  byte-identical even after insertion, deletion, shadowing and failed requests.

The exact fragment and failure classes are specified in
`spec/STAGED_PROTOTYPE.md`. `collections.blot` and `scoped-code.blot` are
executable public examples. No private source, executable, ABI contents, or
source-bearing profiling data is included.

## Frontend work removed without another parser

Entering a function or branch used to copy inherited `HashSet<String>` binding
layers, including the growing module prefix. Layers now retain shared immutable
name sets; mutation detaches with copy-on-write. The 4,096-binding / 4,096-scope
regression requires storage sharing while retaining frame, shadowing and
captured-rebinding diagnostics. The small vector of lexical layers is still
copied: this is not a claim of constant work for arbitrary nesting depth.

A resident prototype retains the previous successful **syntax snapshot**, not a
checked AST or whole artifact. Baba lexing/layout and token acceptance still
run. An identical significant terminal/lexical-identity sequence can reuse a
previous successful grammar tree, relocating both UTF-16 source spans and
token-edge indices. Different token widths, identifier spellings and trivia
counts therefore do not force the island executor to rediscover the same grammar
decisions. Changed terminal sequences, unmatched delimiters and
unanchored/zero-width nodes use the normal parser or retain their normal
diagnostic. Every changed payload is freshly lowered; no semantic input is
authorized by tree reuse.

Relocation uses bounded dense u32 source-offset tables, not a hash map per node.
Tree correspondence outside the edited region uses stable node IDs directly,
rather than another span-index map with per-node candidate vectors. Seventy-two
incremental-versus-fresh AST comparisons cover widths, identifiers, Unicode,
comments, layout, tuples, records, variants and arrays. Focused production-host
checks additionally verify new literal values, unresolved renamed uses, shifted
diagnostics and recovery.

The frontend snapshot's retained vector capacities are charged to the existing
storage budget. It is replaced only after a successful complete request and
released on reset. Each request still processes input/layout, lowers an AST,
checks dependencies/exports, relocates cached fragments, assembles the complete
module and validates Wasm. There is **no whole-artifact cache shortcut**.

## Final reproducible measurement

Run from this branch with pinned Rust 1.97.1:

```sh
cargo build --locked --release --manifest-path experiments/staged-core/native/Cargo.toml \
  --bin staged-prototype
node experiments/staged-core/measure-expansion.mjs \
  experiments/staged-core/native/target/release/staged-prototype
```

The crate's normal release profile is unchanged: size optimization, fat LTO, one
codegen unit. The compiler is a **native Rust process**. Node only launches it
and executes emitted Wasm. There is no production baseline comparison.

| Exported callers | Source bytes | Cold median | Real-edited median | Fresh changed-source median |
| ---------------- | -----------: | ----------: | -----------------: | --------------------------: |
| 128              |       10,357 |   10.388 ms |           5.968 ms |                   10.819 ms |
| 512              |       39,925 |   42.074 ms |          23.773 ms |                   43.998 ms |
| 2,048            |      162,389 |  207.039 ms |          99.316 ms |                  199.668 ms |

All **12 records** are in `expansion-samples.jsonl`: four observations per size,
using the checked-in rotated size order, in **24 fresh native processes** and 36
compiler requests. No hidden warmup, concurrent local build/test/profile, or
discarded observation. The 182.450 ms edited observation is retained; it is not
treated as noise and removed. Filesystem/OS caches are not deliberately flushed.
The 30-second parent deadline was never reached. Small shared-host samples do
not establish portable confidence bounds.

Each edit changes a caller's numeric constant to `99999`: **every size changes
token width and the executable behavior**, including a 1-byte source-length
increase in the 2,048-caller case. Original, edited and independent fresh
changed outputs are validated and every export is executed at three inputs.
Edited/fresh Wasm is compared directly byte-for-byte and by SHA-256. No original
artifact or unchanged-source cache result is returned as the edited result.

At 2,048 callers, the edit checks **one named definition**, reuses **2,056**,
makes **zero static calls**, emits **one new function fragment** and reuses
**2,054**. It still evaluates four simple static steps and checks the export
record. Core-fragment counts exclude initialization and export/helper wrappers.
The edited module has 386,189 bytes; charged retained storage is about 20.96
MiB, not a peak-process-memory measurement.

Compilation includes frontend processing, dependency validation/invalidation,
inference, required static execution, lowering, assembly and final Wasm
validation. Initialization, input/output file reads/writes and reporting are
outside `compilationMs`; process wall time and initialization are separately
recorded. `phasesMs` comes from an optional host callback at completed phase
boundaries; the compiler library does not read a clock and those observations
are not semantic inputs.

- Native binary SHA-256:
  `edb8c229b678d4e9b9c288ff9276b3ef543e6f60bc8fb47c55586c280e847481`.
- Complete sample-file SHA-256:
  `5d711cb370f001f30183a4752c9588c49a407445d761ec023c2f78c1c968e42f`.
- Per-size source, changed-source and executable hashes are retained in every
  record. Only public generated inputs occur in these records.

## Validation and rejected explorations

The final isolated test run passes **81 tests**, zero failures/ignores: 60
staged-core regressions and 21 shared-frontend tests. Relative to `84d63aa`,
this is 25 new staged-core tests and eight new shared-frontend tests. Native
all-target and Wasm-library Clippy pass with warnings denied. The release driver
completes 40 process invocations and 100,155 assertions; 100,000 are repeated
calls to one scalar export, **not independent test cases**. It additionally
exercises 100,000 runtime tail transfers and a 10,000-step static recursive sum.
Tail-call tests bound active frames, not every allocation. All original
regression coverage remains included.

Fresh whole-production and hosted validation is recorded in the PR discussion
when completed; an earlier green head is never substituted for this source. The
shared frontend is covered by the normal production test/build/snapshot checks
as well as the isolated crate. No test discovery, timeout or performance
threshold is weakened. The original prelude snapshot is not rewritten.

Exploratory timing runs before the final source are not extra observations in
this table. A same-width-only reuse version had an approximately 92 ms
large-case edited median, but smaller width-changing cases still reran the
parser. A hash-map relocation version handled those width changes and recorded
about 103 ms for the large edited case. The final version uses dense relocation
tables; all final samples above change token width. These separate batches do
not establish causal percentage improvements. Early byte-equality assertions
exposed history-dependent function/global order; the implementation was
corrected rather than dropping those assertions. Interrupted build/test attempts
are not passes.

A separate one-run native **production** diagnostic on the private application
still recorded approximately 1.25 seconds checking, 2.37 seconds runtime
preparation and 53 ms final emission. That was not the experimental compiler,
not a paired baseline for this table, and not an output-equivalence claim for
the new core. It supports investigating the remaining semantic work rather than
assuming a change of host alone meets the goal.

## Remaining requirements

Effects and resource ownership, module/import graphs, mutually recursive groups,
higher-rank inference, algebraic subtyping/refinement proofs, generic constraint
dictionaries, production ABI compatibility and full-application validation
remain unimplemented. Arrays currently use copying persistent append and a
uniform internal word representation. Scoped code uses checked builders, not
general open quasiquotation or a surface `Code<T>` type. Blocked obligations
settle within a named definition, not across exported dependent generic
interfaces. Arenas are bounded/resettable rather than incrementally
garbage-collected. Whole-module assembly remains. Neither the complete
architecture nor 100 ms compilation of the original application is claimed
finished.
