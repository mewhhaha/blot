# Reload latency review, 2026-09-11

The reload delay is dominated by restoring and checking compiler state. Module
splitting already works: each edit emits one 6,294-byte provider and retains 19
units. Faster browser activation or further Wasm splitting would not address the
measured bottleneck.

## Measurements

The production artifact was
`2d1c2007f76ad4068c785e08b5e78aca13d3e164f4d855d9bd525194e4b9641e`. The workload
edits a 346-byte provider in a 20-unit project. These are sequential runs on the
same machine and artifact, with unrelated CPU work still running; they are
observations rather than isolated-machine performance guarantees.

| Production transport trace, 20 edits | 5,273,553 source bytes | 7,803 source bytes |
| ------------------------------------ | ---------------------: | -----------------: |
| Edit through activation p50          |               154.9 ms |            92.3 ms |
| Edit through activation p95          |               184.8 ms |            99.0 ms |
| Maximum                              |               506.5 ms |           102.8 ms |

The small workload removes only the untouched voxel catalogs, preserving the
unit count, edited provider, and observable calls. The large run spends 97.6% of
aggregate build time in `compileCompilerSessionDevelopmentProgram`; parsing the
edited source takes approximately 0.3–0.5 ms on later edits. Runtime activation
has a 0.56 ms median. From the second edit onward, all 19 provider function
bodies hit the continuation graph cache, while one provider still needs
emission. The benchmark alternates two source versions; this is not a sequence
of unique edits. The first edit has 18 graph hits and one miss.

The earlier ten-sample report's 524 ms p95 was its maximum. With nearest-rank
percentiles, twenty samples exclude the maximum from p95. Preserve first-edit
latency explicitly rather than relying on that statistical difference.

A separate named, optimized `development-profile` artifact
`cf72634e53857f41c44f11012a167761249f6046b842de697f3bab9f6086382f` provided
3,551 ms of sampled compiler CPU time across twenty edits:

| Disjoint phase                      | Sample share |
| ----------------------------------- | -----------: |
| Module checking and invalidation    |        64.1% |
| Runtime HIR elaboration             |        20.9% |
| Request reset and setup             |        14.1% |
| Remaining compilation and transport |         0.9% |

Within those phases, cached-interface budget validation accounts for 14.5%,
value-capsule reconstruction for 15.8%, and environment name lookup for 14.8%.
These inclusive observations overlap and must not be added together. CPU
sampling, instrumentation, and the different artifact make these phase
attributions approximate; use production builds for acceptance timing.

## Causes in the implementation

1. **The first edit inherits the initial build's cleanup.**
   `Checker::begin_request` clears the previous request's solver tables. The
   first edit starts with 215,647 variables and 369,638 constraint type nodes;
   subsequent edits start with 432 variables and 639 nodes. The profile's reset
   cost and the much smaller first-edit delay without catalogs support deferred
   cleanup as a substantial contributor. They do not establish that it explains
   every millisecond of the first edit.

2. **A checked-interface cache hit still traverses source-sized metadata.**
   `Checker::check` clones `CachedModuleInterface`, then `inflate_interface`
   calls `validate_type_budget` again and builds expression/signature lookup
   maps. The validator allocates formatted names for every expression root,
   walks the flat type arena, and constructs error-message prefixes on success.
   Request reset clears inflated interfaces, so unchanged imports can repeatedly
   incur this work. Validation also occurs when the cached interface is created.

3. **Import reuse still reconstructs substantial evaluator state.**
   `apply_with_expected` uses a module-result template keyed by occurrence and
   effect provenance. On a template-instance miss,
   `decode_after_structural_validation` scans the source for closure identities
   and recursive groups, creates environment frames, and decodes their values.
   Source or ancestor revision changes invalidate those instance keys. This is
   necessary for generative identities, but immutable source indexes and
   identity-independent template structure need not be rebuilt with them.
   Environment lookup also repeatedly walks parent frames and string maps.

The continuation-body cache skips specialization; it does not skip these earlier
operations. `close_development_program` starts a semantic request, checks the
entry, and reconstructs Runtime HIR before splitting and reusing emitted units.
Only a completely unchanged request can reuse the closed program directly.

The new safety checker has only about 1 ms of inclusive samples across this run.
There is no controlled old/new compiler comparison here, so this review cannot
attribute a regression to the refinement implementation. The measured dominant
costs are elsewhere.

## Suggested implementation order

1. **Make interface admission durable.** Represent an admitted cached interface
   with immutable shared storage. Validate on construction and external
   certificate admission; retain the validated status with that exact arena and
   root set. Build expression/signature indexes once per immutable interface, or
   use an indexed representation directly. Format diagnostic names only on
   failure. Keep request-specific solver variables separate: retaining them
   across resets would be unsound.

