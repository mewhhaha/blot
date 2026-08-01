# Core WebAssembly ABI

`blot build` publishes a stable Core WebAssembly interface. It does not expose
gpufuck's tagged values or heap objects. Generated adapters lift caller values
into that private representation and lower results back out.

The current contract is Blot Core Wasm ABI 1.0. A compatible compiler may add
manifest fields or exports that do not change an existing declaration. Changing
a function signature, layout, ownership rule, import name, or value meaning
requires a new ABI major.

## Module contract

Every artifact exports:

- `memory`, a memory32 linear memory;
- `cabi_realloc(old_pointer, old_size, alignment, new_size) -> pointer`;
- immutable globals `blot:abi-major` and `blot:abi-minor`; and
- one function named `blot:<source-name>` per runtime module export.

An export with an indirect result also exports
`cabi_post_blot:<source-name>(result_pointer)`. The caller must invoke it once,
after it has finished reading that result.

Host effects import operations from `blot:host/<capability>` under their source
operation name. They use the same value layouts and flattening rules as exports.
Host calls are synchronous in ABI 1.

`@text.len`, `@text.of_int`, `@text.cmp`, and `@text.contains` are implemented
in the artifact. They do not create a `Text` import. Text comparison is
lexicographic by Unicode scalar value. Containment searches the UTF-8
representation; valid UTF-8 preserves textual substring boundaries.

## Core signatures

ABI 1 is the synchronous memory32, UTF-8 subset of the WebAssembly Component
Model Canonical ABI:

- at most 16 flat parameters;
- at most one flat result;
- excess parameters become one pointer to their canonical record layout;
- excess results become one returned pointer for exports;
- an imported excess result adds a final result pointer parameter and returns
  nothing.

The flat core types are:

| Blot value | Flat core values                                  |
| ---------- | ------------------------------------------------- |
| `()`       | none                                              |
| `Int`      | `i64`                                             |
| `Bool`     | `i32`, restricted to 0 or 1                       |
| `Text`     | `i32` pointer, `i32` UTF-8 byte length            |
| array      | `i32` pointer, `i32` element count                |
| record     | its fields in canonical order                     |
| variant    | `i32` discriminant followed by the joined payload |
| seal       | its carrier                                       |

`F64` and `F32` are absent, and that is a limit rather than an omission. gpufuck's
canonical ABI has no float case, so there is no stable layout to publish one
under, even though the Component Model's own canonical ABI has `float64` and
Core computes with doubles internally. A float is therefore a program's own
arithmetic and not its interface: an export or host operation that mentions one
is refused with `BLOT_FLOAT_AT_BOUNDARY`, and `@int.of_float` at the boundary is
the whole of the workaround. Adding the case is additive and would be a minor.

Variant payload slots join `i32` and `i64` as `i64`. Missing payload slots are
zero. A seal is nominal inside Blot but transparent at the caller boundary; its
manifest name still prevents callers from confusing two source contracts.

## Memory layouts

All integers are little-endian.

| Value  | Alignment | Size |
| ------ | --------: | ---: |
| `()`   |         1 |    0 |
| `Bool` |         1 |    1 |
| `Int`  |         8 |    8 |
| `Text` |         4 |    8 |
| array  |         4 |    8 |

A text or array header stores its pointer at offset 0 and its byte length or
element count at offset 4.

Record fields are sorted by source field name. Each field starts at the next
multiple of its alignment; the record size is rounded to the record's maximum
alignment.

Variant cases are sorted by source constructor name. Their zero-based position
is the discriminant. The discriminant occupies one byte through 256 cases, two
bytes through 65,536 cases, and four bytes above that. The payload begins at the
next multiple of the largest payload alignment. All cases share the largest
payload size.

Array elements use the element's canonical size and alignment consecutively.
Nested strings, arrays, records, and variants recursively use these rules.

## Ownership

Parameters are borrowed for the duration of a call. The callee never releases
caller-owned parameter memory.

Results are owned by the caller until post-return:

1. call the export;
2. read or copy the result;
3. call its declared `cabi_post_*` export exactly once.

Post-return recursively releases nested text and array buffers and then the
indirect result record. Direct scalar results need no post-return.

Hosts returning an indirect imported result write into the result pointer
provided by the module. They allocate nested buffers with the module's
`cabi_realloc`. The module consumes and releases those buffers before the
synchronous import call completes.

`cabi_realloc` accepts alignments 1, 2, 4, and 8. A zero new size releases a
nonzero old pointer and returns zero. Invalid alignment, size, pointer, UTF-8,
boolean, variant discriminant, or array length traps.

## Manifest

The exact pretty-printed JSON sidecar is also stored in the `blot:abi` custom
section. A host can read it with
`WebAssembly.Module.customSections(module, "blot:abi")`.

The manifest records:

- format `blot-core-wasm`;
- ABI major and minor;
- memory, encoding, flattening limits, and allocator export;
- runtime and compile-time source exports;
- canonical function types and post-return names;
- effects and result ownership; and
- canonical host import modules, names, and function types.

The sidecar and custom-section bytes are identical, including the final newline.
The canonical type tree contains record field names, variant case names, and
seal names, so compatibility is structural rather than dependent on gpufuck's
private constructor numbers.

## JavaScript example

```js
const module = await WebAssembly.compile(bytes);
const manifestBytes = WebAssembly.Module.customSections(module, "blot:abi")[0];
const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));

let memory;
const instance = await WebAssembly.instantiate(module, {
  "blot:host/Console": {
    write(pointer, length) {
      const bytes = new Uint8Array(memory.buffer, pointer, length);
      console.log(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    },
  },
});
memory = instance.exports.memory;

instance.exports["blot:default"]();
```
