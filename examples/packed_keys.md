# Schema-derived packed keys

`packed_keys.blot` builds compact integer keys from record schemas whose fields
are unsigned fixed-width integers. The reusable abstraction lives in
`lib/packed_key.blot`.

The concrete problem is common at protocol and indexing boundaries: one record
contains several independently bounded integer fields, and callers need a stable
compact key without copying field widths and bit offsets into a second
hand-written encoder. `PackedKey.derive (domain, schema)` makes the schema the
source of truth.

## Abstraction

A schema such as:

```blot
const Header = {
  .version = U 3;
  .kind = U 5;
  .encrypted = U 1;
  .priority = U 3;
  .retries = U 4;
}

const HeaderKey = PackedKey.derive ("example.packet-header.v1", Header)
```

is reflected at compile time. `derive` uses `packed schema` for
declaration-order bit offsets and widths, verifies that every field is exactly
an unsigned `U width` carrier, and generates one
`pack : Header -> HeaderKey.type` function. The key carrier is:

```text
#PackedKey { .domain = "example.packet-header.v1"; .bits = 16; .raw = Int; }
```

The singleton `.domain` and `.bits` fields are part of the type. Two independent
16-bit schemas can therefore encode to the same integer while their keys remain
incompatible. The executable demonstrates that deliberately: a header key and a
window key both encode to `141`, but the wrong-domain fixture is rejected before
execution.

The compiler enforces the input schema, every `U width` field bound, the exact
key domain at consumers such as `.raw`, and the unsigned-field restriction used
by this packing rule. The compiler does **not** prove that a chosen domain
string has globally unique business meaning, and the current public `.raw`
carrier is `Int` rather than the mathematically tighter `U total_bits`; that
latter limitation is recorded below rather than hidden behind a cast.

The abstraction intentionally stops at deterministic packing. It is not a
storage-layout primitive and it does not claim that Blot records themselves use
this packed representation. `packed` is compile-time layout metadata; `pack`
turns that metadata into an ordinary integer encoding. Signed fields are refused
because this example does not invent a two's-complement wire convention.

## Run

With the Rust/Wasm compiler artifact matching the checkout:

```sh
pnpm blot check examples/packed_keys.blot
pnpm blot run examples/packed_keys.blot
pnpm blot lint --check examples/lib/packed_key.blot examples/packed_keys.blot
pnpm blot build examples/packed_keys.blot
node --import tsx --test src/node/packed_keys.test.ts
```

The focused test also compiles the executable to Wasm and compares the emitted
program with a separate Wasm golden.

## Covered cases

The executable covers a mixed 16-bit header, the all-zero key, the maximum legal
header (`65535`), reflected first/last field metadata, and two distinct 16-bit
key domains that intentionally collide at raw integer `141`.

The rejection fixtures cover three separate static boundaries:

- `packed_key_out_of_range.blot` puts `32` into `U 5` and must reject with
  `BLOT_TYPE_ERROR`;
- `packed_key_wrong_domain.blot` feeds an `example.window.v1` key to an
  `example.header.v1` consumer even though both schemas are 16 bits and the
  concrete raw value is valid;
- `packed_key_signed_field.blot` asks this unsigned packing abstraction to
  derive a key from `I 4` and is intentionally refused at compile time.

`examples/pending/packed_key_computed_word_range.blot` is a pressure test, not a
supported example. It records the natural stronger boundary described below.

## Pain point: computed integer bounds do not materialize as a range type

The schema determines the total width at compile time, so the natural raw
carrier for a 16-bit schema is `U 16`, not `Int`. A generic staged helper can
compute `Word = U bits` and `maximum = 2^bits - 1`, then guard a runtime integer
with `value < 0` and `value > maximum`. Today the successful path still has type
`0..9223372036854775807`, and `@satisfies value Word` rejects when `bits = 16`
because that type does not flow into `0..65535`.

That is an inference/refinement ergonomics limitation, not a runtime or
soundness defect. The committed abstraction keeps `.raw = Int` instead of
weakening the checker or inserting an unchecked escape hatch. The schema fields
themselves remain precisely refined and the generated key domain remains
statically distinct.

The pending file preserves the exact reproduction. A future improvement would
let a guard against a compile-time-derived integer bound materialize the
corresponding range at the boundary. Acceptance would be that the pending helper
checks as `Int -> U 16` without a cast, while unconstrained integers still
cannot flow into `U 16` and all three rejection fixtures above continue to
reject.
