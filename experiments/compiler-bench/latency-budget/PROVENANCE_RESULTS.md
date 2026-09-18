# Persistent effect provenance and genuine edited compilation

## Result: the 100 ms goal is not reached

This experiment starts from PR #171's validated `92972a5` compiler, not from
main before #171. It replaces repeatedly copied/hashed effect-call histories
with a persistent immutable graph and adds an edited-source measurement mode.

The cold median changes from **6,647.214 ms** to **6,595.154 ms** (-0.78%). The
real edited median changes from **3,959.694 ms** to **3,817.549 ms** (-3.59%).
The ranges overlap substantially. **This small shared-host batch does not
demonstrate a reliable end-to-end speedup.** It is not another large application
performance win, and it does not establish 100 ms compilation.

| Operation                               | Baseline median | Candidate median |           Baseline range |          Candidate range |
| --------------------------------------- | --------------: | ---------------: | -----------------------: | -----------------------: |
| First complete compilation              |    6,647.214 ms |     6,595.154 ms |   6,262.075–7,784.440 ms |   6,328.486–6,963.648 ms |
| Real entry edit, including invalidation |    3,959.694 ms |     3,817.549 ms |   3,601.776–5,015.837 ms |   3,674.791–4,549.604 ms |
| Compiler initialization                 |      210.428 ms |       206.943 ms |       202.740–228.971 ms |       195.452–319.426 ms |
| Unchanged edited-revision cache hit     |        1.860 ms |         1.691 ms |           1.197–2.940 ms |           1.328–2.521 ms |
| Entire cold/edit/control process        |   11,279.567 ms |    11,078.360 ms | 10,560.946–13,359.097 ms | 10,596.922–12,043.747 ms |

The unchanged control is fast because it returns the existing artifact. It is
not the latency of a changed application. The current candidate still spends
about 38 times the 100 ms budget on the measured entry edit, and about 66 times
that budget on cold compilation. Initialization is additional work; it is not
hidden inside a warmup. Process wall time covers the complete cold, edit, and
unchanged-control sequence, not a single cold CLI invocation.

## Measurement and output equivalence

`provenance-samples.jsonl` contains all twelve unedited JSON observations. Six
rounds alternate baseline/candidate and candidate/baseline order; each
invocation creates a fresh Deno process and compiler session. Each process
performs one cold compile, one genuinely changed entry-buffer compile, and one
unchanged control. There are 24 complete compilations in the latency batch.
Every cold/edited artifact reports `compiled`. The unchanged control must report
`revision-cache` and preserve the edited Wasm and ABI exactly. No sample was
discarded; no timeout, hidden warmup, or simultaneous local build, test, or
profiler occurred during the batch. The parent-enforced 90-second per-process
deadline was never reached. OS and file-system caches were not flushed.

The edited buffer changes one runtime numeric coefficient in the entry module.
The rest of the ten-file, 162,451-byte input snapshot remains unchanged. The
actual `setOverlay` operation is inside the timer, so invalidation and source
synchronization are included. Reading the editor-supplied buffer, fingerprinting
inputs, hashing/validating outputs, optional output writes, and teardown are
outside the compilation intervals and inside process wall time. This is an
entry-only implementation edit, not an import/interface edit or development-unit
rebuild. It does not establish performance for those other workloads.

All twelve original outputs are byte-identical across versions. All twelve
edited outputs are also byte-identical across versions and differ from the
original executable. Every module passes Wasm validation. After the batch, a
separate fresh candidate process compiled the edited source on disk at the same
entry path: its Wasm and ABI agree byte-for-byte with the edited-session result.
The original file was restored immediately afterward. This untimed control is
not included in the paired percentage. A public synthetic harness test checks
the same fresh-versus-edited contract without embedding the application.

- Original input-closure SHA-256:
  `19d5c1a68ce72dba041311bc5428532afa88ab8e341260db3faa669837e60052`.
- Replacement entry-buffer SHA-256:
  `41fc1974efc8f594dbccdb01a8c3c4f6fe644f5b3faea339b5174f09f8ca9fab`.
- Original Wasm SHA-256:
  `ec7595dcff269a1948c1a8f494cbfae7663f29bba7b9f2c0cae04ba6a5cb4f7e`.
- Edited Wasm SHA-256:
  `50a35f1db38cbef4d7b777302ddbab806372da56737112a0ba6c37adeeb28bfe`.
- Original and edited ABI SHA-256:
  `6db001e573531b24cf4ebcbe3dd69c3fd62e2c768150825204731391847652bb`.
- Original and edited module size: 1,479,171 bytes.

Input digests include absolute paths and are not relocation-invariant. Private
source, application Wasm/ABI contents, and source-bearing stderr/profiles are
not published. These digests establish equality within this checkout, not
cross-host path independence.

## Distribution provenance

