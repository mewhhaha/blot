# Changelog

## Unreleased — direct calls for pure callees

### Symptom

Calls from suspending functions into pure (non-suspending) callees cost about
100 us each: a game frame making roughly 300 such calls measured 4.48 ms mean
against 0.12 ms after the fix, with identical output. The same function bodies
measured under 1 us per call when invoked outside a suspension context.

### Root cause

The suspension emitter routed every call to a framed function through the full
frame dance — spill the live set, heap-allocate the callee frame, store
arguments, dispatch through the poll loop, restore the result, free the frame —
even when the callee cannot suspend and already has a direct internal body that
never touches frames.

### What changed

- Non-tail calls to non-suspending framed callees now emit direct Wasm calls to
  their existing internal bodies. Ownership follows the specified direct-callee
  contract (consume argument references, transfer result references).
- Tail calls keep frame reuse, preserving constant-space recursion.
- Functions reachable from worker callbacks keep the frame dance: framed calls
  are cooperative yield points, and routing them direct made admitted-kernel
  cancellation untimely (the cancel test hung instead of draining in 200 ms).
- Measured on the gdev game loop: 4.48 ms to 0.12 ms mean frame time (300
  frames), rendered matrices bit-identical to before.

## Unreleased — Helix timeout fix (formatter/LSP overhaul)

### Symptom

Editing larger Blot files in Helix hung the language server: formatting a 16 KB
file took over a minute end to end, any request behind it waited, and the client
timed out. A burst of keystrokes ahead of a formatting request produced a 69 s
formatting latency through the real server.

### Root causes

1. The formatter re-parsed after every applied fix (one-fix-per-reparse), so
   cost grew superlinearly with construct count: 212 ms for 20 overlong arrays,
   1.6 s for 60, 10.9 s for 150 (measured).
2. The server serialized every request and every background diagnostic pass
   through one in-process queue, so a slow format or a typing burst blocked all
   later requests head-of-line.
3. Even with lanes, one thread ran everything: the first semantic analysis of a
   framework graph takes seconds synchronously inside the compiler, and lanes
   interleave only at await points — a format landing mid-analysis froze with it
   (measured 5.2 s behind a 6.6 s cold analysis).

### What changed

- Fixed-cost formatter: one buffer snapshot builds a typed formatting IR, the IR
  prints once through a document algebra, and changed output validates with
  exactly one output parse. Changed output costs at most two frontend
  invocations (one with a matching supplied snapshot); unchanged output parses
  once and returns. Output must lower to the same representation as the input
  (modulo spans, empty-block collapse, and compiler-minted name suffixes) or the
  pipeline throws a typed invariant failure. Statement width counts trailing
  comments, matching the delimited width rules — previously the two planners
  disagreed and the layout oscillated between passes.
- Coordinator language server: text sync applies immediately while requests flow
  through a syntax lane (formatting only) and a semantic lane (every other
  request and diagnostics), one active job per worker host, with freshness
  gates, deadlines, a watchdog, and crash reconstruction. The shipped entries
  run worker-backed — Deno workers and Node worker threads, one thread per lane
  — so analysis blocks only its own thread; format jobs carry their own text to
  the compiler-free syntax worker and need no service replica. Inline hosts
  remain for tests and embedders that inject their own lanes.
- Content-keyed snapshots and caches (frontend revision key, staged overlays,
  scratch validation sessions) replace eager per-request loads.
- Providers degrade on broken source inputs (check diagnostics, unloadable
  modules, corrupt capsules, missing files): hover, signature help, and
  definition answer null; completion, inlay hints, document symbols, references,
  and code actions answer empty; rename refuses. Operational failures (missing
  compiler artifact, invariant breaks) still fail explicitly, and formatting
  never degrades.
- Installer keeps `auto-format = true` with no timeout override.

### Before / after (measured this release)

Machine: AMD Ryzen 7 7800X3D, linux-x86_64, Deno 2.9.6. Formatter cases are
overlong-array sources; LSP burst is didOpen + 10 rapid didChange + one
formatting request, latency from request send to response.

| Case                           | Before                       | After                        |
| ------------------------------ | ---------------------------- | ---------------------------- |
| Format 20 arrays (warm)        | 212.3 ms                     | 15.9 ms                      |
| Format 60 arrays (warm)        | 1578.0 ms                    | 60.2 ms                      |
| Format 150 arrays (warm)       | 10905.7 ms                   | 151.0 ms                     |
| Format 500 / 1000 arrays       | not measured (prohibitive)   | 651.9 ms / 1.40 s            |
| Formatter frontend invocations | unbounded (per applied fix)  | exactly 2 (1 when unchanged) |
| LSP burst, medium doc          | 172.9 ms                     | 105.2 ms                     |
| LSP burst, large doc (16 KB)   | 69289.2 ms                   | 579.3 ms                     |
| Format during cold analysis    | 5167 ms (frozen on 1 thread) | 32 ms (own thread)           |

### Intentional behavior changes

- Value providers return empty results instead of request errors when a
  dependency is missing or the buffer is unparseable (previously load failures
  propagated as request errors — raw filesystem errors for missing inputs, check
  diagnostics for broken buffers — including mid-typing).
- Overlong bindings whose joined line overflows only because of a trailing
  comment now move the value as a whole to the next line (previously the
  statement and value planners oscillated; output matches the retired formatter
  byte for byte on that shape).
- `audit:lints` excludes `value-rejected/` pathology directories alongside
  `pending/`, `rejected/`, and `traps/` (24/24 never analyze).

### Remaining limitations

- Diagnostics and workspace symbols still propagate a missing-input failure
  instead of degrading: no honest degrade target exists without unattributed
  diagnostics, so the last-good publish stands. Attribute the failure to its
  import span before changing this.
- Clients without `codeAction/resolve` receive eagerly validated edits for at
  most 32 deterministically ordered candidates per request, with no overflow
  marker. Resolve-capable clients are unaffected.
- Stale resolves stay asymmetric: single-fix returns empty edits while fix-all
  errors asking for fresh actions.
- `spec/COMPILER.md` is unchanged: no pass boundary, trusted fact, certificate,
  target relation, or compiler benchmark boundary moved. Host contracts moved to
  `spec/WORKSPACE_GRAPH.md` (staged overlays, disk refresh, workspace closure)
  and `spec/FRONTEND.md` (buffer snapshot identity). No language-surface change
  was made; `LANGUAGE.md` is untouched.
