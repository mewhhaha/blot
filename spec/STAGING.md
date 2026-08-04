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
