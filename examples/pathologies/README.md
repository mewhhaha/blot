# Type-checking and refinement pathologies

The accepted programs live at `examples/pathology_*.blot`, with ordinary catalog
goldens in `examples/expected/`. `cases.json` also records exact principal
types. The eight programs in `rejected/` must parse and then fail during
checking with the recorded diagnostic and a real source span.

The 24 accepted cases cover adjacent and unsorted bases, disconnected
intersections, complement holes, mirrored bounds, De Morgan transformations,
signed-64-bit endpoints, duplicate members, nested refinements, singleton
collapse, base clipping, named witnesses, preserved layouts, semantic comparison
recognition, double negation, overlapping disjuncts, excluded middle, open ends,
a finite schedule, polymorphic projection and identity, width subtyping, and
branch unions. Every accepted case agrees between the Rust evaluator and Wasm.

## Run the focused catalog

```sh
node --import tsx --test src/compiler/refinement_pathologies.test.ts
cargo test --manifest-path compiler/Cargo.toml predicate_refinement
```

The Node command needs the matching compiler artifact, as all semantic compiler
commands do. Build it with `pnpm compiler:build`, or use the verified runnable
CI workspace. The ordinary regression test discovery includes the focused test.

## Diagnostic regression

Empty refinements previously pointed at the prelude wrapper's application span;
unsupported predicates could attach a user expression span to that prelude path.
The checker now identifies the predicate closure's module and body or failing
expression. Negative tests assert the exact source path and source text as well
as checking the span and diagnostic code.

## What was pathological

Intersection previously visited every interval pair, including disjoint pairs,
then sorted the overlaps. For two interleaved 8,192-interval inputs, that is
67,108,864 candidate pairs. The sweep needs 16,383 cursor steps for that shape;
a native regression test asserts the work count rather than a noisy time limit.

Base collection previously recursively normalized each union encountered. Nested
prefixes repeatedly copied and sorted leaves, and shared diamonds were expanded
as trees. The replacement traverses distinct borrowed value identities and
normalizes collected leaves once. The depth-30 diamond regression represents
more than a billion expanded leaves with only linear graph storage.

See [the cost contract](../../spec/REFINEMENT_NORMALIZATION.md) for assumptions
and boundaries. None of these fixes widens inferred types or adds runtime
checks. The existing `pnpm benchmark:predicate-refinements` experiment remains
available for end-to-end timing and erasure comparisons; its timings include
more than interval normalization and should not be reported as an isolated
algorithm speedup.
