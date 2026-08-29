# Case studies

These programs intentionally lean on unknown-first inference: function
parameters, results, and effect rows remain open until their bodies and calls
constrain them. The engine uses `@satisfies` only at the genuinely ambiguous
empty-store boundary; the agent, grep, and terminal cases need no type
declarations beyond their host capability values. This is the intended
balance—constraints where representation is otherwise unknowable, inference
everywhere else.

These are small programs with real host boundaries, not additions to the
language's feature catalog. Each program declares every authority it uses as a
host effect and compiles through the GPU conformance backend to the stable Blot
Core Wasm ABI.

Run them from the repository root. These executable conformance hosts require a
WebGPU adapter:

```bash
WGPU_BACKENDS=vulkan deno task case-study grep "@text.contains" LANGUAGE.md
WGPU_BACKENDS=vulkan deno task case-study terminal
WGPU_BACKENDS=vulkan deno task case-study agent
WGPU_BACKENDS=vulkan deno task case-study engine 60
WGPU_BACKENDS=vulkan deno task case-study game-loop 60
```

The engine also has a browser host, with hot reload:

```bash
WGPU_BACKENDS=vulkan deno task engine
```

The browser compiles each emitted Wasm module once and clones that compiled
module into a candidate worker. The active worker keeps rendering until the
candidate produces its first frame, so compilation and guest startup do not
interrupt the last working revision.

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
read_line : () -> Text
write     : Text -> ()
```

An empty line is treated as an anonymous answer. A richer terminal program
should return an `Option Text` so end-of-input and an intentionally empty line
remain distinct.

## agent

`agent/main.blot` owns the conversation loop and transcript. The host grants a
terminal and a synchronous `Model.complete` operation. The bundled model adapter
is deterministic so the study runs without credentials or network access.

This case deliberately exposes the next ABI question: Core ABI 2 calls host
effects synchronously, while network model APIs are asynchronous. A production
agent therefore needs either a synchronous local model bridge or a future
suspending host-effect ABI; the case study does not disguise that mismatch with
an ambient network call.

## engine

`engine/` is a small 3D engine: an entity-component-system, a camera with two
lenses, four-lane vector maths, and hot reload for both the scene and the code.
It draws to a canvas through four host capabilities and reaches nothing else on
the page.

`engine/game_loop.blot` is the deliberately traditional counterpart. It uses the
same renderer and host boundary, but keeps whole renderable objects in arrays
instead of splitting them into component stores. Its scene is a deterministic
voxel scene generated from the Blot modules under `engine/shrubberies/`: oak,
fir, flower, and rock recipes are typed source values rather than RON or
host-side assets. A source catalog owns each number key and display name, and
the same module owns generator dispatch; the desktop only forwards keys and
displays the selected source-provided name. The generator assigns stable ids
while it builds each owned Array. Named color bindings keep each recipe about
materials such as weathered bark and new growth rather than anonymous RGB
channels. There is no terrain mesh; every visible voxel belongs to the selected
shrubbery.

The selected shrubbery stays immutable and spatially stable while the host
camera moves around it:

```blot
const F = import "./lib/frame.blot"

for ever:
  use remaining <- Host.frame ()
  if F.finished remaining:
    break

  use render game
