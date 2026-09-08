# Development projects

Development mode compiles one source graph into independently reloadable Wasm
units. It keeps one compiler session resident, reuses unchanged checked modules
and unit artifacts, and reports the exact units a host must replace.

This mode does not change Blot imports or source semantics. A production
`blot build` still emits one whole-program artifact.

## Browser example

```bash
pnpm example:hot-reload
```

Open `http://127.0.0.1:8323`. The
[hot-reload example](../case-studies/hot-reload/README.md) serves a two-unit
development project from a small Node HTTP server. Edit `formula.blot` to
replace only its Wasm unit; edit `message.txt` to update the page without a
compiler build. The browser retains the app instance and input value, displays
compilation failures, and reconnects using the latest snapshot. The page reports
server update time, fetch-and-activation time, compiler build count, and the
names of replaced and retained units.

The normal compiler distribution supports development projects. The separate
`compiler:build-development-profile` task adds compiler profiling counters; it
is not needed to run this example. Source edits still incur checking; unchanged
closed scalar call graphs can reuse specialization, and unchanged unit artifacts
and browser instances are retained. Ordinary static resources bypass compilation.

## Caching across restarts

The HTTP example and `blot dev` persist graph memos in
`.blot/cache/development/`. Deleting that directory is safe. The library defaults
to memory caching; opt into persistence with named options:

```ts
const project = await DevelopmentProject.create("./blot.json", {
  compiler: {},
  cache: { mode: "disk" },
});
```

Use `{ mode: "memory" }` or `{ mode: "disabled" }` to select the other modes.
Disk mode accepts an optional `directory`. Watch hosts should ignore paths for
which `project.isCachePath(path)` is true.

The current cache covers closed scalar functions, their helpers, generic
instances, and recursive calls without runtime captures or effects. It validates
cached graphs in Rust and still checks source after restart. Changed imports,
includes, static captures, call demands, or representation prefixes force misses;
an unchanged function signature alone is insufficient. Other functions compile
normally. Restart still emits initial Wasm units and gives each browser a
complete initial build.

`build.work` separates specialized bodies, reused bodies, and emitted units.
`build.cache` reports disk loads, rejected entries, writes, and actual warnings.
Graph entries have a 64 MiB encoded resident budget (plus object overhead) and a
512 MiB disk budget. Compiler/prelude/target identities separate namespaces;
atomic writes and digest checks make interrupted or corrupt entries disposable.

## Project manifest

A project uses a `blot-project` manifest:

```json
{
  "schema": "blot-project",
  "version": 1,
  "entryUnit": "game",
  "units": {
    "game": "./main.blot",
    "simulation": "./simulation.blot"
  }
}
```

