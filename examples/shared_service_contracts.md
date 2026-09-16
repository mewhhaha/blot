# Shared service contracts

This example factors a common modular-service problem into a small compile-time
abstraction: a unary port is identified by a qualified text key plus its exact
request and response types.

`examples/lib/shared_service_port.blot` defines:

```blot
const unary = fn (key, Input, Output) => @effect.shared key {
  .call = Input -> Output;
}
```

The consumer and provider modules independently apply `unary` to the same two
contracts. They do not import a singleton effect value from one another. Blot's
shared-effect identity rule makes those separately constructed effects equal
because both the key and normalized operation contract agree. The main example
can therefore handle the consumer's requests with the provider's effect values.
The same `unary` abstraction is reused for `Int -> Option Text` directory
lookups and `Text -> Int` quota reads.

The compiler enforces the request and response carriers of each operation and
requires every source effect to be discharged before the module boundary. It
also treats a changed key or changed operation contract as a different effect.
The rejection fixtures lock down all three boundaries: wrong request input,
contract drift under the same key, and key drift under the same contract.

The compiler does **not** prove that a text key describes the intended business
meaning or that a provider's returned value is semantically correct beyond its
type. Identical qualified keys with identical contracts intentionally denote the
same effect; key governance therefore remains a library/application convention.
Handlers remain ordinary local values, so the `Ada`, `Grace`, and missing runs
also show that a shared effect identity does not imply shared runtime state.

Run the executable with:

```bash
pnpm blot run examples/shared_service_contracts.blot
```

Run the focused contract suite with:

```bash
node --import tsx --test src/node/shared_service_contracts.test.ts
```

The focused suite checks canonical Blot formatting, type/effect closure, the
evaluator golden, emitted-Wasm golden, and the three intentional rejections.
`deno task verify:showcase` includes the supported executable in the
repository's showcase index.
