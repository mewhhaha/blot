# Checked Store reuse assertions

## 1. Role

`@[assert.reuse]` is a declaration tag that validates a cost property after
ordinary inference, ownership checking, specialization, and Runtime-HIR
lowering. It is not syntax on a lambda and is not an ownership permission.

```blot
@[assert.reuse]
const clear = fn values => @array.set values 0 0
```

Removing the tag changes neither the declaration's type nor its value semantics.
The declaration tag's ordinary identity transform is implemented by
`@assert.reuse`, which attaches the assertion span to the evaluated closure.
Annotating a non-function reports `BLOT_REUSE_ASSERTION_NOT_FUNCTION`.

## 2. Judgment

For residual function `f`, let `updates(f)` be every `store.write` and
`store.grow` operation in its own Runtime-HIR frame. The assertion discharges
exactly when:

```text
forall operation in updates(f). operation.update = owned-reuse
-------------------------------------------------------------- assert-reuse
                         reusable(f)
```

A call evaluated into `f` contributes its operations to that frame. A nested or
recursive closure materialized as another Runtime-HIR function is a separate
frame and carries its own tag when it needs the same assertion. If the condition
fails, compilation reports `BLOT_REUSE_NOT_PROVED` at the assertion span.

Fresh Store creation is permitted. An owned grow may still allocate when
capacity is exhausted. The theorem excludes persistent update copies; it is not
an allocation-free theorem.

## 3. Independence from authority

The tag is interpreted only after the ownership certificate has established each
operation's authority. It cannot:

- turn a shared Store into an owned Store;
- make a last read into a consuming use;
- select an owned specialization;
- trust a binding, namespace, or primitive wrapper name; or
- cause Runtime HIR to rewrite a persistent operation as `owned-reuse`.

The owned-until-shared rules and explicit copy boundary are specified in
[`OWNED_VALUES.md`](OWNED_VALUES.md).

## 4. Runtime certificate

Runtime-HIR schema 3 records `reuse: "checked"` on a discharged materialized
function. The independent validator repeats the local operation check. The
emitter never consults the function bit to select an update strategy: each Store
operation must still carry its own checked `owned-reuse` annotation and closed
layout witness.

The checked-module ownership certificate does not contain the assertion. Its
schema 9 contract contains the parameter pattern, inferred input authority, and
produced result tree. The assertion follows the evaluated closure so portable
ASTs, the type lattice, and imported ownership contracts cannot forge it.

## 5. Examples

An owned Array parameter satisfies the assertion without `!`:

```blot
@[assert.reuse]
const push_zero = fn values => @array.push values 0
```

Freezing first makes the Store shareable, so updating it is rejected before the
assertion can discharge:

```blot
let shared = freeze [1, 2, 3]
let working = Array.copy shared
let updated = push_zero working
```

`Array.copy` is explicit because it is the only operation above whose source
contract permits an `O(n)` Store copy.
