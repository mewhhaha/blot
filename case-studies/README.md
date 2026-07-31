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

The engine also has a browser host, with hot reload:

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

`engine/main.blot` is a small 3D engine: an entity-component-system, a camera
with two lenses, fixed-point maths, and hot reload for both the scene and the
code. It draws to a canvas through four host capabilities and reaches nothing
else on the page.

### The world is the frame loop

An ECS normally exists because game state is a large mutable graph and every
system wants a different slice. Blot has no mutation, so that framing does not
apply — but the layout an ECS arrives at still does: components in parallel
arrays keyed by entity, each system a function over the arrays it reads.

What the language adds is that the world does not have to be a value. A `for`
body's `:=` names are its accumulator, so the frame loop *is* the world:

```blot
for ever do
  let remaining = Host.frame ();
  if remaining <= 0 then do break; end;

  current <- Assets.generation;
  if current != generation then do
    transforms := load_transforms ();
    models := load_models ();
    generation := current;
  end;

  let camera = camera_of (View.yaw (), View.pitch (), View.distance (), View.lens ());
  transforms := advance transforms;
  let _ = render (transforms, models, camera);
end;
```

A system that does not rebind a name provably cannot affect it — the property
an ECS usually arranges with scheduling and declared access. Adding a component
means adding a name.

### Fixed point, and a table the artifact never computes

Blot has one numeric type and it is an integer, so this is a fixed-point engine
at `ONE = 4096`. `lib/math.blot` needs sine and cosine, and gets them from a
Taylor series that runs in the *comptime evaluator*: `const` forces the series
to be evaluated while compiling, so the table reaches WebAssembly as data and
the series that produced it is not in the artifact. The checker even knows the
exact set of values a lookup can return — it prints as a union of 65 singletons.

Accuracy is what you would want: `sin 32` is `2897` against an exact 2896.3, and
`sin 64` is `4096` to the last bit.

### 2D is the same renderer with the lens switched

The camera carries a lens, and `to_screen` is the only place it matters:

```blot
const to_screen = (view, camera) =>
  if camera.lens == 0
  then { .x = CX + view.x * FOCAL / view.z; .y = CY - view.y * FOCAL / view.z; }
  else { .x = CX + M.mul (view.x, camera.zoom); .y = CY - M.mul (view.y, camera.zoom); }
  end;
```

A perspective divide, or no divide. Sprites follow the same rule: a 2D texture's
size divides by depth under one lens and does not under the other, so it is a
billboard in 3D and a plain sprite in 2D without a second code path. Press `L`
in the browser to switch mid-flight; the guest reads the lens every frame, so
nothing reloads.

### Hot reload, two kinds

```bash
WGPU_BACKENDS=vulkan deno task engine        # http://localhost:8321
```

**Assets.** Edit `assets/scene.json` and the server re-reads it and bumps a
generation. The guest compares that generation each frame and rebuilds its
stores from the new scene. No compiler runs and the module is untouched — the
reload path is the same fold as the first load, so there is no second path to
keep correct.

**Code.** Edit `main.blot` or `lib/math.blot` and the server rebuilds the module
and the page swaps in a new worker. The camera survives, because the camera was
never in the guest: `View` is a host capability backed by the page's pointer and
wheel. A rebuild that fails leaves the last good module running and shows the
diagnostic on the page.

One `BlotCompilerSession` is held for the life of the server, so a rebuild is a
compile and not a device acquisition.

### The host boundary

```text
Canvas.clear/present : () -> ()
Canvas.tri           : { ax, ay, bx, by, cx, cy, depth, shade : Int; colour : Str } -> ()
Canvas.sprite        : { x, y, size, depth : Int; texture : Str } -> ()
View.yaw/pitch/distance/lens : () -> Int
Assets.generation/count      : () -> Int
Assets.entry         : Int -> { kind, x, y, z, scale, spin : Int; colour : Str }
Host.frame           : () -> Int
```

The guest projects geometry and hands over triangles with a view depth; sorting
them is the host's job. That is the same split a depth buffer makes, and it is
why the guest never needs one.

Record parameters flatten in *canonical* field order, which is alphabetical and
not the order the program wrote them — `Canvas.tri` arrives as
`ax, ay, bx, by, colour, cx, cy, depth, shade`. `docs/abi.md` is the authority;
getting it wrong silently transposes the geometry.

### Two hosts

`deno task case-study engine [frames] [ortho]` is the headless one. It
rasterizes to a character grid with a painter's algorithm and a scanline fill,
reads the same `scene.json`, and prints the last frame — so the study runs in CI
and its output is a value a test can compare.

`deno task engine` serves the browser host, which has a real
`CanvasRenderingContext2D`, an orbit camera on the pointer, and procedural
textures for the sprite path.

The browser one has a mismatch to resolve: ABI 1 calls host effects
synchronously, and `requestAnimationFrame` is not something a synchronous call
can wait for. So the module runs in a worker, where blocking is allowed, and
`Host.frame` parks on `Atomics.wait` until the page's animation frame bumps a
shared counter. The camera and lens live in that same `SharedArrayBuffer`, so
input costs no round trip. `serve.ts` sends the cross-origin isolation headers
that `SharedArrayBuffer` requires.

This is the seam the agent study names: a suspending host-effect ABI would
remove the worker.

### What the language made awkward

- **A two-component join wants a tuple pattern.**
  `case (at (l, id), at (r, id)) of (#Some a, #Some b) => …` is how this should
  read, and it does not lower — *"a tuple pattern over a literal is not lowered
  to Wasm yet"*. The join helpers nest their `case`s instead, once, so the
  systems stay one expression each.
- **An effect row cannot be written.** `render` is the one binding here with no
  `sig`: an effectful arrow's type includes its row, and a row is printed but
  never written.
- **No SIMD, because no floats.** gpufuck's SIMD is f32x4 and blot has no
  floating-point type at all — no `@float.*` primitives, no float row in the
  ABI. That is why the maths here is fixed point. Reaching f32x4 would mean
  giving blot floats first, in the value domain, the lattice, the ABI, and the
  comptime evaluator, so that all three executions still agree.