2. **Separate template structure from occurrence identity.** Cache source
   closure indexes, recursive groups, and their admission evidence by exact
   module revision. Share immutable decoded structure where the existing reuse
   rules allow it, while creating fresh occurrence/effect-sensitive values as
   required. Cache name resolution only on sealed environments, with correct
   lexical shadowing and `open` precedence. Do not erase provenance from
   instance keys or globally reuse generative imports. The instance cache's
   current clear-all behavior at 64 entries is also worth measuring before
   choosing eviction policy.

3. **Finish request cleanup before the compiler is advertised as ready.**
   Release transient solver state after durable interfaces and artifacts have
   been published and all consumers have finished. Charge initial-build cleanup
   to startup, and include warm cleanup in edit-to-ready time. If destruction
   itself remains expensive, use request-local arenas with bounded lifetime.
   Moving the same pause onto the next event would not solve interactive
   latency.

Start with step 1 because it is local and directly measured. Step 2 addresses
another substantial cost; step 1 alone is unlikely to provide sufficient margin
below 100 ms. This review does not establish a guaranteed speedup.

Acceptance should compare fresh and incremental diagnostics and evaluator/Wasm
results, including generative imports, changed helper bodies and proof evidence,
malformed certificates, interface changes, and shadowing. Add work counters for
interface admission/index construction and template decoding to prove unchanged
revisions skip the intended work. Run both catalog sizes and active-call-graph
benchmarks, with first-edit, repeated-edit, and unique-edit samples reported
separately. Use the production artifact for the latency gate and track memory
growth alongside time.

## Reproduction

`trace.ts` runs the existing benchmark and writes one JSON line per activation
to stderr, including outermost Rust transport timings and work counters. It
preserves the benchmark's correctness checks. Its logging adds some overhead
outside the recorded build duration; it is a diagnostic harness, not the gate.

```sh
deno run --allow-read --allow-write --allow-env --allow-sys=cpus \
  --allow-run=cat,deno,git experiments/development-bench/trace.ts \
  --samples=20 --report-only --output=/tmp/blot-reload-trace-report.json \
  2>/tmp/blot-reload-trace.jsonl
```

Repeat with `--target-bytes=1` for the small control. For named CPU samples,
build the separate distribution without replacing the production artifact:

```sh
CARGO_PROFILE_RELEASE_STRIP=none pnpm compiler:build-development-profile
BLOT_RELOAD_CPU_PROFILE=/tmp/blot-reload.cpuprofile \
  deno run --allow-read --allow-write --allow-env --allow-sys \
  --allow-run=cat,deno,git experiments/development-bench/trace.ts \
  --samples=20 --development-profile --report-only \
  --output=/tmp/blot-reload-cpu-report.json 2>/tmp/blot-reload-cpu.jsonl
python3 experiments/development-bench/summarize_profile.py /tmp/blot-reload.cpuprofile
```

CPU recording starts after initial activation and includes final benchmark
provenance collection. The summarizer filters to stacks under the development
compile call, excluding provenance and unrelated host work. It requires function
names and uses the current Rust phase names. The complete profile can also be
opened in a CPU-profile viewer. Do not modify measured inputs during a run.

## Implemented and measured

The production compiler now retains admitted interface indexes, shares source
capsule indexes by exact AST identity, indexes names in fully reconstructed
captured environments, and shares immutable closure signatures and occurrence
prefixes. Shared signatures remove repeated deep cloning and destruction when
export records and operator attachments copy closures. The signature lookup
cache lives only for one capsule reconstruction. Solver cleanup runs before a
development result is returned, including failure paths. Existing certificate
budgets and occurrence/effect provenance remain enforced.

Production artifact for this first set of changes:
`9449578bf8244448adc5021ce70525fd77e753ea0805770c36f134806008b0b4` (7,011,118
bytes). Twenty edits per workload, with the ordinary 100 ms p95 and 128 MiB
RSS-growth gates enabled:

| Workload                 |  Median |     p95 | First edit | Maximum | Peak RSS growth |
| ------------------------ | ------: | ------: | ---------: | ------: | --------------: |
| 5 MiB, alternating       | 55.6 ms | 85.3 ms |    85.3 ms | 88.1 ms |         0.0 MiB |
| 5 MiB, unique            | 53.6 ms | 78.5 ms |    73.3 ms | 80.1 ms |         9.8 MiB |
| 7,803 bytes, alternating | 58.0 ms | 65.8 ms |    65.8 ms | 66.8 ms |         2.4 MiB |

