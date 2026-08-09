# Language cleanup prototype

This directory isolates four related surface-language changes before they are
wired into the generated Baba plan and both CST lowerers. The production grammar
remains unchanged in this draft so the checked-in parser tables and Rust compiler
cannot drift from `grammar.baba`.

The proposed direction is deliberately subtractive:

1. replace prefix `comptime value` with `compdo:` as the compile-time counterpart
   of `do:`;
2. keep `const` valid in function scopes, but make it a compile-time obligation
   rather than a binding that can silently become runtime;
3. let `sig` effect rows name a tail with `..e`; and
4. remove element syntax and measure the ordinary function/record/array spelling
   before considering replacement sugar.

`element-free.blot` is executable with the current language. It is the existing
`examples/elements.blot` program written without element syntax and is intended
to keep the same observable result:

```text
"<div>Count: <button>Save</button><button disabled data-order=2>Delete</button><icon></icon></div>"
```

## `compdo:`

`do:` remains the ordinary value-producing statement scope:

```blot
let value = do:
  let x = runtime_input ()
  return x
```

`compdo:` has the same statement language and result rule, but the whole scope
must resolve during compilation:

```blot
const fields = compdo:
  let reflected = reflect T
  let names = field_names reflected
  return names
```

The common one-expression case does not need `compdo:`:

```blot
const fields = field_names (reflect T)
```

The grammar should reuse the existing `do_block` island rather than add another
block grammar:

```text
do_block = (
  phase:("do" | "compdo")
  ":"
  LAYOUT_NEWLINE
  LAYOUT_INDENT
  statements:statement*
  LAYOUT_DEDENT
) ;
```

Remove `"comptime"` from `prefix_operator` and from the keyword set, and add
`"compdo"` to the keyword set. CST lowering should lower both forms through the
existing block lowering; when `phase` is `compdo`, wrap the completed block in
the existing compiler-internal `comptime` expression. No downstream evaluator,
type, ownership, Core, or backend form is required.

A `compdo:` scope may use ordinary `let`, `const`, `if`, `case`, `for`, `:=`, and
`return`. If any demanded value in the scope still depends on unresolved runtime
data, compilation reports a staging diagnostic instead of residualizing the
scope.

## Function-local `const`

`const` means the same thing at module scope and inside a function: its value
must be resolved during compilation.

```blot
let render = fn value =>
  const separator = Text.append ":" " "
  return value <> separator
```

A function-local `const` may depend on a parameter or capture only when the
specialization reaching that declaration knows the required value at compile
time:

```blot
let select = fn T =>
  const member = member_for T
  return use member
```

If `T` is still runtime data at that specialization, the `const` is a staging
error. It never degrades into an ordinary runtime `let`. This keeps `const` as a
must-reduce assertion while still allowing useful compile-time work in function
scopes.

The evaluator already switches a `const` declaration to the compile-time phase.
The implementation work is therefore to make checking/staging preserve that
obligation at residual function bodies and to diagnose a residual dependency at
the declaration boundary.

## Writable effect-row tails

A signature may bind the rest of an effect row with one `..name` tail:

```blot
sig map =
  (a -> b ~ { ..e }) ->
  [a] ->
  [b] ~ { ..e }
```

Required effects may precede the tail:

```blot
sig logged_map =
  (a -> b ~ { ..e }) ->
  [a] ->
  [b] ~ { Console, ..e }
```

The intended rules are narrow:

- an effect row has at most one tail;
- a tail name is scoped to the immediately containing `sig`;
- every occurrence of the same tail name in that signature denotes the same
  inferred effect-row variable;
- a tail name must occur at least twice in the signature, so the source cannot
  introduce an unconstrained row variable;
- `{ Console }` remains closed;
- `{ ..e }` requires no named effect but is open through `e`;
- a bare `->` remains the exactly-empty row; and
- this does not add record row polymorphism.

The tail is signature syntax, not an ordinary array spread or runtime value.
Lowering should keep it as signature-local elaboration evidence until the `sig`
is interpreted, then discard the binder. It should not survive into Runtime HIR
or the ABI.

A possible grammar shape is:

```text
effect_row = (
  "{"
  head:effect_row_head?
  tail:effect_row_tail?
  "}"
) ;

effect_row_head = (
  effects:(expression % ",")
  comma:","?
) ;

effect_row_tail = (
  ".."
  name:IDENT
) ;
```

The final grammar needs to preserve the current `{}` versus shape disambiguation:
an effect row with neither named effects nor a tail is still invalid. `{ ..e }`
is the only newly empty-looking effect row.

## Element-free surface

The prototype intentionally adds no replacement syntax. The current element
form already lowers to:

```text
fn () => component properties children
```

where `properties` is a record and `children` is an array of nullary
computations. `element-free.blot` writes exactly that representation directly.
This makes the migration cost visible and separates three conveniences that
should not be assumed to require one feature:

- visual tag nesting;
- implicit child suspension; and
- closed/optional property checking.

Only after the corpus is converted should one of those conveniences earn new
surface syntax or a reusable prelude abstraction.

## Production implementation checklist

This draft does not edit the live grammar because a grammar change is complete
only when the generated compact plan, TypeScript tooling path, Rust production
lowerer, editor grammar, profile counters, and language specification move
together.

- [x] Write an executable element-free equivalent of the current element example.
- [x] Specify `compdo:` in terms of the existing block and internal comptime form.
- [x] Specify the function-local `const` must-reduce boundary.
- [x] Specify effect-row-tail scope and constraints.
- [ ] Change `grammar.baba` and regenerate the Baba/Tree-sitter artifacts.
- [ ] Update both TypeScript and Rust CST lowering.
- [ ] Enforce residual function-local `const` as a staging diagnostic.
- [ ] Elaborate effect-row tails into the existing inferred row variables.
- [ ] Remove the element grammar/lowering/editor queries and migrate rejection tests.
- [ ] Update `LANGUAGE.md`, `spec/STAGING.md`, `spec/TYPECHECKING.md`, and focused docs.
- [ ] Record parser-profile counter changes in `docs/gpu-profile.md`.
- [ ] Run `just check`, `just test`, generation/profile gates, and the compiler corpus.
