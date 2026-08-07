# Design suggestions

These are the remaining changes I would pursue after the current indexed-arena
support. They are suggestions, not accepted language rules; `LANGUAGE.md` and
`spec/` remain authoritative.

## 1. Close recursive algebraic values as fixed points

Inference already accepts the useful equation

```text
List A = #Nil | #Cons (A, List A)
```

but Runtime HIR cannot yet settle that equation to a finite representation. The
next representation feature should detect strongly connected components while
closing types and insert one private indirection on each recursive cycle. A
recursive sum would then be a scratch-arena address to a tag and payload, while
non-recursive records and sums would keep their current flat representation.

This should be automatic. Adding source-level `Box`, pointer types, or lifetime
parameters would expose a target repair as a language concept and make ordinary
algebraic data harder to read. Recursive values should remain barred from ABI 1
until a canonical cyclic graph format is designed; an internal list used to
produce a scalar can safely die with the export call's scratch arena.

The acceptance test is not merely “a list compiles.” It must cover mutually
recursive types, empty and singleton values, constructor and projection
preservation, exhaustive matching, ownership through the recursive edge, cycle
rejection at the public ABI, and linear scaling against the indexed `Arena`
baseline.

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
case already covers compact arena nodes. After structured-loop emission, the
compact arena benchmark takes 4.58 µs versus Rust-Wasm's 2.97 µs for 1,024
nodes. That remaining 1.54× gap does not by itself justify changing every Store;
profile payload-allocation fallbacks separately before paying the capacity cost.

## 3. Make recursive representation closing graph-native

The current lowering failure for an inferred recursive list reports an
unresolved call-site representation variable. Closing should consume the
checker's settled graph directly, allocate Runtime type identities before their
children, and fill their edges afterward. This turns recursive representation
from accidental recursion in `specialized_type_from_type_value` into an explicit
graph algorithm:

```text
discover SCCs -> allocate RuntimeTypeId placeholders -> fill edges -> validate
```

The work is `O(V + E)` in the settled type graph. It also removes formatted type
strings from recursive specialization keys and should improve compiler time on
large structural programs.

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
microseconds; semantic edits are dominated by checking and Runtime-HIR
preparation rather than emission. The next compiler work should continue the
existing flat-arena plan: progressively emit settled Runtime HIR during checking
and delete request-local fact-map reconstruction. Parallelism and SIMD should
wait for a profile that shows independent ready modules or contiguous set scans
dominating wall time.

An optimization is successful only when it removes a derivation or makes its
data contiguous. Moving the same derivation between TypeScript, Rust, and Wasm
is not a compiler-speed improvement.