Every edit changes one provider, retains 19 units, transfers 6,294 Wasm bytes,
and verifies the newly activated numeric results. Relative to the original large
alternating run, p95 falls from 184.8 ms to 85.3 ms and first-edit latency from
506.5 ms to 85.3 ms. This is a workload-specific result on the recorded machine,
not a universal sub-100 ms guarantee. The separate ten-unit active-call-graph
experiment still takes 233.0 ms median / 236.5 ms p95 with memory caching and
231.3 ms / 238.2 ms with disk caching, versus 294.4 ms / 321.5 ms with caching
disabled. All 64 observations, including disk restart and shared-invalidation
cases, retain their runtime and reuse checks.

Reproduce the acceptance runs with:

```sh
pnpm benchmark:development -- --samples=20 --output=/tmp/blot-alternating.json
pnpm benchmark:development -- --samples=20 --unique-edits --output=/tmp/blot-unique.json
pnpm benchmark:development -- --samples=20 --target-bytes=1 --output=/tmp/blot-small.json
pnpm benchmark:development-active 10
```

Verification also exposed a source-lowering bug hidden by a previously pending
refinement example: rebinding collection skipped nested loops, dropping their
updated state after a statement conditional. Collection now visits nested loops
and excludes their local pattern and declaration bindings. The promoted example
observes sums of 0, 5, and 21 rather than only exporting an unexecuted closure.

## Follow-up correctness fixes, 2026-09-12

The first verification pass exposed three additional defects. They now have
executable regressions:

- `examples/dynamic_nested_loop_accumulator.blot` is promoted from the pending
  catalog. An inner array traversal forwarded an integer through a receiver with
  no direct upper bound. Specialization now follows every lower-bound producer
  to its checked numeric carrier. An unknown producer still prevents selection,
  and ordinary generic inference retains its qualified scheme. The evaluator and
  emitted Wasm agree for zero, two, and twenty outer iterations; emitted Wasm
  also completes 100,000 iterations with the expected result of 500,100.
- `examples/literal_rebinding.blot` exercises rebinding without reading the old
  value, including captured bindings. The checker establishes lexical lineage
  before liveness can discard the old initializer. Evaluation of `Shadow` now
  consumes its right-hand side without demanding that dead value. Both
  executions return `[7, 7, 0, 7]`, and an undeclared target still fails source
  checking.
- Independent residual checkers restarted their representation-hole counters
  even while publishing signatures into the same resident context. This allowed
  unrelated integer and array positions to alias. The allocator now belongs to
  that context. The original scratch-sorting test failed on the sixth fresh
  process before this fix; 32 fresh processes passed afterward. A deterministic
  allocator regression and three emitted export-order permutations also pass.

## Verification of the first latency changes

- 561 native Rust tests passed on the final compiler source.
- 272 Node tests, two Web Worker tests, and 20 benchmark harness tests passed.
- The full adjacent regression suite passed all 79 test files.
- All 24 evaluator/Wasm conformance cases agreed, including the newly executed
  relational observations; all 221 accepted corpus programs compiled.
- The package build and six distribution checks passed. The distributed compiler
  digest matches the measured production artifact and current compiler inputs.
- All 41 game compiler probes report `supported: true`, including the original
  three negations, F32 remainder, and Boolean traversal failures.

## Follow-up cache encoding and measurements

The active-graph CPU profile attributed 60.1% of sampled compiler time to
portable cache evidence. The original encoding repeatedly serialized textual
variant names, source paths, and provenance hashes. A representative 32-helper
key contained 58,702 atoms, including 2,840 provenance entries with only three
distinct hashes. Sharing allocation identities in the structural key was not a
valid fix: independently allocated equivalent closures must still share code.

The structural key is unchanged. Its portable representation now uses numeric
kind tags, inline numeric payloads, binary byte payloads, and first-occurrence
dictionaries for strings and provenance digests. The ordered evidence, source
dependencies, variable aliases, and distinction between module instances and
effect scopes remain in the digest. Tests also compare shared and separately
allocated scope values and require identical portable keys.

Production artifact:
`e7e55042947bbc3c4c74f99c89da6f54aebd32ed1a5add8a0a4694113b50a049` (7,024,845
bytes). The comparison against the previous `9449578b…` distribution uses
identical source paths and alternates execution order within each of twenty
unique-edit pairs. Both compilers remain resident and all runtime observations
and changed-unit checks pass:

| Paired active graph, 10 units × 32 helpers |   Median |      p95 |
| ------------------------------------------ | -------: | -------: |
| Previous compiler                          | 356.8 ms | 388.0 ms |
| Current compiler                           | 239.3 ms | 260.4 ms |

