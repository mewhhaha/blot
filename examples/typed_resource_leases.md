# Typed resource leases

`resource_lease.blot` factors a common ownership protocol into one compile-time
type constructor:

```blot
Lease (Resource, Receipt)
```

A lease effect has two operations. `acquire` **produces** one linear `Resource`;
`close` **consumes** exactly that resource and returns its exact `Receipt` type.
Those ownership modes are the ordinary `Effect.produces` and `Effect.consumes`
descriptors interpreted by `@effect`; the library adds no runtime bookkeeping.

The executable instantiates the same constructor for a file handle and a deploy
lock. Their resource and receipt carriers are intentionally distinct variants. A
deployment acquires both resources, closes them in reverse order, and returns
both typed receipts. A second case acquires two independent file handles from
the same effect and proves that each must be closed once.

The compiler enforces resource/receipt carrier compatibility, linear
consumption, and the remaining effect row. It does **not** attach producer
provenance to a runtime value merely because an effect produced it. If two
independent lease effects deliberately expose the same `Resource` carrier, a
value produced by one can satisfy the other's `close` input. The focused
`resource_lease_same_carrier` probe records that boundary. Applications needing
producer identity should make it part of the resource carrier with a distinct
variant or nominal type.

## Run

With the Rust/Wasm compiler artifact matching the checkout:

```sh
pnpm blot check examples/typed_resource_leases.blot
pnpm blot run examples/typed_resource_leases.blot
pnpm blot lint --check examples/lib/resource_lease.blot examples/typed_resource_leases.blot
pnpm blot build examples/typed_resource_leases.blot
node --import tsx --test src/node/typed_resource_leases.test.ts
```

The supported executable covers one lease, nested independent leases, two
simultaneously live resources of one lease, Unicode resource data, and exact
close receipts. The focused rejection fixtures cover a leaked resource, closing
the same resource twice, and closing a file handle through the lock lease.