Both artifacts were rebuilt using Rust 1.97.1 and the unchanged production
`scripts/build_compiler.ts --check`: size optimization, fat LTO, one codegen
unit, and an 8 MiB Wasm stack. Dependencies are the same locked vendored
sources. The original tracked prelude snapshot is unchanged in both builds.
Runtime is Deno 2.9.7, default tiering. Deno's `node` compatibility version in
each JSON sample is not a second Node-runtime experiment.

| Artifact  |     Bytes | Compiler SHA-256                                                   | Semantic-input SHA-256                                             |
| --------- | --------: | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Baseline  | 7,297,629 | `c88e96cba04b4795f21fe319298adb9fc151c937f02f6bdc6d055488aaa77e33` | `8e657674d9e88addadd8a35b44cc386e8449c50a407e5b8eecd6654bb4d2791b` |
| Candidate | 7,303,063 | `c96bef93150c33d7ae9348ca627ab649acd0a768e5a7b3a685183901a7aa56bd` | `f6e4e2f7e08daa10e423f8e49a8996fac7c7d15942dbdfefd7208ffeb42dfeb6` |

Snapshot SHA-256:
`87718708480be1ebe78c1c6cff3944c8e78cafce48157495dad3c780df7bd57f`.

The reconstructed baseline Git tree exactly matches published tree
`8019d76731b65fc698e6e9e4f2eab2a90237895d`. The candidate was built before its
source changes were committed; its generated manifest consequently records the
pre-change commit/tree. The candidate's semantic-input digest and these exact
source blobs identify what was built, rather than that pre-commit metadata:

- `compiler/src/effect_scope.rs`: `8c835f151fb6226e937b22932c7b297515ad9239`.
- `compiler/src/eval.rs`: `7d874d17919c4c13e4f4f909c2229e126f8b1164`.
- `compiler/src/hir.rs`: `7e01c34055add9ae4fe193addf5daa5409447511`.
- `compiler/src/residual_identity.rs`:
  `bab4a6817c1360562db91d32aabbd1cacf5ce4dd`.
- `compiler/src/session.rs`: `1844091fdc78f3b2969d9cdd035a7767898ea117`.
- `compiler/src/value.rs`: `423756d62ce4a884dad86a8e860df917c4ab2f79`.
- `compiler/src/value_capsule.rs`: `2327971ad8d7414e56e970fdc7e9ca7acb10e132`.

This host reports an Intel Xeon Platinum 8573C, a four-core CPU quota, and a 4
GiB memory limit. It is shared infrastructure, not a controlled reference
machine. Absolute timings must not be combined with the previous PR's 4.36 s
capture result on another host.

## What the structural change establishes

An effect-call scope was a vector of frames, each of which could retain another
creation scope. Fork-and-append copied the prefix, and derived hashing/equality
could traverse every path through shared creation histories. The replacement
retains a persistent prefix and immutable creation-scope edges. Appending adds
one node, and cloning a scope retains its root.

Hashes are cached only on immutable owning nodes, computed in bounded-stack
postorder over the graph. They select buckets only: exact graph equality still
compares ordered revision-qualified application identities, prefixes, and
creation histories. Distinct graphs with deliberately identical cached hashes
remain unequal. Identical histories with different allocation sharing remain
equal. Revision searches and teardown also use explicit worklists; no source
effect result or mutable lexical environment is memoized.

Five focused native regressions passed. A depth-24 two-branch creation graph
computes 48 node hashes once and no additional hashes on a repeated query. A
forked prefix computes exactly one additional node hash after append. Separate
tests cover allocation-independent equality and source ordering, forced hash
collisions across same-path distinct revisions, and 4,096-node traversal/drop on
a 128 KiB thread stack. The production build passes the original snapshot
freshness check; no snapshot golden was rewritten.

These deterministic bounds fix a representation pathology. The actual
application's latency batch above does not establish a reliable additional speed
improvement. That distinction is why this follow-up remains a draft.

## Remaining work identified by profiling

A separate symbol-bearing baseline diagnostic build places substantial time in
both source checking and runtime preparation. The sample includes about 2.94 s
under checker entry points and 3.33 s under runtime-HIR elaboration, with about
1.16 s under residual-environment-key construction. These are **overlapping
inclusive sampled stacks**, not disjoint additive stage timers. The profile also
contains repeated allocation/freeing, lexical binding and signature lookup, and
effect-provenance hashing. The private raw profile is not part of this public
report. Profiling was disabled during all paired samples.

For the 100 ms goal, the next architectural target is avoiding rechecking and
restaging an entire demanded entry closure after a local implementation edit,
while preserving dependency/interface invalidation and fresh-effect ownership.
Cold compilation also needs substantially cheaper checking and frontend work.
Removing one hash traversal, timing emission alone, or returning an unchanged
cache hit is not enough. No proposed cache is authorized to use environment
pointers or partial hashes as complete semantic evidence.

Full native, abstraction, regression, and hosted results are recorded on the
exact PR head after those runs complete; pending checks are not claimed as
passes here. No standard CI workflow, test discovery, deadline, or performance
threshold is changed by this experiment.
