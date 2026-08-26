# Cross-spec coherence contract

## Status and authority

This document is normative for rules that cross more than one focused
specification. It exists to make disagreement explicit rather than allowing two
plausible readings of the language or compiler.

Authority is applied in this order:

1. `grammar.baba` decides concrete parse acceptance.
2. This document decides the cross-document invariants and corrections listed
   below.
3. [`LANGUAGE.md`](../LANGUAGE.md) decides the remaining accepted-source
   behavior.
4. A focused specification owns the exact judgment in its domain, subject to the
   cross-document invariants here.
5. [`PAPER.md`](PAPER.md) explains how those judgments compose; it is not a
   second source semantics.
6. Files under `docs/` are operational or historical, except that
   [`docs/abi.md`](../docs/abi.md) is normative for the versioned ABI 1 byte and
   caller-ownership contract by reference from [`RUNTIME.md`](RUNTIME.md).

A subordinate document's broader claim of authority is read subject to this
order. A future edit should repair the originating document and remove the
corresponding correction here; it must not add another silent override.

## 1. Surface language corrections

### 1.1 Fixed operators

Blot has one generated operator plan. Source modules cannot declare punctuation,
precedence, or associativity. The removed `operators` header is accepted only
far enough to produce `BLOT_REMOVED_OPERATOR_SECTION`.

The plan maps a spelling to precedence, associativity, and an ordinary qualified
binding path. Lexical resolution may change the value reached by that path, but
it cannot change grouping. Therefore references in older documents to a
source-provided "fixity environment", an "ordinary fixity entry", or fixities in
a module prefix are superseded by the generated language-plan revision.

### 1.2 Explicit statement values

A function body and a `case` arm are expressions. Layout may continue an
expression after a newline, but indentation alone never creates a value that
contains declarations or statements.

The only expression forms that contain declarations, sequencing, statement `if`,
loops, `break`, or `return` are:

```blot
do:
  statements
  return value

compdo:
  statements
  return value
```

`compdo:` has the same control structure but must resolve at compile time. A
function with a statement body writes `fn x => do:`. A case arm with statements
writes `pattern => do:`. Statement suites under `if` and `for` are constituents
of those statement forms, not independently usable expressions.

Consequently, examples of these shapes in older text are corrected by inserting
the explicit block marker:

```blot
// stale
fn x =>
  let y = f x
  return y

// accepted
fn x => do:
  let y = f x
  return y
```

```blot
// stale
pattern =>
  let y = value
  return y

// accepted
pattern => do:
  let y = value
  return y
```

A statement `if` is not a value expression. Boolean value selection is an
ordinary exhaustive `case`, or a statement `if` inside an explicit block.

### 1.3 No element syntax

Blot has no element or JSX-like semantic form. Components, properties, children,
and suspension are ordinary functions, records, arrays, and nullary closures.
References in older frontend prose to lowering an "element", implicit child
suspension, or an element-specific backend representation are removed from the
semantic model.

## 2. One Core application semantics

Every function application is a Core computation, including a call whose effect
row is empty:

```text
Gamma |- f : A ->{epsilon} B
Gamma |- a : A
-------------------------------- application
Gamma |- apply f a : B ! epsilon
```

Function position is evaluated before a strict argument. An empty row proves
that the call issues no algebraic-effect request. It does not make the call a
second pure reduction relation, and it does not imply termination or absence of
a specified trap.

A source pure position such as the right side of `let` may contain an
application only after its final row settles to empty. Elaboration still
schedules that call through the ordinary Core computation relation and binds its
returned value. `use` admits a non-empty row and is also the explicit sequencing
form for a suspended nullary effect value. No pass may switch between a
pure-call semantics and a computation-call semantics based on an optimization
result.

## 3. Demand precedes use accounting

Dead pure declarations are absent from source evaluation under the lexical
liveness judgment in [`CORE_SEMANTICS.md`](CORE_SEMANTICS.md). Ownership is
checked over the demanded elaborated program, or equivalently with a proof that
removing dead declarations preserves the ownership derivation of every live
path.

A move, cancellation, destructor, or consuming call that occurs only in an
erased declaration is absent. It cannot discharge a linear obligation. An
intentional consuming discard must be sequenced or otherwise contribute to the
demanded result.

Ownership modes retain their distinct meanings:

```text
unrestricted  any number of uses
borrowed      inspection only, no move or escape
affine        at most one consuming use; discard is permitted
linear        exactly one consuming action on every terminating exit
```

Thus the ownership theorem is not the blanket claim that no tracked value is
ever lost. It is a mode-indexed no-duplication, borrow, and terminating-exit
accounting theorem. Current linearity proves structural unique use, not that a
domain-specific finalizer ran.

## 4. Compile-time identity

### 4.1 Effects are generative

An ordinary source effect declaration allocates an atom under its complete
semantic occurrence:

```text
(module instance, declaration node, compile-time scope, signature)
```

Administrative re-evaluation of that recorded occurrence recovers the atom.
Evaluation under a different module-instance stack mints a distinct atom.
Spelling or structural signature equality never identifies ordinary effects.

### 4.2 Seals are applicative

A seal is not generative. Its identity is:

```text
(public name, canonical closed invariant carrier)
```

Reconstructing equal inputs reconstructs the same seal across evaluations and
revisions. The carrier is invariant. Cache keys for seals retain those canonical
inputs; they do not substitute declaration occurrence or an effect-like fresh
atom.

## 5. Partial capability composition

A partitioned-capability family supplies a partial ordered composition `p * q`.
Its associativity law is result coherence when both bracketings are admitted:

```text
(p * q) * r defined    p * (q * r) defined
------------------------------------------------
(p * q) * r = p * (q * r)
```

Definedness of one bracketing does not imply definedness of the other. For
rectangular tiles, two adjacent top rectangles may compose into a full-width
strip that then composes with a bottom strip, while composing one top rectangle
with the bottom strip would form a forbidden L shape.

Proof-tree reassociation therefore consumes the exact old witnesses and asks the
family adapter to validate the new intermediate composition. If that composition
is undefined, reassociation is refused and the existing proof tree remains the
only admissible bracketing. Registration tests must cover both coherence where
two bracketings exist and refusal where the target intermediate does not.

## 6. Failure taxonomy

The compiler distinguishes four meanings even when two are presented through the
same diagnostic transport:

```text
SourceDiagnostic  a source-language premise is false
LimitDiagnostic   a documented deterministic compiler resource bound was reached
TargetRefusal     the selected ABI or target policy does not admit a checked program
InvariantFailure  an earlier compiler contract was violated
```

A `SourceDiagnostic` is evidence that a language derivation failed. A
`LimitDiagnostic`, including `BLOT_EVALUATION_LIMIT`, establishes neither
acceptance nor rejection. It is not a source return, request, trap, or divergent
execution. Raising a limit may allow the same source revision to finish checking
without changing source meaning.

A closed checked internal program may be refused at an explicitly unsupported
public ABI or experimental target boundary. Failure to close a representation
that the production target claims to support is an `InvariantFailure`, not a new
source diagnostic or a target-policy escape hatch.

## 7. ABI authority and nominality

[`RUNTIME.md`](RUNTIME.md) owns the semantic relation between source values,
Runtime HIR, and caller values, including which closed types are admissible.
[`docs/abi.md`](../docs/abi.md) owns the exact versioned Core Wasm ABI 1 bytes,
lifting/lowering rules, and caller ownership obligations. Its section describing
current runtime-target coverage is operational and cannot weaken an ABI rule for
an artifact the compiler accepts.

A seal remains nominal in Blot. Its ABI manifest records the public name, so
conforming tooling and the representation relation distinguish source contracts.
Raw Core Wasm values with equal carrier layouts do not dynamically contain that
name. ABI nominal safety therefore depends on the declared manifest and the
conforming-caller premise; the byte representation alone cannot prevent a
hostile caller from confusing equal carriers.

Every accepted public boundary performs all validation required for its admitted
types before constructing a source value. An unimplemented boolean, pointer,
length, alignment, discriminant, UTF-8, or ownership check requires
`TargetRefusal`. Accepting the boundary without the check is an
`InvariantFailure`.

## 8. Target observations

For a closed program and related host responses, source, specialized Core,
Runtime HIR, and emitted WebAssembly must preserve and reflect:

```text
Return(value)
Request(effect, operation, argument, continuation protocol)
Trap(specified trap)
divergence
```

A weak forward simulation is insufficient by itself because a target could
stutter forever or introduce a target-only finite outcome. Each pass supplies a
progress-sensitive adequacy condition: empty target matches decrease a
well-founded rank, visible finite outcomes are reached in finitely many
administrative steps, target outcomes are reflected by the source, and related
requests resume related one-shot continuations under related host responses.

A defensive target check may remain only with a proof that related validated
states cannot reach it. Reaching one is an `InvariantFailure`, not a permitted
extra target trap.

## 9. Structural collection invariants

The current `OrderedTextMap.of V` carrier is structurally represented by a
`Slice` of `(Text, V)` entries. Its type alone does not prove that keys are
strictly ordered.

`OrderedTextMap.copy` dynamically establishes `ordered(S)`, and exported map
operations preserve it. Map lookup, key-range partition, and logarithmic-cost
claims are conditional on that protocol premise. A caller can construct a
structurally matching raw `Slice`; doing so cannot enlarge interval authority or
cause memory unsafety, but it is outside the abstract ordered-map contract and
need not implement mathematical map lookup. A total abstraction over every
well-typed inhabitant would require a nominal seal or revalidation at every
entry.

## 10. Corrections to stale wording

The rules above supersede these recurring phrases wherever they remain in older
material:

| Stale wording                                           | Correct reading                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| source fixity environment                               | generated fixed operator plan                                                     |
| indentation opens a value block                         | only `do:` or `compdo:` opens a statement value                                   |
| element lowering or implicit children                   | ordinary functions, records, arrays, and nullary closures                         |
| empty-row application is pure Core                      | every application is a computation; the row may be empty                          |
| effects and seals are generative                        | effects generative; seals applicative                                             |
| either associative bracketing implies both              | equality only when both partial compositions exist                                |
| every diagnostic proves invalid source                  | only `SourceDiagnostic` has that meaning                                          |
| seal name is dynamically present in raw ABI bytes       | name is a manifest/conformance fact                                               |
| unreachable defensive trap is an allowed target outcome | it is unreachable or an invariant failure                                         |
| structural ordered-map carrier proves ordering          | ordering is a constructor-established protocol premise                            |
| ownership never loses tracked obligations               | affine discard is allowed; linear paths require exact terminating-exit accounting |

## 11. Proof status

This contract removes ambiguity; it does not claim the whole compiler has been
mechanized. The remaining named obligations include surface-to-Core
correspondence, liveness erasure, principality within the stated rank-1
fragment, certificate replay, phase safety, representation closure,
capability-family law checks, progress-sensitive pass composition,
canonical-adapter validation, and a checked correspondence between production
artifacts and the Lean model.
