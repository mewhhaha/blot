# Case studies

These are small programs with real host boundaries, not additions to the
language's feature catalog. Each program declares every authority it uses as a
host effect and compiles through gpufuck to the stable Blot Core Wasm ABI.

Run them from the repository root. A WebGPU adapter is required because the
compiler itself runs on the GPU:

```bash
WGPU_BACKENDS=vulkan deno task case-study grep "@text.contains" LANGUAGE.md
WGPU_BACKENDS=vulkan deno task case-study terminal
WGPU_BACKENDS=vulkan deno task case-study agent
WGPU_BACKENDS=vulkan deno task case-study engine 60
```

The engine also has a browser host:

```bash
WGPU_BACKENDS=vulkan deno task engine
```

## grep

`grep/main.blot` owns matching, iteration, output selection, and the exit count.
The runner owns argument parsing and file access. It grants only four
operations: obtain the pattern, obtain the number of lines, read one line, and
write one matching line. No filesystem handle or path is visible inside blot.

The program returns the number of matching lines. The runner follows grep's
useful exit convention: zero when at least one line matched and one when none
did.

## terminal

`terminal/main.blot` asks for a name and prints a greeting. Its whole interface
is the `Terminal` effect:

```text
read_line : () -> Str
write     : Str -> ()
```

An empty line is treated as an anonymous answer. A richer terminal program
should return an `Option Text` so end-of-input and an intentionally empty line
remain distinct.

## agent

`agent/main.blot` owns the conversation loop and transcript. The host grants a
terminal and a synchronous `Model.complete` operation. The bundled model adapter
is deterministic so the study runs without credentials or network access.

This case deliberately exposes the next ABI question: Core ABI 1 calls host
effects synchronously, while network model APIs are asynchronous. A production
agent therefore needs either a synchronous local model bridge or a future
suspending host-effect ABI; the case study does not disguise that mismatch with
an ambient network call.

## engine

`engine/main.blot` is an entity-component-system running a paddle and three
bouncing blocks, drawn to a canvas.

An ECS normally exists because game state is a large mutable graph and every
system wants a different slice of it. Blot has no mutation, so that framing does
not apply — but the layout an ECS arrives at still does: components in parallel
arrays keyed by entity, and each system a function over the arrays it reads.

What the language adds is that the world does not have to be a value. A `for`
body's `:=` names are its accumulator, so the frame loop *is* the world:

```blot
for ever do
  let remaining = Host.frame ();
  if remaining <= 0 then do break; end;
  axis <- Host.axis;

  positions := control (positions, axis);
  velocities := bounce (velocities, positions, sprites);
  positions := movement (positions, velocities);

  let _ = render (positions, sprites);
  frames := frames + 1;
end;
```

Each system is `store -> store`, and a system that does not rebind a name
provably cannot affect it — the property an ECS usually arranges with
scheduling and declared access. Adding a component means adding a name.

The join helpers hold the only awkward part. `case (at (l, id), at (r, id)) of`
with a tuple pattern is the natural way to write "entities that have both", and
that shape does not lower yet — a tuple pattern in a `case` with a wildcard arm
reaches `a tuple pattern over a literal is not lowered to Wasm yet`. The
helpers nest their `case`s instead, once, so the systems stay one-liners.

`render` is also the one binding here with no `sig`: an effectful arrow's type
includes its row, and a row is printed but never written.

### The host boundary

Four operations, and no canvas handle anywhere in the program:

```text
Canvas.clear   : () -> ()
Canvas.fill    : { .x, .y, .w, .h : Int; .colour : Str } -> ()
Canvas.present : () -> ()
Host.axis      : () -> Int     -- -1, 0, or 1
Host.frame     : () -> Int     -- frames remaining; 0 stops the loop
```

`Canvas.fill` takes a record, so it flattens to six core parameters in
*canonical* field order — `colour, h, w, x, y`, not the order the program wrote
them. `docs/abi.md` is the authority on that; both hosts below depend on it.

### Two hosts

`deno task case-study engine [frames]` is the headless one. It rasterizes to a
character grid, scripts the input (hold right, then let go), and prints the last
frame, so the study runs in CI and its output is a value a test can compare.

`deno task engine` serves `index.html` on port 8321 against a real
`CanvasRenderingContext2D`, with arrow keys for input.

That one has a mismatch to resolve: ABI 1 calls host effects synchronously, and
`requestAnimationFrame` is not something a synchronous call can wait for. So the
module runs in a worker, where blocking is allowed, and `Host.frame` parks on
`Atomics.wait` until the page's animation frame bumps a shared counter. The
program keeps its own frame loop, the page keeps its refresh rate, and neither
has to know about the other. `SharedArrayBuffer` is why `serve.ts` sends the
cross-origin isolation headers.

This is the same seam the agent study names: a suspending host-effect ABI would
remove the worker. A worker is a reasonable answer in the meantime, and unlike
the agent's asynchronous model call it does not need the program to change.
