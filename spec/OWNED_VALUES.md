# Owned-until-shared Store values

## 1. Boundary

Blot gives every fresh array Store one affine ownership authority. The ordinary
array type remains `[T]`: ownership is a flow fact after inference, not a member
of the algebraic subtype lattice and not a second array type.

The first production instance is deliberately Store-shaped. Tuples, shapes,
closures, text, and indirect values remain immutable runtime values until their
backends expose a closed-layout update operation worth authorizing. Region
authorities remain the stronger, linear capability for splitting one Store into
independently writable intervals.

Write `Own(S, E)` for the unique authority over Store `S` with element ownership
tree `E`, and `Shared(S)` for the same immutable value after that authority has
been relinquished.

```text
fresh-array(E) : Own(S, E)
copy(Shared(S)) : Own(S', none)
freeze(Own(S, E)) : Shared(S)       when freeze(E) is defined
borrow(Own(S, E)) : &S              without consuming Own(S, E)
```

The transition to shared is one-way. A compiler may prove that an explicit
`Array.copy` can steal a last Store reference, but source never turns a possibly
shared value back into owned authority without naming that potentially linear
operation.

## 2. Inferred function contract

An unqualified function parameter whose checked runtime representation is a
Store begins as a unique authority candidate. Its exported contract is consuming
only when the body actually demands that authority by updating it, returning it,
capturing it into an owning closure, or passing it to another consuming
contract. A body that only observes or ignores the parameter exports a
non-consuming contract. A parameter written `&name` is a guaranteed transient
read-only borrow. `!name` continues to mean an exact linear obligation, but
ordinary Store ownership does not require it.

```blot
const push = fn (values, value) => @array.push values value
const length = fn &values => @array.len (&values)
```

The first arrow transfers one Store authority and returns its successor. The
second never owns the Store. The same non-consuming result can be inferred for
an unqualified parameter, but `&` additionally guarantees that calling the
function preserves the caller's uniqueness instead of sharing it. This calling
convention is published structurally in the ownership certificate and is
independent of binding or module names.

Each symbolic Array position carries two independent certificate facts:

- whether its element ownership tree can be shared; and
- whether the backing Store access is `Shared` or `Unique`.

Concrete type specialization may refine the first fact. It preserves the second.
An operation that destructively reuses, partitions, or recycles the Store raises
the access requirement to `Unique`, including through nested and imported calls.
Control-flow joins retain `Unique` when any alternative requires it while
keeping the common Store lineage.

A caller may hand a fresh or otherwise owned Store directly to a consuming
parameter:

```blot
let values = [3, 1, 2]
let sorted = quicksort (values, compare)
```

The old binding is unavailable after the call. No source or physical copy
occurs. Passing a shared Store to the same contract is rejected; preserving an
alias and obtaining an owned working Store requires `Array.copy`.

## 3. Sharing and freezing

`freeze value` consumes every affine Store authority in `value` and returns the
same immutable value without those authorities. The operation is `O(1)` in
runtime work: the ownership checker discharges the finite structural tree, and
the runtime representation does not walk the elements.

Freezing is undefined when the value contains a genuinely linear resource such
as a Region or rejoin witness. Such a resource must follow its own consuming
protocol. Nested owned Stores may be frozen recursively because each becomes
immutable and shareable; their bytes are not copied.

An owned value can be borrowed any number of times before its final consuming
handoff. A borrow cannot escape, be stored, or cross a host boundary. Passing an
ordinary owned argument to a resolved non-consuming contract may relinquish its
authority and leave it shared; this is the implicit `O(1)` alternative to a
hidden copy. Write `&parameter` when the function must preserve the caller's
unique authority, and `freeze` when source should state the sharing boundary
locally. A read-only Store captured by an escaping or recursive closure is
shared for the same reason; a capture that later consumes it instead transfers
the authority into the closure.

An exclusive runtime branch preserves Store authority when every continuing arm
returns an owned successor of the same incoming authority. Runtime HIR retains
that ownership meaning on its block parameter: the ownership certificate has
already proved that only one arm executes and that their outgoing states agree.
A join with a shared arm is not reusable.

At a module or host result boundary, an otherwise valid owned Store is frozen
implicitly. The boundary already transfers no source-visible destructive
authority, and the transition performs no copy. Linear resources remain
forbidden at that boundary.

## 4. Updates and explicit copies

`@array.set` and `@array.push` have persistent value semantics in every case.
When their Store operand carries `Own`, the ownership checker consumes that
authority and returns its successor, and Runtime HIR must emit `owned-reuse`.
The old source value is unavailable, so destructive implementation is
unobservable.

A Store update through `Shared` is not silently copied. Code that needs to keep
the shared value requests the allocation boundary:

```blot
let original = freeze [3, 1, 2]
let working = Array.copy original
let sorted = quicksort (working, compare)
return (original, freeze sorted)
```

`Array.copy` has pure copy semantics and worst-case `O(n)` time and space. A
proved last Store reference may make its physical implementation `O(1)` without
changing that source contract. This is the only ordinary frozen-array-to-owned
boundary; no update or function call inserts a copy.

## 5. Checked reuse assertion

Store reuse is requested through the existing declaration-tag mechanism:

```blot
@[assert.reuse]
const transform = fn values => body
```

