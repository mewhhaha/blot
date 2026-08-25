# Core semantic identities and observations

## Status and scope

[`LANGUAGE.md`](../LANGUAGE.md), subject to [`COHERENCE.md`](COHERENCE.md),
defines accepted-source behavior. This document owns the focused Core rules for
demand, application, semantic identity, module instances, algebraic effects,
handlers, one-shot continuations, progress, and divergence.

[`PAPER.md`](PAPER.md) supplies the integrated model;
[`COMPILER.md`](COMPILER.md) supplies the pass graph; and
[`CORRECTNESS.md`](CORRECTNESS.md) supplies the translation theorem package.

## 1. Configurations and observations

A closed Core computation has finite observations:

```text
Return(v)
Request(ell, operation, argument, continuation-protocol)
Trap(specified-trap)
```

Divergence is a maximal execution with infinitely many reduction steps. It is
not another current-state constructor.

Internal allocation identities, administrative reductions, closure indices,
Store headers, and private representation choices are hidden unless a source or
ABI relation explicitly exposes a corresponding value.

A request is compared as a protocol. Related executions agree on effect
identity, operation, and related argument. Related host responses resume related
one-shot continuations. Raw continuation addresses are not source observations.

## 2. Values and computations

Core distinguishes values from computations:

```text
Gamma |- v : A
Gamma |- c : A ! epsilon
```

A value is already formed. A computation may return a value, issue a request
named by `epsilon`, trap according to a specified rule, or diverge.

Representative forms are:

```text
c ::= return v
    | bind x <- c in c
    | apply v v
    | primitive(v*)
    | perform[ell, operation] v
    | handle ell c with h
    | if v then c else c
    | case v of K_i x_i => c_i
```

The implementation may introduce administrative forms when they are related to
these configurations.

### 2.1 One application rule

Every application is a computation:

```text
Gamma |- f : A ->{epsilon} B
Gamma |- a : A
-------------------------------- application
Gamma |- apply f a : B ! epsilon
```

Function position is evaluated before the strict argument at the surface-to-Core
boundary. An empty row means that the application issues no algebraic-effect
request. It does not create a second pure application relation, and it does not
exclude a return, specified trap, or divergence.

A source pure position admits an application only after its final row settles to
the empty row. Elaboration still schedules the call through this computation
rule and binds the returned value. Surface `<-` admits a non-empty row and is
also the explicit sequencing form for a suspended nullary effect value. Such a
value is applied to unit exactly once; an already applied computation is not
applied again.

## 3. Demand and pure declarations

Liveness is a lexical source judgment, not an observation guessed by an
optimizer. For a block with resolved declarations `d_1 ... d_n` and result `r`,
walk the binding-dependency graph backwards from:

- every binding identity read by `r`; and
- every declaration that source semantics classifies as forced.

Write:

```text
live(block, result) = L
```

A pure declaration outside `L` is absent from source evaluation. Every retained
pure declaration evaluates exactly once in source order. This is not
call-by-name or first-use forcing; no run-time thunk is introduced.

Operational declarations such as signatures, ordinary effect declarations,
explicit shadowing, and `open` remain forced according to their source rules.

The erasure obligation is:

```text
erase_dead(block, L)
```

preserves every demanded return, request, specified trap, and divergence. An
optimizer cannot first erase a behavior and then use that absence as evidence
that the declaration was dead.

Ownership is checked over the demanded program. A move, cancellation,
destructor, or consuming call occurring only in an erased declaration is absent
and cannot discharge a linear obligation. Intentional consuming discard must be
sequenced or otherwise contribute to a demanded result.

A retained empty-row computation may still trap or diverge. Reordering requires
an independent totality and dependency proof; effect emptiness is not enough.

## 4. Identity classes

The compiler uses identities with different allocation and lifetime rules:

| Identity          | Allocated by                   | Equality means                                    | Cache rule                                 |
| ----------------- | ------------------------------ | ------------------------------------------------- | ------------------------------------------ |
| expression        | frontend AST                   | same expression in one source revision            | serialize a stable expression ID           |
| binding           | elaboration/checking           | same lexical binding in one revision              | only through a closed certificate          |
| immutable value   | relationship analysis          | same value origin for `Phi`                       | reconstruct or certify explicitly          |
| effect atom       | compile-time evaluation        | same generative effect occurrence                 | preserve complete module-instance identity |
| seal              | compile-time type construction | same public name and canonical carrier            | reconstruct canonical inputs               |
| module definition | resolver                       | same resolved module artifact                     | ordinary revision rules                    |
| import occurrence | resolved source graph          | same written import site in one importer revision | retain importer revision                   |
| module instance   | module evaluation              | same occurrence under same parent stack           | retain complete instance stack             |
| Store/root        | ownership/lowering             | same physical authority root                      | retain ownership certificate               |
| revision          | incremental compiler           | same complete observed compiler input             | cache namespace identity                   |

No pass may replace one identity class with another because their printed data
match. A module path is not a module instance, a source name is not an effect
atom, and a source value identity is not a Store root.

## 5. Module definitions, occurrences, and instances

Let `m` be a resolved module definition and `o` a written import occurrence
under parent instance `p`:

```text
ModuleDef(m)
ImportSite(p, importer-revision, source-site, m) = o
ModuleInstance(parent-stack(p) ++ [o]) = iota
```

Bare `import` supplies unit. `import ... with value` supplies the explicit
argument. Evaluating the occurrence evaluates that instance's top-level
declarations once in source order and yields the instance result. It does not
return an uninvoked source module function.

Aliasing, projecting, or returning the result shares it and does not replay
initialization. A second written occurrence is a second instance even when its
resolved module and argument are equal. The same nested import site under two
parent instances is distinct because the complete parent stack differs.

Inlining may erase a module shell but must preserve instance identity and
observations. A cached result requires the complete instance identity and source
revision. A definition path alone is invalid for a result that may contain or
capture generative values, closures, traps, or divergence.

## 6. Generative effects

For an ordinary source effect declaration:

```text
newEffect(module-instance, source-node, compile-time-scope, Sigma)
  => effect(ell, Sigma)
```

An application occurrence is the exact source-expression identity in its
complete semantic module revision, not its span or the printed form of its
argument. The compile-time scope is the ordered stack of closure-application
occurrences. Each frame also retains the closure's creation-scope provenance;
closures created by imported module instances retain that defining instance
stack. A compiler-owned application that may reach `newEffect` has a typed role
rooted in its owning source expression, declaration, handler request, or runtime
export parameter. It may not use a dummy span or an argument rendering as that
root.

Two executions of one application node under an equal outer stack record the
same occurrence. A second written application records another occurrence.
Recursive evaluation at one application node appends another frame, so recursion
depth remains distinct while administrative re-evaluation of the same recorded
stack is stable. A module revision changes when its source, configuration, or an
observable dependency boundary changes.

`Sigma` is compared by exact type-value equality: quantified variables are
alpha-equivalent, record order is immaterial, and referenced effect atoms keep
their exact identities. It is never replaced by a partial structural hash.

`ell` is fresh for every different tuple. Administrative compiler re-evaluation
of the same recorded tuple recovers the same atom. Evaluation in another module
instance mints another atom.

Aliases preserve the atom. Structural equality of operation descriptors does not
identify ordinary effects. A compiler-private named capability may have a
separately specified applicative identity rule; that does not change ordinary
`@effect`.

Seals do not use this rule. They are applicative identities of public name and
canonical invariant carrier, as specified by `TYPECHECKING.md` and `STAGING.md`.

## 7. Effect requests

If:

```text
Signature(ell, operation) = A -> B
```

then:

```text
Gamma |- v : A
--------------------------------------------- perform
Gamma |- perform[ell, operation](v) : B ! {ell}
```

The atom is part of the capability. An equal-looking signature under another
atom does not handle or authorize the request.

## 8. Handler reduction and rows

