# Generated-code performance

`deno run --allow-read --allow-write --allow-run=rustc experiments/generated-code/benchmark.ts`
compares WebAssembly emitted by the production Blot compiler with equivalent
Rust compiled for `wasm32-unknown-unknown`. Both artifacts execute in the same
Deno V8 process. Compilation, validation, instantiation, warmup, and observation
validation are outside the clock.

Every timed row first checks both artifacts against an independent TypeScript
result. The harness takes eleven alternating samples, reports the median with
p10 and p90, and calibrates each implementation toward a 40 ms sample. Scalar
host-input workloads cycle through 64 values. Scaling workloads call the same
first-order export with one of four runtime sizes, so their artifact does not
grow with the input.

Rust is built with:

```text
rustc --edition=2024 --target=wasm32-unknown-unknown -O \
  -Coverflow-checks=yes -Cpanic=abort -Cstrip=symbols --crate-type=cdylib
```

## 2026-08-06 observation

This run used an AMD Ryzen 7 7800X3D on Linux 7.1.5, Deno 2.9.4 with V8
15.0.245.2, and rustc 1.96.0-nightly. The Blot compiler artifact SHA-256 was
`9535d8fd57bfce8dbdc888ef77703c48d05aa48e00d16cdd7f955e65b0a1e95f`.

This historical run used Rust's release-default wrapping arithmetic. The
2026-08-07 semantic-match observation below supersedes its integer-loop ratios;
Blot `Int` traps on overflow, so current Rust counterparts enable matching
overflow checks.

| Workload       | Pressure                           | Blot ns/call | Rust ns/call | Blot / Rust |
| -------------- | ---------------------------------- | -----------: | -----------: | ----------: |
| host roundtrip | Wasm call and scalar host import   |         15.8 |         17.2 |       0.92× |
| scalar mix     | 16 dependent checked integer steps |         72.2 |         60.3 |       1.20× |
| branch mix     | seven-leaf dynamic conditional     |         23.4 |         18.6 |       1.26× |
| function chain | 16 source-level function calls     |         70.1 |         56.8 |       1.23× |
| fixed array    | eight values, destructure, release |         22.7 |         50.9 |       0.45× |

The Runtime-HIR forwarding-block simplification reduced the branch artifact from
3,353 to 3,253 bytes. On this run the branch ratio also moved from the previous
1.50× observation to 1.26×. The size change is deterministic; the time change is
an observation, not proof that all of it came from the simplification.

## Scaling

| Family / n         |      16 |      64 |     256 |   1,024 |
| ------------------ | ------: | ------: | ------: | ------: |
| tail recursion     |  212 ns |  692 ns | 2.78 µs | 11.1 µs |
| Rust counterpart   | 13.9 ns | 12.9 ns | 15.5 ns | 14.1 ns |
| range fold         |  193 ns |  748 ns | 3.08 µs | 11.6 µs |
| Rust counterpart   | 11.4 ns | 12.4 ns | 12.2 ns | 12.5 ns |
| surface iteration  |  136 ns |  510 ns | 2.45 µs | 8.87 µs |
| Rust counterpart   | 12.7 ns | 13.9 ns | 14.4 ns | 15.8 ns |
| array construction |  247 ns | 1.14 µs | 6.65 µs | 75.1 µs |
| Rust counterpart   | 63.5 ns |  132 ns |  377 ns | 1.33 µs |
| retained growth    |  351 ns | 1.43 µs | 8.05 µs | 74.7 µs |
| Rust counterpart   |  418 ns | 2.51 µs | 14.2 µs | 83.7 µs |

The first three families expose the important pathological case. Blot emits
linear work. LLVM recognizes the Rust accumulators and range sums and reduces
them to constant-work arithmetic. Surface `for` is about 20–30% faster than the
generic range fold here, but both retain the same linear asymptote. Blot needs
tail-recursion-to-loop recovery and a comparable predictable fold
simplification; faster call emission alone cannot close this gap.

