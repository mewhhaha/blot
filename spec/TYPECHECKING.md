# Type checking

This document specifies the mathematical model and implementation obligations of
Blot's type checker. [`LANGUAGE.md`](../LANGUAGE.md) remains the normative
language specification, and [`COMPILER.md`](COMPILER.md) places this judgment in
the whole compiler. This document defines the judgment implemented by the
Rust/Wasm semantic checker and the obligations for changing its internal
representation without changing the language.

The checker is split into three parts:

1. elaboration evaluates compile-time type values and assigns fresh inference
   variables;
2. biunification accumulates subtype bounds and propagates their consequences;
3. settling reads the resulting graph at a chosen polarity.

Ownership, linearity, exhaustiveness, and refinement facts are separate
analyses. They may consume inferred types, but they do not add constructors to
the type lattice.

Predicate-defined integer types do not change this algebra. As specified in
[`PREDICATE_REFINEMENTS.md`](PREDICATE_REFINEMENTS.md), compile-time evaluation
normalizes an accepted pure predicate to existing ranges and finite ground
unions before bridging. Biunification never receives a predicate constructor.

The coherent core is intentionally asymmetric:

```txt
open expression  --Simple-sub bounds--> principal structural type
closed type value --Boolean normalizer--> canonical finite set
```

Open inference remains the polynomial bound graph. Closed type values are
flattened, deduplicated by an alpha-aware structural fingerprint, sorted by that
same fingerprint, stripped of `bottom`, absorbed by `top`, and may use the exact
ground intersection/difference fragment. The resulting normal form is
independent of construction order, map insertion order, rigid-variable names,
and pretty-printer choices. This is compatible with the set interpretation and
with the normal forms developed by
[The Simple Essence of Boolean-Algebraic Subtyping](https://doi.org/10.1145/3776689),
without moving arbitrary negation or intersection into open inference.

Elaboration exposes one requirement judgment:

```txt
Gamma |- subject satisfies canonical(A)   iff Gamma |- subject <= A
Gamma |- subject satisfies predicate(p)   iff close(subject) and p(reify(subject)) = True
```

Both a signature header and `@satisfies` call this judgment. A header accepts
only `canonical(A)` because its following lambda may need bidirectional and
rank-N checking. Predicate requirements are observations of a closed result:
they may reject, but never grant an operation or add a solver node.

When a predicate guards a staged computed-field reconstruction and its subject
still contains an unresolved internal `bottom`, the checker records that the
enclosing closure requires specialization instead of evaluating the predicate
against that placeholder. The concrete application rechecks the closure with its
argument type and must discharge the predicate then. Computed-field presence is
an immutable closure-body fact available after loading a module capsule;
silently accepting a still-open predicate at residualization is an invariant
failure.

For `k r? x :: R` followed by `k r? x = e`, elaboration evaluates `R` at compile
time and requires `R` to bridge to `canonical(A)`, then checks `e` against `A`.
Any difference in `k`, the presence of `rec`, or `x` is a source diagnostic
before either declaration contributes a binding.

Each `_` expression identity inside `R` evaluates to its own temporary rigid
type value. Immediately after bridging, elaboration replaces exactly those
rigids with distinct fresh inference variables before checking `e`; quantified
rigids created by `@forall` are not replaced. The settled variable is recorded
as the expression-type fact for the hole's source span, so editor analysis reads
the same solution as the signature check instead of inferring the binding a
second time. Signature evaluation carries the same identity map when it later
attaches requirements to evaluator closures. The map is scoped to the source
module and expression identities of `R`, so `_` in any other value remains an
unbound name.

## 1. Type algebra

Let labels range over interned field, constructor, and effect names. Let scalar
bounds be inclusive and either unbounded or an integer/text value.

```txt
A, B ::=
    alpha                         inference variable
  | rho                           rigid variable
  | bottom | top
  | unit
  | range(domain, lower, upper)
  | A ->{E} B
  | { label_i : A_i }
  | update A with { label_i : A_i }   internal record relationship
  | Array A
  | < label_i : A_i >open
  | Effects { label_i }
  | A_1 | ... | A_n              finite ground union
  | Opaque identity
  | forall rho_1 ... rho_n. A
```

`forall` occurs in the Rust inference authority. A backend may erase it only
after the same left-instantiation and right-skolemisation checks have been
performed.

A type is **ground** when it contains no inference variable or `forall`. Source
union values bridge only to ground unions. At that boundary, nested unions are
flattened, duplicate members and `bottom` are removed, `top` absorbs, and zero
members becomes `bottom`. The same normalizer receives exact ground intersection
and difference results. Inference may compute joins containing variables
internally; those joins are not admissible as the right-hand disjunction rule
described below.

## 2. Declarative subtyping

Write `A <= B` when every value admitted by `A` is admitted by `B`. Reflexivity
and transitivity are implicit. The structural rules are:

```txt
bottom <= A                         A <= top

C <= A    B <= D    E <= F
------------------------------------------- function
(A ->{E} B) <= (C ->{F} D)

for every (l : B) in R, (l : A) in L and A <= B
------------------------------------------------ record
L <= R

A <= B
---------------- Array
Array A <= Array B

cases(L) subset cases(R), unless R is open
payload_L(l) <= payload_R(l), for each shared l
L is not open when R is closed
------------------------------------------------ variant
L <= R

labels(E) subset labels(F)
-------------------------- effects
E <= F

domain(A) = domain(B)
lower(B) <= lower(A) and upper(A) <= upper(B)
---------------------------------------------- range
A <= B

for every i, A_i <= B              some j, A <= B_j
---------------------- union-left  ------------------ union-right
(| A_i) <= B                       A <= (| B_j)
```

Record fields whose type admits `unit` may be omitted. This is a property of the
required field type, not a distinct optional-field constructor.

Functions are contravariant in their parameter and covariant in their effect row
and result. Arrays are immutable at the language level and therefore covariant.
Effects and variants use finite set inclusion.

## 3. Constraint state

The solver state is a finite directed bound graph

```txt
S = (V, level, lower, upper)
```

where each inference variable `alpha in V` has a creation level, a finite set of
lower bounds `L(alpha)`, and a finite set of upper bounds `U(alpha)`. An edge
`A in L(alpha)` means `A <= alpha`; an edge `B in U(alpha)` means `alpha <= B`.

The operational judgement

```txt
S |- A <= B => S'
```

either succeeds with an extended state `S'` or reports a diagnostic. A
successful transition never removes a bound. Duplicate edges are ignored.

Adding `A` to `L(alpha)` immediately emits `A <= B` for every existing
`B in U(alpha)`. Adding `B` to `U(alpha)` symmetrically emits `A <= B` for every
existing `A in L(alpha)`. Variable-to-variable edges propagate the same closure
without recursively expanding an already visited ordered pair.

### Levels and extrusion

If a constraint would connect a shallower variable to a type containing deeper
variables, the deeper part is copied down before recording the edge. Polarity is
reversed only through function parameters. The original and copy are linked in
the direction that preserves the requested subtype constraint.

This is Simple-sub's level discipline. It prevents a local variable from
escaping its scope while avoiding a free-variable scan during generalisation. A
`let` use freshens every variable created below the binding's saved level;
different uses receive different copies.

### Rank-N boundaries

On the left, `forall rho. A <= B` instantiates each bound rigid variable with a
fresh inference variable. On the right, `A <= forall rho. B` replaces each bound
rigid variable with a fresh rigid identity. This is predicative: an inference
variable is never solved with a polymorphic type.

Equality of quantified types is alpha-equivalence under a scoped bijection of
their bound rigid identities. A bound rigid never compares equal to a free rigid
merely because their integer representations coincide.

## 4. Choice and transactions

Right-hand ground unions introduce choice once the left side is structural. An
inference variable first records the complete union as an upper bound; its known
lower bounds are then checked against that union. This distinction is necessary
because `alpha <= (A | B)` does not imply either `alpha <= A` or `alpha <= B`
while `alpha` is still unknown. For a structural left side, each candidate is
checked from the same input state:

```txt
S |- A <= B_1 => failure   ...   S |- A <= B_k => S'
-----------------------------------------------------
S |- A <= (B_1 | ... | B_n) => S'
```

Failed candidates must be observationally atomic: they leave `V`, all bound
sets, extrusion links, and fresh-identity counters exactly as they were at the
candidate's entry. The first successful candidate commits. A left-hand union is
conjunction and does not introduce choice.

The implementation uses an undo journal and a variable-arena checkpoint. It must
not clone the whole solver graph for a candidate. This is both a semantic
requirement and the first performance invariant.

## 5. Required lemmas

These are proof obligations for the implementation. A proof sketch records why
the representation is allowed; executable tests cover the finite cases most
likely to regress it.

### Lemma 1: monotonicity

If `S |- A <= B => S'`, then every variable and edge in `S` is present in `S'`.

_Sketch._ Structural rules only recurse. Variable rules append an edge when it
is absent and propagate consequences. Extrusion allocates variables and edges;
it does not rewrite an existing type. Choice commits one successful monotone
transition.

### Lemma 2: propagation closure

After success, for every `A in L(alpha)` and `B in U(alpha)`, the solver has
successfully established `A <= B`.

_Sketch._ Whichever edge is inserted second emits the cross-product constraint.
The ordered-pair visited set cuts recursive graph traversal, not a previously
unestablished structural obligation.

### Lemma 3: failed-choice rollback

If a union candidate fails from `S`, the next candidate starts from a state
observationally equal to `S`.

_Sketch._ A checkpoint records the variable-arena length, journal length, and
fresh-identity counters. Rollback reverses journal entries in reverse order,
truncates fresh variables, and restores the counters. Every mutation reachable
from constraint solving must pass through a journalled operation.

### Lemma 4: extrusion preserves the requested relation

Copying a deeper type to level `k` at polarity `p`, and installing the directed
links specified above, yields a type usable at `k` without identifying distinct
generalised uses.

_Sketch._ Induct on the type structure. Function parameters flip polarity; all
other structural positions retain it. Variable copies are memoised within one
extrusion, preserving recursive sharing. Freshening a scheme deliberately does
not install these links, so separate instantiations remain independent.

### Lemma 5: termination

For a finite elaborated program, constraint propagation terminates.

_Sketch._ Structural descent is finite. Each variable-bound edge is inserted at
most once, and each ordered variable pair is expanded at most once per root
constraint. Extrusion memoises source variables. Ground union choice is finite.
The implementation must compare interned identities rather than repeatedly walk
trees for this measure to be reflected in runtime cost.

A visited ordered pair may close a cycle in the inference graph. This supports
recursive functions and recursive flows; it does not introduce a first-class
equi-recursive source type. Recursive type values remain outside this algebra.

### Lemma 6: persistent environments preserve lexical lookup

Let an environment be an ordered chain of finite maps
`Gamma = Delta_n :: ... :: Delta_0`, with lookup choosing the first map that
contains a name. Replacing a copied aggregate map with an immutable parent and a
copy-on-write child overlay preserves every lookup provided a write enters only
the current overlay.

_Sketch._ Induct on the chain. A name in the new overlay shadows the same name a
copied map would replace. A name absent from the overlay is read from the
unchanged parent. Both representations retain the same inference-variable
identities into the one solver graph; structural sharing changes only how the
name-to-type mapping is stored and introduces no new typing effect.

### Lemma 7: an open frame is equivalent to eager member insertion

Let `open(F, mu)` contain immutable compile-time members `F` and an injective
target-to-source mapping `mu`. For a record these are its fields. For an effect
they are operation values pairing each declared operation name with the same
generative effect atom. Assume every target in `mu` is absent from the preceding
lexical environment. Define lookup through the frame by:

```txt
lookup(open(F, mu) :: Gamma, x) = F[mu(x)]  when x in dom(mu)
lookup(open(F, mu) :: Gamma, x) = lookup(Gamma, x) otherwise
```

This equals lookup after eagerly inserting every `x -> F[mu(x)]` into a copied
map. Explicit bindings in a later overlay still shadow the frame, and rejecting
non-injective or colliding `mu` preserves the eager representation's
diagnostics.

_Sketch._ Case on membership of `x` in `dom(mu)`. Membership selects the same
source field in both representations. Absence leaves the preceding environment
unchanged. Immutability of `F` makes sharing unobservable, while the collision
premise prevents insertion order from choosing a different binding.

### Theorem obligation: principal inferred types

For the rank-1 fragment after compile-time elaboration, settling the completed
bound graph yields a principal type up to alpha-renaming and the lattice's
join/meet normalisation.

This follows the Simple-sub construction, provided Lemmas 1--5 hold and settling
is polarity-correct. Rank-N subsumption, ground union choice, omitted record
fields, and compile-time type evaluation are extensions and require their own
preservation tests. This document does not claim a mechanised proof.

## 6. Flat implementation model

Recursive owned type trees are a reference representation, not the target
layout. The production Rust checker should use append-only arenas and integer
identities:

```txt
TypeId  = u32
VarId   = u32
LabelId = u32
SetId   = u32

TypeNode = fixed tag + fixed-width payload indices
Field   = (LabelId, TypeId)
Bound   = (VarId, TypeId, lower_or_upper)
Work    = (TypeId, TypeId)
```

Variable records store ranges or small vectors of bound edge indices. Records,
variants, effects, and unions store sorted interned labels/members in separate
flat arenas. Hash-consing immutable nodes makes equality an integer comparison
and makes the visited relation a packed pair of `TypeId`s.

The hot solver is an explicit worklist. It pops one `(left, right)` pair,
dispatches on two tags, and appends zero or more pairs. It does not recursively
clone types. Diagnostics retain source spans only at root obligations; hot edges
carry a compact diagnostic origin index.

### SIMD boundary

SIMD is useful for finite, canonical sets, not for graph control flow. Sorted
`LabelId` and `TypeId` runs allow vectorised equality, subset, and intersection
checks. A small-set inline representation should be measured before adding
wide-vector code. The solver must first become flat enough that scalar scans are
contiguous; SIMD over pointer-rich trees is not a meaningful target.

## 6.1 Auxiliary judgements and certificates

The value type is deliberately not the home of every fact the compiler knows.
Elaboration also produces four finite, erasable contexts:

```txt
K : ExpressionId -> Value                 compile-time values
Phi ::= t = u | t < u | t <= u            relational propositions
R : ValueId -> Relation                   value identities and array lengths
Omega : BindingId -> OwnershipTree        live and moved ownership paths
```

The complete checking judgement is

```txt
Gamma ; K ; Phi ; R ; Omega |- e : A ! E ; C
```

where `C` is a finite set of certificates consumed by lowering. None of `K`,
`Phi`, `R`, `Omega`, or `C` participates in subtype propagation. This separation
is the condition under which the additions below preserve the principal-type
theorem: erasing the auxiliary contexts yields the same `Gamma |- e : A ! E`
judgement as before.

Certificates are not source values. They are keyed by the saturated AST node
whose lowering spends them, contain the identities of every premise, and are
rechecked by Core construction. A certificate copied to a different expression
or used after an identity-changing rebinding is invalid.

`Phi` also consumes verified function summaries without extending the value type
lattice. The canonical summary language is:

```txt
measure ::= array-length | region-length
summary(f) = result = measure(parameter_i) + k
```

where `i` selects any curried parameter and `k` is a compile-time integer. A
summary is derived from the closure value by structurally checking its body
against `@array.len` or `@region.length`, transparent linearity wrappers, affine
literal shifts, or another already derived summary. The closure environment
resolves callees; source spelling never does. At application, the selected
argument's immutable value identity replaces `parameter_i` and the resulting
term enters `Phi`. The serialized fingerprint includes a schema version,
measure, parameter index, and offset. Cycles and bodies outside this fragment
derive no fact.

A runtime name bound to one of these terms receives an affine equality between
its binding identity and the retained term. When that name is compared with a
compile-time integer, it is the comparison subject even though the same name can
also serve as a stable witness elsewhere. Branch constraints attach to the
binding identity, and shortest-path entailment transports them through the
equality to the measured array or region length. Thus the untaken branch of
`length < 2`, after `let length = @array.len xs`, proves literal index zero
below `length(xs)`. Two retained non-literal terms remain witnesses with no
subject and are not compared by this decidable fragment.

The relationship context is explicitly bounded to 512 immutable terms and 2,048
directed difference edges per module. Exceeding either budget stops fact
derivation and produces `BLOT_REFINEMENT_BUDGET` if a direct operation later
requires the truncated proof graph. The checker never substitutes an approximate
positive result.

Typestate and effects compose without another type constructor. A state machine
is represented by ordinary closed variants in `Gamma`; a transition has an
ordinary effectful arrow; and a linear state value is tracked and consumed in
`Omega`. An effect handler discharges the named row while returning the
transition's refined variant. Erasing `Phi` and `Omega` therefore leaves the
same structural/effect type, while erasing the handler would still expose the
effect. This is the required separation between value set, behavior, and use.

When `:=` removes the last visible name for an old identity, the refinement
graph projects that identity out by shortest-path closure before deleting its
incident edges. The projected graph preserves every entailed difference bound
between remaining identities. Merely dropping incident facts is not sound: a
dead identity may be the intermediate node proving a relation between two live
ones.

### Compile-time immediates

Write `K(e) = n` when evaluation of `e` in the compile-time environment
terminates at the integer `n`. A target immediate is admitted by:

```txt
Gamma |- e : L..H       K(e) = n       L <= n <= H
-------------------------------------------------- immediate
Gamma ; K |- immediate(e, L, H) => Immediate(e, n)
```

The type premise proves range correctness and the `K` premise proves staging.
Neither implies the other. In particular, a runtime value of singleton type is
not a target immediate unless its expression is also in `K`. SIMD lane and
shuffle operations consume `Immediate` certificates; lowering never re-evaluates
or guesses the selector.

### Staged function families across modules

An ordinary arrow cannot state that a function's result changes structurally
with a compile-time argument. Blot does not add dependent arrows to the runtime
lattice. Instead, compile-time application synthesizes from the value that
evaluation selected.

Let `M(v)` be the defining module carried by a closure value, `Gamma_m` the
settled environment of that module in the current compilation, and `Delta(v)`
the concrete lexical scopes captured between the closure and its module body.
Write `VType_m(v) = A` for value-directed synthesis:

```txt
bridge(v) = A
-------------------------- value-bridge
VType_m(v) = A

VType_m(v_i) = A_i for every field i
------------------------------------------------ value-record
VType_m({ l_i = v_i }) = { l_i = A_i }

Gamma_m, bridge(Delta(v)) |- lambda(v) : A
------------------------------------------------ value-closure
VType_m(v) = A
```

Captured closures use the same rule recursively. Failure to synthesize one
capture makes this path unavailable; it does not invent a variable that could
satisfy any later signature.

The application rule is:

```txt
K(f) = closure_m      K(a) = w      closure_m(w) evaluates to v
VType_m(v) = A
---------------------------------------------------------------- staged-apply
Gamma ; K |- f a : A
```

The staged result replaces the ordinary application result only when that result
has multiple structural or function lower alternatives, or contains unevidenced
structural inspection. The ordinary arrow is still constrained at the call, so
parameter, effect, and representation flow reaches the defining module. This
side condition prevents partial evaluation from changing the principal type of
an already precise ordinary call merely because its arguments happen to be
constants.

When a callable belongs to an ordinary compile-time record and one premise is
unavailable, checking falls back to the record's settled arrow. An attached
namespace has no such runtime field type, so the checker returns a fresh
inference variable carrying staged-availability evidence. That evidence lives
outside the subtype lattice and prevents the variable from authorizing runtime
work or proving a signature. It is deliberately not `top`: lack of compile-time
evidence is not the set of all inhabitants. Fresh inference variables are
allocated for every `VType` derivation, so two call sites never share an
instantiation merely because they selected the same source lambda.

While deriving `VType` for a selected closure, a structural projection whose
label is not yet a value introduces a staged projection obligation rather than
an ordinary dynamic lookup. Its result may participate in the local inference
graph, but the obligation is not part of the inferred runtime arrow and cannot
cross the `ClosedProgram` boundary. Structural-fold residualization must replace
it with projections at static labels; otherwise closing fails. Outside a `VType`
derivation the same unknown label is rejected immediately. Thus generic
structural source can be checked before unrolling without admitting a runtime
operation over heterogeneous record keys.

`M(v)` is invariant under aliasing and return through another module. This
yields the coherence property

```txt
VType_m(f a) = VType_m((alias_through_module f) a)
```

for the same evaluated argument. The per-compilation origin table may refer to
the live module graph only while that module itself is being checked. Once the
module body is complete, imported specialization uses a capsule

```txt
C_m = <m, code_m, rho_m, Sigma_m, imports_m, deps_m>
```

where `m` is the module revision identity, `code_m` and `rho_m` are its source
closures and compile-time value environment, `Sigma_m` is a closed snapshot of
the module's lexical schemes, and `deps_m` identifies the complete import and
include closure. A capsule is valid when

```txt
free(code_m) subseteq dom(rho_m) union dom(Sigma_m)
Sigma_m(x) = forall alpha. A       free(A) subseteq alpha
rho_m contains only deterministic compile-time values
fingerprint(deps_m) = fingerprint(dependencies on disk)
```

The module input is deliberately absent from `Sigma_m`. It is not a property of
the source module: every import occurrence supplies another value. The input
environment is therefore the outermost member of `Delta(v)` and is bridged at
the importing expression. This gives the instantiation law

```txt
VType(C_m[r_1] a) and VType(C_m[r_2] a)
```

independent fresh derivations even when both use the same cached `C_m`.

The second premise is the parallel boundary: a ground type may cross directly,
and every inference variable that crosses must be quantified by its scheme.
Mutable bound arrays, pending constraints, and fact sinks are not interface
members. At an importing call, every scheme is instantiated freshly and facts
derived while checking the selected closure belong to the importing compilation.

An evaluated closure retains the residual quantified signature established at
its own declaration. Attaching a settled signature to an enclosing record,
array, constructor, or module result may fill an unsigned closure or refine a
quantifier local to its output, but must not remove a quantifier relating the
closure's input to its output. The enclosing view can be less precise because it
settles the same variable once in each polarity; it is not evidence against that
principal input-output relationship. When a statically known callee evaluates to
a closure with a closed attached signature whose returned data contains a
callable, an application instantiates that signature directly. An ordinary
curried result is not returned data for this rule. This preserves the closure's
own quantified relationships after it has passed through an enclosing value and
hands the next higher-order specialization its exact input. It does not make
arbitrary closure-bearing records exact at their declarations or exported module
boundaries.

Closed residual signatures reify `Slice.of T` as the compiler-private
`@region.type T` type value. This preserves the signature of a local recursive
closure whose argument or result carries Region authority. It does not reify a
live Region value, expose Store identity or bounds, or admit Region at a public
ABI boundary.

An unsettled top or bottom position in a residual signature reifies as a fresh
representation hole, never as runtime `Unit`. The call site's checked expression
type, a structural ownership result, or the private recursive-representation
rule must close that hole before ordinary first-order use.

The synthetic recursive closure emitted for `for` has the representation
signature of its type-preserving `:=` accumulator. A `RecordUpdate` relationship
retained by source inference is therefore projected to its base representation
inside that synthetic signature: the back edge has already proved that the
updated value has the accumulator's stable type. The closed signature is
available through the same module-and-body resolver used for installed
certificate signatures and is memoized on first demand. Runtime lowering does
not reconstruct it, and a missing `Arrow` after successful checking is an
invariant failure.

A shape whose first member is an open spread receives
`update A with { label_i : B_i }`, where `A` is the spread operand and the
listed fields are the later statically named or computed-at-compile-time
members. Settling against a concrete record applies the replacements in source
order. A second open spread is refused because it would require concatenating
two unknown field sets. The relationship is an inference fact only; Runtime HIR
receives the settled nominal record.

If an ordinary statically known application still settles to top or bottom, the
checker infers the selected nonrecursive closure once against the actual
argument type. This recovers evidence from the closure body while an explicit
signature remains the way to widen a known singleton into a stable public
contract. Effects found while checking the body join the application's ordinary
inferred row.

Write `encode(C_m)` for an immutable capsule snapshot and `decode` for loading
one with fresh inference identities. Level-4 coherence is

```txt
VType_m(eval(C_m, w)) =_alpha
VType_m(eval(decode(encode(C_m)), w))
```

provided the dependency fingerprint still matches. The proof is structural on
the serialized value graph. Scalar values and closed types are immediate;
records and arrays use the induction hypothesis per member; closures use lexical
closure plus alpha-renaming of their quantified schemes. A stale dependency or a
free mutable variable makes the capsule invalid rather than widening its answer.

The module-snapshot representation assigns identities to lexical environments,
serializes their parent and value edges once, and reconstructs all environment
shells before filling those edges. A module-local closure stores a local marker
rather than the producer's path, so installation restores the consumer's module
identity. Closure signatures come from the separately validated checked-module
certificate rather than being duplicated on every closure value. Mutable runtime
Stores, continuations, residual values, and generative effects cannot enter this
capsule.

The cache key is the loader's module-revision identity together with every
generative declaration identity observed in the closed type graph. Today the
latter are effect labels. A source, include, or transitive dependency edit
replaces the loader identity; reevaluating a generative declaration replaces its
declaration identity. Either change misses the cache. This conservative rule is
equivalent to stable serialized declaration IDs, while permitting the in-process
evaluator to retain fresh numeric brands.

For a resident nullary module with an empty checked effect row, the evaluator
may return its retained compile-time result directly only when the closed result
type contains no ordinary or host effect identity and the actual value is
recursively independent of its producing module instance. A higher-order closure
can expose its creation scope by invoking a supplied effect constructor even
when its own module is effect-free, so closure-bearing results are evaluated
under each importing occurrence. The same applies to exposed effects,
operations, deferred environments, function choices, Regions, continuations,
residual runtime values, and non-empty nested effect rows.

A validated snapshot environment may be instantiated as a revision-keyed
template for each import. Decoding prefixes every recorded module-instance and
creation scope with the importing occurrence before evaluating the module's
result expression. This preserves the no-sharing judgment while avoiding a
second evaluation of declarations whose values the capsule already records.

Sharing that resident result does not by itself make its reverse-invalidation
fingerprint structural. Scalars, closed types, and recursively complete
immutable aggregates compare by value. A missing result or one containing a
closure, deferred environment, function choice, Region Store/root, rejoin
witness, or residual runtime value is bound to the exact loader revision. An
edit therefore cannot preserve an importer through equality of only the
printable or source-naming parts of such a value.

The in-process representation may retain AST and compile-time value identities
instead of encoding bytes. It must nevertheless enforce the same boundary by
copying and freezing the closed type graph, dropping the foreign live context,
and reconstructing a specialization context from the capsule at every call. This
is the executable precursor of a persistent package artifact: persistence
changes representation, not the judgment.

### Structural fold residualization

Residualization uses two value classes: static `v` and dynamic code `~e`. For a
known field-name vector `L = [l_0, ..., l_(n-1)]`, partial evaluation obeys

```txt
PE(fold([], s, k)) = PE(s)
PE(fold(l :: ls, s, k)) = PE(fold(ls, k(s, l), k))
PE(shape.get(~r, l)) = ~(project_l r)       when l is static
PE({ ...~r; .[l] = ~v }) = ~(update_l r v)  when l is static
```

The recursive binding remains available to the partial evaluator, but each
recursive choice is discharged by a static array index. Dynamic accumulator
values are residual operands and do not prevent the next static iteration.
Termination follows from the finite array and the ordinary compile-time fuel
bound.

**Direct-projection lemma.** If every iterator name is static, residualization
of the fold contains only projections whose labels occur in `L`; it contains no
dynamic shape primitive.

**Phase-preservation lemma.** Replacing the fold by those ordered projections
and residual scalar operations preserves the evaluator result for every runtime
record admitting all labels in `L`. The proof is induction on `L`, using the
source semantics of `fold` for the inductive step.

These lemmas justify structural derivation generally. Component packing is one
application; no component or ECS construct appears in the judgment.

### Checked and wrapping integer lanes

For `w > 0`, define

```txt
Signed(w)   = -2^(w-1) .. 2^(w-1)-1
Unsigned(w) = 0 .. 2^w-1
wrap_w(n)   = the signed representative of n modulo 2^w
```

A checked signed lane constructor has domain `Signed(w)`. It is therefore an
ordinary subtype obligation and cannot change the value:

```txt
Gamma |- e : A       A <= Signed(w)
------------------------------------ checked-lane
Gamma |- lane_w(e) : LaneVector(w)
```

The explicitly wrapping constructor has domain `Int` and semantics `wrap_w`.
Keeping the two names distinct prevents a successful constraint from silently
changing a number. Arithmetic on lane vectors remains wrapping because that is
the algebra of the vector type itself.

### Relational array indices

Each array-producing expression receives a stable `ValueId`. Aliasing preserves
the identity; construction, rebinding, and an unknown function result mint a new
one. `len(a)` is a symbolic term, not a type constructor. Direct access is
admitted when closure of `Phi` establishes

```txt
0 <= i  and  i < len(a).
```

`Iter.indexed a` produces an erased package

```txt
IndexWitness(a, i) = { 0 <= i, i < len(a) }
```

for the yielded index. A transparent alias substitutes the same `ValueId`; a
rebind does not. Function specialization may carry a witness into a callee only
when the specialized parameter is identified with the witnessed array and the
index parameter with its index. The resulting `ArrayIndexProof` records both
identities and the derivation rules used.

**Array preservation lemma.** If an `ArrayIndexProof(a, i)` verifies and neither
`a` nor `i` is rebound along the path to its access, then evaluating the access
cannot observe an out-of-bounds index.

_Sketch._ Verification reconstructs `0 <= i < len(a)` from literals,
comparisons, aliases, or an indexed-iterator witness. Immutable arrays preserve
their length. Identity-changing operations cannot satisfy the certificate's
premises.

### Field-sensitive ownership

For a value with structural paths `p`, an ownership tree maps every path to

```txt
Live | Moved | Partial(children)
```

Moving `x.p` changes that leaf to `Moved` and every ancestor to `Partial`.
Reading or moving the whole `x` requires its root to be `Live`; accessing a
sibling `x.q` requires only that `q` remain `Live`. Moving the final live child
collapses the root to `Moved`.

Branch join is defined pointwise. A reusable path joins by intersection of what
remains live. A linear path must have the same terminal consumption on every
continuing branch; otherwise checking reports the existing branch-disagreement
diagnostic at the smallest disagreeing path. Borrowing a path never changes the
tree, but the borrow retains that exact path and cannot be used to recover its
parent.

The prefix markers `!e`, `?e`, and `&e` do not change `e`'s value type. They
request, respectively, an exact move, an at-most-once move, or a borrow in
`Omega`. An application admits `?e` only when `e` carries an affine obligation
and the selected parameter summary promises at-most-once use. The marker cannot
manufacture uniqueness for a shared value, and its runtime identity is erased
after ownership-directed lowering has consumed the permission.

An effect operation descriptor is checked at compile time as an exact
`.signature`, `.input`, `.result` record. Its normalized ownership leaves are
unrestricted, affine, or linear; structural summaries must match every field of
a closed record/tuple or every case of a closed variant. Direct arrow operations
normalize to unrestricted roots. The result is attached to the generative effect
value and later consumed by `Omega`; it contributes no type bound, subtype edge,
or effect-row label. Borrow is deliberately absent because a lexical borrow
cannot survive a suspended request.

**No-double-move lemma.** If `Omega` admits a move of path `p`, no prefix or
descendant of `p` has previously been moved on that control-flow path.

_Sketch._ A move requires `Live(p)`. Every earlier move of a prefix makes `p`
unreachable below `Moved`; every earlier move of a descendant makes a prefix of
`p` `Partial`. Both fail the premise.

### Conservativity obligation

For a program containing no immediate-consuming primitive, checked lane
constructor, direct array access, ownership qualifier, or open effect-row
signature, the auxiliary judgements emit no certificate and inference must
return exactly the same principal type and diagnostics as the base system. Each
implementation slice below must include an erasure test for this property.

### Theory/implementation bounce: auxiliary certificates

The first implementation bounce maps each judgement above to one existing
authority rather than duplicating it:

- `K` is the checker's `comptimeValues` certificate map. `@i32x4.lane` records
  its selector there only after `immediate`; both Runtime-HIR paths consume that
  recorded integer. A runtime singleton is rejected before lowering.
- Checked SIMD construction is an ordinary range constraint over `I32`, `I16`,
  or `I8`. The separately named wrapping primitives retain the modulo evaluator
  and lowering rule. Thus no successful subtype constraint changes a value.
- Array `ValueId`s now include immutable projection identities derived from the
  parent identity and field name. Indexed-iterator packages, pattern bindings,
  direct aliases, and projected aliases all converge on `ArrayIndexProof`, which
  Core independently replays.
- The ownership pass stores the live structural remainder of a binding. A field
  move replaces exactly one leaf by `none`, blocks whole-value reuse while the
  root is partial, and snapshots that remainder at branches and speculative
  ownership transactions. Ownership leaves also retain their source binding and
  path. Checked-module certificate schema 10 retains that schema-9 lineage and
  independently requires both `take` outputs or all three `split` outputs at one
  extraction identity.
- A region ownership value is `Region(authority, elements)`: the first component
  is the opaque interval permission and the second is a hidden positional
  ownership tree transferred from the consumed input array. Region split and
  replacement add extraction identities to that tree; join and freeze restore
  it. `get` and discarding `set` require an unrestricted element tree, while
  consuming `replace` returns the displaced tree position on success and both
  inputs on failure. This analysis representation is absent from simple types.
- Rejoin witnesses form binary proof trees. `reassociate_left` accepts witnesses
  for `A * BC -> ABC` and `B * C -> BC`; `reassociate_right` is its inverse. The
  checker mints the rotated witnesses only after exact parent-child identity
  succeeds, and certificate replay validates the same relation.
- A written effect-row tail elaborates to one signature-local row variable. The
  same `..e` identity is reused at each occurrence in that signature header, and
  lowering refuses a tail with fewer than two occurrences before ordinary
  inference. Open effect rows are erased before Runtime HIR and do not alter
  record subtyping.

The second theory bounce tightens one implementation consequence. An array
projection identity includes its parent identity, so rebinding a record
invalidates every projected relationship without an explicit invalidation pass.

The third bounce tests erasure and authority agreement. Ordinary function calls
retain record width subtyping; effect-row tails affect only the effect-set
component of arrows. The integer SIMD catalog runs through the comptime
evaluator, scalar conformance lowering, native Runtime HIR, production compiler,
and emitted `wasm-simd128`; the certified selector becomes `i32x4.extract_lane`.
The checker, Runtime-HIR, evaluator, and emitted-Wasm corpora report no
cross-phase disagreements, and the full language corpus preserves
three-execution agreement.

### Parallel boundary

One connected inference-variable graph is intentionally sequential because each
new edge may enable another. Independent module interfaces and independent
strongly connected declaration groups can be checked in parallel after their
imports are available. Published module interfaces must contain settled,
immutable types and a content/dependency fingerprint; mutable inference
variables never cross a cache or worker boundary.

### Evaluation reuse

Checking a declaration already evaluates every `const` and attempts every pure
runtime binding because types are values and compile-time reflection depends on
those results. For a nullary module, let `rho_c` be the resulting value
environment and write `complete(rho_c)` when every binding needed by the module
result evaluated successfully. Then:

```txt
parameter(m) = unit       complete(rho_c)
------------------------------------------------ checked-environment
eval_module(m, unit) = eval(result(m), rho_c)
```

The equality is by induction over the declaration sequence: each successful
binding extends the same lexical environment with the same value, and `open`
copies the same ordered fields. A failed speculative runtime evaluation makes
`complete(rho_c)` false. Parameterised modules also fail the premise because
their value environment does not contain the caller's argument. In either case
Runtime-HIR preparation runs the ordinary whole-module evaluator. Thus the
optimisation cannot discard a trap, divergence, host request, or argument
dependency that checking did not observe.

### Resident interface cache

The resident Rust compiler transports a cached interface through an append-only
flat arena:

```txt
FlatTypeId = u32
FlatNode   = tag + child FlatTypeId values
Interface = <arena, result, effects, parameter, evaluated-value-certificate,
             expression-types, closure-signatures, ownership-contracts>
```

Encoding rejects every inference variable and every rigid not bound by an
enclosing `forall`. Decoding allocates a fresh rigid identity for every
quantifier and reconstructs an ordinary checker type. Consequently no mutable
bound edge crosses compilations, and two cache hits are alpha-equivalent but
share no generated rigid identity.

Encoding structurally interns equal flat nodes across module results, runtime
application types, and closure signatures. Compile-time-only imports retain
their type for request-local analysis but do not enter the Runtime-HIR
application certificate. The certificate therefore pays once for repeated type
structure; interning changes neither identity scope nor the decoded type graph.

A resident checker may retain the expanded `CheckedModule` after that encoding
gate succeeds. Its types contain no mutable inference variables, its quantified
rigids are immutable, and the resident skolem allocator is monotonic, so a later
derivation cannot reuse one of their identities. Results that cannot be encoded,
including failed checks, are removed before the next request. This avoids
decoding unchanged dependency interfaces while preserving the same closed-type
premise as the flat cache.

The in-memory cache key is the resident module path under the session's current
source graph. Replacing a source module or changing its resolved imports or
included contents first invalidates only that module's private facts. A
successful recheck closes and alpha-canonicalizes the public parameter, result,
and effect types into a versioned binary boundary, then appends the canonical
compile-time result and the fixed-size session identities of ordered
direct-dependency boundaries. The producing module compares its complete
canonical bytes; equal bytes retain its identity and importer interfaces, while
different bytes receive a fresh identity and dirty direct importers. Repeating
this rule is equivalent to the dependency fingerprint required by capsule
coherence above while allowing propagation to stop at an observationally equal
boundary.

Ownership and safety results are cached at the same revision boundary only for
nullary modules. Ownership is a function of the AST. Safety additionally reads
the checked value environment; the nullary restriction and reverse-dependency
invalidation ensure that environment denotes the same module instance.
Parameterised analyses remain per-check because their values may depend on the
caller's argument.

The source text and the semantic revision are distinct. Write `lower(s) = m` for
Baba tokenisation, island parsing, compact-CST materialisation, and Blot
lowering together. When an edit satisfies `lower(s') = lower(s)`, equality here
includes every AST node and source span. Inference, compile-time evaluation,
ownership, safety, and Runtime-HIR preparation observe only that module, its
resolved inputs, and the invalidation-stable context. Therefore:

```txt
lower(s') = lower(s)    inputs(s') = inputs(s)
------------------------------------------------ semantic-source-reuse
compile(s') = compile(s)
```

Keeping the previous certificates and artifact is memoisation of the same
judgement, not a weakening of it. A whitespace edit that moves a reported span
does not satisfy the premise and is conservatively rechecked.

Incremental lexing retains a token prefix only before the earliest token whose
lexical decision examined the edited position. The lexer records that dependency
end separately from the accepted token end, because maximal munch can inspect a
code point that is not consumed. It relexes the remainder to end of file and
runs island parsing over the complete resulting stream. Every retained token
depends only on an unchanged source prefix, and every other token is freshly
derived, so the result is identical to fresh lexing. Executable tests compare
the complete token, node, and edge arrays for replacement, append, and
token-merging edits.

Runtime HIR is cached under the same semantic revision. Its preparation is a
deterministic function of the checked module and invalidation-stable context;
the Wasm artifact is a deterministic function of that HIR and ABI policy. A
reverse-import invalidation removes both caches. Thus a cache hit cannot retain
code produced from a stale dependency, and `prepare` followed by `compile`
shares work without introducing a second authority.

The checked artifact also publishes typed Core. Every Core expression carries
one stable `CoreNodeId` and one `TyRepId` into an interned structural type
graph. After safety and ownership replay, the checker may attach a settled HIR
builder state to that node when its effect row, representation, permission, and
proof markers are closed. Structural folds and finite closure choices that still
need specialization remain explicitly pending. Consumers compare these
identities; they do not format recursive types and compare the resulting text.

For an invariant recursive accumulator constructor such as `Array`, the
recursive call and the initializing value constrain the same element variable.
An empty initializer contributes no inhabitant and therefore cannot remain as an
independent positive array alternative once a recursive step contributes an
element type:

```txt
empty : Array a    step : (Array a, b) -> Array a    b <= a
----------------------------------------------------------- recursive-array
loop(empty, step) : Array a
```

This closes the element type without asserting that an iteration is non-empty.
It is a recursive-knot rule over an invariant constructor, not a special rule
for `collect` and not a lattice-wide widening.

Checked-module certificates also carry the closure bodies belonging to recursive
components. The checker builds the free-name graph for each prebound `rec` group
and finds its strongly connected components with forward and reverse graph
traversals. A singleton is recursive only when it has a self-edge. The
serialized body set must be duplicate-free and a subset of the certificate's
closure signatures. Runtime lowering may allocate a private recursive
representation only for a body in that set.

The certificate carries the closed checked result type of each application,
keyed by its module-local expression identity. Installation rejects duplicate or
absent identities. Runtime lowering consumes that type as a representation
expectation, so a recursive function can choose its first-order result layout
before its body evaluates another recursive call. This is the compact
certificate counterpart of the compiler's full typed-Core expression map, not a
backend reconstruction of source constraints.

Residual aggregate construction consumes the checked type attached to the source
expression or application argument that introduced the current view. Immutable
aliases and field projections preserve that checked expectation. An aggregate
memo may reuse only one unambiguous closed representation; conflicting views
erase the memoized answer instead of selecting one by observation order. A
polymorphic recursive call specializes from its checked argument type rather
than the first runtime inhabitant observed in that value.

The certificate also carries each source closure's ownership contract, keyed by
the same `(module, body-expression)` identity as its runtime closure signature.
Its parameter pattern, inferred-input authority tree, and produced-result tree
are interpreted only against the certificate's exact installed AST. An
unqualified settled Array parameter starts with affine Store authority, but its
certificate input retains that authority only if the body consumes or transfers
it; the type remains `[T]`. Validation rejects unknown body or pattern
identities, invalid spans, and malformed region derivation trees before the
contract becomes visible to an importer. At a statically resolved call, the
importer substitutes its concrete argument authority through that defining
pattern. This is interface transport of the same ownership judgement, not
re-inference and not trust attached to an exported name.

Immutable function aliases and record projections preserve the closure's
defining module and body identity, so they select the same ownership contract as
the original closure. When a polymorphic Store parameter is instantiated, the
call site's checked argument type also settles whether its element authority is
shareable; this refinement changes neither the source Array type nor the
certificate. Consequently direct, aliased, and record-member calls consume or
share the same concrete Store authority without recognizing an exported name.

The checked-module certificate also carries editor simplification facts keyed by
the expression that was proved. An integer-equality fact requires the resolved
closure to factor its two arguments through exactly one `@int.cmp`, use each
argument once, and return true for exactly `#Equal` when probed across all three
orderings. Its replacement pattern is limited to a written integer literal or a
pin whose binding evaluates to an integer at compile time; two unresolved
runtime operands produce no fact. A short-circuit-conjunction fact requires both
the complete Boolean truth table and an operational demand probe proving that a
deferred right operand is skipped for `#False` and demanded exactly once for
`#True`. Truth-table equivalence alone is insufficient.

These facts refer to module-local expression identities, and installation
rejects any reference outside the installed AST or a duplicate fact for one
expression. Immutable aliases and record projections are recognized through
their resolved compile-time values rather than source spelling. The editor may
compose the primitive facts into a larger decision-matrix suggestion, but the
TypeScript host neither resolves equality nor proves demand behavior.

The checked declaration signature remains authoritative across compile-time
re-evaluation; a provisional inferred closure type cannot replace it before
ownership certification. A recursive Array result is a checked ownership fixed
point: the sole affine Array input seeds the provisional result, and the
completed body must reproduce the same authority tree. This adds no recursive
constraint to the type lattice.

When a closure contract's produced-result tree is exactly `Parameter(source)`,
residual lowering may project `source` structurally from the closure's actual
argument and use that value's settled runtime type as the recursive result type.
The permission applies to any certified linear parameter component; it does not
recognize Region, Slice, an algorithm, or a source name.

### Flat constraint graph

Let `intern(t)` append immutable children before their parent and return the
canonical `u32` identity of the resulting node. Mutable inference variables
remain separate graph vertices; their lower and upper adjacency lists contain
only these identities:

```txt
Variable = <level, lower: [TypeId], upper: [TypeId]>
TypeId   = index(TypeNode)
```

For every `t`, `expand(intern(t)) = t`. If two interned identities are equal,
their expansions are structurally equal. The converse is deliberately not
required for alpha-equivalent quantified types or differently ordered finite
rows. An adjacency insertion first compares identities and, only when they
differ, applies the ordinary semantic equality relation. The fallback is
necessary because two permutation-equivalent upper bounds are not merely a space
cost: meeting them independently must not widen their variable to `top`. Thus
the fast path cannot identify unequal types, while the fallback preserves row
permutation and quantified alpha-equivalence.

The arena is append-only, including across a failed speculative union branch.
Rollback truncates the variable arena and journals its adjacency insertions, but
need not truncate immutable type nodes. A retained node has no mutable bounds of
its own, and a reused variable number denotes the same syntactic
`Variable(number)` node. Therefore unreachable arena entries cannot affect a
later constraint judgement. This separates dense, stable type storage from the
journalled graph that inference mutates.

### Shared live type graph

The recursive `Type` view used between checker operations is immutable. Its
function, collection, quantified, effect-tail, record, variant, and union edges
share their children. Cloning a type therefore copies one root handle and does
not recursively copy the reachable graph. Mutable inference information exists
only in the variable arena and its interned lower and upper edges; a pass must
not recover mutability by editing a shared type child. Recursive constructor
payloads in finite exhaustiveness witnesses follow the same immutable-sharing
rule.

Settling and residual-signature construction may cache the reading of an
inference variable. Any new bound conservatively invalidates those caches before
another reading. A cached result is an implementation fact about the current
bound graph, never a transported certificate. Residual closure signatures and
diagnostic strings are materialized from the graph only at a boundary that
consumes them; recursive closure inference itself carries the shared type.

Closed-union deduplication compares types structurally with scoped
alpha-equivalence. Pretty printing is not an identity operation and must not be
used to construct a union, constraint, cache, or visited key. Evaluated closure
inference inspects only the closure body's free names and bridges the matching
captured values. Scanning every value in every captured frame would make an
unused environment part of inference cost without changing the judgment.

## 7. Implementation stages and gates

Each stage must preserve diagnostic fixtures, inferred principal types, Runtime
HIR certificates, and emitted ABI bytes before the next stage begins.

1. Replace whole-state speculative clones with journalled transactions.
2. Preserve the level/extrusion and rank-N rules while changing storage.
3. Intern labels and immutable type nodes; replace recursive equality with IDs.
4. Replace recursive propagation with a compact worklist and edge sets.
5. Canonicalise finite rows and measure scalar contiguous scans.
6. Add content-addressed immutable module-interface caching.
7. Add parallel module scheduling only when profiles show multiple ready modules
   dominate wall time.
8. Consider explicit SIMD only when a finite-set scan remains a measured hot
   loop.

Stages 1 and 2 are implemented in the Rust checker shipped as Wasm. The solver
journals bound insertions and checkpoints both the variable arena and skolem
allocator around every right-union candidate. Its rollback tests include a
candidate that mutates a nested variable before failing.

Lexical environments in the Rust checker use persistent copy-on-write maps, as
per Lemma 6. Compile-time records and effects opened into scope remain immutable
open frames under Lemma 7. Record storage and effect-operation aliases retain
their source values and target indices between the evaluator and checker, so
opening a large module does not clone every recursive value and type merely to
establish aliases. Scheme instantiation memoises generalized variable
replacements within one freshening while allocating distinct replacements for
separate instantiations. Neither change alters the lattice or lets mutable
inference state cross a module boundary.

The Rust resident boundary implements flat `TypeId` transport and in-process
module reuse. Closed settled trees are encoded into flat arenas, and every cache
hit inflates them with fresh quantified identities. The live solver also stores
every lower and upper constraint edge as a canonical `TypeId` into an
append-only arena. The live recursive view shares immutable children, so cloning
it does not duplicate those trees; only the mutable graph's hot adjacency
representation is flat. Successful ownership and safety analyses share the same
invalidation boundary. Checked value environments are retained under the
`checked-environment` premise, so Runtime-HIR preparation does not evaluate a
complete nullary module twice.

The 2026-08-03 `storage.blot` profiles justified stage 3 but not SIMD. A
historical TypeScript implementation, measured before Rust/Wasm became the sole
semantic authority, reduced sampled constraint time from 178.6 ms to 49.6 ms
across 50 repeated checks by replacing formatted visited keys. Those numbers are
migration history, not a current correctness or performance gate. In the Rust
checker, named Wasm profiles identified allocation, recursive `Type`
destruction, and lexical-map cloning as the hottest implementation costs.
Persistent lexical maps reduced that cost without adding per-binding
indirection.

After flat constraint edges, incremental Baba frontend state, resident caches,
and persistent open frames, five independent nine-sample runs on 2026-08-04
measured an unchanged Rust check at a 0.280 ms median. A changed lowered module
took 14.4 ms, while a trailing comment edit that preserved the lowered module
took 0.781 ms. The changed-module phase medians were 13.0 ms for loading and
checking, 1.30 ms for HIR preparation, and 0.344 ms for emission after
preparation. Cold end-to-end compilation took 73.6 ms including 3.4 ms of
compiler-Wasm instantiation. For historical migration context, the retired
TypeScript implementation measured 29.7 ms for changed-module edits and 164.4 ms
cold.

A separate 30-sample native release profile isolated the two representation
changes. Replacing copied active-island sets with one stack reduced prelude
frontend work from about 8.69 ms to 6.27 ms; replacing the remaining hash set
with the measured depth-bounded flat stack reduced an isolated 100-sample median
from 6.95 ms to 5.47 ms. Sharing immutable opened records reduced the importing
module's check from about 9.37 ms to 7.42 ms. These measurements do not justify
parallel checking or vectorised row operations: no solver scan is currently a
dominant frame. Further incremental gains require declaration-level checking
certificates or a validated prelude snapshot rather than another backend
shortcut.

Storing every environment typing behind a separate reference-counted pointer was
measured and rejected. It made map copies cheaper but moved the same cost to
lookup and instantiation, regressing the isolated resident Rust check from about
28.3 ms to 30--33 ms. Persistent maps remain; per-binding indirection does not.

The benchmark corpus must include a real edit to the measured source graph. A
standalone one-line file measures compiler call overhead, not incremental
compilation of `examples/storage.blot`.

Correctness gates:

```txt
cargo fmt --manifest-path compiler/Cargo.toml -- --check
cargo clippy --manifest-path compiler/Cargo.toml --target wasm32-unknown-unknown -- -D warnings
pnpm compiler:build
deno check .
deno fmt --check
deno lint
pnpm test
pnpm test:compiler
```

Performance reports record medians, source path, compiler artifact hash, sample
count, cold instantiation separately from compilation, and checker timing. A
faster result that changes a principal type, diagnostic, Runtime HIR, or ABI is
not an optimisation.
