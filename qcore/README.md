# QCore representation schema

`schema.json` is the sole authority for QCore schema version 3 constructor
names, numeric tags, fields, and reference kinds. The schema describes a future
proof-oriented core representation. The schema itself does not define typing,
reduction, erasure, equality, serialization, or a translation from the current
compiler. [`spec/QCORE_TYPING.md`](../spec/QCORE_TYPING.md) separately defines
an executable typing and conversion shadow for a strict pure subset.

The schema keeps values and computations separate. `BoundVariable` carries a de
Bruijn index, while dependent `Pi` and `Sigma` nodes refer to value nodes; the
generator assigns no binder semantics. `TypeUniverse` carries a level, and
`Prop` is a distinct proposition universe. Neither the schema nor the current
pure kernel proves proof irrelevance or authorizes erasure. Function binders
refer to an effect row and an interval grade. A grade records only lower and
upper use bounds in this version.

Version 3 also carries the production checker's closed structural type algebra
without interpreting it as dependent QCore terms. Dedicated constructors retain
rigids and `forall`, scalar ranges, deferred arrows, labeled records and
variants, arrays, regions, scratch storage, closed and open effect sets, unions,
opaque names, and the lattice bounds. Integer bounds use canonical arbitrary-
precision decimal text. This shadow algebra is a migration artifact, not a
second inference language.

A raw `QModule` is the input to the structural artifact boundary;
`ValidatedQModule` is its successful output. `CheckedPureQModule` separately
marks the admitted pure fragment whose declared typing boundaries were checked.
The `QArena` arrays give every numeric reference its index space. Definitions
supply closed value or computation roots together with their declared type and
effects, while imports name external definitions without supplying a body. An
effect-row variable is a de Bruijn index into the module's declared effect
parameters. A field type ending in `[]` is an ordered list in the schema and
generates as `Vec`, a readonly TypeScript array, and Lean `List`. The Lean
target quotes every generated field binder, preserving schema names without
coupling generation to Lean's evolving keyword set.

`DefinitionKey` identifies a source definition. `SemanticKey` identifies a
canonical semantic artifact. They remain different generated types even when a
later implementation chooses the same physical digest representation.
`SourceOrigin` records a source identity and half-open offsets, and term nodes
carry a `SourceOriginId`. `ProofId` refers to evidence that a later verifier
must check. None of these references grants authority by existing.

Run `deno task generate:qcore` after changing the schema. The generator writes:

- `compiler/src/qcore_generated.rs`;
- `src/qcore_generated.ts`; and
- `formal/lean/Blot/QCoreGenerated.lean`.

Run `deno task check:qcore` to compare all three files byte-for-byte with the
schema and run the generator regressions. `compiler/src/qcore.rs` implements the
shadow structural validator, and `formal/lean/Blot/QCore.lean` mirrors its
scoping predicates and grade algebra. `compiler/src/qcore_typing.rs` implements
the bounded pure-fragment typing and conversion shadow, with a declarative Lean
mirror in `formal/lean/Blot/QCoreTyping.lean`.
[`spec/QCORE.md`](../spec/QCORE.md) and
[`spec/QCORE_TYPING.md`](../spec/QCORE_TYPING.md) own their exact claims. The
production checker, ownership analysis, Runtime HIR, and ABI do not consume
QCore.

Any change to a tag, field, reference representation, or interpretation must
increment `version`. Adding semantics requires a focused specification and a
checked translation boundary; this schema alone is not such a boundary.