Dynamic array construction currently uses persistent Store growth. Each push
allocates and copies the existing payload, so the curve trends quadratic while
Rust's `Vec` grows geometrically. The retained-growth counterpart deliberately
clones the Rust `Vec` before every push because the old version remains
observable. Under those equal immutable semantics Blot is between 0.57× and
0.89× Rust in the larger three cases. This distinction is the ownership theory
in executable form: an owned-reuse certificate changes the asymptotic cost;
without one, copying is required for correctness.

## 2026-08-07 affine arena observation

The indexed-list workload builds `n` `(value, next)` nodes with `Arena.insert`,
then follows the indices and sums the values. Its array parameter is affine, so
Runtime HIR carries `owned-reuse`; the allocator extends the most-recent scratch
allocation in place. The same harness and machine measured:

| Family / n       |      16 |      64 |     256 |   1,024 |
| ---------------- | ------: | ------: | ------: | ------: |
| Blot arena list  |  381 ns | 1.45 µs | 6.37 µs | 27.6 µs |
| Rust `Vec` arena | 89.3 ns |  236 ns |  796 ns | 2.98 µs |

Both curves are linear. Blot is 4.3–9.2× slower here because each node goes
through residual recursive calls, safe `Option` lookup, and checked integer
operations; the former quadratic Store copying is absent. A matched persistent
version measured separately at `n=1,024` took about 138 µs versus 25.8 µs for
the affine version, and its doubling curve remained quadratic. At that point,
loop recovery and bounds-proof propagation were the next relevant optimizations,
not another allocator special case.

## 2026-08-07 recovered-loop observation

Runtime HIR recovers direct tail calls through the private return sum and exact
product projection/reconstruction. It also omits the target bounds decision on
safety-certified Store reads. The compiler artifact SHA-256 was
`c35025554fc966526af07d32dc13874f62042a91e5496f3f143cb1585439ffbe`.

Enabling Rust overflow checks changes the sum comparison fundamentally. LLVM can
no longer replace the Rust loop with wrapping closed arithmetic because the
counterpart must preserve Blot's traps. Both emitted artifacts now scale
linearly:

| Workload at `n=1,024` | Blot Wasm | Rust Wasm | Blot / Rust |
| --------------------- | --------: | --------: | ----------: |
| direct tail recursion |   6.39 µs |    836 ns |       7.64× |
| range fold            |   6.93 µs |    809 ns |       8.56× |
| surface iteration     |   6.76 µs |    869 ns |       7.78× |

All three Runtime-HIR programs contain entry-block back-edges and no direct
self-call. The remaining difference is loop-body quality: Blot retains more
administrative locals and checked operations per source iteration.

A second scaling workload separates that overhead from the sum pattern. It uses
the same nonlinear recurrence in both languages, so each result depends on the
previous iteration:

```text
state = (state * 48_271 + remaining) % 2_147_483_647
```

| Loop mix / n |      16 |      64 |     256 |   1,024 |
| ------------ | ------: | ------: | ------: | ------: |
| Blot Wasm    |  282 ns | 1.00 µs | 3.86 µs | 14.7 µs |
| Rust Wasm    | 58.9 ns |  213 ns |  841 ns | 3.30 µs |
| Blot / Rust  |   4.79× |   4.70× |   4.59× |   4.46× |

At `n=1,024`, that is about 14.4 ns per Blot iteration and 3.22 ns per Rust-Wasm
iteration. Before structured emission, the 4.5–8.6× range was the relevant
tight-loop gap; the former hundreds-fold ratios measured mismatched overflow
semantics and LLVM's algebraic simplification, not WebAssembly dispatch or
call-stack growth. The next observation supersedes this one.

## 2026-08-07 structured-loop observation

The emitter now replaces a reducible Runtime-HIR entry cycle with one structured
WebAssembly loop. HIR first bypasses boolean materialization and known sum
constructor/tag/payload round-trips; irreducible or over-budget control flow
keeps the dispatcher. The compiler artifact SHA-256 was
`0648896d0a19d1546da26cc286bb18fb9874b39d24bc8fb9ef5eae9cfe70af2a`.

Both sides below are WebAssembly, compiled ahead of timing and run in the same
warmed Deno V8 instance. Rust uses `wasm32-unknown-unknown`, `-O`, and overflow
checks. Each value is the median of three independent process medians; each
process used 11 alternating samples and validated every input against the
independent workload model before timing.

