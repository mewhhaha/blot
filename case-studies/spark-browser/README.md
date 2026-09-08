# Browser event actor

Run `pnpm example:spark-browser` and open <http://127.0.0.1:8324>. Build the
compiler once with `pnpm compiler:build` if its artifact is missing. The
resident development server recompiles changed source; it does not rebuild the
compiler on saves.

`main.blot` owns an event loop and its received-event counter. The host passes
an explicit `io` record containing an executor, input-event source, clock, HTTP
capability, and view. The source chooses `#Latest` delivery, fetches the heading
once, and registers its cleanup before subscribing.

- Type a quantity. Blot awaits an input event and a short clock delay, then
  calls the separate formula unit in a reusable Web Worker and updates the view.
  Each calculation has a child scope, drained before the next input.
- Change `quantity * 2` to `quantity * 3` in `formula.blot`. The runtime
  prepares the replacement, cancels and drains the old actor, runs its cleanup
  with the old provider still installed, and then starts a fresh actor. The app
  Wasm instance and input stay; the actor's event counter restarts.
- Edit `message.txt`. The heading updates without source compilation.
- Stop and restart the actor with the button. Cleanup detaches its subscription;
  input events cannot resume the stopped invocation.
- Make an invalid source edit. The last successful activation keeps running.

The page reports observed server and activation timings. COOP/COEP headers are
set for browser worker isolation. Workers receive precompiled unit bundles once
per revision and keep private Wasm heaps. No job compiles source or Wasm. The
worker cache retains at most sixteen programs; reload chooses the new provider
even when the app module stays unchanged. Suspending links inherit the caller
scope. Callback values themselves remain inside their compiled unit.

Verify its real HTTP, Wasm, event, worker, and cleanup path with:

```sh
node --import tsx --test --test-timeout=30000 case-studies/spark-browser/browser_contract.test.ts
node --import tsx --test --test-timeout=30000 src/node/development_async.test.ts
```

The tests do not replace an interactive browser check. No interactive browser
was connected during implementation.
