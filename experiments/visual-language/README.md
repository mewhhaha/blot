# Blot visual language review

Review date: 2026-09-12. The highlighted comparison is
`blot-visual-review.html`. Its first four comparisons show the example changes
in this diff. The typed-parameter, record-shorthand, and multiline-field
comparisons now use implemented syntax. The executable examples are
[typed parameters](../../examples/typed_parameters.blot) and
[record fields](../../examples/record_fields.blot).

The [language triage](../../docs/language-triage-2026-09-12.md) places these
syntax changes alongside current compiler defects, library gaps, and deliberate
limits.

The comparison uses the checked-in Baba Wasm lexer and an illustrative palette.
It is not a screenshot of an installed editor theme. Switching off colors lets
the indentation, names, and punctuation carry the comparison on their own.

## Assessment

Blot's small expression forms are already elegant. Application reads naturally
as `evaluate left`, cases put alternatives in one column, and constructors make
an expression tree recognizable without another declaration language. The
combination of `const`, ordinary functions, and ordinary type values also gives
refinements a good surface:

```blot
const Natural = refine (Int, fn value => value >= 0)
```

The weakest passages are orchestration code and large record values. They stack
several individually understandable conventions: a signature, a repeated binding
header, `fn`, `=> do:`, an ownership qualifier, callback declarations, and
record terminators. In the Spark browser example, long effect rows compete with
the actual sequence of operations for attention. This is partly example style,
partly API shape, and partly syntax.

The visual target should be a clear left edge, one visible operation per step,
and short expressions where the reader can recognize the whole operation.
Reducing line count is useful when it reveals that structure. Compressing a long
function signature onto its body line often works against it.

## Rewrites made with current syntax

- [FizzBuzz](../../examples/fizzbuzz.blot): guarded cases present the ordered
  classification directly. `%` makes the divisibility conditions recognizable.
  The accumulator loop remains, because this example demonstrates that loop.
- [Expression interpreter](../../examples/expression_interpreter.blot): tuple
  patterns name `left` and `right` where they are unpacked. Unary negation
  expresses the operation directly. The tree and recursive algorithm remain the
  same.
- [Engine arithmetic](../../case-studies/engine/lib/math.blot): the sine
  polynomial uses arithmetic operators. Its alternating signs and denominators
  can be read down the page. The power construction, evaluation order, numeric
  precision, and final positive thirteenth-order term are preserved; this is not
  a change to the approximation.
- [Parallel Sparks](../../examples/lib/spark_parallel.blot): the scope callback
  is placed at its call, and the two fresh, short work closures are passed
  directly. The public signature, explicit executor, child scope, and joins
  remain visible. No binding is introduced merely to transfer a fresh closure.

The Spark rewrite still has a busy boundary:

```blot
return Spark.scope io.executor $ fn scope => do:
  use first <- Spark.parallel scope (fn () => sum count)
  use second <- Spark.parallel scope (fn () => sum (count + 1))
  use a <- Spark.join first
  use b <- Spark.join second
  return a + b
```

`$ fn ... => do:` costs several symbols, but the scope and work are now
adjacent. A larger callback with a useful domain name can still earn a separate
binding. Passing fresh callbacks does not imply that ownership markers can be
removed from transfers of already-bound resources.

## Style improvements already available

Keep written binding signatures separate from their definitions:

```blot
const score :: Int -> Int
const score = fn quantity => formula.score quantity
```

Inline binding signatures are accepted by the current compiler, but are not the
chosen style. Direct parameter annotations now put a type beside a name inside a
function definition. Infer local callback types when the surrounding contract
already determines them. Preserve useful numeric, ownership, and public boundary
constraints.

Keep `do:` for function bodies containing statements:

```blot
const double = fn value => do:
  let result = value + value
  return result
```

Expression bodies remain ordinary expressions. An indented statement sequence
after `=>` has no implicit block; the language specification now describes the
same explicit boundary as the compiler and frontend contract.

Use `use operation argument` when discarding the result. The formatter already
prefers it over `use () <- operation argument`. Keep `use result <- ...` when
the result has a name. This gives effectful sequences a consistent, readable
left edge without introducing `async` and `await` as another vocabulary.

Effect rows can already be named as ordinary compile-time values:

```blot
const Clock = @effect.host { .now = Unit -> Int; }
const Reads = { Clock }
let read :: Unit -> Int ~ Reads
let read = fn () => Clock.now ()
```

A named row helps when it represents a stable, repeated contract. A giant
catch-all row merely makes broad effects less visible. For the browser actor,
smaller operations and local inference deserve attention before an umbrella
effect alias.

Use `if` for control transfer and state carried out of branches; use `case` for
a compact selection of values. The interpreter and guarded examples show the
latter well. In [grep](../../case-studies/grep/main.blot), the matching branch
could also increment the count where it writes the matching line, avoiding a
second Boolean case. That is a suggested follow-up, not another change in this
diff.

