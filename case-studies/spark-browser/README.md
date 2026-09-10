# Browser event actor

Run `pnpm example:spark-browser` and open <http://127.0.0.1:8324>. Build the
compiler once with `pnpm compiler:build` if its artifact is missing. The
resident development server recompiles changed source; it does not rebuild the
compiler on saves.

`main.blot` owns the input policy and published-result counter. The host passes
an explicit `io` record containing an executor, input-event source, clock, HTTP
capability, and view. Source chooses `#Latest` delivery, fetches the heading
once, and registers cleanup before subscribing.

- Type a quantity. Blot uses `Select` to wait for 150 ms of quiet input, then
  starts a calculation in a child scope. A deliberate 300 ms simulated service
  delay makes cancellation visible; the formula runs in a reusable Web Worker.
- Type again while it says **Calculating**. Source races incoming events against
  the completion channel, cancels and drains obsolete work, then debounces the
  newest value. Only completed current work publishes. Input wins when both
  selection arms are ready. The page shows activity, the latest 40 transitions,
  active and retained Spark jobs, and completed worker jobs.
- Change `quantity * 2` to `quantity * 3` in `formula.blot`. The runtime
  prepares the replacement, drains the old actor and its cleanup, then starts a
  fresh actor. The app Wasm instance and input stay; the result counter
  restarts.
- Edit `message.txt`. The heading updates without source compilation.
- Stop and restart the actor with the button, including during calculation.
  Cleanup detaches its subscription and cancels pending timers and jobs.
- Make an invalid source edit. The last successful activation keeps running.

The page reports observed server and activation timings. COOP/COEP headers are
set for browser worker isolation. Workers receive precompiled unit bundles once
per revision and keep private Wasm heaps. No job compiles source; each worker
instantiates the already compiled Wasm program once per cached revision. The
worker cache retains at most sixteen programs. Callback values remain inside
their compiled unit, and reload selects the new provider even when the app
module stays unchanged.

Verify the HTTP, Wasm, event, worker, cancellation, and reload paths with:

```sh
pnpm test:live-actor
```

The actor test supplies a controlled clock and checks debounce replacement,
cancellation of obsolete work, the latest published value, and zero active or
retained jobs after stopping. Development tests check revision draining and
worker provider replacement. These tests do not replace an interactive browser
check.

The selected child-scope result has an explicit `Select.Selection Int`
annotation. Without it, the generated outer loop currently loses its settled
signature during lowering. Debounce uses explicit tail recursion; the equivalent
loop with mixed early `Some`/`None` returns currently narrows its return
signature incorrectly. These compiler limitations remain separate follow-up
work.
