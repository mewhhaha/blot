# Release-Wasm result: no demonstrated speedup

The graph and instantiation redesign passes correctness checks, but it does not
meet the compilation-speed goal on the cold-semantic full fixture. This is a
negative performance result. Keep the PR draft; do not merge it as a speed fix.

## Boundary and provenance

Measured on September 17, 2026: five samples per artifact per fixture, twenty
fresh Node processes in total, alternating artifact order. Both use the same
tracked prelude snapshot and unchanged prefix/full/framework sources. No sample
was discarded. Other compiler builds and test suites were not running locally
during this batch. The host is a shared container, not a dedicated benchmark
machine; the timing ranges overlap substantially.

Baseline source: `8d30e17cfabcb341d5617be59ce46a12672dc603`.

Candidate source: `44f607e37f2e29468be858c13c3e02ff807981b7`.

The candidate Rust sources were byte-compared with the PR's CI source snapshot.
There were no compiler-source mismatches. Later result-documentation changes do
not change the compiler. Both artifacts use the pinned Rust 1.97.1 toolchain and
the same bare Cargo release configuration: `opt-level = "s"`, fat LTO, one
codegen unit, panic abort, and stripping. These are not byte-identical to the
distributed artifact produced by the repository's build script, which adds
linker flags.

Host: Node v22.16.0, Linux x64, Intel Xeon Platinum 8573C.

Artifact SHA-256:

```text
baseline  23a53f851611ecd14edb83b38cb02c56d29ca3c51a33a903f16b46c56a2ea002
candidate a7b2920dd986e6cf8b2a735aba0823b02a138a6eae328dcaf3604c373023ca16
```

Input SHA-256:

```text
prelude source 257f18f8fbcd0b7d7c991d0f6cf6af4f51e0c1f5b7704fb11e99845848e1064f
snapshot       87718708480be1ebe78c1c6cff3944c8e78cafce48157495dad3c780df7bd57f
framework      18b5829343fa977c0cea93834352d9b3e418f321a080cc069c68e57fbfe04e15
prefix         009d4e05d86b3b437f036ee7573656506bc72141186c9f58214079908faa168e
full           8ec9d28a1c8c6b9bd4a345881e91a0c2c6b55f147f5e535d217459289d324054
```

The measured analysis boundary includes semantic preparation, fact
materialization, and target preflight. It excludes Wasm instantiation, snapshot
installation, source registration, final executable emission, and executable
runtime. Phase telemetry was enabled for both artifacts; this batch has no
telemetry-off control and does not establish uninstrumented CLI performance. See
`README.md` and `compare.mjs` for the exact driver and reproduction command.

## Results

Times are milliseconds. Values in each row are ordered by iteration, not sorted.

```text
fixture artifact   iteration0 iteration1 iteration2 iteration3 iteration4     median
prefix  baseline     1416.515   1739.634   1613.594   1329.740   1332.882   1416.515
prefix  candidate    1628.256   1307.926   1396.840   1559.152   1275.231   1396.840
full    baseline    18098.709  15115.835  15700.866  15579.364  18365.138  15700.866
full    candidate   16156.681  16816.432  16177.271  17287.136  14935.441  16177.271
```

Prefix median: 1.39% lower. Full median: 3.03% higher. Five samples on this host
are not sufficient to establish a small regression statistically, but they do
not support a speedup claim. The full-case range is 15,115.835-18,365.138 ms for
the baseline and 14,935.441-17,287.136 ms for the candidate.

Full-fixture semantic-preparation evaluator median: 11,820.529 ms baseline and
12,046.772 ms candidate. Its evaluator step count is unchanged at 4,014,502;
closure applications are unchanged at 332,118. The prefix uses 71,055 evaluator
steps and 5,282 closure applications in both versions. All evaluator counters,
result types, effects, interface keys, and target-preflight results match
between versions. Some structural counters decrease slightly; for example,
full-fixture settle visits are 443,731 versus 443,666. Do not describe all work
counters as identical.

All twenty runs return `{ .run = Int -> Int }`, no effects, and supported target
preflight. The final Wasm linear-memory size is 40,763,392 versus 40,370,176
bytes for prefix, and 118,423,552 versus 117,440,512 bytes for full. This is
allocated linear memory at the end of analysis, not process RSS or peak live
heap usage.

## Interpretation

The redesign removes specific avoidable type traversals and recursive edge
copies, but does not reduce the dominant evaluator fan-out. On this fixture the
full program still executes about 56.5 times as many evaluator steps as prefix.
The full evaluator span remains about twelve seconds. Representation changes
alone have not solved that problem; this result does not justify discarding the
subtype solver or weakening correctness checks.

A subsequent speed-oriented design needs to reduce repeated staged execution
itself, or materially reduce its per-step cost. Any reuse of staged type
builders must carry sound environment/evidence dependencies and preserve fresh
effect, region, and quantifier identities. This PR deliberately does not treat a
lossy fingerprint, a shared pointer, or an apparently pure closure as proof of
reusable semantic results.

## Validation

Local final-code checks: 663 native tests passed, zero failed, one explicitly
ignored diagnostic benchmark; Rust formatting passed; Wasm-target Clippy passed
with warnings denied; release-Wasm compilation succeeded. The fourteen new
regressions cover copy-on-write isolation, summary invalidation, bounded summary
traversal, union normalization, effect substitution, quantifier shadowing,
independent generic calls, and zero/one-visit argument-reflection cost gates.

On implementation commit `44f607e37f2e29468be858c13c3e02ff807981b7`, GitHub
Actions `Type-system validation` (run 35214377351) and `Abstraction contracts`
(run 35214377350) passed. Repository-wide CI (run 35214377565) remains blocked
by pre-existing Deno formatting failures in unrelated files. Those files were
not mass-reformatted or excluded to hide the failure.
