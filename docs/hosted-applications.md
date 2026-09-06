# Hosted Blot applications

Blot compiles the guest's logic; the host supplies explicitly selected platform
operations. The production compiler remains Rust/Wasm. These Node APIs do not
implement a checker, evaluator, lowering pass, or alternative source semantics.

## Installed package versus contributor checkout

An installed npm distribution includes JavaScript, declarations, the matching
compiler Wasm, and the prelude snapshot. Use its `blot` executable:

```sh
npm install @mewhhaha/blot
npx blot --help
npx blot check main.blot
npx blot build main.blot
npx blot run main.blot
npx blot pack library/blot.json
npx blot explain main.blot 3:8
npx blot explain --json main.blot 3:8
```

The commands describe the distribution produced by this source revision; they do
not assert that a new version has already been published to npm. Contributor
checkouts instead use `pnpm install` and a matching `pnpm compiler:download` or
`pnpm compiler:build`, then `pnpm blot ...`. Compiler download is a contributor
workflow requiring access to the repository's Actions artifacts. Package users
do not need that workflow, a TypeScript loader, Cargo, or Deno to run the CLI.

`pack` invokes the existing checked package builder. Every export needs a
`source` and `built` target in its version-4 package manifest. All export graphs
are checked and encoded before any output is written. This prevents a type error
in a later export from overwriting an earlier artifact; it is not a transaction
across filesystem failures during the final writes. Capsule bytes remain
deterministic for the same checked graph. The consumer still performs its own
checking and specialization; a capsule is not final Wasm.

`explain` reads one source snapshot and asks the real Rust compiler for an
explanation at a one-based line and UTF-16 column. JSON output preserves that
location and the compiler's original fact. Missing evidence is reported as
missing, not inferred by the CLI. A target-preflight explanation is module-level
and is not presented as an invented diagnostic at line 1. This exposes existing
type, specialization, ownership, and target facts; it does not implement native
typed holes or synthesize a missing refinement proof.

## Scalar host adapter

```ts
import { Compiler, instantiateArtifact } from "@mewhhaha/blot";

const compiler = await Compiler.create();
try {
  const artifact = await compiler.compile("./main.blot");
  const guest = await instantiateArtifact(artifact);
  try {
    console.log(guest.call("score", [21n]));
  } finally {
    guest.destroy();
  }
} finally {
  compiler.destroy();
}
```

The adapter supports closed ABI 2.0 artifacts with scalar input parameters:
`Int` uses JavaScript `bigint`, `F32`/`F64` use `number`, `Bool` uses `boolean`,
and `Unit` uses `null`. Signatures requiring more than 16 flattened input lanes
are refused rather than incorrectly passed as scalar arguments. The argument
list follows the manifest's logical parameters, not flattened machine lanes. A
`Unit -> Int` export is called with `[null]`, whereas an exported constant takes
`[]`. Out-of-range i64 arguments are rejected instead of silently wrapping or
rounding through Number.

Results use the existing canonical decoder shared with `blot run`: scalars and
text become JavaScript values, arrays become arrays, records contain a field
Map, and variants/seals retain explicit kind/name/payload data. Indirect values
are copied before `cabi_post_*` runs in a `finally` block. A later guest call
cannot invalidate a previously returned text or aggregate value. The adapter
checks exact embedded/sidecar manifest agreement before exposing any exports.

Supply synchronous host operations through an explicit Map of capabilities:

```ts
import type { HostOperation } from "@mewhhaha/blot";

const operations = new Map<string, HostOperation>([
  ["read", () => 42n],
  ["write", (value) => {
    console.log(value);
    return null;
  }],
]);
const capabilities = new Map([["Device", operations]]);
```

Pass `capabilities` as the second argument to `instantiateArtifact`. Both
missing and unused capabilities/operations are rejected. The maps are
snapshotted before asynchronous Wasm compilation. The actual Wasm import set
must match the manifest. This adapter currently accepts only scalar
host-operation parameters and results with unrestricted ownership; it refuses
aggregate imports, owned resource transfers, and split development-unit links.
Those restrictions belong to this adapter, not to the language's complete ABI 2
support.

A handler must return synchronously. Returning a Promise is rejected even for a
Unit operation, whose result might otherwise be discarded unnoticed. Calling an
async JavaScript function can already start work before that rejection; the
adapter cannot undo host actions. Reentrant guest calls and destroying the
instance during a guest call are refused. `destroy` invalidates subsequent calls
and releases the adapter's instance reference; it does not run
application-specific finalizers or interrupt a nonterminating synchronous call.

## Live report

The executable application at `case-studies/live-report/serve.ts` runs without
WebGPU, network credentials, or an external service:

```sh
node --import tsx case-studies/live-report/serve.ts
```

Its fixed browser page sends decimal quantities to a loopback HTTP host. Blot
owns the heading and scoring function; the host owns HTTP and file watching.
Editing modules or the included heading file prepares a candidate. Compilation
failure, candidate startup traps, closure of the host, and superseding requests
cannot replace the last validated running report. Existing tests separately
cover unsaved editor overlays and shared include invalidation.

This is a usable demonstration of the hosted direction, not a production data
analytics framework. Its score-at-zero activation check is an explicit smoke
policy, not proof that all quantities terminate or avoid traps.

## Boundaries retained

ABI 2 host effects are still synchronous. This change does not add guest
suspension, a scheduler, continuation serialization, asynchronous cancellation,
or a WASI Component Model adapter. A future suspending ABI needs an explicit
version, continuation ownership, failure/cleanup rules, and reload interaction;
a Promise wrapper is not an implementation of those semantics.

Compilation can execute compile-time code and read declared includes and
packages. Effects expose dependencies but are not a complete sandbox. This host
adapter expects compiler-produced artifacts and trusted host code. Deploying
untrusted programs additionally needs compilation/process budgets, filesystem
policy, runtime interruption, memory limits, and a separately reviewed threat
model. Lexical path confinement is not filesystem isolation.
