# Development projects

Development mode compiles one source graph into independently reloadable Wasm
units. It keeps one compiler session resident, reuses unchanged checked modules
and unit artifacts, and reports the exact units a host must replace.

This mode does not change Blot imports or source semantics. A production
`blot build` still emits one whole-program artifact.

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
must name one declared unit.

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
deno run --allow-read --allow-env src/cli.ts dev \
  case-studies/engine/browser.blot.json
```

The command compiles and reports `changed`, `retained`, and `removed` units. It
does not launch an application. A failed edit prints its diagnostic and leaves
the watcher alive. Changing the manifest creates a fresh project session only
after the replacement project builds successfully.

Known filesystem changes take the incremental path. An embedding host should
call `markChanged(path)` before `build()` when it already knows which files a
watch event touched. Editor integrations may use `setOverlay` and `clearOverlay`
instead.

## Activating builds

`DevelopmentProject` owns compilation and `DevelopmentRuntime` owns live Wasm
instances:

```ts
import { DevelopmentProject, DevelopmentRuntime } from "@mewhhaha/blot";

const project = await DevelopmentProject.create("./blot.json");
const runtime = new DevelopmentRuntime();

try {
  const build = await project.build();
  await runtime.activate(build);

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

Activation validates the full build delta, manifest digest, embedded ABI
manifest, link signatures, and unit classifications before replacing live
instances. It instantiates every changed unit first and commits the replacement
only when every candidate succeeds. Changed units receive fresh memory and
module state. Retained units keep their existing instances. Removed units leave
the runtime at the same commit point.

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

The benchmark requires exactly one changed unit and a p95 below 100 ms on the
reference machine. It does not claim the same latency for interface changes or
newly demanded subsystems. See
[`experiments/development-bench/README.md`](../experiments/development-bench/README.md)
for the exact workload.
