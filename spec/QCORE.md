# QCore checked-kernel boundary

## Status

QCore is a shadow artifact. The production typechecker, ownership analysis,
Runtime HIR, evaluator, and Wasm backend do not consume it. This document owns
structural validation. [`QCORE_TYPING.md`](QCORE_TYPING.md) defines a separate
typing and conversion shadow for an explicitly smaller pure fragment. Neither
document defines erasure or a production term/elaboration translation from
current Core; the closed checked-certificate embedding below is structural and
shadow-only.

[`qcore/schema.json`](../qcore/schema.json) is the only representation
authority. It assigns schema versions, constructors, numeric tags, fields, list
shapes, and reference representations. Generated Rust, TypeScript, and Lean
definitions must match it byte for byte.

The structural Rust kernel establishes only this judgment:

```text
validate(M) = ValidatedQModule(M)
```

Failure means that bytes or an in-memory producer violated the QCore artifact
contract. It is not a Blot source diagnostic.

## Module and arena

A `QModule` contains:

- the exact QCore schema version;
- a semantic module identity;
- the number of module-level effect-row parameters;
- imported definition references;
- local definitions with value or computation roots and their declared
  boundaries; and
- one `QArena`.

Each numeric reference is a zero-based index in exactly one arena array:

| Reference        | Array          |
| ---------------- | -------------- |
| `SourceOriginId` | `origins`      |
| `ValueId`        | `values`       |
| `ComputationId`  | `computations` |
| `EffectRowId`    | `effect_rows`  |
| `GradeId`        | `grades`       |
| `ProofId`        | `proofs`       |

Every array length must fit the `u32` index domain. A proof stored at slot `i`
must declare `ProofId(i)`. Every reference must be in bounds. Source origins use
half-open UTF-16 code-unit offsets from the production source-span space and
require `start <= end`.

Imported and local definition keys share one namespace. Keys are unique. A
`GlobalDefinition` must name an import or local definition and carry the same
`SemanticKey`. Recursion crosses this named boundary. Direct cycles among value
and computation arena nodes are invalid.

A value definition carries its expected type as a `ValueId`. A computation
definition carries its result type and effect row. These declarations are closed
roots for scoping and reachability. Structural validation does not prove that a
value inhabits its expected type or that a computation has its declared result
and effects. The pure-fragment judgment in `QCORE_TYPING.md` discharges those
premises only for its admitted constructors.

Every arena entry must be reachable from a local definition root. Imports and
local definitions make their source origins reachable. A reachable node makes
its origin and referenced arena entries reachable. A `Proof` makes its proof
record reachable, and its proposition must equal the proposition in that record.
Rejecting unreachable entries gives every node a binding context and prevents
unchecked open fragments from hiding in a validated module.

## Closed structural certificate shadow

QCore version 3 can project the existing checked-module certificate without
rerunning inference. Each `FlatTypeNode` maps to one dedicated structural value:

| Existing node                      | QCore value                                  |
| ---------------------------------- | -------------------------------------------- |
| `Rigid`, `Forall`                  | `StructuralRigid`, `StructuralForall`        |
| `Range`, `Unit`                    | `StructuralRange`, `StructuralUnit`          |
| `Function`                         | `StructuralFunction`                         |
| `Record`, `RecordUpdate`           | `StructuralRecord`, `StructuralRecordUpdate` |
| `Array`, `Region`, `Scratch`       | matching structural container                |
| `Variant`                          | `StructuralVariant`                          |
| `Effects`, `OpenEffects`           | `StructuralEffects`, `StructuralOpenEffects` |
| `Union`, `Opaque`, `Top`, `Bottom` | matching structural value                    |

This is a representation embedding, not a typing translation. In particular,
`StructuralFunction` does not claim `DependentPi`, structural effect sets do not
claim QCore `EffectRow`, and a rigid effect tail is not assigned an effect-row
kind that the production certificate does not record. `Bottom` remains distinct
from an empty structural effect set. Opaque names and effect labels remain
uninterpreted strings.

Record fields, record-update fields, and variant cases are parallel label/type
arrays of equal length. Labels are strictly increasing by UTF-8 byte order, so
the representation is unique and duplicate-free. Structural effect labels obey
the same order. A raw checked-certificate projection preserves its union member
vector because QCore claims no semantic equality for unions. The production
sealed-boundary copier separately sorts union members by its canonical
structural key before serialization, so a shadow projection of that boundary
observes the canonical order specified by [`TYPECHECKING.md`](TYPECHECKING.md).

`StructuralForall` binds the exact nominal rigid identifiers in its `variables`
list. A structural rigid is valid only beneath a binder naming that identifier.
The same identifier cannot be rebound in its active scope. This scope is
separate from the de Bruijn scope of executable QCore terms.

