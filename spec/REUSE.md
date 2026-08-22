# Checked Store reuse

## 1. Boundary

`reuse fn` is a source-level assertion about Store updates, not an ownership
qualifier and not a second function type:

```blot
reuse fn parameter => body
```

The function has the same value semantics and inferred type as
`fn parameter => body`. The keyword does not consume an argument, establish
uniqueness, insert a copy, or select another specialization. Ownership remains a
separate flow analysis. Removing `reuse` from an accepted program therefore
preserves both its value and its accepted calls.

The assertion is checked against the residual execution of the lambda. Write

```text
Delta ; C |- body => h
reuse_clean(h)
```

where `C` contains the ordinary ownership certificates and `h` is the Runtime
HIR emitted while evaluating the lambda body. `reuse_clean` holds exactly when
every emitted `store.write` and `store.grow` is marked `owned-reuse` and passes
the ordinary closed-layout check.

```text
Delta ; C |- body => h    reuse_clean(h)
------------------------------------------------ reuse-lambda
Delta ; C |- reuse fn p => body
```

A persistent Store update rejects the assertion with `BLOT_REUSE_NOT_PROVED`.
The diagnostic points at the asserted lambda; it is not converted into a target
error or a synthetic offset-zero diagnostic.

## 2. What the assertion guarantees

For an accepted `reuse fn`:

- no Store version observable through an older value is copied by an array
  update in that function's residual execution;
- every destructive Store update was independently licensed by linear or affine
  consumption and exact closed-layout equality;
- ordinary evaluation and the emitted Wasm still agree; and
- the compiler emits one specialization for the ordinary inferred source type,
  not owned and persistent variants selected by the keyword.

The guarantee deliberately does not mean allocation-free:

- an array literal or `@array.empty` may create a fresh Store;
- `store.grow` may ask the allocator to relocate a uniquely owned buffer when
  capacity is insufficient;
- text, indirect, closure, product, and sum construction are outside this first
  Store contract; and
- a separately residualized function is its own checking frame.

Calls evaluated into the current residual frame are included. A recursive
closure that becomes a distinct Runtime-HIR function is checked by its own
`reuse fn` assertion. This follows the compiler's real residual boundary rather
than source-name heuristics.

## 3. Currying, nesting, and staging

The grammar parses a source chain such as

```blot
reuse fn x => fn y => body
```

as one flat lambda island. Lowering attaches the assertion to every unary lambda
created from that chain, so the promise cannot become vacuous merely because the
Store update occurs after a later parameter is supplied.

A separately written nested lambda begins another assertion frame only when it
also says `reuse`. A lambda erased completely by compile-time evaluation emits
no Store update and satisfies the assertion vacuously.

## 4. Certificates and Runtime HIR

Ownership certificate schema 3 records whether the lambda asserted reuse, keyed
by defining module identity and exact lambda-body identity. Importing a module
validates that bit against the installed AST together with the existing
parameter and produced-result tree. Runtime lowering reads the explicit bit and
source span from that exact installed lambda; it never infers either from a
binding name. A name such as `reuse`, `Array.set`, or `Slice.swap` is never
evidence.

Runtime-HIR schema 3 adds `reuse: "checked"` to each materialized function whose
source assertion was discharged. The independent Runtime-HIR validator rejects a
checked function containing a persistent `store.write` or `store.grow`. Unmarked
functions retain the ordinary persistent-or-owned update policy.

The serialized fact is an audit certificate. Backend emission still consumes the
per-operation ownership and layout facts; the function bit cannot authorize an
operation that lacks them.

## 5. Examples

An owned update satisfies the assertion:

```blot
const clear = reuse fn !values => do:
  if @array.len (&values) > 0:
    return @array.set (!values) 0 0
  return !values
```

An ordinary persistent update does not:

```blot
const clear = reuse fn values => do:
  if @array.len values > 0:
    return @array.set values 0 0
  return values
```

The second function remains valid when `reuse` is removed. The rejection is a
failed cost assertion, not a change to the value semantics of `@array.set`.

`examples/owned_quicksort.blot` puts the assertion on both the owned entry and
its separately residualized recursive worker. The mutating `Slice` prelude
operations assert the same contract, including the recursive partition worker.
Its persistent wrapper still has one explicit `Slice.copy` boundary; after that
boundary, every Store update in these materialized frames must use the one
private allocation.

## 6. Deliberate next boundary

This contract does not claim dynamic copy-on-write. Blot's current Store ABI has
no precise reference count, so an unknown or shared ordinary value cannot be
tested and detached once. A later Runtime-HIR schema may add `retain`,
`release`, and `ensure-unique`; at that point the assertion may grow a
conditional unique-input allocation theorem. That extension must preserve this
rule: the keyword checks a fact and never creates the ownership fact it checks.
