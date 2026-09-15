# Applicative nominal domains

This example factors a common module-boundary problem into a small type-valued
API: two independently authored modules need to agree that an integer is a
`CustomerId` without sharing one declaration object, while `CustomerId` must
remain distinct from another integer-backed domain such as `InvoiceId`.

`lib/nominal_domain.blot` uses Blot's sealed types directly.
`domain (name, Carrier)` returns the sealed type itself with `of`, `value`, and
`name` attached as its namespace. Because seals are applicative, their identity
is the public name plus invariant carrier. Reconstructing
`("example.customer-id.v1", Int)` in the customer module, billing module, or
application therefore yields the same nominal type. Changing either the name or
the carrier yields a different type.

The abstraction keeps the representation boundary honest. `CustomerId` and
`InvoiceId` erase to their carriers at runtime, but ordinary `Int` values cannot
flow into either domain and one sealed domain cannot flow into the other.
`unseal` is confined to the generated `.value` operation instead of being
scattered through application code.

The compiler enforces the seal identity, carrier invariance, typed constructors,
and typed eliminators. It does not know the business meaning of the public name.
Two unrelated authors who choose exactly the same name and carrier have
intentionally reconstructed the same seal as far as the language is concerned.
Qualified, versioned names are therefore part of the API contract.

## Run

With a Rust/Wasm compiler artifact that exactly matches the checkout:

```sh
pnpm blot check examples/applicative_nominal_domains.blot
pnpm blot run examples/applicative_nominal_domains.blot
pnpm blot lint --check \
  examples/lib/nominal_domain.blot \
  examples/lib/customer_identity.blot \
  examples/lib/billing_identity.blot \
  examples/applicative_nominal_domains.blot
pnpm blot build examples/applicative_nominal_domains.blot
node --import tsx --test src/node/applicative_nominal_domains.test.ts
node scripts/check_abstractions.mjs
```

## Covered cases

The executable sends a customer ID created in `customer_identity.blot` through
`billing_identity.blot`, reconstructs the same customer domain a third time in
the application, derives a distinct invoice domain over the same `Int` carrier,
and carries Unicode text through a separate sealed alias domain.

Three fixtures are intentional source-level rejections: an invoice passed to a
customer consumer, a raw integer passed where `CustomerId` is required, and the
same public customer name rebuilt over `Text` instead of `Int`. A fourth focused
fixture is supported rather than rejected: two locally reconstructed seals with
the exact same public name and `Int` carrier interoperate, preserving the
applicative-identity boundary as executable evidence.

## Design tradeoff

A globally meaningful text name is simpler than a runtime registry and enables
independent reconstruction across module/package boundaries, but it requires
naming discipline. If application-local freshness is required, a generative
constructor is the appropriate semantic shape; this helper deliberately
demonstrates Blot's existing applicative seal semantics instead of simulating
freshness with hidden runtime data.
