# Interpretable policies

`examples/lib/interpretable_policy.blot` separates a policy's structure from the
result a caller wants to observe. The concrete example models request admission:
administrators are admitted directly, while ordinary members must satisfy both a
region requirement and a refined quota policy.

The core type is:

```blot
const Policy = fn Subject =>
  @forall (fn Result => (Algebra Result, Subject) -> Result)
```

A policy therefore cannot pick its own result representation. Every use supplies
an `Algebra Result`, and the policy must work for that arbitrary `Result`. The
example reuses one policy with two interpreters: `Algebra Bool` computes an
admission decision, while `Algebra Trace` records every leaf result and the same
composed Boolean outcome. No dynamic tag registry, cast, or host-language AST is
needed.

`check` turns a typed predicate into a leaf. `both` and `either` combine policies
only when their `Subject` types agree, while `contramap` lifts a policy through a
projection such as `Request -> Profile`. The application therefore defines its
profile rules once and reuses them under the wider request type. `Quota = 1..100`
remains a real compiler-enforced refinement at construction boundaries.

The compiler enforces the shared subject carrier, the projection result required
by `contramap`, and refined request data. It does not prove application laws such
as whether a label accurately describes its predicate, nor Boolean-algebra laws
for arbitrary user-supplied `Algebra` implementations.

## Strict composition tradeoff

`both` and `either` call both child policies before passing their results to the
algebra. That is intentional for the tracing interpreter: an administrator with
an invalid profile is admitted, but its trace still records `+admin`, `-region`,
and `-quota<=80`. It also means this API does not promise short-circuiting.
Blot has an explicit affine deferred arrow (`~>`) when call-by-name demand is the
actual contract; changing this policy representation to use deferral would be a
different abstraction with different ownership/effect behavior.

## Run

With a Rust/Wasm compiler artifact matching the checkout:

```sh
pnpm blot check examples/interpretable_policies.blot
pnpm blot run examples/interpretable_policies.blot
pnpm blot build examples/interpretable_policies.blot
pnpm blot lint --check examples/lib/interpretable_policy.blot examples/interpretable_policies.blot
node --import tsx --test src/node/interpretable_policies.test.ts
node scripts/check_abstractions.mjs
```

The focused suite checks the exact principal result type and empty effect row,
canonical Blot formatting, evaluator and emitted-Wasm goldens, and three static
rejections: incompatible subjects, a bad `contramap` projection, and an invalid
quota refinement.
