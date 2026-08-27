# Partitioned ownership regions

Status: implementation contract. The source rules are normative in
`LANGUAGE.md`; this file owns the proof argument, compiler boundaries, and
production gates behind them.

The motivating program is quicksort over one Store. Partitioning should
rearrange one backing allocation, split permission to mutate it into disjoint
child regions, recurse over the children, and rejoin the permission without
copying the array at each recursive step.

The useful compiler concept is broader than arrays:

> A **partitioned ownership authority** is a linear capability naming one region
> of one private runtime resource. A trusted partition consumes one authority
> and produces authorities for a disjoint cover. A trusted combine consumes
> compatible authorities and produces their union.

The design keeps regions out of algebraic subtyping. Ordinary value types still
describe values. Blot's existing flow-sensitive ownership analysis decides when
a capability is consumed; a separate region derivation proves what part of a
resource that capability authorizes.

## 1. The proof stack

Implementation feedback exposed three facts which must not be conflated:

```text
Store provenance
    -> path-sensitive linear ownership
        -> region-family derivation
            -> destructive Runtime-HIR operation
```

Each layer answers a different question.

### 1.1 Store provenance: may this allocation be stolen?

Consider:

```blot
let shared = [1, 2, 3]
let !candidate = shared
```

The `!` marker constrains how `candidate` is consumed. It does not by itself
prove that `shared` cannot still denote the same persistent Store. A destructive
write through `candidate` could therefore be observed through `shared`.

A **Store root** is stronger evidence: it proves that an allocation has no
source-visible persistent observer while destructive authority is active.

The simplest root is a fresh private allocation. An optimization may preserve a
root through an operation whose existing reuse proof shows that the old Store is
consumed and no observer survives. Runtime HIR additionally requires the old and
new Store to have the same closed layout fingerprint before accepting
`owned-reuse`; uniqueness cannot justify reinterpreting bytes.

Region checking never invents Store roots.

### 1.2 Existing ownership: is this authority used on every path correctly?

Region authority is a linear obligation carried by an ordinary source value. Its
branch, loop, closure, and recursive-call behavior belongs to the existing
ownership checker.

This matters because a static compiler certificate is not a runtime event log.
For example:

```text
if condition:
  transform p at site A
else:
  transform p at site B
```

Both sites consume `p` in source, but they are alternatives. A flat sequence
`A; B` would falsely look like a double consumption. The current ownership
certificate already represents this correctly: one binding can have multiple
consumption sites while the checker proves that each execution path consumes it
exactly once.

Therefore region support must extend the existing `Produced`/lineage machinery
rather than replace it with a second path-analysis algorithm.

### 1.3 Region derivation: what memory may this authority touch?

Once path-sensitive ownership has established that capabilities are neither
duplicated nor leaked, a family-specific derivation proves how their write sets
relate.

For an array interval:

```text
Own(root, [lo, hi))
```

A partition witnesses:

```text
[lo, hi) = [lo, mid) * [mid, hi)
```

where `*` is defined only for disjoint regions whose ordered union is valid.
This is a small separation algebra: split factors one permission; join composes
compatible permissions; a transform preserves the permission while changing the
resource contents.

A new proof-producing collection can reuse the ownership integration after it
supplies its own checked region algebra.

`spec/PARTITIONED_CAPABILITIES.md` defines that reusable algebra, its
conservation and coherence laws, the family-adapter trust boundary, and the
conditions under which lists, trees, maps, tensors, arenas, or graphs can use
it. This file instantiates the algebra for array intervals; it does not make
integer indexing or Store layout part of the generic ownership concept.

## 2. Array interval algebra

For a Store `S` of extent `n`, an interval is:

```text
R = [lo, hi)
0 <= lo <= hi <= n
```

Two non-empty intervals for one origin are disjoint iff:

```text
hi1 <= lo2 || hi2 <= lo1
```

Empty intervals authorize no address and are disjoint from every interval.

The invariant is:

> All simultaneously live write authorities for one Store root are pairwise
> disjoint.

Ordered composition is:

```text
[lo, mid) * [mid, hi) = [lo, hi)
```

A split at relative offset `k`, with `0 <= k <= hi - lo`, produces:

```text
[lo, lo+k)   [lo+k, hi)
```

The outputs are a disjoint exact cover of the input. The pure validator in
`compiler/src/partition.rs` implements these laws independently of any compiler
control-flow representation.

## 3. `copy` is the explicit allocation boundary

A useful source operation should not require a new uniqueness type merely to be
safe:

```text
copy : [A] -> Slice A
```

For the first implementation, `A` is restricted to values whose array contents
carry no linear or affine obligations. Its semantic meaning is:

1. create a private Store initialized from the input array;
2. create a fresh Store root for that allocation;
3. create the full interval authority `[0,len)`; and
4. return a linear slice carrying that authority.

This is safe even when the source array is shared because old aliases observe a
different Store.

The compiler may elide the acquisition copy only when Store provenance proves
that the input allocation is already uniquely reusable:

```text
unknown/shared input
  array --copy elements--> fresh private Store --mint authority--> Slice

proved unique input
  array ---------reuse root-----------> Slice
```

Allocation identity is not source-observable, so these implementations have the
same source meaning.

This separates acceptance from optimization:

- ordinary code can always call `Slice.copy` for copyable elements; and
- zero-copy acquisition requires a verified Store root.

Arrays containing owned elements need a consuming acquisition which _moves_
those obligations rather than copying them. That extension should be built on
existing consuming-array lineage and is deliberately outside the first patch.

## 4. Trusted intrinsic boundary

Application code calls ordinary prelude or user-defined wrappers. `@region.*` is
the small trusted boundary recognized by ownership and Runtime HIR.

### `@region.copy`

Creates a full array-interval authority. The evaluator may always take the
copy-safe path. Runtime HIR may use a proof-backed reuse path.

```text
Slice(S, 0, len(S)) carries Own(root, [0,len(S)))
```

A reuse lowering must cite a valid Store root. A fresh lowering creates one.

### `@region.split`

Consumes one authority and, on success, produces two child authorities plus the
recombination witness that rejoins them:

```text
Own(root,[lo,hi))   0 <= k <= hi-lo
------------------------------------
Own(root,[lo,lo+k)) * Own(root,[lo+k,hi)) * Rejoin(root,lo,lo+k,hi)
```

The runtime operation changes metadata only, and the witness is element-free: it
erases to unit at Runtime-HIR lowering. Failure returns the original authority
and mints nothing:

```text
#Split (left, right, rejoin)
| #SplitOutOfBounds original
```

No element Store is copied.

### `@region.join`

Consumes a recombination witness and the two part authorities it was minted
with:

```text
Rejoin(root,lo,mid,hi) * Own(root,[lo,mid)) * Own(root,[mid,hi))
----------------------------------------------------------------
Own(root,[lo,hi))
```

The witness is the proof: ownership pairs it with its two parts by
produced-value identity, so the proof travels through bindings and function
calls like any linear value (section 13). Reassociating nested partitions by
bare adjacency is deliberately given up in this version; a checked
witness-combination law can restore it later if a program needs it.

### `@region.length`

Borrows a slice and returns its interval length. It changes no authority.

### `@region.get`

Borrows a slice and reads relative to its start:

```text
&Own(root,[lo,hi))   0 <= i < hi-lo
------------------------------------
S[lo+i]
```

The eventual checked form should use the same proof-producing bounds machinery
as direct `@array.get`.

The first implementation is for unrestricted element ownership. Region authority
does not make an owned element copyable.

### `@region.set`

Consumes one authority and returns its successor over the same interval:

```text
Own(root,R)   i in R
--------------------
Own(root,R)
```

The Store-root proof excludes persistent observers; the interval proof excludes
other live write authorities for the address.

The first implementation should reject replacing an element whose old or new
value carries an ownership obligation. A later consuming replacement can state
the transfer explicitly.

### `@region.swap`

Consumes one authority, swaps two in-range positions, and returns the successor
authority for the same interval.

This is the important sorting primitive. It moves slots internally instead of
copying them and leaves a clean path to supporting owned elements later.

### `@region.freeze`

Consumes the sole live full-region authority and returns an ordinary persistent
array:

```text
Own(root,[0,len(S)))
---------------------
[A]
```

No destructive authority survives. The first implementation requires this to be
the only live permission for the root, including empty permissions.

`freeze` intentionally ends the private destructive phase. A later copy remains
semantically valid by copying and may steal again only if separate Store
provenance re-establishes uniqueness.

## 5. Source-facing `Slice`

A prelude wrapper can keep application code ordinary:

```blot
const Slice = {
  .copy = fn !values => @region.copy (!values);
  .length = fn &slice => @region.length (&slice);
  .split = fn (!slice, index) => @region.split (slice, index);
  .join = fn (!rejoin, !left, !right) => @region.join (rejoin, left, right);
  .get = fn (&slice, index) => @region.get ((&slice), index);
  .set = fn (!slice, index, value) =>
    @region.set (slice, index, value)
  ;
  .swap = fn (!slice, left, right) =>
    @region.swap (slice, left, right)
  ;
  .freeze = fn !slice => @region.freeze slice;
}
```