| Workload at `n=1,024` | Blot Wasm | Rust Wasm | Blot / Rust |
| --------------------- | --------: | --------: | ----------: |
| direct tail recursion |    669 ns |    683 ns |       0.98× |
| nonlinear loop mix    |   3.53 µs |   3.42 µs |       1.03× |
| range fold            |    676 ns |    635 ns |       1.06× |
| surface iteration     |    688 ns |    759 ns |       0.91× |
| affine arena list     |   4.58 µs |   2.97 µs |       1.54× |

These results close the measured general scalar-loop gap: its four ratios span
0.91–1.06× rather than 4.5–8.6×. They do not claim that Blot always beats Rust;
differences this small are engine and code-shape noise. The defensible result is
parity for these semantics-matched Wasm loops. The arena list improved from 27.6
µs before recovery to 4.58 µs, a 6.0× reduction, and its gap to Rust's `Vec`
narrowed from 9.2× to 1.54×. Its remaining work includes a checked allocator
path per append and the typed Store/`Option` representation rather than
dispatcher overhead.

The nonlinear loop also makes the code-size effect visible. Naive CFG unfolding
grew its hot function from the 603-byte dispatcher body to 1,186 bytes because
shared administrative joins were copied. Boolean canonicalization reduced that
to 628 bytes, and known-sum dispatch removal reduced it to 235 bytes. The final
Blot artifact is 1,425 bytes; its Rust counterpart's exported hot function is
100 bytes, while Rust's complete 12,989-byte artifact includes overflow-panic
and standard-library support. Complete artifact size and hot-function size are
therefore both reported rather than conflated.

## Artifact size

Marginal bytes subtract a boundary-matched baseline: host roundtrip for the
nullary host-input artifacts and unary identity for first-order function
exports. The subtraction isolates workload growth without pretending that the
ABI shell disappears from the shipped file.

This table belongs to the 2026-08-06 historical run and therefore records the
older Rust wrapping-arithmetic artifacts. A complete artifact-size refresh waits
for the in-progress frontend artifact migration to restore the full benchmark
run.

| Artifact           | Blot bytes | Blot marginal | Rust bytes | Rust marginal |
| ------------------ | ---------: | ------------: | ---------: | ------------: |
| host roundtrip     |      1,901 |             0 |        155 |             0 |
| scalar mix         |      3,994 |         2,093 |        218 |            63 |
| branch mix         |      3,253 |         1,352 |        329 |           174 |
| function chain     |      3,998 |         2,097 |        277 |           122 |
| fixed array        |      2,322 |           421 |     13,564 |        13,409 |
| unary identity     |      1,125 |             0 |        122 |             0 |
| tail recursion     |      1,564 |           439 |        344 |           222 |
| range fold         |      1,554 |           429 |        364 |           242 |
| surface iteration  |      1,596 |           471 |        338 |           216 |
| array construction |      1,649 |           524 |     13,392 |        13,270 |
| retained growth    |      1,845 |           720 |     13,571 |        13,449 |

Small non-allocating Blot artifacts pay roughly a 1.1 KB ABI/runtime shell.
Rust's allocator makes its Store counterparts much larger, while its scalar
artifacts remain substantially smaller.

## Current capability probe

Residual recursion, captured runtime bounds, direct calls, explicitly signed
first-order exports, host-driven module loops, surface `for` over `Iter.range`,
indexed recursive data, and direct recursive algebraic representations now
compile through the Rust production path. The recursive-representation refusal
recorded by the historical report has been closed and is no longer a current
lowering gap. The engine case study still reaches ABI planning and is refused
for its declared `F32x4` host boundary, which is the specified ABI 1 SIMD
restriction rather than a residual-lowering gap.

This status paragraph does not refresh the historical timings or artifact sizes
above. Use `TASKS.md` for current architectural work and rerun the benchmark
before making a new performance claim.

The complete machine-readable report includes source and artifact hashes,
artifact sizes and boundary-relative marginal sizes, flags, calibrated
invocation counts, percentile ranges, and capability diagnostics. Re-run it
after a backend change instead of treating one machine's observations as a
release threshold.
