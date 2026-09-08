# Browser hot reload

A small Node HTTP server keeps one `DevelopmentProject` resident. The browser
runs the emitted Wasm through `DevelopmentRuntime` and retains unchanged unit
instances. This uses Blot's development mode and its ordinary compiler artifact.

From the repository root, with dependencies and the compiler artifact installed:

```sh
pnpm example:hot-reload
```

Open <http://127.0.0.1:8323>. Pass a different port with
`pnpm example:hot-reload 8400`. If the compiler artifact is missing, run
`pnpm compiler:build` once before starting the example. The server does not
invoke Cargo or rebuild the compiler on source edits.

## Try it

1. Enter `21`: the initial formula returns `42` in browser Wasm.
2. In `formula.blot`, change `quantity * 2` to `quantity * 3`. The result
   becomes `63`; the formula instance is replaced and the app instance stays.
3. Edit `message.txt`. The heading changes, both Wasm instances stay, and the
   compiler-build count does not increase.
4. Introduce a syntax error in `formula.blot`. The diagnostic appears while the
   last working formula remains usable. Fix the file to activate the repair.
5. Open a second tab. Each browser starts from the current units, without
   another server compilation. Input values belong to each tab and survive
   source reloads.
6. Restart the server. Its disk cache restores eligible scalar graphs; the page
   reports restored graphs and reused function bodies. Each tab reconnects to
   the complete current build.

`blot.json` declares the two reload boundaries. `main.blot` uses an ordinary
relative import to call `formula.blot`. Both are pure; the browser supplies the
runtime integer argument directly through the ABI 3 export.

## What is reused

The watcher batches editor save events for 35 ms and serializes builds. Known
changed source paths go through `markChanged` on the resident project. Closed
scalar graphs are cached in `.blot/cache/development/`, including ordinary
helpers, generic instances, and recursion. The page distinguishes specialized
and reused bodies. Source is checked again after restart, and initial Wasm units
are still emitted. Delete the cache directory to force a cold start.
Implementation-only provider edits reuse the unchanged app artifact. The page
shows the server's update duration separately from the browser's artifact fetch
and activation duration; neither measurement includes the debounce or guarantees
an iteration-time budget.

The server publishes a metadata snapshot and notifies tabs over server-sent
events. Browsers compare all three unit identities (interface, implementation,
and Wasm), fetch only changed artifacts from immutable URLs, and prepare an
activation before committing it. A save during artifact fetching makes an old
URL return 409; the browser retries from the latest snapshot. Reconnection also
starts from a fresh snapshot, so missed events require no replay log. The server
retains only its current unit artifacts, with no per-client revision history.

A source or manifest error keeps the previous published build. Invalid manifests
are retried on the next save; a valid replacement manifest gets a fresh compiler
session. Changed unit memory resets. Retained unit memory and host-owned input
state survive. This is not general migration of state between changed units.

`message.txt` is a host-loaded resource, not an `@include`. A compile-time
include is an input to Blot checking and needs a rebuild when edited. The
watcher tracks `.blot`, `.txt`, and the project manifest. Restart the server
after editing the HTML or JavaScript host; its browser bundle is built once at
startup using the repository's existing esbuild dependency.

## Verification

```sh
node --import tsx --test --test-timeout=30000 case-studies/hot-reload/serve.test.ts
```

The test copies fixtures to a temporary directory, runs the real HTTP server,
edits files by atomic rename, observes SSE notifications, fetches the emitted
units, and runs their exports. It checks provider replacement, consumer instance
identity, asset-only updates, failed edits, repair, and reads without compiler
work. Timings are printed as observations rather than fixed-speed assertions.
