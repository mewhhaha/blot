# Next-feature experiments

These spikes ask whether Blot needs new syntax or whether its existing semantic
core can absorb the feature. They are deliberately outside `examples/`: an
experiment is evidence for a design decision, not a language promise.

## Recommendation

Make handler records fully first-class checked values before adding another
control-flow feature. A handler clause should carry the continuation qualifier
and its validated ownership contract from the module that defined it. Then
`@handle` can consume that certificate instead of reopening the caller's AST.

The implementation experiment should proceed in four small steps:

1. Record the continuation qualifier and checked ownership contract with an
   evaluated handler clause.
2. Make type checking and ownership validation consume those facts across module
   boundaries.
3. Move `map_with`, `fold`, state, tracing, and scheduler handler builders into
   ordinary prelude modules.
4. Measure those library forms against their literal-handler and direct
   baselines before considering syntax.

This preserves Blot's existing surface-to-core rule: streams and concurrency
remain ordinary effects and handlers, and the prelude remains an ordinary
module. The feature is better module compositionality, not another AST node.

## Effect-driven streams

`effect_stream.blot` treats a stream as an effect protocol. A producer performs
`emit`; a transformer handles that effect by performing another `emit`; and a
consumer folds the final protocol into a result.

The hypothesis is that one-shot handlers can unify generators, iterator
adapters, structured concurrency, tracing, and backpressure without another
control-flow AST. The experiment must establish:

- the source works with the current effect system;
- handler composition keeps the producer independent of the consumer; and
- Runtime HIR contains no new stream or generator operation.

The raw pipeline specializes to one function, one block, 16 scalar/constant
operations, no residual capabilities, and 1,839 Wasm bytes. The direct
arithmetic baseline needs 14 operations and 1,813 bytes. The effect machinery
therefore erases; the remaining problem is source ergonomics rather than a new
runtime abstraction.

`effect_stream_combinators.blot` tests the next boundary by moving reusable
`map_with` and `fold` handler builders into an imported module. The source is
currently rejected with `BLOT_HANDLER_RESUME_NOT_AFFINE` even though the
defining clause binds `?resume`. Evaluated closures retain their defining
module, but the checker looks up the parameter in the importing module's AST.
Ownership also currently expects a source-local literal when validating linear
handler clauses.

That makes first-class handler values the strongest simplification candidate.
Preserving a checked continuation-usage certificate on handler values would let
the prelude provide stream, state, tracing, and concurrency combinators without
adding `yield`, `async`, or generator nodes to the language.

## Comptime derivation

`derived_accessors.blot` derives a type namespace of field accessors from an
ordinary shape value. It relies on the decisions that types are values,
compile-time functions are ordinary functions, and attached member names must
resolve to static text.

The hypothesis is that a small `Derive` prelude API can generate equality,
formatting, codecs, visitors, lenses, and ABI adapters without macros,
typeclasses, annotations, or a second type-level language. The experiment must
establish:

- every generated name is statically known after specialization;
- the generated functions retain distinct field result types; and
- no reflection or dynamic field lookup survives into Runtime HIR.

The derived and hand-written projections both specialize to one function, one
block, three product operations, no residual capabilities, and nearly identical
artifacts (2,172 and 2,181 Wasm bytes respectively). No reflection or dynamic
field lookup survives into Runtime HIR.

The unresolved question is recursion. A useful derivation facility needs a
well-founded way to derive operations for nested and recursive type values
without turning specialization into an unbounded search.

## Capture contracts

The third candidate is deliberately not prototyped in syntax. Publishing the
capabilities captured by a closure could make scoped resources, callbacks, and
structured concurrency more compositional. Blot already computes free captures
and ownership obligations, so the experiment should begin as an additional
certificate fact and LSP display, not as a new type constructor.

It is lower priority than the two runnable spikes: explicit effect rows already
state ambient operations, while ownership certificates already prevent linear
captures from escaping. A capture row earns source syntax only if the internal
fact accepts useful programs that those two systems cannot express.