Integer ranges carry arbitrary-precision bounds as canonical decimal strings.
Text ranges carry text bounds. A finite low bound must not exceed a finite high
bound. Float ranges have no finite scalar representation in the current
certificate and therefore require two unbounded endpoints. A bound whose scalar
kind disagrees with its range domain is invalid.

The checked-certificate projection requires its matching validated AST. Result
and effect roots use the result expression's real span; expression-type and
closure-signature roots use their referenced expression spans; a parameter root
uses the module span. Interned structural nodes use the real whole-module origin
because one node may be shared by uses at several spans. Every projected root is
a value definition whose declared type is the shared `Type 0` universe value. A
sealed boundary has no expression facts, so its caller must supply the real
module origin.

The projection calls the production certificate validator and then the QCore
structural validator. It is not called by checking, caching, Runtime-HIR
preparation, or release artifact emission. Failure is an artifact invariant, not
a source diagnostic. QCore does not yet define canonical serialization or a
content-derived semantic identity for this projection.

## De Bruijn scope

Local definition roots start at value depth zero. `BoundVariable(index)` is in
scope exactly when `index < depth`. These edges preserve or extend depth:

| Constructor edge                      | Child depth |
| ------------------------------------- | ----------- |
| `DependentPi.domain`                  | `depth`     |
| `DependentPi.codomain`                | `depth + 1` |
| `DependentSigma.first`                | `depth`     |
| `DependentSigma.second`               | `depth + 1` |
| `Lambda.body`                         | `depth + 1` |
| `LetValue.value`, `Bind.first`        | `depth`     |
| `LetValue.body`, `Bind.body`          | `depth + 1` |
| every other value or computation edge | `depth`     |

Shared nodes must be scoped at every depth from which they are reached. The
validator therefore memoizes a node together with its value depth. It detects
cycles by node identity without using depth, so a cycle cannot evade detection
by crossing a binder.

`EffectRow.Variable(index)` is in scope exactly when `index` is less than the
module's `effect_parameter_count`. QCore version 3 has no nested effect-row
binder.

## Canonical effect rows

An effect row is a finite chain ending in `Empty` or `Variable`. For

```text
Extend(effect, Extend(next, tail))
```

the UTF-8 byte sequence of `effect` must be strictly less than that of `next`.
Strict ordering removes duplicate labels and makes construction order
irrelevant. A shared tail is valid. A cyclic tail, an out-of-scope variable, or
an extension in non-increasing order is invalid.

The kernel does not assign meaning to a `SemanticKey` string. A later hashing or
serialization boundary must specify how those strings are produced.

## Interval grades

A grade denotes an interval of natural-number uses:

```text
[lower, finite upper]  when lower <= upper
[lower, infinity]
```

Invalid finite intervals never enter a `ValidatedQModule`.

The grade order is interval containment. Write `a <= b` when every count in `a`
is also in `b`:

```text
b.lower <= a.lower
a.upper <= b.upper
```

Finite bounds are below infinity. Addition and multiplication lift natural
addition and multiplication to interval endpoints:

```text
[a, b] + [c, d] = [a + c, b + d]
[a, b] * [c, d] = [a * c, b * d]
```

Infinity is absorbing for addition. It is absorbing for multiplication except
that zero times infinity is zero. Rust operations are partial refinements of
this mathematical algebra because the schema stores finite bounds as `u32`. They
reject an invalid operand or finite overflow instead of wrapping.

The Lean mirror states the extended-natural algebra separately from machine
overflow and proves reflexivity and transitivity of grade containment plus the
commutativity of interval addition and multiplication.

## Deliberate omissions

Structural validity proves no term has a type. The version-3 structural type
values are therefore deliberately outside any typing or conversion judgment. A
`ProofId` identifies evidence but does not make that evidence sound. Full QCore
still needs extensions to the pure typing and conversion shadow plus separate
definitions for proof checking, erasure, and translation adequacy. None may be
inferred from `ValidatedQModule` alone.

### Qualified structural certificates

Schema version 4 adds `StructuralQualified`: a body plus equally sized member
name, receiver-type, and member-type arrays. Receivers and members are checked
under the enclosing structural quantifiers. Repeated member names are valid when
they constrain different receivers. These obligations are retained in the
structural shadow certificate; they do not become proofs in the pure QCore
fragment, which rejects this node like other structural certificate forms.

Checked-module certificate schema 17 carries the corresponding qualified flat
type. Older certificates are rejected rather than read with erased obligations.
Unresolved qualifications cannot select a Runtime HIR representation.