Keep long discussions of implementation history in accompanying documentation.
Some examples have more commentary than executable source, which makes them
harder to survey as a catalog. Comments that explain constraints still belong
beside the code.

## Selected syntax direction

### 1. Annotate parameters directly

Implemented:

```blot
const double = fn (a :: Int) -> Int => do:
  return a + a

const add = fn (left :: Int, right :: Int) -> Int => do:
  return left + right
```

Keep `fn` as the function introducer. Parameter annotations put names beside
their constraints, `-> Int` describes the result, and `=>` starts the body.
`do:` remains required when that body contains statements. The tuple in `add` is
still one parameter pattern; it does not introduce a different calling
convention or implicit currying.

Annotations must remain ordinary compile-time type values and constrain the
ordinary function's inferred type. A separate signature can still state a
whole-function contract; when both are written, both must hold. The grammar
supports result effect rows, qualifier placement, destructuring, recursion, and
separate polymorphic signatures through ordinary function constraints. An
omitted result infers its effect row; a written result is pure unless an effect
row is written.

### 2. Extend record shorthand from patterns to values

Current:

```blot
return { .run = run; .kernel = sum; }
```

Implemented:

```blot
return { .run; .kernel = sum; }
```

`.run;` already means `.run = run;` in a record pattern. Giving a value field
the corresponding expansion removes a recurring repetition from exports and
record construction. Renames remain explicit. This needs only ordinary field
construction after surface lowering, with the existing name lookup, duplicate
field, staging, and ownership rules.

Keep the leading dot. Blot currently uses it to distinguish records from effect
rows such as `{ Clock, Console }`; removing it would spend a useful distinction
for a small reduction in punctuation.

### 3. Make multiline record fields follow layout

The standalone `;` after a block-valued handler field is a particularly awkward
visual seam. This layout is accepted:

```blot
let collecting = {
  .write = fn (message, ?resume) => do:
    use rest <- resume ()
    return @text.concat (@text.concat message "|") rest
  .return = fn value => value
}
```

Fields sharing a physical line keep explicit separators. When the first field
starts on its own line, a new field at that indentation terminates the previous
one. More-indented field accesses remain continuations; nested suites and
closing delimiters retain their boundaries. Baba generation accepts the
version-3 general profile with every rule an island and no conflict resolutions.
The counter changes are recorded in [the profile](../../docs/gpu-profile.md).

## Highlighting and formatting

The
[generated highlight query](../../generated/queries/generated-highlights.scm)
now captures field names precisely and adds contextual keywords and function
bindings. `.return` stays a member. Uppercase identifiers use the same variable
capture as lowercase identifiers: capitalization does not establish a type
namespace. The comparison uses that distinction with an illustrative palette; it
is not a screenshot of an installed editor theme.

The formatter supports typed parameter tuples, puts a multiline function body
relative to its `=>` line, and retains the selected record separator style. The
syntax tests cover nested records, comments, continuation dots, block-valued
fields, qualifiers, and annotation errors. Formatting the executable catalog
must remain idempotent.

## Implementation

`fn` introduces every function; `do:` introduces a body containing statements.
Separate binding signatures remain available, and both constraints apply when a
definition also annotates its parameters or result. Record shorthand and newline
boundaries lower to the existing field constructions. None of these forms adds a
semantic AST or Runtime-HIR node.

[The implementation ledger](../../docs/triage-implementation.md) records the
compiler, library, performance, and downstream acceptance checks.

## Verification

- FizzBuzz and the interpreter produce their existing golden outputs before and
  after rewriting, in both the Rust evaluator and emitted Wasm.
- The arithmetic comparison checks all 65 polynomial table inputs, 21 whole-step
  samples, and 27 samples each for precise sine and cosine. The samples cover
  negative inputs, zero, quadrant boundaries, interpolation boundaries, and
  wrapping. All 140 numeric observations agree exactly before/after and between
  evaluator and Wasm, including signed zero. Values are compared structurally;
  the two display printers use different F32 spellings and record field order.
- The revised Spark kernel's catalog result agrees between evaluator and Wasm.
  All five Node worker-executor tests pass, exercising actual parallel work,
  worker reuse, cancellation, purity refusal, and recovery after a worker trap.
- All four edited files pass canonical formatting. The separate signature and
  named effect-row examples compile. Typed headers, record shorthand, and
  multiline field boundaries now have parser, lowering, formatter, evaluator,
  and Wasm regressions. The engine game-loop consumer also compiles with the
  revised arithmetic library.
- All 15 corrected or added language-specification snippets pass Baba parsing
  with illustrative context supplied where needed. The description retains
  explicit `do:` for statement-valued function bodies.
- All seven visual comparisons were inspected at 736px and 360px in both light
  and dark themes. The selector and syntax-color toggle work without horizontal
  overflow or browser script errors.

The initial review changed example presentation. Its subsequent implementation
also changes grammar, compiler lowering, and generated editor artifacts; the
implementation ledger records the current verification and remaining limits.
