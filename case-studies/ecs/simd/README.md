# SIMD matrices and component blocks

These examples use existing Blot types, ordinary functions, and `F32x4`
operations. The component and schedule generators specialize the same way they
do for scalar components.

```bash
pnpm blot run case-studies/ecs/simd/matrices.blot
pnpm blot run case-studies/ecs/simd/main.blot
pnpm test:ecs
pnpm benchmark:ecs-simd
```

## One matrix algebra, two representations

[`matrix.blot`](matrix.blot) builds a matrix type from its column type:

```blot
const matrix_type = fn Column => { .c0 = Column; .c1 = Column; .c2 = Column; .c3 = Column; }
const Matrix = matrix_type Vector
const Packed = matrix_type F32x4
```

`Vector` is an ordinary `{x: F32, y: F32, z: F32, w: F32}` record. A packed
matrix contains four SIMD columns. Matrix-vector multiplication broadcasts the
point's coordinates, scales each column, and adds the four resulting vectors:

```text
M × p = (M.c0 × splat(p.x) + M.c1 × splat(p.y))
      + (M.c2 × splat(p.z) + M.c3 × splat(p.w))
```

Matrix multiplication applies that operation to each column of the right-hand
matrix. `multiply (left, right)` applies `right` first when transforming a
column vector. No transpose is necessary.

[`matrices.blot`](matrices.blot) makes the ordering visible. Scaling `(1, 2, 3)`
by `(2, 3, 1)` and then translating by `(10, 20, 30)` gives `(12, 26, 33)`.
Reversing those operations gives `(22, 66, 33)`. A point has `w = 1`; a
direction has `w = 0`, so translation leaves the direction unchanged. These are
homogeneous transforms; the example does not divide by the resulting `w`.

Both implementations use the same pairwise addition order and round each
operation to F32. The SIMD implementation does not use fused multiply-add or
reassociate the scalar expression. Runtime tests compare both with an
independent F32 model over identity, translation, scaling, rotation, dense
matrices, signed zero, and fractional inputs.

## Generate the same ECS from either algebra

[`transforms.blot`](transforms.blot) accepts an algebra record with `Matrix`,
`Vector`, `multiply`, and `transform`. It derives Entity from those type values,
then generates the systems:

```blot
const C = S.components
const compose = S.define (
  { .reads = [C.Parent, C.Local]; .writes = [C.World]; },
  fn read => { .World = Algebra.multiply (read.Parent, read.Local); }
)
const project = S.define (
  { .reads = [C.World, C.Point]; .writes = [C.Projected]; },
  fn read => { .Projected = Algebra.transform (read.World, read.Point); }
)
```

An independent Age system joins the graph. The planner produces compatible
batches `[compose, age]` then `[project]`, and fuses them into one traversal per
tick. Project sees the World written by compose. The callbacks receive exactly
their declared read types and return checked write patches.

```blot
const Scalar = Transforms Mat4.Scalar
const Simd = Transforms Mat4.Simd
```

That changes the component representations and arithmetic while retaining the
same systems and graph. The algebra is known at compile time: emitted kernels
have direct calls and native vector instructions, with no runtime algebra lookup
or indirect dispatch.

`Parent` is a matrix already supplied on the entity. The example does not
resolve parent entity IDs or schedule a transform hierarchy. The exported
convenience `tick` converts scalar rows to packed rows, runs the packed tick,
and converts back: three array traversals. Applications running several frames
can pack once, call `Simd.tick` repeatedly, and unpack at their output boundary,
as the benchmark does. Neither graph uses worker execution.

## Four entities per vector

[`particles.blot`](particles.blot) uses the lanes differently:

| Layout                   | One SIMD vector represents                      |
| ------------------------ | ----------------------------------------------- |
| Matrix column            | x, y, z, w coordinates within one entity        |
| Particle component block | The same component on four consecutive entities |

```blot
const Entity = { .Position = F32; .Velocity = F32; }
const Block = { .Position = F32x4; .Velocity = F32x4; }
const Table = { .count = Int; .blocks = [Block]; }
```

