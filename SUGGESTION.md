# Design suggestions

These are the remaining changes I would pursue after indexed arenas and the
initial recursive-value representation work. They are suggestions, not accepted
language rules; `LANGUAGE.md` and `spec/` remain authoritative.

## 1. Implemented: close positive recursive algebraic values

Inference already accepts the useful equation

```text
List A = #Nil | #Cons (A, List A)
```

Runtime HIR schema 2 now settles that equation to a finite graph. It allocates a
private indirect root before compiling the positive constructor body, fills the
target afterward, and emits scratch-arena `indirect.make` and `indirect.load`
operations. A recursive sum is therefore an address to a tag and payload, while
non-recursive records and sums keep their flat representation.

The mechanism is automatic. Adding source-level `Box`, pointer types, or
lifetime parameters would expose a target repair as a language concept and make
ordinary algebraic data harder to read. Recursive values should remain barred
from ABI 1 until a canonical cyclic graph format is designed; an internal list
used to produce a scalar can safely die with the export call's scratch arena.

The executable probes cover direct and mutually recursive values, empty and
singleton cases, constructor projection, exhaustive matching, ABI refusal, and
scaling against the indexed `Arena` baseline. Structural ownership lineage
through an extracted recursive edge remains part of the broader ownership
summary work below.

## 2. Give Store an explicit capacity only when profiles require it

Affine `Arena.insert` now extends the most recent allocation in place. That is
`O(1)` per fixed-size node while nothing allocates between the Store and its
append. A node containing freshly allocated text or another Store breaks that
condition and falls back to copying the prefix.

If those workloads matter, change the private Store representation from
`(pointer, length)` to `(pointer, length, capacity)` and grow capacity
geometrically under owned-reuse permission. Keep the public ABI at
`(pointer, length)` through adapters. Do not add capacity pre-emptively: it adds
a local and adapter work to every array operation, while the current bump-tail
case already covers compact arena nodes. In the equal-semantics Wasm benchmark,
the compact arena takes 4.76 µs versus Rust's `Vec` arena at 3.04 µs for 1,024
nodes. That remaining 1.57× gap does not by itself justify changing every Store;
profile payload-allocation fallbacks separately before paying the capacity cost.

The benchmark now measures the direct recursive list too. At 1,024 nodes it
takes 9.36 µs, versus 19.30 µs for Rust `Box` recursion and 4.76 µs for Blot's
indexed arena. Private indirection is therefore linear and competitive with the
matching recursive Rust representation, while the compact arena remains the
throughput-oriented choice.

## 3. Keep recursive discovery in the checker graph

The checker now builds the free-name graph of each typed `rec` group and finds
its strongly connected components in `O(V + E)`. Certificate schema 3 persists
the recursive closure bodies. Runtime HIR closing allocates a private root only
when that certificate authorizes the exact body, then fills its positive
constructor edge and validates the finite graph:

```text
discover SCCs -> allocate RuntimeTypeId placeholders -> fill edges -> validate
```

An unresolved result without the certificate is refused. Formatted type strings
remain in specialization cache keys; replacing those with structural identities
belongs to the broader progressive checked-to-HIR construction work rather than
recursive representation soundness.

## 4. Require evidence before adding algebraic loop rewrites

Runtime HIR now rewrites direct self-tail calls to block back-edges, including
the private sum and product reconstruction introduced by source elaboration. The
emitter turns a reducible entry cycle into structured WebAssembly and keeps the
dispatcher for non-entry cycles or excessive path expansion. HIR also removes
known boolean and sum constructor/tag round-trips before structuring. That
covers direct recursion, range folds, surface iteration, and arena-list
construction and traversal without source-level loop machinery or a separate
loop IR.

Equal-semantics Rust-Wasm measurements now put the representative scalar loops
within normal engine noise of their Rust counterparts. A range-sum formula could
still reduce asymptotic work, but it is no longer justified as repair for a
general loop overhead. Add one only with a source theorem covering integer
overflow and iteration boundaries, plus a workload where the removed work
matters outside the benchmark itself. Indirect and mutual recursion should
remain calls until a separate control-flow argument covers them.

The general recovery remains shared by ordinary recursive traversals, while a
special formula improves one pattern. Each new rewrite still needs a
source/Runtime-HIR simulation argument and trap-preservation tests before its
performance measurement counts.

## 5. Keep compiler optimization profile-driven

The resident compiler already returns unchanged artifacts in tens of
microseconds; lowered-module edits are dominated by checking and Runtime-HIR
preparation rather than emission. A current nine-sample profile measured the
list-heavy example at 23.6 ms: 6.60 ms checking, 14.4 ms preparing HIR, and only
0.293 ms emitting. Its final HIR has 63 operations, so the preparation cost is
staged recursive evaluation and residual-trace reconstruction rather than final
graph size. The next compiler work should continue the existing flat-arena plan:
progressively emit settled Runtime HIR during checking and delete request-local
fact-map reconstruction. Parallelism and SIMD should wait for a profile that
shows independent ready modules or contiguous set scans dominating wall time.

An optimization is successful only when it removes a derivation or makes its
data contiguous. Moving the same derivation between TypeScript, Rust, and Wasm
is not a compiler-speed improvement.

## 6. Current theory/implementation frontier

The representative scalar tight-loop gap is closed: equal-semantics Blot and
Rust Wasm are within 0.91--1.06x on the measured loops, and the indexed arena is
about 1.5x Rust's `Vec`. Recursive values, nested static function aggregates,
known higher-order selection, path-sensitive ownership summaries, and generated
staging/handler/target simulations now have executable boundaries.

What remains falls into three different classes and should not be described as
one unfinished feature list:

- **Semantic closure:** finite run-time choices returned by known higher-order
  functions are defunctionalized, but a function whose source set is opaque to
  whole-program control-flow analysis still needs closure conversion with a
  closed parameter representation or a representation dictionary. This is the
  remaining source program that can be well typed yet reach a structural
  representation refusal.
- **Compiler architecture:** progressively commit typed Runtime HIR during
  checking and publish structural extraction lineage in ownership certificates.
  These remove duplicate derivations or strengthen evidence; they do not need
  new surface syntax.
- **Evidence:** mechanize preservation/progress for the stable core. Generated
  tests now cover returns, staging, handlers, ownership-path mutations, host
  order, checked-integer traps, divergence, and evaluator/Wasm agreement, but
  remain bounded simulations rather than a proof.

Capacity-bearing Stores, another proof-producing collection, first-class
references, and a full-width word domain are contingent extensions. The current
profiles and examples do not justify adding them to the language or runtime.