The median reduction within pairs is 33.0%; the current compiler is faster in
all twenty pairs. Concurrent unrelated compiler work varied during these runs,
so this paired result is more informative than comparing separate runs hours
apart. Ordinary single-compiler active-graph runs measured 254.5 ms median /
276.1 ms p95 with memory caching, 252.3 / 272.9 ms with disk caching, and 469.2
/ 508.9 ms with caching disabled. All 64 observations, including disk restart,
passed.

The 5 MiB absolute-latency gate is **not consistently green** in this
environment:

| Twenty edits, one compiler |   Median |      p95 |  Maximum | Peak RSS growth |
| -------------------------- | -------: | -------: | -------: | --------------: |
| Alternating, first run     | 123.0 ms | 143.4 ms | 143.5 ms |         7.0 MiB |
| Alternating, repeat        |  83.5 ms | 100.7 ms | 102.1 ms |         9.0 MiB |
| Alternating, later run     |  91.3 ms | 126.9 ms | 140.0 ms |        11.8 MiB |
| Unique                     |  84.5 ms |  94.2 ms | 100.6 ms |        10.9 MiB |

All runs retain 19 units, transfer one 6,294-byte provider, and validate the
newly activated values. Unique edits pass the unchanged 100 ms p95 gate; all
three alternating runs fail it. Every run passes the 128 MiB RSS-growth gate.
These measurements establish a heavy-graph speedup, not a universal sub-100 ms
result.

Final correctness verification:

- All 566 native tests, 275 Node tests, 25 evaluator/Wasm observations, and 223
  accepted corpus compilations pass.
- The full adjacent regression run passes 1,656 tests in 79 files. After the
  last encoding change, all 18 native development tests and 13 host development
  tests pass again, including persistent-cache restoration and invalidation.
- The two Web Worker tests, package build, six package checks, generated
  contract checks, and all 41 game compiler probes pass. The package's compiler
  digest and the current compiler-input digest match the measured production
  artifact.
- Full game verification also passes: asset generation, 44 tests, typechecking,
  the production build, and 33 browser scenarios. This ran from a temporary copy
  of the working game sources with the rebuilt Blot package, preserving local
  edits to the original Blender assets. The copy reused installed dependencies
  with automatic installation disabled.

## Current language work and latency, 2026-09-12

The syntax, library, handler, and observation changes in
[the implementation ledger](../../docs/triage-implementation.md) were measured
again with production artifacts. The current compiler adds two bounded storage
optimizations:

- Provenance encoding retains at most 1,024 memo entries and 1 MiB of accounted
  evidence. Weak owners prevent allocation-address reuse without retaining old
  module revisions. The memo preserves portable bytes and eligibility budgets;
  each key still reads current dependency revision digests.
- Records with at most eight fields search their ordered entries directly.
  Larger records maintain the existing name index. Capsule reconstruction and
  invalidation allocate fewer maps and duplicate field names for small records;
  copy-on-write snapshots, field order, and source identities are unchanged.

A named development-profile artifact
`9cfaf0d06c703fd587f32d1c2466dbe7db17f62bdf16f44f5d7b6379248a45e5` provided
1,754.8 ms of sampled development compiler time. Checking and invalidation
account for 68.3%, Runtime HIR for 28.1%, and remaining work for 3.7% (rounding
makes the sum slightly exceed 100%). Inclusive capsule reconstruction accounts
for 26.7%, portable evidence for 5.8%, environment lookup for 4.4%, and
interface inflation for 3.4%. Allocation has 14.1% self samples; value
destruction has 5.5% and deallocation 5.4%. These observations motivated the
small-record change. Sampling and profiling instrumentation are excluded from
acceptance timing.

The earlier twenty-pair provenance comparison measured 160.6/177.8 ms median/p95
for `923a2814…` and 154.8/163.1 ms for `398213b4…`, with a 2.42% median
within-pair reduction. The prelude snapshot identities differ in that
comparison, so it does not isolate the memo's individual contribution.

The subsequent small-record comparison uses the same prelude snapshot and twenty
unique-edit pairs, alternating compiler order:

| Active graph, 10 units × 32 helpers     |   Median |      p95 |
| --------------------------------------- | -------: | -------: |
| Before small-record change, `398213b4…` | 154.8 ms | 169.6 ms |
| Current compiler, `f10b0978…`           | 153.0 ms | 162.8 ms |

The median within-pair reduction is 1.47%; thirteen of twenty pairs are faster.
This is a modest measured improvement. Both compilers remain resident and all
runtime and changed-unit assertions pass.

