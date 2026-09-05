# Language and syntax review implementation

This draft tracks the language review as one change series. A checkbox is checked
only when its implementation and validation are present; a design sketch is not
an implemented language feature. `LANGUAGE.md` remains the normative specification.

## Workstreams

- [ ] Operator identity, scope, defaulting, and refactoring-stability tests.
- [ ] Checked predicate summaries, proof-loss diagnostics, and safe affine reasoning.
- [ ] Full-range numeric literals, separators, exponent notation, and lexical-boundary tests.
- [ ] Non-trapping floating-point partial comparison with an explicit unordered result.
- [ ] Ownership-aware reflection evidence and a restricted derivation example.
- [ ] Expression holes retaining type, effect, phase, ownership, and refinement obligations.
- [ ] Pipeline-oriented library conventions and explicit filtering-pattern examples.
- [ ] Editor visibility for return/break destinations and loop accumulators.
- [ ] Executable documentation claims and reconciliation of outdated specifications.
- [ ] Linearity/cancellation audit and research evaluation plans.

## Validation policy

Changes preserve Baba as the sole syntax authority, Rust/Wasm as the sole semantic
compiler, separate ownership analysis, and the existing runtime ABI. Changes to
public language behavior update `LANGUAGE.md`; changes to compiler evidence and
pass contracts update the corresponding `spec/` document. New trusted evidence
must be checked, not inferred from an identifier's spelling. Incomplete expression
holes must never discharge resource obligations or produce a production artifact.

Record actual commands and results below. Do not label unexecuted tests as passing.

## Progress

- Draft opened before implementation, as requested.
- Implementation and test results pending.