```

Run it with `deno task case-study game-loop [frames] [ortho] [selection]`. The
two entry points make the tradeoff visible without changing the graphics code:
the traditional loop keeps each object's fields together; the ECS layout lets
systems traverse an open collection of entities by component.

Deno 2.9 or newer can run the traditional loop in a native desktop window:

```bash
deno task game-loop:desktop
```

On Arch-family x86-64 Linux systems where Deno's launcher needs `libxdo.so.3`,
the task downloads a checksum-pinned copy into the user cache and exposes it
only to the desktop process. It does not replace the system `libxdo.so.4`.

This entry point selects Deno Desktop's raw backend: there is no HTML, Canvas
2D, webview, or browser GPU implementation. Deno exposes the native window as a
WebGPU surface backed by wgpu; the Blot loop stays in a worker because its
synchronous `Host.frame` call must not block window and input events. Hold the
middle mouse button and drag to orbit, scroll to dolly, press `L` to switch
lenses, press `1` through `5` to browse the mixed shrubbery, oak, fir, flower
patch, and rock cluster, and press Escape to exit. Camera angles use sixteenths
of the renderer's 256-step turn, so small pointer movements interpolate between
table entries instead of disappearing at a whole angle step. Projected positions
retain 1/256-pixel precision across the integer host boundary, and the native
pipeline resolves four coverage samples per pixel. The native host enables the
source-defined `VoxelCanvas` effect, so each streaming update transfers one
compact instance per voxel. WGPU keeps those instances resident and performs
cube expansion, camera transforms, projection, face lighting, culling, and depth
on every draw. Each orbit, scroll, or lens input wakes the Blot loop for one
`VoxelCanvas.redraw` effect that updates a uniform. The application therefore
owns the render request without rebuilding or retransferring its scene. The
headless host disables `VoxelCanvas`; the same Blot source then uses its `F32x4`
SIMD projection and culling renderer as the reference path. Set
`DENO_WEBGPU_BACKEND=vulkan`, `metal`, or `dx12` to require a particular wgpu
backend. The host watches every `.blot` file below `engine/`. A successful
compile starts a candidate worker and promotes it only after its first rendered
frame; a syntax, type, instantiation, or runtime failure leaves the last working
revision drawing. The GPU instance buffer grows geometrically with the generated
scene, up to the adapter's reported buffer limit. Changing shrubbery starts a
fresh guest from the already compiled artifact. That lets the previous linear
voxel Store leave with its Wasm instance while the shared camera remains
untouched. The generator uses half-size voxels and twice the recipe resolution.
It presents the current immutable Store after the first voxel and every 256
additions, so the candidate appears immediately and fills in while its final
Store is still being built.

The development compiler has two split-unit examples for this source tree:
`browser.blot.json` assigns `main.blot` and `lib/frame.blot` to separate units,
while `desktop.blot.json` does the same for `game_loop.blot`. Inspect their
incremental build sets without launching a graphics host:

```bash
pnpm blot dev case-studies/engine/browser.blot.json
pnpm blot dev case-studies/engine/desktop.blot.json
```

These commands compile and report unit changes. The browser and desktop graphics
hosts retain their existing candidate-worker reload paths.

### Five modules, and what each of them owns

```text
main.blot        the game: its components, its systems, its scene, its loop
lib/ecs.blot     stores and joins over entities, and no authority at all
lib/frame.blot   the shared frame-completion policy
lib/render.blot  the camera, the projection, the cube, and the two draw calls
lib/math.blot    sine and cosine, indexed by step
```

`main.blot` declares `Assets` and `Host` because the scene format is this game's
and the frame clock is this game's loop. It does _not_ declare `Canvas` or
`View`: those belong to the renderer and are declared inside it, because an
effect's identity is its declaration site. A library that draws must own what it
draws through — two modules that each wrote `@effect.host` for a canvas would be
two capabilities and two host imports, and a capability cannot be passed in as a
module input because a compile-time value has no runtime representation to pass.
So importing `lib/render.blot` _is_ how this program acquires the authority to
draw, and its inferred type says so:

```text
case-studies/engine/main.blot: (Int | 0) ~ { Assets, Canvas, Host, View }
```

The same reason keeps `Canvas` out of the renderer's returned API: an effect has
no runtime representation to return. The renderer instead returns its `Color`
type, `rgb` constructor, coordinate conversions, and a `frame` that clears,
reads the camera, hands the application two brushes, and presents.

A camera is one record inside `lib/render.blot` and a different field subset at
each of the four places that reads one, and those shapes agree because inference
watches the record reach them. It watches across a module boundary too, now — a
record may cross carrying more fields than the module it enters reads. So a
brush takes a position, an angle, a scale, and a color rather than a `Transform`
because the renderer has no business knowing that this game's transform also has
a spin, which is a design reason and no longer a lowering one.

### The world is the frame loop

An ECS normally exists because game state is a large mutable graph and every
system wants a different slice. Blot has no mutation, so that framing does not
apply — but the layout an ECS arrives at still does: components in parallel
arrays keyed by entity, each system a function over the arrays it reads.

What the language adds is that the world does not have to be a value. A `for`
body's `:=` names are its accumulator, so the frame loop _is_ the world:

```blot
const F = import "./lib/frame.blot"