The backing Store must not be projectable from source. A Runtime-HIR
representation may contain `(store,start,length,extent)`, but that layout is
compiler-private and refused by ABI 2. `Slice.length` may publish the same
verified affine summary as `@region.length`, including selection of a later
curried parameter and a literal offset. That fact enters `Phi`; it neither
exposes the Store nor duplicates the authority in `Omega`.

These wrappers certify as ordinary source: a region proof over an abstract
parameter defers to the call site, where substitution makes the caller's
authority concrete (section 13). No compiler trust attaches to the prelude and
no source binding name is recognized by the ownership checker.

### 5.1 Module ownership summaries

Every checked source closure publishes a type-independent ownership contract:

```text
OwnershipContract = <parameter-pattern, produced-result>
ClosureIdentity   = <defining-module, body-expression>
```

The parameter pattern and produced result refer to nodes in the defining
module's checked AST. An application resolves its callee through the ordinary
compile-time value environment. If that value is a source closure, its stable
closure identity selects the contract and the caller substitutes its concrete
argument authority through the defining module's parameter pattern. Thus an
imported wrapper has exactly the same ownership meaning as the same wrapper
written locally.

The resident Rust checker retains these immutable contracts with the checked
module interface and serializes them in the checked module certificate beside
closure signatures. It validates every expression, pattern, span, and region
derivation reference against the exact AST installed for that certificate. A
contract never crosses a source revision independently of that AST. Unknown or
host-supplied callees publish no contract and retain the ordinary conservative
call rule.

## 6. Static certificate shape

The production proof reuses the current ownership certificate rather than
recording a flat authority program.

Conceptually, each region-carrying ownership leaf gains region lineage:

```text
copy(root, family, operation)
partition(parent, part, part_count, operation)
combine(parents, operation)
transform(parent, operation)
```

The existing ownership pass remains responsible for whether that leaf is used
exactly once on each path. Region verification checks only local derivation
facts:

- a `copy` is backed by either fresh allocation or a verified reuse root;
- all parts of a partition are accounted for, as existing consuming extraction
  lineage already requires for `@array.take` and `@array.split`;
- a partition's family validator proves its outputs are a disjoint exact cover;
- a combine consumes compatible authorities and its validator proves their
  composition;
- a transform preserves root and region; and
- Runtime HIR binds every destructive operation to the exact certified source
  occurrence.

This makes branch handling compositional. Each branch carries the same incoming
ownership state; the existing branch agreement checks the outgoing obligation.
Region lineage follows the value on that branch and does not need to flatten the
branches into one fake execution order.

## 7. What `region_certificate.ts` currently proves

`compiler/src/ownership.rs` contains the executable **single-path trace
oracle**, not yet the production static source certificate.

It checks the linear graph for one concrete trace:

```text
copy(root, origin, family) -> p
partition(p)                -> [p1, ..., pn]
combine([p1, ..., pn])      -> p
transform(p)                -> p'
release(p)
```

It rejects untrusted roots, duplicate root/origin/permit production,
use-after-partition, incompatible combine inputs, double release, and leaked
leaves.

The runtime model records its actually executed trace and replays it at freeze.
That is useful executable evidence for the algebra, but it must **not** be wired
as the source compiler's only ownership certificate: mutually exclusive source
branches are not one runtime trace.

The production integration is the lineage design in section 6, checked alongside
the existing path-sensitive ownership certificate.

## 8. Failure conservation

Every total operation must return all authority it received on failure.
Otherwise an error path could silently leak a linear resource.

Bad:

```text
split : Own R -> Result (Own L * Own R) Error
```

Required:

```text
split : Own R -> Split (Own L) (Own R) | OutOfBounds (Own R)
```

Likewise:

- failed join returns both inputs;
- failed set returns its input; and
- failed swap returns its input.

A failed operation creates no region derivation because no ownership transition
occurred.

## 9. Preservation argument

Assume a valid Store root for allocation `S`: no persistent source-visible alias
may observe destructive changes to `S` while that root is active.

Let `Live(S)` be the intervals authorized by the live linear ownership leaves
for that root. Maintain:

```text
forall R1 != R2 in Live(S). disjoint(R1,R2)
```

### Copy

The semantic copy creates a private Store, so the root premise holds by
construction. Its physical elision is admitted only with Store-provenance
evidence. `Live(S)` begins as one full interval.

### Split

Replacing `[lo,hi)` with `[lo,mid)` and `[mid,hi)` preserves pairwise
disjointness because both children are subsets of the parent and are disjoint
from each other. The existing ownership checker prevents either child from being
duplicated later.

### Join

Replacing adjacent `[lo,mid)` and `[mid,hi)` with `[lo,hi)` preserves the
invariant: any third live interval overlapping the union would have overlapped
at least one input. The ownership checker proves both inputs are consumed by the
join path.

