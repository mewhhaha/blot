# PR 107: compiler nontermination and residual interfaces

The CI stall was reproducible in the unchanged
`engine_entry_points_prepare_and_the_game_loop_emits_wasm` test, primarily while
checking `case-studies/engine/lib/shrubbery.blot` and constructing its analysis
metadata. The existing ten-minute native-test step and thirty-minute job limits
are retained. A timeout remains a failure.

## Root causes and corrections

The constraint graph is shared, but several consumers treated it as an expanded
tree. Arena expansion, free-variable walks, qualified-member reachability,
signature substitution, and equality repeatedly revisited shared subgraphs.
Metadata construction then eagerly rendered every private expression type. The
engine combines higher-order functions, recursive accumulators, and
source-defined operators, amplifying these repeated traversals.

The repair preserves sharing and memoizes complete graph results. Member
reachability caches cover strongly connected components, not partial depth-first
results. Mutating bounds, adding or discharging requirements, and speculation
rollback invalidate the relevant cache. Equality and substitution respect
quantified scopes. Residual speculation journals its writes. Editor metadata
retains immutable type recipes and renders them only when requested; the checked
facts are not deleted.

Public boundary identity incorrectly serialized all private expression facts
before hashing its public result, parameter, and effects. This made a large
private signature block an otherwise valid boundary. Boundary identity now uses
only its public roots; complete portable certificates retain their independent
structural validation and resource limits.

The selected result of an ordinary closure call was disconnected from the
original application's result variable. Reconnecting them preserves the caller's
open-result relationships, including generic array element helpers used
independently at Int, F64, and F32.

Missing residual interfaces must be established with the same Rust source
checker, not guessed from representation holes. A recursive or development
instance is checked with its actual argument and lexical captures. Parameter
names shadow outer bindings; records retain their checked callable fields;
ground source types remain distinct from runtime carriers. Sum arguments use the
call's settled substitutions. Instance facts stay with that instance instead of
overwriting per-body facts used by another specialization.

Finally, a type attachment must retain the closure environment and module
instance whose member it denotes. Resident attachment ownership now retains
those facts until invalidation; a regression also checks that dropping the owner
releases them.

## Execution regressions uncovered by completing CI

The host-read pipeline fixture expected an i64 ABI without supplying a type for
`init.read`. With extensible source-defined operators, `.add` alone cannot prove
that the receiver is Int. The fixture now explicitly gives that operation
`Unit -> Int`, retaining its exact i64 ABI and execution assertions. No integer
default or operator-name recognition was added.

A tuple case in the fir recipe was treating runtime fields as failed static
matches, falling through to the last color. Scalar tuple-expression decisions
now reuse ordinary scalar case lowering after evaluating every tuple component
exactly once. The real-Wasm regression checks each Boolean/integer outcome and
effect order, including an ignored later component. This is not new support for
arbitrary product or payload-pattern forms.

The tree geometry goldens also contained mixed-scene translations for standalone
trees whose source explicitly places them at the origin. The replacement
regression compares every emitted oak and fir voxel with a separate
direct-coordinate recipe oracle, including origin, seed, color, and order.
Existing counts, frame, streaming, upload, and redraw assertions remain. The
oracle is a test fixture, not a second language compiler or target.

The prelude struct constructor now states its field-name requirement as a
compile-time predicate on the specialized record type. Its former unconditional
`[Text]`-to-literal-name-array constraint rejected valid closed records before
specialization. A whole-record requirement checks all field types before the
construction loop, and a specialized key predicate checks for extras. Extra,
missing, and incorrectly typed fields remain rejected. Closed computed-field
results retain their checked exact types without changing a runtime parameter's
phase. Signed sealed declarations additionally verify the evaluated carrier
rather than trusting an open constructor-result variable.

The public function adapter also used sorted canonical constructor tags as
private runtime tags. Flat arguments and direct scalar results now translate by
constructor name, including nested products and sealed carriers. The executable
tuple regression checks both directions and rejects an out-of-range tag.

Completing the existing catalog exposed baseline fixture drift as well. The
signature-hole example now uses `Int.add` to state the numeric domain its
unchanged assertions require. The module-return hover expectation matches the
current wording. Four accepted Blot sources are reformatted with the repository
formatter; normalized syntax trees and a second formatting pass were compared
before writing them.

## Validation contract

The full existing native suite, including the engine and all six originally
failing cases, is required. Focused passing tests do not replace that gate. The
rebuilt compiler must additionally pass the complete Node/regression suite,
abstraction contracts, runtime conformance, generated-file checks, types,
formatting, lint, and packaged distribution checks. Generated compiler bytes
remain ignored derived output; the regenerated prelude snapshot remains tracked.

No test is ignored, no timeout is converted to success, and no standard CI
validation stage is disabled. Exact-commit Actions results, not intermediate
local compiler builds, govern merge readiness.
