# ECS: typed queries, fused schedules, and entity messages

A component schema generates typed readers and replacements. Queries compose
their effects; handling those effects produces pure row transformations.
Schedules compose those transformations before choosing where to traverse the
table. Component predicates select entire archetypes at compile time; runtime
guards filter rows, lazy streams combine reductions, and typed messages connect
entities across an explicit delivery phase.

The particle example moves particles, reflects their horizontal velocity after
crossing a boundary, and increments their age. The reflection stage sees the
position written by the movement stage. Position and Velocity deliberately share
the same vector type while retaining distinct reader identities.

```bash
pnpm blot run case-studies/ecs/main.blot
pnpm blot run case-studies/ecs/queries-and-messages.blot
pnpm test:ecs
pnpm benchmark:ecs
```

This case study runs with Node and the Rust/Wasm compiler. Its library is
ordinary Blot source in [ecs.blot](ecs.blot); [simulation.blot](simulation.blot)
contains the particle application. [arena.blot](arena.blot) adds fighters,
medics, sleeping entities, scenery, and messages.

## Generate components from types

```blot
const Vec2 = { .x = Int; .y = Int; }
const Entity = ECS.archetype {
  .Position = Vec2;
  .Velocity = Vec2;
  .Age = Int;
  .Label = Text;
}
const C = Entity.components
```

`Entity` remains the record type. Its attached namespace contains one component
descriptor per field, derived by iterating the schema at compile time:

| Member                               | Meaning                                       |
| ------------------------------------ | --------------------------------------------- |
| `C.Position.Type`                    | The original vector type                      |
| `C.Position.Read`                    | A generated reader effect                     |
| `C.Position.get`                     | Its `Unit -> Vec2` operation                  |
| `C.Position.replace (row, position)` | A new row with a checked Position replacement |

The replacement preserves the other fields. A text value cannot become a
Position, and replacing Position also leaves Velocity intact despite their equal
carrier types. Descriptors keep their methods separate from the component type's
own namespace, so a Text component can retain `Text.replace`.

## Merge queries, then bind their results

```blot
const motion = Query.merge (C.Position.get, C.Velocity.get)
const next_position = Query.map (motion, fn (position, velocity) => {
  .x = position.x + velocity.x;
  .y = position.y + velocity.y;
})

const next_velocity = Query.and_then (C.Position.get, fn position => fn () => do:
  use velocity <- C.Velocity.get ()
  if position.x >= 10:
    return { .x = 0 - velocity.x; .y = velocity.y; }
  else:
    return velocity
)
```

These queries are nullary computations. `merge` sequences both queries and
returns their pair. `map` transforms the result. `and_then` chooses a further
computation from an earlier result. Each combinator preserves the inferred
effect row; the reader requirements accumulate through ordinary function calls.

`use` gives the query body normal sequencing and local names. It is Blot's
existing effect sequencing syntax. There is no query AST, macro, runtime query
object, or additional inference implementation.

The application supplies its row snapshot with explicit handlers:

```blot
const resolve = fn (row, work) => @handle (
  C.Position.Read,
  fn () => @handle (
    C.Velocity.Read,
    work,
    { .get = fn ((), ?resume) => resume row.Velocity; }
  ),
  { .get = fn ((), ?resume) => resume row.Position; }
)
```

The compiler can see the exact effects and clauses. Repeated reads return the
same component of that snapshot. Reading Age in this resolver leaves an
unhandled effect and is rejected. Adding another reader requires its explicit
handler at this boundary. The current compiler limitation behind keeping these
clauses explicit is recorded in [compiler-findings.md](compiler-findings.md).

## Select archetypes, guard rows, and fold streams

The arena builds this predicate from ordinary functions on type values:

```blot
const eligible = Query.all (
  Query.has "Health",
  Query.all (
    Query.without "Sleeping",
    Query.any (Query.has "Damage", Query.has "Healing")
  )
)
```

`has`, `without`, `all`, `any`, and `not` inspect the record schema at compile
time. `Query.table (Row, predicate)` constructs a query specialized on that
decision; bind that query with `const`, then supply `(rows, select)` at runtime.
An excluded archetype contributes an empty iterator and never applies `select`.
The same selection can therefore cover scenery without trying to read a Health
field that scenery does not have. These are explicit schema predicates; the
library does not infer them from arbitrary field reads.

Runtime conditions belong inside the query:

```blot
const inspect_character = fn row => Query.run (fn () => do:
  use Query.guard (row.Health > 0)
  return { .health = row.Health; .name = row.Name; }
)
const select_fighters = Query.table (Fighter, eligible)
const select_medics = Query.table (Medic, eligible)
let fighters = select_fighters (world.fighters, inspect_character)
let medics = select_medics (world.medics, inspect_character)
let selected = Stream.append (fighters, medics)
return Iter.fold_with (fn (total, character) => total + character.health) 0 selected
```