Unit names start with a lowercase letter and may contain lowercase letters,
digits, and `-`. Every source path must be a relative `.blot` path confined to
the manifest directory. Two units cannot name the same root, and `entryUnit`
must name one declared unit. Confinement uses the same host-native, lexical path
check as [package exports](../spec/PACKAGES.md#2-logical-and-physical-identity):
filename characters cannot choose the separator, and another Windows drive or
UNC share is outside the root. This is not a symlink-resolving filesystem
sandbox.

The configured roots are reload boundaries, not a second module system. Source
still uses ordinary relative imports:

```blot
const simulation = import "./simulation.blot"
return simulation.next 41
```

The compiler specializes the whole reachable program before splitting it. A
direct call across configured roots becomes a development link. Local calls stay
local.

## Watch compilation

The Node CLI watches the manifest directory and prints each successful build:

```bash
pnpm blot dev case-studies/engine/browser.blot.json
```

The Deno CLI exposes the same command when embedded with filesystem read and
watch permissions:

```bash
deno run --allow-read --allow-write --allow-env src/cli.ts dev \
  case-studies/engine/browser.blot.json
```

The command compiles and reports `changed`, `retained`, and `removed` units. It
does not launch an application. A failed edit prints its diagnostic and leaves
the watcher alive. Changing the manifest creates a fresh project session only
after the replacement project builds successfully.

Known filesystem changes take the incremental path. An embedding host should
call `markChanged(path)` before `prepareBuild()` or `activate(runtime)` when it
already knows which files a watch event touched. Editor integrations may use
`setOverlay` instead. Roots and overlays have separate lifetimes, so closing an
editor document releases both in that order:

```ts
await project.releaseRoot(path);
await project.clearOverlay(path);
```

Releasing first also permits a diskless, unsaved document to close without a
filesystem read.

## Activating builds

`DevelopmentProject` owns compilation and `DevelopmentRuntime` owns live Wasm
instances:

```ts
import { DevelopmentProject, DevelopmentRuntime } from "@mewhhaha/blot";

const project = await DevelopmentProject.create("./blot.json");
const runtime = new DevelopmentRuntime();

try {
  const build = await project.activate(runtime);

  const run = runtime.entryInstance.exports["blot:default"];
  if (typeof run !== "function") {
    throw new Error("development entry unit has no default export");
  }
  console.log(run());
} finally {
  project.destroy();
}
```

Pass a callback to `DevelopmentRuntime` when units import host effects. The
callback receives the unit name and a `memory()` accessor for that unit's
canonical memory:

```ts
const runtime = new DevelopmentRuntime(({ unit, memory }) => ({
  "blot:host/Clock": {
    frame: () => {
      console.log(unit, memory().buffer.byteLength);
      return 1n;
    },
  },
}));
```

Do not call `memory()` while the unit is being instantiated. The instance does
not exist until instantiation finishes.

`project.activate(runtime)` is the publication boundary. It prepares a project
build, validates the full delta, checks the manifest and Wasm digests, compiles
and instantiates every changed unit, and only then publishes the project and
runtime candidates synchronously. The project's committed unit baseline and the
runtime's revision and instances remain unchanged during preparation. A failed
validation, host import callback, compilation, or instantiation aborts both
candidates, so the same edit can be retried against the previous committed
state.

The project keeps newly compiled bytes in a private artifact reservoir when a
candidate aborts. A retry may therefore resolve an identity-only compiler cache
hit without treating that artifact as committed. Changed and retained
classification always compares against the last committed project baseline. The
lower compiler-host call has its own narrower transaction: Rust stages unit
artifact-cache replacements while Node copies and hashes the result, then Node
commits that cache before returning the prepared project build. If copying,
identity validation, or hashing fails, Rust retains its former committed map and
the next call recompiles the abandoned replacements. Caller-visible buffers and
capability arrays do not alias either private cache.

`runtime.prepareActivation` accepts an external transition as `unknown` and
validates it before issuing a runtime-owned activation capability. An HTTP host
can reconstruct the byte arrays without manufacturing a project commit token.

The runtime copies the complete external build transition before its first
asynchronous step. It hashes and compiles those private bytes, then recomputes
the canonical revision from the entry unit and the final units' interface,
implementation, and Wasm identities. Mutating a caller-owned artifact while a
candidate is preparing cannot change what eventually commits.

Development edges are derivable from the final units' ABI manifests. The runtime
derives them again, requires every linked provider to be present, and requires
exact agreement with the reported edge set. The revision does not hash the edge
list separately because each interface digest already commits to its unit's
manifest and links. Before requesting host imports, the runtime also requires
the compiled provider module to export a function under each linked manifest
name and each declared post-return name. The manifest remains the authority for
the logical function signature because JavaScript's Wasm reflection exposes
export names and kinds, not function types.

Changed units receive fresh memory and module state. Retained units keep their
existing instances. Removed units leave the runtime at the same commit point.
The host import callback runs during preparation and may run again after an
aborted candidate, so external work performed by that callback must tolerate a
retry.

A project and runtime each permit one candidate at a time. Source mutations,
another preparation, and project destruction are rejected while a build is
preparing or pending. `commitBuild`, `abortBuild`, `commitActivation`, and
`abortActivation` accept only the exact pending candidate from their owner and
reject stale, copied, or already consumed candidates.

A build-only host prepares its report before publishing the compiler baseline:

```ts
const build = await project.prepareBuild();
try {
  await publishBuildReport(build);
} catch (error) {
  project.abortBuild(build);
  throw error;
}
project.commitBuild(build);
```

A host that needs to coordinate another reversible resource can use
`runtime.prepareActivation(build)` directly. It must abort both candidates if
any later preparation fails, then call `project.commitBuild(build)` and
`runtime.commitActivation(activation)` without an `await` or other fallible host
work between them. The runtime does not expose candidate instances before
commit.

Values crossing a development link are copied between unit memories. The
supported boundary is the closed first-order ABI subset: unit, integers, floats,
booleans, text, arrays, records, variants, and seals. Functions, SIMD vectors
and masks, capabilities, continuations, Scratch, and other compiler-private
representations cannot cross a reload boundary. The compiler reports a target
refusal for such a split.

An implementation-only provider edit replaces that provider. A changed link
interface also rebuilds its direct consumers. Edits that change demand may
change the unit set and correctly require more work.

Always call `destroy()` when the project is no longer used. It releases the
resident compiler session. `DevelopmentRuntime` has no explicit teardown;
dropping it releases its instances.

## Latency gate

The checked development benchmark generates a 5 MiB project with 20 reachable
units, edits one small provider without changing its interface, and measures 20
warm rebuilds:

```bash
pnpm benchmark:development
```

The benchmark requires exactly one changed unit, a p95 below 100 ms, and less
than 128 MiB of resident-memory growth after initial activation on the reference
machine. It does not claim the same latency for interface changes or newly
demanded subsystems. See
[`experiments/development-bench/README.md`](../experiments/development-bench/README.md)
for the exact workload.

A compiler built with the `development-profile` feature also returns
`DevelopmentBuild.developmentProfile`. Its checkpoints report compiler Wasm
pages and solver arena counts for benchmark diagnosis. Production compiler
artifacts leave this field `undefined`.
