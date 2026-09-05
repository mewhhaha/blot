# Source-defined generic operators: implementation work

Status: work in progress. This file records the scope of the draft PR, not an
assertion that the implementation already satisfies it. LANGUAGE.md and
spec/TYPECHECKING.md remain the normative contracts.

## Acceptance criteria

- Source fixities and ordinary attached members determine binary and unary
  operator behavior; checker fast paths must not replace a custom member's
  signature with a built-in signature based on its spelling.
- Unknown operands retain member requirements instead of silently defaulting to
  Int. An inferred arithmetic function must work independently at Int, F64, and
  F32 call sites when the selected members support those operations.
- Refined input and result signatures survive member resolution, including
  safety requirements such as nonzero divisors. There is no implicit conversion
  between already-bound numeric domains.
- Prefix negation uses the same source-defined member dispatch contract as
  binary arithmetic, with integer and floating-point coverage.
- The language and compiler contracts, prelude comments, generated snapshots,
  and executable examples agree with the implementation.
- Regression coverage checks principal types, custom member behavior, rejected
  missing/mismatched members, and agreement between evaluation and emitted Wasm.

## Delivery

The draft PR is opened before implementation. Follow-up commits will contain
incremental source changes and tests. Validation results and any remaining
limitations are recorded in the PR rather than being reported as completed
before tests run.