`guard` is an effect operation. Its handler resumes with Unit on success and
returns `None` without resuming on failure. Subsequent reads and calculations
are skipped. The arena's attack query combines these guards with the generated
Health and Damage readers using `use`.

`Stream.Iterator (State, Element)` constructs the ordinary iterator record type.
`Stream.choose` adapts an `Option` selection to that protocol. `Stream.append`
runs its left stream, then its right stream, with a tagged state that
accommodates different iterator state types. Grouping does not change order. The
final fold visits selected rows without collecting a combined array; rejected
rows advance in a tail-recursive loop. There is still ordinary iterator state
and closure representation, so this is not a zero-allocation claim.

Every fold supplies an explicit seed. The complete arena summary uses
`{ .count = 0; .health = 0; .names = ""; }`, so an empty world has a defined
text result. It adds a separator only after the first selected name. The seed
world summarizes as three living eligible characters, 21 health, and
`"Ada, Cy, Dee"`. Sleeping Eve and scenery are excluded by schema; dead Bram is
excluded by the runtime guard.

## Deliver typed messages between phases

```blot
const Mail = ECS.Messages (#Damage Int | #Heal Int)
let outbox = Mail.send ([], {
  .sender = 0;
  .recipient = 2;
  .payload = #Damage 8;
})
let delivery = Mail.deliver (recipient_count, Stream.append (
  attacks world.fighters,
  Stream.append (heals world.medics, Iter.items outbox)
))
let health = Iter.fold_with (fn (health, envelope) => case envelope.payload of
  #Damage amount => Int.max 0 (health - amount)
  #Heal amount => health + amount
) row.Health (Mail.expect_inbox (delivery, row.Id))
```

The type constructor derives the envelope and delivery snapshot types from the
payload type. An outbox starts with `[]` and remains owned while being built.
Delivery accepts an iterator, allowing independently generated message streams
to merge without an intermediate outbox. It freezes its completed arrays so many
entities can read the same snapshot.

Addresses are dense integers in `[0, recipient_count)`. The application must
assign distinct addresses in that range; this study has no entity allocator,
generations, deletion, or migration. Negative or out-of-range destinations are
returned by `Mail.undelivered`, in source order. `expect_inbox` requires a valid
address and traps otherwise. Delivery does not check sender membership or
whether an entity implements a particular gameplay reaction. Scenery in this
application has an address but no damage/healing reaction.

A delivery builds head and tail indices per recipient and a next index per
message. Each inbox walks only its own links in FIFO order. Building the index
costs O(entity count + message count); visiting all inboxes costs O(message
count), with O(entity count + message count) storage. The compiler tests require
every index update and append to retain its `owned-reuse` proof. There is no
scan of every message for every entity.

`arena.tick` first generates every attack and heal from the incoming world, then
delivers them, then produces the successor world. Cy can send a heal in the same
phase in which an attack kills Cy. After one tick Ada has 17 health, Cy has
zero, and Dee has five: the new summary is two characters, 22 health, and
`"Ada, Dee"`. The executable also returns a message addressed to 99 as
undelivered. Reusing a delivery snapshot replays it; advancing phases and
preventing accidental replay remain explicit application responsibilities.

## Merge schedules before traversing

```blot
const Schedule = ECS.Schedule Entity

const integrate :: Entity -> Entity
const integrate = fn row => C.Position.replace (row, resolve (row, next_position))

const bounce :: Entity -> Entity
const bounce = fn row => C.Velocity.replace (row, resolve (row, next_velocity))

const age :: Entity -> Entity
const age = fn row => C.Age.replace (row, row.Age + 1)

const physics = Schedule.merge (integrate, bounce)
const bookkeeping = Schedule.merge (Schedule.empty, age)
const tick = Schedule.merge (physics, bookkeeping)
const fused :: [Entity] -> [Entity]
const fused = Schedule.each tick
```

`Schedule.merge (first, second)` means `fn row => second (first row)`.
`Schedule.empty` is identity. This gives schedules an associative composition
with an identity: entire subschedules merge exactly like individual stages.
Regrouping preserves execution order. Reordering does not: reflecting velocity
before moving changes the result for an entity crossing the boundary.

The constructor checks every stage against the pure arrow `Entity -> Entity`. A
stage must preserve the archetype, and its effects must already be handled. This
rules out logging or mutable host state inside the fused loop. Immutable values
captured by a stage remain fixed snapshots.

