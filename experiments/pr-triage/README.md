# PR pain-point probes

Small reproductions for the
[September 13 PR triage](../../docs/pr-pain-points-2026-09-13.md). These
intentionally include rejected syntax, conservative checker failures, and
programs whose successful source check disagrees with later compiler phases.
They belong outside the supported example catalog.

Run from the repository with its matching compiler artifact:

```sh
node --import tsx experiments/pr-triage/run.ts > pr-triage-results.json
```

The runner records observations, including expected failures; its exit status
does not assert that the compiler bugs are fixed. A failed source check stops
that probe before evaluation. Two function-valued probes inspect types only. The
remaining accepted probes evaluate and compile independently, then execute the
emitted Wasm when compilation succeeds. Source and compiler hashes identify the
measured inputs. [results.json](results.json) is the review baseline.

The four `control_` programs demonstrate supported alternatives. In particular,
`record_intersection.blot` documents the current union-member intersection
contract; it is not evidence of a structural-intersection compiler bug.
`runtime_seal.blot` isolates the quantity example's second blocker after fixing
its reserved binding name. Its intended runtime construction contract needs a
decision before choosing a compiler change.

The original parser/index, diagnostic-location, and PR cleanup probes
additionally used the exact PR library revisions linked in the report. These
standalone programs do not replace that evidence or claim to cover every library
case.