for ever:
  use remaining <- Host.frame ()
  if F.finished remaining:
    break

  use current <- Assets.generation ()
  if current != generation:
    use transforms <- load_transforms ()
    use models <- load_models ()
    generation := current

  transforms := advance transforms
  use render (transforms, models)
```

A system that does not rebind a name provably cannot affect it — the property an
ECS usually arranges with scheduling and declared access. Adding a component
means adding a name.

### The fourth lane is the one doing the work

The geometry is `F32x4`. It was fixed point at 4096 until the language had a
second numeric type, then `F64` scalars until it had a fourth, and neither move
touched the boundary: no float crossed one at the time, so the scene arrives as
thousandths and the screen leaves as 1/256-pixel fixed point, and everything
between is a lane. Scalar floats cross now — `F32` and `F64` are canonical `f32`
and `f64` at the ABI — so those two conversions are the port's history rather
than a rule. `F32x4` is what still cannot cross, and that has not changed.

A three-component vector in a four-lane register leaves one lane spare, and the
whole port turns on spending it. A point carries 1 there and a direction carries
0, which is what makes a transform a matrix and a matrix row a dot product: the
row's fourth lane is its translation, and the point's fourth lane decides
whether that translation applies.

```blot
const turn_y = fn (point, rotation) => F32x4.of (
  F32x4.dot point rotation.to_x,
  F32x4.y point,
  F32x4.dot point rotation.to_z,
  F32x4.w point
);

const to_view = fn (point, camera) => F32x4.of (
  F32x4.dot point camera.right,
  F32x4.dot point camera.up,
  F32x4.dot point camera.forward,
  ONE
);
```

A cube corner is an offset from the model's own origin, so it carries 0 and
scaling and turning it are lane-wise across all four. Adding the entity's
position — which carries 1 — is the single step that makes it a point, and the
camera's translation reaches it from there for free. `to_view` was three
subtractions, eight multiplies, and six more adds and subtracts, over ten reads
of a field by name; it is three dot products now, and no field is named anywhere
in it.

The camera orbits the origin, and writing the view transform as rows makes that
visible rather than incidental: the eye only ever moves along `forward`, so the
two screen rows translate by nothing at all and the depth row translates by the
orbit radius. Subtracting the eye per vertex arrives at those same three
numbers.

Shading was already a dot product and now says so. Every projected triangle also
keeps the view depth of each vertex, so the desktop host can interpolate depth
across slanted faces instead of assigning one painter-order value to the whole
face.

Single precision is comfortable here on the arithmetic: `F32` carries about
seven decimal digits, the scene is a few units across, and the screen is a few
hundred pixels. That is a reason to expect it to hold rather than a measurement
that it does — what has been checked is that the ported engine renders, that its
exports are unchanged, and that all three executions agree on them.

`lib/render.blot` needs sine and cosine, and `main.blot` needs the size of a
turn to step a spin by; both come from `lib/math.blot`, which builds them from a
Taylor series that runs in the _comptime evaluator_: `const` forces the series
to be evaluated while compiling, so a quarter turn of sines reaches WebAssembly
as data and the polynomial that produced it is not in the artifact. Seven terms
now rather than four — the fixed-point version could not afford the
intermediates. The series is still evaluated in double precision and narrowed
per entry as the table is built, because an `F64` in the comptime evaluator
costs the artifact nothing.

`sin 45°` is `0.707`, which is what you would want and what the fixed-point
version could only approach. The module's square root takes an `F32` now, so
`sqrt 2.0` is a type error and `sqrt (F32.of_float 2.0)` is how it is asked — a
lane cannot be written, only converted.

### 2D is the same renderer with the lens switched

The camera carries a lens, and `to_screen` is the only place it matters:

```blot
const to_screen = fn (view, camera) => case camera.lens of
  #Perspective => F32x4.add
      SCREEN_CENTRE
      (F32x4.div (F32x4.mul view FOCAL_AXES) (F32x4.splat (F32x4.z view)))

  #Orthographic => F32x4.add SCREEN_CENTRE (F32x4.mul view camera.zoom_axes)
