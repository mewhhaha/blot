# Blot review: practical boundaries and trustworthy tooling

Reviewed on September 5, 2026 against `main` at
`bbd33c00275189a45d22ad6c23cb231567d0d583`, after the fixes merged in
[#84](https://github.com/mewhhaha/blot/pull/84) and
[#85](https://github.com/mewhhaha/blot/pull/85). The starting source tree was
verified as `58eaa6145510c1c9d28aa93d69174775011f77f5` against the runnable
workspace from the successful main CI run
[33958254674](https://github.com/mewhhaha/blot/actions/runs/33958254674).

This is a review of the merged language, not a claim about the unmerged operator
and language-library work in #86, #87, or their integration PRs. It adds executable
examples and bounded tooling fixes without changing the Rust semantic compiler,
Baba grammar, prelude, ownership rules, compiler ABI, or CI workflows.

## Assessment

The exercised paths support useful small data-processing programs: borrowed
collections, tagged error results, persistent maps, explicit numeric conversion,
Unicode text operations, and emitted-Wasm execution. The examples below combine
those facilities instead of demonstrating only isolated syntax.

The most actionable gaps found in this pass were at the boundaries between
"parses", "checks", "evaluates", and "compiles". Those are different claims.
A syntax command unnecessarily required the semantic compiler; a compilation
command reported refusals but still exited successfully; and three accepted
examples had evaluator results but no supported runtime export shape. A separate
syntax gate also applied a narrower integer policy than production parsing.

Float-loop inference remains a concrete language ergonomics problem. This patch
records a working source-level workaround rather than claiming to complete the
ongoing operator implementation.

## Findings and fixes

### P1: accepted-corpus refusals were reported as success

In [`scripts/compile_corpus.ts`](../scripts/compile_corpus.ts), the final exit
condition considered `failed` but not `refused`. A corpus containing target
refusals and no other errors therefore exited zero, even though not every
accepted example produced Wasm.

The command now fails for either category. Its JSON still distinguishes a
`TargetRefusal` from an ordinary error; no refusal is converted into a source
diagnostic. Five process-level tests exercise successful, refused, failed, and
mixed outcomes through the actual script. The tests inject outcomes only in
isolated children; they are not an alternative compiler. The accepted-corpus
success contract is recorded in [the compiler guide](compiler.md).

Running the strengthened command exposed three real refusals among 137 examples:
`capabilities.blot`, `projected.blot`, and `tour.blot`. Each had an effectful module
initialization and multiple runtime field exports. The compiler correctly refused
to replay that initialization independently for each exported field.

The examples now return one runtime aggregate under `.default`. The tour keeps
its `.small` and `.message` type values as separate compile-time exports. These
are example export-shape changes, not a relaxation of the effect or ABI policy.
Their evaluator goldens preserve the same writes and contained values, with the
new record nesting made explicit. Three regression tests check compilation,
capabilities, the single runtime export, and the tour's retained type exports.

After those repairs, the real corpus command produced **137 compiled, zero
refused, zero failed**, with exit status zero.

### P2: AST inspection depended on the semantic compiler artifact

[`src/node/cli.ts`](../src/node/cli.ts) created a `Compiler` before dispatching
`ast`. An unavailable or incompatible Rust/Wasm artifact therefore prevented
syntax-only inspection, even though the generated Baba frontend was available.

`ast` now has a syntax-only branch. It preserves BigInt JSON serialization,
source diagnostics, nonzero status for unreadable files, and continued processing
of later paths. Four isolated child-process regressions deliberately make
`Compiler.create` fail: three prove `ast` still works or reports the correct file
or syntax error, and one proves `check` still requires the semantic compiler.
No semantic fallback was introduced.

### P2: the syntax corpus gate used Baba's compact I32 policy directly

The new pagination boundary case includes `9223372036854775807`, the maximum
signed Blot `Int`. Production checking and execution accepted it, but
[`syntax.test.ts`](../syntax.test.ts) called `CpuFrontend.ingest` directly and
rejected it with `GPU_FRONTEND_INTEGER_BOUNDS`.

The gate now uses the existing production `ingestCpuSource` adapter. Baba still
owns token recognition and syntax acceptance; there is no new parser and no
narrowing of the example's boundary value to satisfy the test. Additional tests
assert that the parsed value remains exactly `9223372036854775807n` and that a
malformed expression containing that literal still reports a syntax error.

### P3: documentation and showcase coverage drifted

The float example still said sharing `+` between numeric domains would require
runtime typeclass machinery. That explanation predates source-defined inferred
type-member dispatch. The comment now distinguishes concrete float operators
from the remaining generic-loop issue below.

The showcase verifier now includes all four new examples and the previously
omitted `shader_metadata.blot`, which was already listed in the example catalog.
The example index links the boundary cases, explains their limitations, and gives
direct run commands. Compiler documentation explains the syntax-only AST path.

## New practical examples

Each example has `Pain point:` comments beside the relevant operation, deliberate
edge-case inputs, an evaluator golden, and a separate exact emitted-Wasm result
golden. All four expose a `.default` runtime value and need no host capabilities.

### Bounded pagination

[`paginated_feed.blot`](../examples/paginated_feed.blot) returns a page and an
optional continuation cursor, or a typed invalid-page result. It covers the first
page, final page, exhausted feed, empty feed, negative offset, zero limit, and an
Int-maximum limit.

The important order is to clamp against `length - offset` before computing the
stop index. Adding arbitrary caller bounds first can overflow. Checked indexing
also has an explicit invariant-error branch instead of silently omitting an
unexpectedly missing item. The input is borrowed; the page owns its result array.

### Unicode-scalar previews

[`unicode_preview.blot`](../examples/unicode_preview.blot) budgets one scalar for
an ellipsis, accepts empty and zero-length results, and returns an error for a
negative limit. For `café🙂`, a five-scalar budget preserves the text and a
four-scalar budget produces `caf…`.

Comments distinguish scalars from UTF-8 bytes, UTF-16 code units, and grapheme
clusters. The precomposed and decomposed accent cases make the limitation visible:
this is not normalization or user-perceived-character segmentation.

### Idempotent small-batch processing

[`idempotent_events.blot`](../examples/idempotent_events.blot) separates accepted
events, identical retries, conflicting payloads, and invalid quantities. Invalid
input does not claim an identifier, so a corrected retry can subsequently pass.
The demonstration yields total 5, two accepted events, one duplicate, one
conflict, and one invalid event; an empty batch yields zero counters.

The code makes dictionary replacement, persistent copying, borrowing, and
loop-carried counters explicit. It also says what it is not: an array-backed map
and repeated copies are a quadratic small-batch baseline, not a constant-time,
durable, or exactly-once delivery system.

### Sensor-unit conversion and optional means

[`sensor_units.blot`](../examples/sensor_units.blot) converts integer tenths to
`F64`, computes Celsius and Fahrenheit values, and uses `Option F64` for an empty
mean rather than dividing by zero. The sample Celsius values are 19.5, 20, and
20.5, with a mean of 20.

The comments distinguish contextual numeric literals from conversion of an
already-bound integer. They also distinguish stable accumulator typing from the
operator-inference limitation, using `F64.add` inside the loop and the named
float negation member on this main revision.

Run the examples with:

```sh
pnpm blot run examples/paginated_feed.blot
pnpm blot run examples/unicode_preview.blot
pnpm blot run examples/idempotent_events.blot
pnpm blot run examples/sensor_units.blot
```

## Remaining reproduced limitation: generic float accumulation

This reduced program is rejected on the reviewed compiler with `BLOT_TYPE_ERROR`
and the message `F64 does not flow into Int`:

```blot
open import "blot:prelude"

let sum :: [F64] -> F64
let sum = fn &values => do:
  let total :: F64
  let total = 0.0
  for value in Iter.items (&values):
    total := total + value

  return total

return sum [1.0, 2.0]
```

Replacing only `total + value` with `F64.add total value` makes it check as `F64`.
Concrete float arithmetic outside the loop is exercised successfully in the
sensor example. This is a current operator/loop-inference interaction, not a
language rule that floats cannot use operators. The patch does not weaken a
principal-type assertion, add implicit numeric coercions, or claim a compiler
fix for this case. It should be reevaluated against the eventual merged operator
implementation before removing the workaround.

## Validation and limits

Local validation used Node 22.16.0 and main's actual CI-built Rust/Wasm compiler.
The artifact's bytes, host ABI, prelude digest, and compiler-input identity were
verified against the downloaded source tree before testing.

- The initial focused tooling run had five failures: three AST failures and two
  refusal-status failures. The same assertions passed after the fixes.
- The final catalog plus Node integration and corpus-status run passed **460
  tests, zero failed, zero skipped**. This includes exact evaluator goldens for
  the catalog, exact public-ABI Wasm output for the four new examples, their
  formatting checks, and the three repaired export-shape regressions.
- The updated syntax suite passed **181 tests, zero failed, zero skipped**.
- The complete discovered Node regression suite passed **1,062 tests across 48
  files, zero failed, zero skipped**, including the repaired syntax gate.
- The full accepted compilation corpus passed **137/137** with no refusals.
- The expanded showcase verifier evaluated and compiled **20/20** programs.
- The language-health generated-output check passed without changing its output.

These checks overlap and must not be added together as unique coverage. The
initial broader regression run exposed the syntax-gate mismatch described above;
the final complete rerun passed after repairing the gate. Local checks do not
establish green remote CI: native Rust, Lean, Deno typechecking, lint, package
verification, and the other supported Node versions remain part of the unchanged
repository CI contract.
