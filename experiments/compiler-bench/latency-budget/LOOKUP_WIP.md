# WIP: signature substitution and borrowed runtime evidence

This checkpoint publishes the saved post-#171 patch on top of PR #172 commit
`2529e5203d203710f6f11e1545e9cc526feced03`. It preserves the persistent effect
provenance implementation and edited-compilation benchmark already in this PR.
It is work in progress, not a demonstrated further application speedup or a
completed 100 ms compiler.

## Included changes

- Preserve shared function/range edges and record storage within one signature
  substitution. Memos retain their input owners and end with the operation;
  later calls still observe current type/effect substitutions and parents.
- Borrow captured bindings and signatures during synchronous residual-identity
  construction instead of cloning values for immediately discarded reads.
  Recursive groups, lookup precedence, and observed-open reads retain their
  existing behavior.
- Check for a residual trace before looking up an argument solely for runtime
  representation evidence. Runtime-presence scans visit shared records once per
  query, retaining variant boundaries, short circuiting, and fresh reads of
  mutable cells in later queries.
- Add 15 regressions: six substitution, four borrowed-lookup, four
  runtime-presence, and one absent-trace test. Update the staging contract and
  regenerate the source-derived language-health inventory.

The saved recursive-lookup fixture used the old vector-based effect scope. Its
empty scope is adapted to `EffectScope::default()` from the current PR; the
persistent provenance implementation is not reverted. No private application
source, generated executable, ABI contents, or source-bearing profile is added.
No standard workflow, test-discovery rule, deadline, or performance gate
changes.

## Measurement limits

The retained prior exploratory observations were collected against the older
post-#171 baseline, not the current combined PR #172 tree. Each of the two
substitution experiments has only two observations per version:

| Earlier experiment          | Baseline median | Candidate median |
| --------------------------- | --------------: | ---------------: |
| Initial substitution memo   |    4,519.718 ms |     4,552.285 ms |
| Selective substitution memo |    4,720.074 ms |     4,757.622 ms |

Neither experiment establishes a speedup. The retained runtime-demand JSONL
contains only one baseline observation and no completed candidate comparison; it
is not performance evidence for the combined patch. There is no new
full-compilation benchmark or output-equivalence claim for this integrated tree.
The existing provenance measurements apply to their recorded commit, not to this
later WIP increment.

## Publication validation

Fresh formatting, lint, compilation, and focused-test results are recorded in
the PR conversation for the published head. The earlier saved logs are not a
substitute for validation after integrating this patch with PR #172. Complete
hosted CI, full abstraction/regression/conformance coverage, and a balanced
application-level comparison are required before treating this increment as
ready for review. The PR remains a draft.