`assert.reuse` is an identity transform carrying a compiler proof request. It
does not change the function type, make an argument owned, select another
specialization, or authorize an update. Every `store.write` and `store.grow`
emitted in each asserted residual function frame must independently carry
`owned-reuse`; otherwise compilation reports `BLOT_REUSE_NOT_PROVED` at the
tagged declaration.

Fresh Store construction is allowed, and an owned grow may relocate when
capacity is insufficient. The assertion is therefore a no-persistent-update copy
contract, not an allocation-free theorem. Separately materialized nested or
recursive functions carry their own tag.

The Runtime-HIR function certificate remains `reuse: "checked"`. Its validator
checks every operation independently, so the function bit cannot grant
permission absent from the operation.

## 6. Higher-order state recursion

Repeated recursion over one owned value can be factored into a state-passing
driver only when the driver's transition contract records a relation, not just
an arrow type: every transition must consume the current authority and return
its successor in each continuing result alternative. A binary driver would
accept `#Done state` or `#Split (state, first, second)`, recursively process the
smaller problem, and leave the larger problem in ownership-tail position.

The certificate therefore carries **callback requirements**. When a
function-valued parameter is called with owned arguments and its result is
immediately bound by a declaration pattern or eliminated by `case`, existing `!`
and `?` binders identify the successor positions. Owned input leaves and
qualified output leaves are paired structurally from left to right. A direct
result must expose exactly the consumed leaves; every named alternative must do
the same, with compatible obligations. No new source annotation or ownership
type is introduced.

For example, the driver below requires `transition` to consume one affine state
authority and return that exact successor in the first payload position of both
alternatives:

```blot
const divide = fn transition => do:
  let rec go = fn (?state, problem, context) => do:
    return case transition (?state, problem, context) of
      #Done ?state => state
      #Split (?state, first, second) => do:
        let state = go (?state, first, context)
        return go (?state, second, context)

  return go
```

The requirement is inferred while checking `divide`, serialized beside its
ordinary ownership contract, and erased before Runtime HIR. Applying `divide`
validates the actual callback's checked input/result contract after substituting
the driver's symbolic input authority through it. Equal value types are not
evidence: a callback that drops the state, returns a fresh Array, shares it, or
omits it from one result alternative is rejected. An unresolved or host-supplied
callback cannot discharge the requirement.

The result must be exposed immediately because the qualified pattern is the
finite proof of where each successor resides. A state fold can therefore write
`use ?next <- step (?current, value)` without declaring an ownership type for
`step`. Returning or storing an opaque owned callback result remains rejected.
This keeps the relation language small, decidable, and separate from
biunification while covering folds, work lists, and divide-and-conquer drivers.
Compile-time specialization does not grant the relation; it may only optimize
code after the certificate has validated it.

## 7. Quicksort and the Region boundary

Sequential quicksort threads one whole Store authority through both recursive
calls. It therefore needs an owned array and range values, not a `Slice` merely
to establish privacy:

```blot
let values = [4, 7, 3, 8, 2, 6, 1, 5]
return Array.quicksort (values, fn (left, right) => left <= right)
```

`Array.quicksort` is ordinary prelude source. Its private recursive kernel uses
one affine parameter marker as the induction hypothesis for recursive Store
return, and `@[assert.reuse]` verifies the kernel's residual writes. Neither is
part of the public call. The kernel evaluates the shorter range first, so its
non-tail recursion depth is `O(log n)` even for unbalanced partitions. `Slice`
remains the correct tool when two disjoint interval authorities must be live
independently, transferred to unrelated callees, processed concurrently, or
rejoined later.

## 8. Soundness and cost obligations

The implementation must preserve these facts:

1. one live `Own(S, E)` exists at most once on every execution path;
2. borrowing never consumes or escapes that authority;
3. inferred sharing cannot discard a linear non-Store obligation;
4. a shared Store never reaches an owned update without explicit `Array.copy`;
5. ownership contracts are keyed by module and exact closure AST identity;
6. Runtime HIR verifies closed element layout before every destructive update;
7. removing `@[assert.reuse]` changes neither accepted calls nor value results;
8. evaluator and emitted Wasm observe the same persistent value semantics; and
9. residual aggregate specialization preserves the concrete Store element
   representation observed at the call site; and
10. a residual direct call restores Store authority only from its certified
    produced-result tree.
11. an opaque higher-order callback never receives owned state without a
    certified consuming parameter contract; and
12. each inferred callback requirement is discharged by substituting the actual
    callback's checked result contract, never by type equality or callee name.

The useful asymptotic boundary is explicit:

| Operation                      |                         Time |    New element Store |
| ------------------------------ | ---------------------------: | -------------------: |
| borrow                         |                       `O(1)` |                 none |
| hand off owned Store           |                       `O(1)` |                 none |
| freeze                         |                       `O(1)` |                 none |
| owned `set`                    |                       `O(1)` |                 none |
| owned `push`                   |             amortized `O(1)` | only capacity growth |
| `Array.copy` shared Store      |                       `O(n)` |                  one |
| `Array.copy` proved-last Store | `O(1)` physical optimization |                 none |

Reusable initialized-prefix construction is the separate affine `Scratch`
capability specified in [`SCRATCH.md`](SCRATCH.md). It neither changes ordinary
Array ownership nor permits uninitialized values to enter the type lattice.