Before the small-record change, the alternating 5 MiB gate passed at 97.9 ms
p95, but the unique-edit gate failed at 103.8 ms. Preserve that failed result;
the following green run does not erase it. The production artifact at that point
is `f10b09784dcca173e419842959ac9795db53f68df307710cc262b24da5ba07c8` (7,067,042
bytes), with compiler input digest
`3cfa0f913092a0fe3af64c26f28ba9a8b1ef3c987d0ed02d4bb5d14d538fe2b2`. Twenty edits
per workload pass the unchanged 100 ms p95 and 128 MiB RSS-growth gates:

| 5 MiB, 20 units   |  Median |     p95 | First edit |  Maximum | Peak RSS growth |
| ----------------- | ------: | ------: | ---------: | -------: | --------------: |
| Unique edits      | 79.0 ms | 85.8 ms |    78.0 ms |  89.0 ms |         2.6 MiB |
| Alternating edits | 92.0 ms | 98.6 ms |    80.8 ms | 110.3 ms |         8.2 MiB |

Every edit transfers one 6,294-byte Wasm provider plus its 974-byte manifest,
retains 19 units, and validates the changed runtime result. Initial compilation
of this synthetic catalog takes 30–32 seconds; these edit measurements do not
remove that startup cost. Compiler RSS after startup is approximately 2.2–2.3
GiB, distinct from the incremental growth gate.

The same artifact's ordinary active-graph benchmark passes all 64 observations.
Its twenty warm edits measure 317.3/344.9 ms median/p95 with caching disabled,
164.6/178.6 ms with memory caching, and 168.6/181.4 ms with disk caching. Disk
restart and shared dependency invalidation retain their correctness assertions.
This workload remains above 100 ms. Unrelated CPU activity continued during the
measurements, while this task's builds and tests were stopped. None of these
results establishes a universal sub-100 ms guarantee.

That compiler passes 572 native tests, 284 Node tests, two Web Worker tests,
1,693 adjacent regressions, 32 typed evaluator/Wasm comparisons, and all 230
accepted corpus compilations. Package distribution checks and all 41 game
compiler probes pass with the same compiler digest. The implementation ledger
records the end-to-end game verification outcome.

## Final CI cleanup and artifact verification

CI lint found mechanical warnings in the preceding refinement/cache edits:
nested conditions, an optional-value loop, and a redundant cast. Those are
cleaned up. The boxed environment index keeps an explicit lint exception because
unindexed lexical frames should pay only for its pointer. Clippy passes with
warnings denied, as do Deno lint and the emitted memory-lifetime and guest ABI
audits.

The rebuilt compiler is
`0cda8f4e75a7296809500b307ae94577f655b6097177e7213910d3cb341c3086` (7,067,128
bytes), with compiler input digest
`4fab4bae994c510a2bfccddc0be64e04d13306cd2ca3ccfdf6a0c4e1a93e640e`. The prelude
snapshot is unchanged. Because the compiler bytes changed, both twenty-edit
gates were repeated after other work from this task finished:

| 5 MiB, 20 units   |  Median |     p95 | First edit | Maximum | Peak RSS growth |
| ----------------- | ------: | ------: | ---------: | ------: | --------------: |
| Unique edits      | 73.4 ms | 77.6 ms |    69.9 ms | 81.3 ms |         5.6 MiB |
| Alternating edits | 85.0 ms | 89.0 ms |    72.3 ms | 90.3 ms |         9.5 MiB |

Both pass the unchanged gates, retain 19 units, transfer one 6,294-byte
provider, and check the activated values. Initial compilation takes 27–28
seconds and retains approximately 2.4 GiB RSS for this synthetic catalog. These
are new observations on the recorded machine, not a claimed speedup from lint
cleanup.

All 64 active-graph observations pass again, including disk restart and shared
invalidation. Twenty warm edits measure 302.3/335.3 ms median/p95 with caching
disabled, 154.0/160.5 ms with memory caching, and 156.4/165.4 ms with disk
caching. This heavier graph still exceeds 100 ms; the distinction between
workloads remains material.

The rebuilt compiler passes 572 native tests, 284 Node tests, 32 typed
evaluator/Wasm comparisons, and all 230 accepted corpus compilations. Package
checks and all 41 game compiler probes pass with the new digest. Full game
verification passes its 44 tests, typecheck, production build, and 33 browser
scenarios after a Chromium process closure on the first attempt. Recompiling the
game after lint cleanup produces byte-identical Wasm to that browser-tested
artifact. The implementation ledger records the complete verification boundary.