`each` chooses the traversal boundary. Applying it once creates one output
array; applying it to the three stages separately creates three:

```blot
const separate = fn rows => (Schedule.each age) (
  (Schedule.each bounce) ((Schedule.each integrate) rows)
)
```

For normally terminating stages, both forms produce the same final rows. Pure
functions can still trap or diverge: merging explicitly chooses per-row
execution and can change which failure happens first. Keep separate passes when
whole-pass failure order matters. Global reductions, neighbor queries over an
updated world, and structural entity changes likewise require explicit phase
boundaries; this library does not move them across a traversal.

## Storage and cost

Each archetype table is a dense `[Entity]`: an array of row records, with every
component present in every row. There are no per-entity optional component
tests. Empty tables produce empty tables. A component whose domain is optional
can explicitly use `Option T` and choose a default in its query.

This layout keeps the case study small enough to inspect. It does not implement
columnar storage, entity allocation, deletion, archetype migration, or automatic
parallel scheduling. Rows and intermediate records still have their normal Blot
representation. Input snapshots remain valid; the implementation constructs a
successor array with appends checked as `owned-reuse`.

The structural checks inspect validated Runtime HIR for the isolated kernels:

| Kernel                  | Output array builders | Static Store read sites | Specialized functions |
| ----------------------- | --------------------: | ----------------------: | --------------------: |
| Fused schedule          |                     1 |                       3 |                    14 |
| Three separate passes   |                     3 |                       6 |                    14 |
| Direct single-pass code |                     1 |                       3 |                     3 |

Read-site counts describe generated instructions, not reads per entity: loop
entry and recursive paths can contain separate sites. The fused version removes
two intermediate arrays. Its component names and reader effects leave no runtime
lookup or indirect-call machinery. Direct specialized calls and ordinary record
construction remain, so this is not a claim of zero overhead versus handwritten
code.

[benchmark.ts](benchmark.ts) compares all three implementations with an
independent checksum model before timing. It varies a runtime row count while
keeping the source and artifacts fixed. Timed calls include input generation,
the tick, the checksum, and scalar ABI scope entry/exit. A fourth workload
reports input generation and checksum alone; it is not subtracted from the
measurements. Compilation, instantiation, warmup, and correctness checks are
outside the clock.

The JSON report includes raw samples, medians, memory pages, complete and
marginal Wasm sizes, artifact and source hashes, compiler identity, and
execution environment. To save a report without package-runner output:

```bash
node --import tsx case-studies/ecs/benchmark.ts > ecs-results.json
```

The [recorded local run](benchmark-results.json) is the particle baseline from
`7b4bc9b`, before the ownership fixes and messaging extension below. Its source
and compiler hashes identify that historical run; these timings do not measure
the new messaging workload. On 2026-09-13 it used Node 24.12.0, V8 13.6, and a
Ryzen 7 7800X3D. Median microseconds per call, over seven samples:

| Rows |  Fused | Separate passes | Direct | Setup and checksum |
| ---- | -----: | --------------: | -----: | -----------------: |
| 64   |   6.26 |            8.71 |   3.67 |               2.42 |
| 512  |  46.39 |           65.52 |  27.03 |              17.24 |
| 4096 | 375.02 |          514.37 | 203.19 |             135.68 |

Here fusion is about 1.4 times faster than separate passes. Direct code remains
1.7–1.8 times faster than the abstraction. The remaining direct calls and record
construction are a concrete optimization target; timings are observations of
this workload and compiler, rather than a CI speed threshold. The complete Wasm
artifacts are 14,064 bytes fused, 16,095 bytes separate, and 13,191 bytes
direct.

## Extending the design

A broader ECS can preserve these boundaries:

1. Generate column types and accessors from the same schema, with equal column
   lengths established when a table is constructed. Change the row-loading and
   storage boundary while keeping the query bodies.
2. Extend the explicit archetype predicates into a world registry while
   retaining specialization per matching table. Add entity identity and
   migration rules before allowing structural changes.
3. Give systems explicit read and write capabilities before inferring
   independent work. A query's reader effects describe its reads; the pure row
   arrow alone does not describe its writes. A planner must not invent a write
   set from that arrow.
4. Merge dependency graphs by stable system identity, preserve barriers, reject
   cycles, and fuse only compatible ordered row work. Parallel execution needs
   separate ownership evidence for the storage being written.

Those are extensions to investigate, rather than promises made by the current
library. Types derive the component interface, effects describe reader and guard
requirements, and ordinary function composition merges work before traversal.
The [compiler findings](compiler-findings.md) distinguish the compiler defects
fixed by this extension from the remaining effect and closure limitations.