Each block holds two component columns. Integrate adds the Position and Velocity
vectors. Bounce compares the updated Position with `splat 10` and uses
`F32x4.select` to retain or negate each lane's Velocity. This implements a guard
on four entities at once without a branch per entity. NaN compares false, so its
velocity takes the negated branch; the scalar reference makes that policy
explicit too.

Packing establishes `blocks.length = ceil(count / 4)` and zero-fills the final
partial block. The scheduled updates preserve that shape. Unpacking visits only
the live indices `0..count`, so padding never becomes an entity. Empty input
produces no blocks and an empty output. Tests exercise every tail size, repeated
frames, NaNs, infinities, and signed zero. This padding scheme is valid for the
lane-local systems shown here; a horizontal reduction must exclude padded lanes.

This is an array of component blocks, often called AoSoA. It still uses Blot row
records and owned output arrays. It does not establish independently owned world
columns or authorize concurrent component writes.

## Runtime boundaries and measurements

The public kernels in [`../kernels`](../kernels) accept scalar records and
arrays; the vectors stay internal. `product` takes one matrix pair directly, and
`point` takes one matrix/point pair. Their wide records cross the boundary
through canonical parameter blocks. `multiply` and `transform` retain batch
interfaces for bulk work. Tests cover all four exports with runtime inputs.

The seed callback uses F32 literals under its enclosing result signature.
[`partial-blocks.blot`](partial-blocks.blot) also demonstrates conditional
appends when unpacking a block: only live lanes are emitted, including every
possible tail length and empty input.

The [runtime tests](../simd.test.ts) verify results and principal types, then
inspect Runtime HIR for native vector operations, direct dispatch, and
`owned-reuse` array updates. A native compiler regression also decodes the
emitted Wasm and checks `f32x4.add`, `f32x4.mul`, and `v128.bitselect`. It
constructs scalar and SIMD factories in both orders. A constant example alone
could not prove that any SIMD survives staging.

[`../simd-benchmark.ts`](../simd-benchmark.ts) measures 64, 512, and 4096
entities over one or 32 frames. Every timed call includes seed construction,
packing once for SIMD, all frames, unpacking once, checksum, and scalar ABI
scope entry/exit. Setup-only results are reported separately without
subtraction. Compilation, instantiation, warmup, and model comparisons are
outside the clock. Seven samples rotate variant order and retain raw durations
and memory-page counts.

The transform comparison uses the same generated ECS in both representations.
The particle comparison uses a direct scalar loop and a generated block
schedule, so it measures both representation and abstraction costs. Neither
isolates the hardware instruction speedup. The JSON records source and compiler
hashes, artifact size, runtime versions, and CPU model:

```bash
node --import tsx case-studies/ecs/simd-benchmark.ts > ecs-simd-results.json
```

The [recorded local run](../simd-benchmark-results.json) measures `725fc051`,
including generated component descriptors and the compiler fixes. It used Node
24.12.0, V8 13.6, and a Ryzen 7 7800X3D on 2026-09-13. For 4096 entities, median
microseconds per call over seven samples were:

| Workload   | Frames |   Scalar |    SIMD | Setup and checksum |
| ---------- | -----: | -------: | ------: | -----------------: |
| Particles  |      1 |   146.13 |  269.53 |              84.70 |
| Particles  |     32 |  2185.70 |  843.91 |              79.01 |
| Transforms |      1 |  1083.70 |  745.69 |             198.69 |
| Transforms |     32 | 26567.24 | 5703.08 |             203.34 |

At 32 frames, packed transforms were about 4.7 times faster and particle blocks
about 2.6 times faster. A single particle frame was slower after paying for
packing and unpacking. The useful application boundary is therefore persistent
packed state, with conversions at input and output. These are local workload
observations, not a portable speed guarantee or a CI threshold. The complete
benchmark Wasm, containing all six exports, is 68,712 bytes.

The [compiler findings](../compiler-findings.md) describe the specialization bug
this example exposed and the remaining ergonomics limitations.
