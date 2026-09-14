# Example PR triage — 2026-09-14

All seven example PRs, #136–#142, are valid additions. Three reported compiler
defects reproduce on the current baseline and are fixed in this integration. The
remaining reports describe intentional language boundaries or behavior that no
longer reproduces. None of these PRs needs to be discarded.

The baseline is `63be0f89`, the commit that saves all previously local compiler,
editor, formatting, and example work. Its Rust/Wasm compiler SHA-256 is
`d83d200bd11eee0f14775f8df054c54d10ef20f9fca3e088bd866e20dc60f980`. The
integration builds its compiler from source and preserves each reviewed PR head
in the merge history.

## Confirmed compiler fixes

| Finding                                                    | Evidence before the fix                                                                                                                                     | Resolution and regression                                                                                                                                                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #141: specialization discards an incompatible body result  | `T.over (T.each, values, fn _ => 1)` for `values :: [Text]` checked as `[Text]`, evaluated to `[1, 1]`, then failed emission with a static Store invariant. | Constrain the specialized body result to the instantiated checked result before publishing that result. The direct polymorphic call now fails during checking with `BLOT_TYPE_ERROR`; valid modifiers still evaluate and emit. |
| #136: nested quantified names collide in type display      | Three independent binders printed as `forall 'q0. forall 'q0. forall 'q0.`.                                                                                 | Allocate display names from one supply per rendered type. The exact-type regression distinguishes both binders and their references in a polymorphic pair swap.                                                                |
| #142: generated projection errors point inside the prelude | Selecting `"missing"` reported `BLOT_NO_FIELD` at the implementation of `Reflect.pick`.                                                                     | Preserve application evidence through specialization and compile-time binding evaluation. The projection fixture now points to the caller and retains the originating constraint in its explanation.                           |

Native regressions are in
[`compiler/src/abstraction_tests.rs`](../compiler/src/abstraction_tests.rs). The
imported projection and traversal tests also exercise the Rust/Wasm compiler
through the public Node API. The normative language and compiler specifications
describe the result check, binder display, and source-evidence obligations.

Integration also exposed a tooling defect: selective-import fixes included
following comments in their edit span, so the comment-preservation check removed
the proposed fix. The rule now replaces only the opening's code. A focused
regression checks that the import narrows, the explanation after it survives
unchanged, and the result still evaluates correctly.

## PR decisions

| PR                                                                       | Reviewed head                              | Decision                                                                                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#136](https://github.com/mewhhaha/blot/pull/136), deferred fallback     | `555f775d9d5009a1a8cf0aaec116a045d816ea38` | Merge with the quantifier-display fix. Keep conditional runtime demand, conservative effects, and the explicit deferred-ABI refusal.                        |
| [#137](https://github.com/mewhhaha/blot/pull/137), residual router       | `39deac48ecfc1e517f309a935ee69c44a0e3d7e1` | Merge. Explicit `Remaining` parameters preserve the intended relation under the existing open-inference model.                                              |
| [#138](https://github.com/mewhhaha/blot/pull/138), relational group join | `304303a30cd1e7e9eff460f9b5cf37f13e085331` | Merge after removing the unnecessary empty-left result annotation and correcting its explanation. Keep the explicit right-side sharing boundary.            |
| [#139](https://github.com/mewhhaha/blot/pull/139), coordinate spaces     | `192728fe1331853008f5a1d7874e89997fd21fe1` | Merge. Staged descriptors enforce a concrete frame; the quantified widening fixture correctly documents covariance.                                         |
| [#140](https://github.com/mewhhaha/blot/pull/140), reversible updates    | `e810276ae2304182dd179122e1dceca0e6ffe2e8` | Merge. The API checks carrier compatibility; round-trip laws and tuple association remain explicit library contracts.                                       |
| [#141](https://github.com/mewhhaha/blot/pull/141), typed traversals      | `69083b5a709ff2b35980bcc6d5be4c9335339813` | Merge after the specialization fix. The rejection fixture uses `T.each` directly, and a documented nested-array record setter is tested in both executions. |
| [#142](https://github.com/mewhhaha/blot/pull/142), record projections    | `1955c5f4f2ec1574f4986411d7c2afcb96fa268d` | Merge with the caller-diagnostic fix. Keep concrete type-value staging for selected record shapes.                                                          |

The examples and libraries are updated for current formatting and lint rules.
Their tests assert the public type/effect observations while allowing the
compiler's additional interface identity. All seven programs are registered in
the example index, showcase runner, and abstraction qualification suite.

## Boundaries retained

- **Empty arrays:** the unannotated empty-left join now infers `[⊥]`, evaluates
  to `[]`, and compiles. An array with no possible element is inhabited by the
  empty array; this is different from an impossible whole result `⊥`. The old
  whole-result failure does not reproduce on the baseline. No widening patch is
  needed.
- **Deferred effects and the ABI:** a possibly demanded fallback contributes its
  effects even if one execution skips it. A known deferred call is specialized;
  an opaque deferred function cannot cross the public runtime ABI. The example
  covers skipped division by zero, observed remote demand, and target refusal.
- **Open type algebra:** closed residual differences are computed exactly, but
  arbitrary Boolean formulas over open quantified variables are outside the
  inference contract. An empty closed difference is intentionally not a surface
  type value. The router's final stage consumes its explicit remaining cases.
- **Coordinate markers:** repeated covariant variables permit a common union;
  they are not nominal equality constraints. Generating a descriptor for one
  concrete marker gives operations the required fixed frame.
- **Ownership:** a join revisits its right array and therefore freezes it once.
  A traversal observes a whole before rebuilding it. For a record containing
  nested arrays, explicit sharing plus `{ ...config; .items = values; }`
  supplies a checked implementation path. The
  [traversal notes](../examples/typed_traversals.md) and focused test cover it;
  generic setters do not receive an unchecked ownership exemption.
- **Library laws and staged records:** a structural signature relates carriers;
  it does not prove arbitrary functions are inverses or flatten differently
  associated tuples. Record projections derive their selected type at compile
  time because the language has no record-row variables. These examples keep
  those contracts visible.

Possible future work such as richer deferred-effect explanations, different
runtime suspension APIs, or domain-specific flattened undo plans requires its
own design decision. This triage does not classify those requests as unfixed
compiler correctness bugs.