### Set/swap

The operation touches only addresses inside one live interval. Every other live
write authority is disjoint, and the Store root excludes persistent observers.
The ownership checker proves that the old authority is consumed while a
same-region successor is produced.

### Branches

Each branch starts from the same ownership state. Existing ownership agreement
requires every outgoing path to discharge or transfer the same linear
obligations. Region derivations on mutually exclusive paths therefore do not
coexist in `Live(S)`.

### Freeze

Freeze consumes the sole full authority before exposing the ordinary persistent
array. No destructive permission remains able to change the Store after it
becomes shareable again.

Hence a destructive operation authorized by all three proof layers is
observationally equivalent to persistent source semantics: allocation identity
may change; source-visible values do not.

## 10. Quicksort

The executable catalog entry uses Lomuto partitioning with `swap`, carrying one
complete root and ordinary half-open range metadata:

```text
let rec sort_range =
  fn (!slice, bounds) =>
    if length(bounds) < 2:
      return slice
    let (slice, pivot) = partition (!slice, bounds)
    let left = before(bounds, pivot)
    let right = after(bounds, pivot)
    if length(left) < length(right):
      let slice = sort_range (!slice, left)
      return sort_range (!slice, right)
    let slice = sort_range (!slice, right)
    return sort_range (!slice, left)
```

The real source uses checked prelude range and index helpers. It sorts the
smaller partition in the only non-tail recursive call and leaves the larger
partition as a self-tail call, which Runtime-HIR loop recovery turns into a back
edge. The call stack is therefore `O(log n)` even for maximally unbalanced
partitions. The element Store is never copied during partition or recursive
sorting. The only possible `O(n)` element copy is acquisition of a private
Store, and Store provenance eliminates that copy for an explicitly owned fresh
input.

```text
shared/unknown input: one O(n) acquisition copy + in-place quicksort
proved unique input: zero acquisition copy + in-place quicksort
```

`split`/`join` supports a recursive program whose calls own disjoint regions;
the focused witness tests establish that algebra independently. The catalog
implementation deliberately transfers one complete root sequentially, avoiding a
tree of witnesses while exercising the same destructive partition operations.

A zipper is the explicit structural alternative. Partitioning a Region produces
left, pivot, and right children plus the two rejoin witnesses. The recursive
calls consume the disjoint children independently; the return path joins the
pivot to the right child and then joins that result to the left child. Every
stack frame is therefore a linear reconstruction context:

```text
                 outer witness                 inner witness
root  ->  (left, pivot+right)  ->  (left, pivot, right)
       <- join(left, pivot+right) <- join(pivot, right)
```

This shape makes separation and reconstruction visible and is useful when the
children escape to unrelated callees or later become parallel. A direct
sequential quicksort remains preferable for its smaller source and guaranteed
`O(log n)` non-tail stack. Naive zipper recursion calls both children normally
and can retain `O(n)` reconstruction frames for a maximally unbalanced
partition; the ownership proof does not imply a balancing theorem.

## 11. Why this is not general mutable references

The proposal does not introduce arbitrary addresses which can be stored,
returned, compared, or freely aliased. A slice is a private resource view with a
compiler-known region family and linear ownership transitions.

That restriction keeps the proof local:

- no lifetime parameters;
- no alias search through arbitrary heap graphs;
- no mutable-reference subtype relation;
- no region variables inside algebraic type inference; and
- no second control-flow ownership checker.

A new region family can reuse the pattern only after it supplies checked
partition/combine/transform laws.

### 11.1 Why regular-path borrow tracking is deferred