Let `E` be the delimited evaluation context captured by the handler. A request
for the handled atom reduces as:

```text
handle ell (E[perform[ell, operation](v)]) with h
  --> h.operation(v, resume)

resume = one-shot (lambda b.
  handle ell (E[return b]) with h)
```

A successful resume re-enters the handler around the captured context. The
operation clause itself is not recursively enclosed by the same handler. A
clause that performs `ell` therefore emits a new request and reintroduces the
label.

Let all operation clauses and the optional return clause contribute `epsilon_h`.
Handling has the row rule:

```text
Gamma |- c : A ! epsilon_c
Gamma |- h : Handler(ell, A, B, epsilon_h)
----------------------------------------------------------- handle
Gamma |- handle ell c with h
  : B ! ((epsilon_c \ {ell}) union epsilon_h)
```

Set subtraction is part of the rule. Factoring the premise as
`epsilon union {ell}` without an absence condition is non-unique because union
is idempotent.

Handling an atom absent from `epsilon_c` is valid. Operation clauses are
unreachable for that computation, while the return clause may still transform
the normal result.

## 9. One-shot continuations

A captured continuation can be consumed at most once. Ownership assigns its
binding an affine or linear obligation:

- affine: resume or cancel zero or one time;
- linear: one consuming action on every terminating clause exit.

`Continuation.cancel` is an explicit sequenced consuming destructor. It spends
the continuation without entering its captured context. It cannot be erased as a
dead pure `let`, forged for an arbitrary closure, or used to justify a later
resume.

Cancellation accounts for structural ownership of the continuation. It does not
execute consumers or finalizers inside the discarded context. Current linearity
is therefore a unique-use discipline, not a must-finalize resource theorem.

A future must-finalize resource requires one of:

1. a separate explicit finalization effect or consuming operation;
2. checked cancellation evidence covering every captured must-use resource; or
3. a restriction requiring the continuation to resume exactly once.

A defensive spent flag may remain at run time, but accepted source must not rely
on it to reject a second resume.

## 10. Progress and maximal executions

For a closed well-typed computation `c : A ! epsilon`, one-step progress says
that `c` is one of:

- `return v` for an appropriate value;
- able to take a reduction step;
- poised to request an operation whose atom is in `epsilon`; or
- at a specified language trap.

It is not stuck on an unclassified machine state.

The maximal-execution theorem says every maximal execution either reaches a
classified finite outcome or contains infinitely many reduction steps.
Divergence is handled here, not as a fifth one-step progress form.

A compiler pass must not turn demanded source divergence into a return or
unrelated trap, erase demanded divergence through liveness or optimization, or
manufacture divergence by infinite administrative stuttering.

## 11. Host boundary

Ordinary source effects must be handled before a closed module boundary. An
explicit admitted host capability may remain and lower to a typed import. The
entry input and explicitly supplied host capabilities are the complete ambient
run-time authority.

A conforming host follows the declared request/response and ownership protocol.
A host may diverge, take a specified host trap, or fail to respond. Canonical
adapters validate untrusted representation claims before constructing source
values.

## 12. Obligations and evidence

This boundary owes:

1. one computation semantics for all applications;
2. lexical-demand determinism and dead-declaration erasure adequacy;
3. ownership compatibility with demand;
4. separation of every identity class;
5. occurrence-scoped module instantiation;
6. generative ordinary-effect identity;
7. subtraction-based handler rows;
8. one-shot continuation use and explicit cancellation;
9. preservation and one-step progress; and
10. maximal-execution classification including divergence.

Maintained regressions should distinguish:

- repeated administrative evaluation of one import occurrence from a second
  written occurrence;
- aliases of one effect from structurally equal fresh effects;
- nested imports under different parent instances;
- re-performing a handled effect from discharging it;
- handling an absent effect with a transforming return clause;
- empty-row calls that return, trap, and diverge; and
- a consuming use in live code from the same syntax inside a dead declaration.

Tests exercise these boundaries but do not become an alternative authority for
demand, application, identity, handlers, or progress.