```

A perspective divide, or no divide — the lenses differ only in what the view
point is measured against. A screen's y counts down and a world's counts up, so
that flip rides in the axis vectors rather than in a subtraction only one of the
two lanes wants. Sprites follow the same rule: a 2D texture's size divides by
depth under one lens and does not under the other, so it is a billboard in 3D
and a plain sprite in 2D without a second code path. Press `L` in the browser to
switch mid-flight; the guest reads the lens every frame, so nothing reloads.

### Hot reload, two kinds

```bash
WGPU_BACKENDS=vulkan deno task engine             # opens a browser
WGPU_BACKENDS=vulkan deno task engine --no-open   # just serves
```

The task compiles the module, serves it on port 8321, watches both trees, and
opens the page. Deno is the whole toolchain here — there is no bundler and no
build step, and the browser is the display rather than the environment: the
compiler, the file watcher, and the reload channel all live in `serve.ts`.

**Assets.** Edit `assets/scene.json` and the server re-reads it and bumps a
generation. The guest compares that generation each frame and rebuilds its
stores from the new scene. No compiler runs and the module is untouched — the
reload path is the same fold as the first load, so there is no second path to
keep correct.

**Code.** Edit `main.blot` or anything under `lib/` and the server rebuilds the
module and the page swaps in a new worker. The camera survives, because the
camera was never in the guest: `View` is a host capability backed by the page's
pointer and wheel. A rebuild that fails leaves the last good module running and
shows the diagnostic on the page.

One GPU compiler session is held for the life of the server, so a rebuild is a
compile and not a device acquisition.

### The host boundary

```text
Color                = { red, green, blue : Int }
rgb                  : (U8, U8, U8) -> Color
Canvas.clear/present : () -> ()
Canvas.tri           : { ax, ay, az, bx, by, bz, cx, cy, cz, shade : Int; color : Color } -> ()
Canvas.sprite        : { x, y, size, depth : Int; texture : Text } -> ()
View.yaw/pitch/distance/lens : () -> Int
VoxelCanvas.enabled           : () -> Bool
VoxelCanvas.clear/present     : () -> ()
VoxelCanvas.redraw            : () -> ()
VoxelCanvas.voxel     : { x, y, z, scale : Int; color : Color } -> ()
Assets.generation/count      : () -> Int
Assets.entry         : Int -> { kind, x, y, z, scale, spin : Int; color : Color; texture : Text }
Host.frame/seed/selection : () -> Int
Host.option/selected      : { key : Int; name : Text } -> ()
Stream.batch_size        : () -> Int
Stream.yield             : () -> ()
```

`Color` uses runtime `Int` carriers because narrowed ranges do not survive in
residual host and loop signatures. Blot-authored colors still enter through
`rgb`, whose `U8` parameters prove each channel is from 0 through 255, and both
scene hosts enforce the same range while parsing `scene.json`.

The general renderer projects geometry and hands over triangles with one view
depth per vertex. The desktop host maps those values into its GPU depth
attachment; the headless character renderer averages them because its cells are
only a coarse preview. The shrubbery's native path instead hands stable voxel
instances to WGPU and leaves projection on the device.

Record parameters flatten in _canonical_ field order, which is alphabetical and
not the order the program wrote them. Nested records follow the same rule, so
`Canvas.tri` arrives as
`ax, ay, az, bx, by, bz, color.blue, color.green, color.red, cx,
cy, cz, shade`.
`docs/abi.md` is the authority; getting it wrong silently transposes the
geometry.

### Two hosts

`deno task case-study engine [frames] [ortho]` is the headless one. It
rasterizes to a character grid with a painter's algorithm and a scanline fill,
reads the same `scene.json`, and prints the last frame — so the study runs in CI
and its output is a value a test can compare.

`deno task engine` serves the browser host, which has a real
`CanvasRenderingContext2D`, an orbit camera on the pointer, and procedural
textures for the sprite path.

The browser one has a mismatch to resolve: ABI 2 calls host effects
synchronously, and `requestAnimationFrame` is not something a synchronous call
can wait for. So the module runs in a worker, where blocking is allowed, and
`Host.frame` parks on `Atomics.wait` until the page's animation frame bumps a
shared counter. The camera and lens live in that same `SharedArrayBuffer`, so
input costs no round trip. `serve.ts` sends the cross-origin isolation headers
that `SharedArrayBuffer` requires.

This is the seam the agent study names: a suspending host-effect ABI would
remove the worker.

### What the language made awkward

- **A record does not survive a tuple scrutinee.** `each_2` writes the join the
  way it should read —
  `case (at (l, id), at (r, id)) of (#Some a, #Some b) => …` — and lowers,
  because what it carries out is a component the visitor consumes whole.
  `visit_2` cannot: its visitor projects `transform.position`, and a record
  reaching a projection only by having been a tuple column records the narrower
  set the projection's own body reads rather than the set the store built, so
  the runtime record is the wrong one and lowering refuses the mismatch
  (`LANGUAGE.md` §15). So a renderer's join stays two nested `case`s, and the
  cause is the record, not the tuple pattern.
- **A lane cannot be written, only converted.** There is one float token in the
  grammar and it reads as an `F64`, so every single-precision constant in the
  engine is a `F32.of_float` the program wrote down. That is the right default —
  narrowing should be visible — but a file whose every constant is single
  precision pays for it on every line.
- **A vector is four boxed lanes at a lazy boundary.** `F32x4` reaches Core as a
  one-constructor type with four `F32` fields. A strict chain stays in a `v128`
  across let bindings and calls when every argument is provably a vector, so
  `F32x4.dot (F32x4.add a b) c` keeps its register; a materialized closure or a
  lazy boundary still boxes, because a heap value must outlive the native worker
  that produced it. The instructions are in the artifact and this is one of the
  programs that put them there, as is `examples/simd.blot`, which takes a lane
  from its exported function argument so that it cannot fold the way
  `examples/vectors.blot` does. The renderer also compares four view depths
  together and reduces the resulting mask for its near-plane test.

Three more were true when this was written and are not now. The engine has not
been rewritten to take them:

- **An effect row can be written now** (`LANGUAGE.md` §12.4). Not one effectful
  binding in the engine carries a signature — not `render`, not the two loaders,
  not the renderer's `frame` — and that is now a thing to do rather than a thing
  the language forbids.
- **A record may cross a module boundary carrying more fields than the module
  reads** (`LANGUAGE.md` §3). The renderer's brushes take a position, an angle,
  a scale, and a color because a boundary that names what it reads is a good
  boundary, not because a `Transform` would fail to lower. Differently shaped
  calls, including calls from separate importers, now specialize independently.
- **A float crosses the module boundary.** `F32` and `F64` are canonical `f32`
  and `f64` at the ABI (`docs/abi.md`), so `Assets.entry` carries thousandths
  and `Canvas.tri` carries 1/256-pixel fixed point by history rather than by
  necessity.