Nowacki et al.'s
[regex-based Move borrow checker](https://verse-lab.org/papers/regex-borrows-oopsla26.pdf)
gives a useful design for a different boundary. It assigns each live reference
an abstract identity and labels reachability edges with regular languages of
field paths. Brzozowski derivatives expose the paths reachable after a field
borrow, union joins alternative control-flow paths, Kleene star summarizes
unknown borrow chains across calls, and write safety reduces to regular-language
emptiness. The path environment remains an auxiliary judgment rather than
ordinary value-type structure.

That machinery is justified when references are first-class, may escape a call,
and coexist with mutation. Blot's borrow is none of those things: it is a
transient read-only view, and the region proposal exposes linear capabilities
rather than addresses. Adding a regular-path environment now would duplicate the
existing ownership control-flow analysis without discharging either Store
provenance or the family-specific region derivation.

It is also too coarse for the motivating array program. The Move model gives
every vector element the same path symbol, deliberately refusing to distinguish
simultaneous borrows of different indices. Blot's quicksort proof instead needs
the exact interval separation algebra in section 2. A regex can describe a set
of structural access paths; it does not prove that two numeric intervals are a
disjoint exact cover. Recombination witnesses likewise preserve the exact
sibling relation that a conservative call summary would forget.

If Blot later admits stored or returned borrows, regular-path reachability is a
candidate provenance calculus. A bounded experiment should then use fresh
abstract references, derivative-based extension, union at branch joins, removal
of consumed references, and checked call/return summaries. It must remain
separate from algebraic subtyping and compose with, rather than replace, Store
roots and region-family laws. No such experiment is warranted until a concrete
program requires a borrow to escape the current lexical boundary.

## 12. Production gates

The first region family is production-complete. Its gates are:

- Store-provenance tests proving zero-copy copy is denied when an older
  persistent alias could observe the Store;
- a copy fallback proving ordinary copy remains valid for shared inputs;
- a first-version restriction or consuming transfer proof for owned elements;
- path-sensitive tests where alternative branches consume/transform one slice;
- lineage tamper tests proving every partition output is accounted for;
- family tests for exact split cover, adjacency, bounds, empty intervals, and
  full freeze;
- failure-conservation tests on every total operation;
- evaluator/Runtime-HIR/Wasm agreement;
- ABI refusal for live slice values;
- an in-place quicksort corpus entry that allocates no element Stores after
  acquisition, with split/join conservation covered independently; and
- a dynamic benchmark that distinguishes input-construction growth from sort
  writes in Runtime HIR and rejects persistent sites or Store helper imports.

The accepted/rejected catalog, dynamic Wasm tests, certificate validation,
cross-module wrapper example, and `pnpm benchmark:owned-regions` provide that
evidence. The catalog quicksort carries one complete root through smaller-first
recursion; its larger recursive step becomes a loop back-edge, and it exercises
the same partition writes without manufacturing a tree of live witnesses. Split,
failed split, sibling isolation, exact rejoin, reversed-part rejection,
partial-freeze rejection, shared-input copy, owned-input reuse, and ABI refusal
remain separate focused contracts.

## 13. Recombination witnesses

Implemented. An earlier prototype carried three compensations that contradicted
the prelude's own principle that nothing in it is built into the compiler:

- its ownership checker certified the prelude's `Slice` wrappers under a trusted
  mode, because a join of two abstract parameters had no split lineage to
  inspect;
- it recognized an unshadowed variable spelled `Slice` and mapped its fields
  back to `@region.*`, so caller-side proofs bypass the wrapper; and
- argument interpretation changes when the callee is spelled `Slice`, to unpack
  the wrappers' tuple calling convention.

Each was the same missing abstraction. The ownership summary of a function did
not express a relation between two of its arguments — "these are the sibling
halves of one split" — so the relation was patched in by name. A relational
contract language could express it, but there is a smaller design: make the
relation a value. The trusted mode is deleted; a region proof over an abstract
parameter defers as a pending obligation carried in the function's summary and
is discharged at the call site, after parameter substitution makes the caller's
authorities concrete. Ownership contracts now cross module interfaces; the
production Rust checker contains neither name recognition nor tuple
reinterpretation.

### The witness

`@region.split` returns three linear values on success. `@region.join` consumes
three:

```text
split : !Own(root,[lo,hi))  k
        -> #Split (Own(root,[lo,lo+k)),
                   Own(root,[lo+k,hi)),
                   Rejoin(root, lo, lo+k, hi))
         | #SplitOutOfBounds Own(root,[lo,hi))

join  : !Rejoin(root, lo, mid, hi) * !Own(root,[lo,mid)) * !Own(root,[mid,hi))
        -> Own(root,[lo,hi))
```

`Rejoin` is an unforgeable, opaque, element-free capability: the proof that its
two parts recombine into their parent, reified as a value. It carries no data a
program can read, costs metadata only, and is erased entirely at Runtime-HIR
lowering — the runtime join operation is unchanged, taking the left part's start
and the right part's end.

### Why this fits the proof stack

The pairing between a witness and its two parts lives in the ownership
analysis's produced values, keyed by value identity, not in the type lattice.
The witness's type is one opaque nominal; no region variable enters algebraic
inference, so every restriction in section 11 still holds. Join checks that its
first argument's produced value is the witness whose recorded parts are exactly
the other two arguments. Where the analysis cannot trace a witness, it rejects —
the same conservatism as the current lineage proof.

What changes is composition. A witness travels through bindings, tuples, case
arms, calls, and imported closure contracts by the ordinary parameter-
substitution machinery that already threads concrete authorities into function
results. A user function that receives a witness and two parts and joins them
certifies with no new rules:

```blot
let rejoin_sorted = fn (!rejoin, !left, !right) =>
  Region.join ((!rejoin), (quicksort (!left)), (quicksort (!right)))
```

No compiler rule remembers that two arguments originated from one particular
split; the proof arrived with them.

### Obligations

- A witness is linear. Leaking one is the ordinary unconsumed-linear error, and
  correctly so: losing the ability to rejoin means the root can never be
  reassembled for `freeze`.
- A witness is refused at ABI 2 exactly as a live region authority is.
- Witness pairing proves sibling recombination of one split. The section 4
  adjacency rule — reassociating nested partitions — is deliberately given up in
  the first version; a checked witness-combination law can restore it later if a
  program needs it.
- Failure conservation extends to the witness: `#SplitOutOfBounds` returns the
  parent authority and mints nothing.

### Quicksort under witnesses

```text
whole
  |
split -> left, rest, J1
                 |
            split -> pivot, right, J2

sort left, sort right
join J2 pivot right
join J1 left (pivot ++ right)
```

Every recombination names its proof. The recursion passes witnesses down as
ordinary linear values, so helper functions of any shape stay certifiable.

### What this deletes

With witnesses, the prelude's `Slice` wrappers are ordinary certifiable source:
each body forwards values whose proofs travel with them.

The production Rust checker contains none of:

- the trusted-prelude ownership mode and every path by which the prelude was
  identified;
- the name-keyed recognition of `Slice.*`; and
- the `Slice`-specific tuple-argument reinterpretation.

The replaceability test holds across modules: a user wrapper over split, join,
or freeze — any name, any record shape — certifies with no new rules because the
imported closure contract carries the deferred proof to the caller's concrete
authorities.

### Family generality

The witness generalizes the family contract of section 11: a region family's
partition operation returns pieces plus a recombination witness, and its combine
operation consumes them. Matrix tiles, tree partitions, and arena chunks can
implement the same shape without the checker learning anything per family beyond
the family's own partition/combine laws.

## 14. Owned elements and composable witnesses

The next region-family revision extends the production contract in three coupled
directions: a region may carry element obligations, replacement transfers those
obligations without copying or dropping them, and nested partition witnesses may
be reassociated without re-splitting the Store. These are one feature because
each operation must preserve both the interval authority and the ownership
lineage of every element inside it.

### 14.1 Consuming acquisition and freeze

`@region.copy` keeps its copy-safe behavior for unrestricted elements. When the
input array carries affine or linear elements, copy is accepted only as a proved
consumption of the complete array. The operation moves its positional ownership
lineage into the new full-region value:

```text
!Array(root, [o0, ..., on]) -> Slice(store, [0,n), [o0, ..., on])
```

No fallback copy is permitted for an owned element. A proved uniquely reusable
Store may still avoid the acquisition copy; otherwise the Store allocation is
copied while the element values and their obligations are transferred exactly
once. The source array is unavailable after either path.

Split partitions the positional lineage at the same boundary as the interval.
Join requires the witness's exact sibling regions and concatenates their
lineage. Swap permutes two lineage positions with the corresponding Store slots.
Freeze consumes the sole full-region authority and reconstructs an ordinary
array carrying the same obligations in their final positions. Copy followed by
freeze is therefore ownership-neutral even when the representation changes.

Borrowed `get` remains unavailable for an owned element because it would copy an
obligation. Reading such an element requires a consuming transfer operation;
this revision introduces replacement, not a hole-bearing region, so it does not
add `take`.

### 14.2 Consuming replacement

The existing `@region.set` remains the unrestricted-element operation and
continues to return only the successor slice. Owned replacement uses a distinct
primitive so no accepted program changes result shape:

```text
@region.replace (!slice, index, !new)
  -> #Replaced (!old, !slice)
   | #ReplaceOutOfBounds (!new, !slice)
```

On success, the old positional obligation is transferred to `old`, the new
obligation occupies that exact position, and the returned slice keeps the same
root and interval. On failure, both incoming obligations are returned unchanged
and no Store write or ownership transition occurs. Unrestricted values use the
same result shape, which keeps wrappers parametric over element ownership.

`Slice.replace` is an ordinary prelude wrapper over the primitive. Its imported
ownership contract must express both the removed element and the successor
slice; no name-based privilege is permitted. Runtime HIR binds the destructive
write to the checked replacement occurrence, and the Rust certificate validates
the positional transfer against the exact source AST.

### 14.3 Witness reassociation

A split witness proves one binary partition. Nested partitions form a proof
tree. Reassociation changes only that proof tree; it never changes the Store,
the live intervals, or their order.

For an outer witness `J₁ : A * BC -> ABC` and an inner witness
`J₂ : B * C -> BC`, left reassociation consumes both and produces:

```text
@region.reassociate_left (!J₁, !J₂)
  -> (J₄ : AB * C -> ABC, J₃ : A * B -> AB)
```

Its inverse keeps the outer witness first:

```text
@region.reassociate_right (!J₄, !J₃)
  -> (J₁ : A * BC -> ABC, J₂ : B * C -> BC)
```

Thus `reassociate_left` rotates a right-nested proof tree left and
`reassociate_right` rotates a left-nested tree right. Each rewrite is accepted
only when root identity, ordered boundaries, and parent-child identities match
exactly. For concrete witnesses the equations are:

```text
J₁ = (store, a, b, d)    J₂ = (store, b, c, d)
J₄ = (store, a, c, d)    J₃ = (store, a, b, c)
```

Both operations are involutive as a pair: applying one and then the other to the
returned outer/inner pair recovers witnesses for the original proof tree.

The operations are compiler-private proof rewrites exposed through ordinary
`Slice` wrappers. Witnesses remain opaque, linear, element-free, and erased
before runtime emission. Reassociation must therefore emit no Store operation
and allocate no runtime value. Failure is a source diagnostic when the concrete
lineage disproves the relation; an invalid certified rewrite after checking is
an invariant failure.

### 14.4 Production gates

This revision is complete only when the Rust checker/evaluator and emitted Wasm
satisfy their respective obligations for:

- consuming copy and freeze for arrays containing affine and linear elements;
- rejection of any copy path that would duplicate an owned element;
- split, swap, join, and freeze preserving positional element obligations;
- successful replacement returning the old obligation exactly once;
- out-of-bounds replacement returning both inputs and performing no write;
- cross-module wrappers carrying the full replacement contract;
- left and right witness reassociation plus their inverses;
- rejection of mismatched roots, boundaries, siblings, and already-consumed
  witnesses;
- Runtime-HIR validation, ABI refusal for live regions and witnesses, and zero
  runtime code for proof reassociation;
- accepted and rejected catalog examples exercising nested partitions with owned
  elements; and
- strict Rust-evaluator/emitted-Wasm agreement under the Node host, with the
  generated prelude snapshot and compiler specifications updated in the same
  change.

### 14.5 Ownership representation and conservation

The ownership analysis represents a region as `Region(authority, elements)`.
`authority` is the single linear interval permission; `elements` is a hidden
positional ownership tree. This is an analysis value only. It neither adds a
source-visible field nor changes `Region T` in the type lattice.

The conservation equations are:

```text
copy(Array(E))                             = Region(root, E)
split(Region(P, E), k)                      = Region(L, Eₗ), Region(R, Eᵣ), J
join(J, Region(L, Eₗ), Region(R, Eᵣ)) = Region(P, E)
replace(Region(P, E), i, N)                 = E[i], Region(P, E[i := N])
freeze(Region(root, E))                     = Array(E)
```

For a statically known position, `Eₗ`, `Eᵣ`, and `E[i := N]` preserve exact
positions. For a dynamic position the certificate records one extraction
identity shared by the selected and residual obligations; independent validation
requires both outputs, so the abstraction may forget a position but cannot
duplicate or drop its owner. Swap merely permutes positions and never changes
the multiset of obligations.

The witness records only the interval equation `L * R = P`; it never snapshots
`Eₗ`, `Eᵣ`, or `E`. Join therefore matches the witness against the two live
child authorities and reconstructs the parent with the children's current
element trees in left-to-right order. In particular, a successful replacement
inside either child cannot invalidate the interval proof, and join must not
restore the stale element tree that existed when split minted the witness. When
control-flow alternatives return the same interval authority, the checker
likewise keeps one authority and joins only their alternative element trees. It
must not combine mutually exclusive results into two simultaneous authorities.
For a generic region parameter, element partitions remain rooted in that
parameter until call-site substitution. Substitution replays the partition over
the caller's actual element tree; an unrestricted tree therefore yields no
synthetic obligation, while an owned tree retains the same extraction identity.

The non-consuming `get` and discarding `set` remain valid only when the hidden
element tree is unrestricted. The checker defers that condition for a symbolic
region parameter and replays it after caller substitution. `replace` is the
ownership-general write because both success and failure return every incoming
obligation exactly once.

### 14.6 Cost model

- `replace` performs one bounds check, one Store read, and one Store write: time
  `O(1)` and allocation `O(1)` in the same sense as `set`.
- `split`, `join`, and both reassociation operations copy no elements. Split and
  join construct only fixed-size private region products; reassociation is
  proof-only and emits no Runtime-HIR or Wasm operation.
- `copy` is `O(1)` when the consumed array Store is certified reusable and
  otherwise `O(n)` for the required private Store copy. Owned elements never add
  a second copy.
- `freeze` is `O(1)` for a complete root because it exposes the private Store as
  an immutable array; it performs no element walk.

## 15. Pure consuming transforms over one Store

`Slice` is the source-level way to request destructive implementation without
making mutation observable. A transforming operation consumes the only authority
for an interval and returns its successor:

```text
transform : (!Slice A, arguments...) -> Slice A
```

The old slice is unavailable after the call. Reads through aliases are
impossible because `copy` established a private Store root, and writes through
other authorities are impossible because the region proof requires their
intervals to be disjoint. The compiler may therefore update the Store in place,
while the source meaning remains the persistent equation:

```text
freeze(transform(copy(xs), args))
  == persistent_transform(xs, args)
```

Allocation identity is absent from the language, so copying and verified reuse
are observationally equivalent implementations of that equation. This is the
same principle already used by `Slice.set`, `Slice.replace`, and `Slice.swap`;
it is not a separate effect system or a mutable-reference escape hatch.

### 15.1 In-place partition

Classification is the first higher-level consuming transform:

```text
Slice.partition (!slice, belongs_left)
  -> (!slice, boundary)

Slice.partition_range (!slice, start, end, belongs_left)
  -> #Partitioned (!slice, boundary)
   | #PartitionOutOfBounds (!slice, start)
```

For a successful range partition over `[start,end)`, the returned boundary `mid`
satisfies:

```text
start <= mid <= end
forall i in [start,mid): belongs_left(result[i]) == #True
forall i in [mid,end):   belongs_left(result[i]) == #False
multiset(result[start:end]) == multiset(input[start:end])
result[0:start] == input[0:start]
result[end:n] == input[end:n]
```

The predicate is evaluated exactly once per element. The first implementation
uses swaps, is deliberately unstable, takes `O(end-start)` time, and needs
`O(1)` element storage. It allocates no element Store after `copy`; the same
private Store and interval authority flow into the result. `Slice.partition` is
the total whole-interval specialization and therefore needs no failure variant.

`partition_range` validates `0 <= start <= end <= length` before the first
predicate call or swap. Failure returns the unchanged authority and the supplied
start boundary. Both constructors carry the same `(authority, boundary)` shape,
so conservation is structural across the result. A total consuming operation may
never lose its unique input on the failure path. The whole-slice form constructs
its own valid range and therefore needs no result variant.

The operation is derived in ordinary prelude source from `length`, `get`, and
`swap`; no new intrinsic or compiler privilege is introduced. Its element read
means this first form applies to copyable elements. A future variant for owned
elements must make the predicate's borrow and every element movement explicit
rather than copying an obligation out of the Store.

### 15.2 Checked range and index ergonomics

Algorithms that retain a complete root otherwise repeat the same total-result
arms around every index operation. The prelude may package those arms without
turning bounds metadata into authority:

```text
Slice.whole(&slice)                         -> Slice.Range
Slice.range(&slice, start, end)             -> #Range Slice.Range
                                                | #RangeOutOfBounds
Slice.range_length(bounds)                  -> Int
Slice.range_last(bounds)                    -> Int
Slice.range_before(bounds, pivot)           -> Slice.Range
Slice.range_after(bounds, pivot)            -> Slice.Range
Slice.partition_in(!slice, bounds, test)    -> partition result
Slice.expect_get(&slice, index)             -> element or trap
Slice.swap_or_keep(!slice, left, right)     -> !slice
```

`Slice.Range` is an ordinary structural `{start,end}` source value. `whole` and
a successful `range` enforce `0 <= start <= end <= length(slice)`. Its
arithmetic helpers preserve that relation when they receive a boundary returned
by the validated partition, deriving half-open lengths, the last index, and the
ranges before and after its pivot. It is not a second linear capability, does
not enter ownership certificates, and cannot authorize Store reuse.

Because any matching structural record can be constructed directly, and a range
may be reused with another region, `partition_in` is only an ordinary wrapper
that passes its fields to the total `partition_range`. That operation
revalidates them against the current borrowed `Slice` before the first predicate
call or write. An invalid borrowed read traps; an invalid consuming operation
performs no Store access and returns its unchanged authority. The `Slice`
authority remains the only trusted fact, so this convenience layer stays
entirely in prelude source.

### 15.3 Relation to array monoids and split witnesses

`Array.partition` remains the stable, persistent value operation. It creates two
independent arrays, and `left <> right` is ordinary monoid append. Neither
operation carries uniqueness or sibling provenance, so neither licenses
destructive reuse.

`Slice.partition` instead rearranges one authority and returns an integer
boundary. Callers that need independently recursive pieces may split at that
boundary and later join the exact siblings with the returned rejoin witness. The
boundary classifies positions; the witness proves ownership. Keeping those roles
separate prevents a general `<>` from becoming a hidden, unsound memory
operation.
