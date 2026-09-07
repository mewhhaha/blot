# Exact values, callable payloads, and shared graphs

`value-cases.json` adds 32 accepted programs and 24 rejected programs. Run the
catalog through the Rust/Wasm compiler with:

```sh
node --import ./src/node/deno_test_compat.mjs --import tsx --test \
  src/compiler/value_pathologies.test.ts
```

Accepted cases assert the principal result type (`Int`), the evaluator result,
the checked-in output (`42`), emitted Wasm execution, and identical cold/warm
Wasm bytes. Rejected cases first pass the real Baba frontend, then assert the
source diagnostic code, originating file and source text, and a nonempty span.
They are not expected parser errors or target refusals.

## Exact conversion must not erase values

On baseline `cc0bafe979b3891f51a17a80db804f2bcbc97cba`, all 24 rejected programs
incorrectly passed checking. For example, `[1, fn item => item]` satisfied
`[1]`, and `#Some (fn item => item)` satisfied `#Some Unit`. The evaluator
retained the function, so the resulting types did not describe the values. Ten
valid tagged callback programs also failed because their callable payloads
became `Unit`.

The optional conversion from a compile-time value into an exact canonical type
now refuses the whole aggregate when any child cannot be represented. The
ordinary inferred type remains authoritative for constant bindings. A required
signature instead reports `BLOT_SIGNATURE_NOT_A_TYPE`. Arrays, unions, regions,
and constructor payloads must never silently drop information. The catalog
covers closures, primitives, factories, aliases, nested arrays, records, tuples,
constructors, and invalid canonical signatures.

## Sharing is not an expanded tree

The eight `shared_record_*` programs cover depths 1, 2, 3, 4, 6, 8, 10, and 12.
Each level reuses the preceding immutable record twice, then projects one
scalar. They are ordinary executable examples, not enormous generated source
fixtures.

Native Rust tests exercise depth-30 shared graphs without timing thresholds.
Record conversion memoizes immutable record storage within one call; repeated
conversion reuses the same type row. Reusability analysis and type-variable
collection use explicit worklists and visit each source value once. Their tests
assert 61 visits for depth 30, preserve generative-value refusals, and retain
binders, effect tails, and attached members.

An empty-array carrier allocates a fresh element variable. Any record conversion
that allocates a variable is excluded from memoization, so two occurrences do
not accidentally share a new inference variable. Cache keys are call-local
storage addresses, never semantic identities or serialized facts.

These are bounds for the named operations, not a claim that every compiler pass
is linear. Other elaboration, attachment, inference, and emission traversals can
still dominate an end-to-end shared-graph workload. Wall-clock measurements are
exploratory evidence, not CI pass/fail gates.
