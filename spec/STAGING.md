# Staging and specialization

## 1. Phase separation

Blot has one value language observed at two phases. Compile-time availability is
evidence about an expression, not a second type system. Let

```text
K : ExpressionId -> CompileTimeValue
```

record successful deterministic evaluation during checking. A type may be a
compile-time value; it has no runtime representation merely because it appears
in the ordinary value language.

Residualization is written

```text
K |- e => v          fully evaluated compile-time value
K |- e => ~r         residual runtime expression
```

Failure to evaluate a pure runtime expression speculatively does not authorize
its erasure. It remains residual unless the language requires compile-time
evaluation and reports a diagnostic.

## 2. Phase safety

Let `erase(K, e)` remove compile-time declarations after substituting the code
and representation decisions they produced. The phase-safety obligation is:

```text
K |- e => ~r
-------------------------------
free_runtime(r) intersect dom(K) = {}
```

and for any two compile-time environments that produce the same residual code,
runtime observations agree. A compile-time value may change runtime behavior
only through the residual code, layout, effect identity, or adapter it
explicitly generates.

Compile-time evaluation is deterministic for a fixed source graph. Fuel or
resource exhaustion is an implementation refusal, not a silently chosen value.
Host effects and ambient I/O are unavailable unless represented by explicit
compile-time input in the source graph.

## 3. Modules and generative identity

An imported module evaluates as an ordinary compile-time function over its
explicit parameter. A closure retains its defining module revision and closed
lexical environment. Re-exporting the closure does not replace that origin.

Generative declarations, currently effects and seals, mint an identity per
evaluated declaration occurrence. Cache reuse preserves an identity only when
the complete declaration revision is unchanged; reevaluation after invalidation
mints another identity. Spelling is not identity.

The closed specialization capsule and its coherence law are specified in
[`TYPECHECKING.md`](TYPECHECKING.md). A capsule contains no live inference
variable, mutable solver state, or undeclared dependency.

## 4. Specialization judgment

Specialization converts typed, owned residual source into representation-closed
runtime code:

```text
K ; Sigma ; C |- e => r : Rep(A)
```

`Sigma` contains settled schemes and concrete call-site shapes. `C` contains the
certificates produced by inference and safety analyses. `Rep(A)` is a closed
physical representation; it contains no inference variable, open record row,
open variant row, compile-time type value, dynamic structural name, or
unresolved handler.

Specialization may clone a definition for distinct concrete representations. Two
clones must remain contextually equivalent to the source definition at their
respective call types. Memoization keys include closure identity, argument
representation, effect identity, and every compile-time value observed while
selecting the result.

For a closure `lambda x. e`, let `FV_r(e)` be the lexically free bindings whose
values contain residual runtime components. Closure conversion is:

```text
FV_r(e) = { c1 : C1, ..., cn : Cn }
------------------------------------------------------------ closure-convert
rec f x = e  =>  fun f(x : A, c1 : C1, ..., cn : Cn) = e'
```

where `e'` replaces each captured runtime component with the corresponding
function parameter. A recursive application passes the same explicit captures.
Compile-time free bindings remain in the evaluator environment and do not become
runtime parameters. The dynamicity test is over the argument and the free
variables unless the evaluator holds a finite staged driver:

```text
Dynamic(x) or exists c in FV(e). Dynamic(c)
-------------------------------------------- residual-recursion
residualize(rec f x = e)
```

If neither premise holds, ordinary static evaluation may continue. A finite
staged iterator or a captured finite staged array paired with a static index is
a stronger witness: recursion unfolds around the dynamic accumulator until that
driver is exhausted. This is what permits a compile-time field-name array to
drive residual projections. In the absence of that witness, recursion controlled
by a dynamic captured bound must not be unrolled merely because its initial
accumulator is static.

When a higher-order argument supplies a concrete arrow for an abstract arrow,
specialization records the induced representation substitution. For example,
matching `(A, T) -> A` with `(Store S, Int) -> Store S` establishes
`Rep(A) = Store(Rep(S))` and `Rep(T) = i64` for nested closures evaluated in
that lexical scope. Every representation hole has a globally fresh identity in
the checked module; two unrelated `Bottom` positions must not unify merely
because their signatures were reified in separate traversals.

Call-site facts are transactional. Matching an expected type expression `A`
against an argument with layout `rho` records `Rep(A) = rho`. Products also
record a structural key made from their field names and nesting, because scalar
refinements do not affect layout:

```text
Rep({ generation : Int; frames : Top })
  = Rep({ generation : Top; frames : Top })
```

only when that structural key has one observed call-site representation. Two
different layouts for the same key erase the fact rather than selecting the
first. Exact type-variable substitutions remain stronger than structural facts.
This is representation erasure under checked shape equality, not structural type
inference in the backend.

Recursive representation equations use their concrete union members as
witnesses. Positive recursion takes the least fixed point, so `R = R | X` has
representation `Rep(X)` when every concrete member agrees. A compiler-local
control constructor is the runtime envelope of its inferred union; payload
projection distributes over unions,

```text
payload(A | B) = payload(A) | payload(B),
```

and removes the unspellable `{ .value = ... }` wrapper before choosing the
runtime sum payload. The specializer may not infer a recursive result by looking
at unrelated captured closures.

Ownership markers and branch hints are identities after their respective
certificates have been consumed. Staged non-empty arrays residualize as Store
construction with one checked element representation. A dynamic conditional
residualizes each branch in order, including `else if` chains, and injects a
singleton constructor into the already inferred sum when necessary.

An element effect value is a nullary closure during staging. Constructing it is
pure and retains its lexical environment. At an effect-binding boundary, a
checked `Unit -> A ~ E` value is applied to `()` exactly once; its `E` joins the
surrounding row and the binding receives `A`. A residual effect value is
therefore handled by ordinary closure conversion and direct calls rather than a
second runtime representation.

## 5. Imported compile-time dispatch

When a compile-time closure chooses a branch from a concrete argument, result
typing follows the value produced by that evaluated branch. The imported module
interface does not collapse differently shaped branch results into one
Hindley--Milner arrow. Each call gets a fresh value-directed synthesis.

This rule supports an imported dispatcher whose selected descriptor contains a
different `.pack` signature for each known arity. It remains predicative and
does not add dependent runtime arrows: the dependency is discharged by
compile-time evaluation before runtime typing is closed.

## 6. Structural folds

For a static finite label vector, residualization unfolds a structural fold and
turns each static lookup into a direct projection:

```text
PE(fold([], z, k)) = PE(z)
PE(fold(l :: ls, z, k)) = PE(fold(ls, k(z, l), k))
PE(shape.get(~r, l)) = ~(project_l r)
```

The dynamic accumulator may remain residual; it does not make the static label
dynamic. The direct-projection and phase-preservation lemmas are detailed in
[`TYPECHECKING.md`](TYPECHECKING.md).

## 7. Representation-closure theorem obligation

For a well-typed closed program admitted by the production target,
specialization terminates or reports a compiler resource refusal, and successful
specialization produces only closed representations. Evaluating the specialized
program is observationally equivalent to evaluating the residual source program.

A dynamic shape operation, unresolved structural function, or unexpected
Hindley--Milner rejection after this point is an invariant failure. It is not a
reason to widen or narrow the inferred source type.
