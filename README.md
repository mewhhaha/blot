# Blot

Blot is a functional language built as one coherent system: compact CST parsing,
comptime evaluation, algebraic subtyping, typed effects, ownership,
specialization, and WebAssembly compilation all shape the source language.

See [DOCS.md](DOCS.md) for idiomatic Blot, [LANGUAGE.md](LANGUAGE.md) for the
current language, and the [specification map](spec/README.md) for the language
model, compiler theorem, typechecking theory, staging, safety, lowering,
incrementality, and cost model. Executable application studies live in
[case-studies/](case-studies/): a grep-like file search, an interactive terminal
program, an agent-style conversation loop, and a 3D engine with a browser host
and hot reload.

`@mewhhaha/blot` uses Node/TypeScript as the default compiler development
environment. Node hosts Baba's checked-in generated parser and gpupaper's
embedded Rust/Wasm emitter. Blot's CI-built Rust compiler Wasm is the production
implementation; strict parity keeps both implementations on the same compiler
contract. Blot's TypeScript passes connect the development pipeline:

```ts
import { parse } from "@mewhhaha/blot";

const result = await parse("return 42\n");
```

Run `pnpm pack --dry-run` to verify the package before publishing.

## Direct definitions should stay viable

Blot's performance goal is not to make programmers translate the clear version
of an algorithm into compiler-shaped ceremony. Textbook definitions that are
often presented as elegant but dismissed as impractical should remain useful
source programs, with staging, specialization, loop recovery, layout selection,
and ownership reuse doing the mechanical work.

The executable catalog keeps that claim concrete:

| definition               | executable source                                                                            | what it pressures                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| persistent quicksort     | [`examples/quicksort.blot`](examples/quicksort.blot)                                         | structural recursion, stable partitioning, and allocation visibility |
| in-place quicksort       | [`examples/owned_quicksort.blot`](examples/owned_quicksort.blot)                             | one-Store ownership, partitioning, and memory reuse                  |
| naïve Fibonacci          | [`examples/pathological_fibonacci.blot`](examples/pathological_fibonacci.blot)               | non-tail overlapping recursion and the future memoization boundary   |
| recursive lists          | [`examples/pathological_recursive_values.blot`](examples/pathological_recursive_values.blot) | direct and mutual recursive algebraic values                         |
| binary trees             | [`examples/arena_binary_tree.blot`](examples/arena_binary_tree.blot)                         | compact arena layout and recursive traversal                         |
| recursive descent        | [`examples/walker.blot`](examples/walker.blot)                                               | mutually recursive functions with checked indexing                   |
| ordinary loops and folds | [`examples/loops.blot`](examples/loops.blot)                                                 | inferred loop state and structured control-flow recovery             |

These files are executable correctness claims. Performance claims are added only
with equal-semantics benchmarks: accepting naïve Fibonacci is not yet a claim
that exponential recursion has become linear. The point of keeping the direct
program in the corpus is to give optimization work a stable source-level target
without replacing it with a hand-written different algorithm.

The development and production compilers intentionally use the same phase
vocabulary: `frontend`, `typecheck`, `hir`, `backend`, and `session`. The Node
modules under `src/compiler/` are arranged to resemble the corresponding Rust
modules under `compiler/src/`, so a feature can be developed readably in
TypeScript and then ported phase-for-phase to production Rust.

Blot libraries can be distributed through an ordinary npm-linked package. The
package owns a `blot.json` manifest and may ship both readable source and a
checked module capsule:

```json
{
  "schema": "blot-package",
  "version": 3,
  "exports": {
    ".": {
      "source": "./src/mod.blot",
      "built": "./dist/mod.blotc"
    }
  }
}
```

The Node CLI does not build package capsules yet. It does resolve existing
source and capsule exports from `node_modules`. An importer writes
`import "@scope/package"`, or a declared package subpath, and Blot resolves the
nearest `node_modules` package without executing its JavaScript. A valid
`.blotc` is preferred and corrupt or unsupported built files fall back to the
declared source. The capsule bundles the package-owned lowered AST graph and its
includes without retaining source text, while package imports remain shared
external edges. Consumer-specific typechecking and compile-time specialization
still happen in the importer, so a reusable capsule is not final WebAssembly.
See [spec/PACKAGES.md](spec/PACKAGES.md).

The parser profile is a design tool, not an implementation afterthought. It
rules out contextual lexing and recursive precedence grammar, keeping both the
grammar and the language small enough to understand. Node instantiates Baba
9.0.0's generated lexer Wasm with Blot's checked-in binary and plan. Because
that plan uses Baba's `general` throughput profile, Baba's own CPU island
executor completes parsing; the generated-Wasm island parser intentionally
accepts only `strict`. WebGPU remains a comparison target.

## Status

It runs. M0 (the Baba-profile grammar) and M1 (elaboration, the comptime
evaluator, and the prelude) are done. Every example in `examples/` evaluates to
a recorded value, and every program in the corpus — the prelude included — is
accepted and materialized by Baba 9's CPU frontend.

Type inference (M2) landed too: `blot check` infers principal types with no
annotations anywhere, enforces `sig` by subsumption, and rejects unhandled
effects at the module boundary. See [docs/inference.md](docs/inference.md),
including what it does _not_ yet prove. The declarative relation, solver lemmas,
transactional implementation invariants, and performance gates are in
[spec/TYPECHECKING.md](spec/TYPECHECKING.md).

A branch proves what its condition computes, and the proof is set algebra on
types. `if n == 1` narrows `n` to `1` in the taken branch and to `T \\ 1` in the
untaken one; comparisons compose, and `&&` proves what both halves prove. A
`case` over what a branch proved can then be complete, and one over an unbounded
domain is refused rather than left to trap — `@panic` is how an arm says why
reaching it is impossible. An array's length is a bound an index can be compared
against, so a checked read is accepted and a constant past the end is a compile
error.

Nothing is recognised by name: a comparison and a junction are both identified
by _tabulating_ them, so a module that shadows `Eq` or `Logic.and` with
something that is not equality or conjunction proves nothing rather than
something false.

Linearity and ownership (M3) landed too: `!` is checked exactly-once on every
path, `?` at most once — which is what makes `resume` one-shot statically rather
than by runtime check — `&` may be read but never moved, and a closure inherits
the strongest obligation it captured. A recursive group is one scope here as
well: a member spends a sibling wherever the sibling is written, and a closure
holding a spendable value cannot be called from inside its own group, because a
recursive call is a second call. `blot ownership` prints the last-use facts the
backend consumes. A final `@array.set` or `@array.push` on a proved linear array
reuses its Store allocation; ordinary shared arrays remain persistent. See
[docs/ownership.md](docs/ownership.md).

The compiler (M4) develops accepted programs through the Baba-Wasm → Node →
gpupaper-Wasm pipeline; the CI-built Rust compiler Wasm is the production
implementation. `pnpm blot check` and `pnpm blot build` need neither Deno nor
native Rust; building produces caller-facing WebAssembly plus a JSON ABI
manifest without executing the program. The identical manifest is embedded in
the `blot:abi` custom section. See [docs/abi.md](docs/abi.md). Compile-time-only
result fields are erased, runtime fields become named Wasm exports, host effects
become typed imports, and one-shot handlers are specialized through non-tail
resume and abort. See [docs/backend.md](docs/backend.md).

The public `Compiler` API runs the same pipeline as `pnpm blot build`. Baba's
generated Wasm parses source, Blot's TypeScript checker and staging passes
produce validated Runtime HIR, and gpupaper 0.1.6 lowers Core through its
embedded Rust/Wasm emitter. The operational boundary is documented in
[docs/compiler.md](docs/compiler.md).

The production compiler binary is not committed to Git. CI publishes a 90-day
`blot-rust-compiler` artifact and a runnable workspace containing the same
bytes. From a checkout at the corresponding commit, `pnpm compiler:download`
downloads the latest successful artifact for that commit and verifies its source
tree, pinned toolchain provenance, byte length, Wasm header, and SHA-256 before
installing it under `generated/compiler/`. `pnpm compiler:build` reproduces it
locally when Cargo and the Wasm target are available. Downloading requires an
authenticated GitHub CLI that can read Actions artifacts for the repository.

```ts
import { Compiler } from "@mewhhaha/blot";

const compiler = await Compiler.create();
try {
  const artifact = await compiler.compile("examples/minimal.blot");
  console.log(artifact.wasm.byteLength);
} finally {
  compiler.destroy();
}
```

```bash
corepack enable
pnpm install
pnpm blot check examples/tour.blot
pnpm blot build examples/compiled.blot
pnpm blot ast examples/minimal.blot
pnpm test
```

Compile one or several modules through Node:

```bash
pnpm blot build examples/minimal.blot examples/arithmetic.blot
```

Blot owns parsing policy, checking, staging, specialization, Runtime HIR,
canonical ABI adapters, and target orchestration. Baba's generated Wasm lexer
and general-profile CPU island executor own syntax. Gpupaper owns Core-to-Wasm
planning and uses its embedded Rust/Wasm emitter for the final bytes. Node
supplies filesystem and package access and hosts both Wasm modules. No compiler
command initializes WebGPU or invokes Deno, Cargo, or a native Rust binary.

`just install` builds the Tree-sitter grammar from the same grammar source as
the GPU parser, installs highlight, indent, textobject, tag, and rainbow
queries, and registers `.blot` and the language server in a managed block in
`~/.config/helix/languages.toml`. Re-running replaces that block rather than
appending a second copy. It finishes by proving the editor grammar and the
compiler agree about what the language is — see [docs/editor.md](docs/editor.md)
for why that check exists.

## The language

Declarations end at a logical newline; indentation delimits suites:

```blot
let name = expr          // runtime binding
const name = expr        // must evaluate at compile time
sig name = expr          // constraint on the following binding
open expr                // spread every field into scope
for src:                 // loop; see below
  ...
for ever:                // iterate the prelude's infinite iterator
  ...
break                    // exit the nearest `for`
if c:                    // conditional control flow
  ...
if let p = x else:       // bind p or leave through the else branch
  return fallback
name := expr             // shadow a name while preserving its type
name <- expr             // sequence an effect and bind its result
<- expr                  // sequence an effect and discard its result
return expr              // exit the nearest function, `do`, or module
```

Value selection is written with `case`, including Boolean choices:

```blot
let label = case ready of
  #True => "ready"
  #False => "waiting"
```

A standalone `if` is surrounding control flow, has an optional `else`, and may
transfer control:

```blot
let describe = fn value =>
  if value < 0:
    return "negative"
  return "non-negative"
```

A deconstructing guard binds its pattern on the path that follows:

```blot
if let #Some value = candidate else:
  return fallback
// value is in scope here
```

This form has no success suite: its success path is the following statements.
The `else` body must leave that path with `return` or `break`, so every name in
the pattern is known to exist afterward.

An indented expression block produces `()` when it reaches its dedent;
`return value` exits the current module or explicit expression block, including
from a statement branch or across a loop. Bare `break` only exits a `for`. A
bare trailing expression remains invalid because a trailing name and the start
of `name := ...` have the same one-token prefix.

Components use ordinary functions, records, arrays, and nullary computations;
there is no element syntax. A renderer-shaped API can keep the same convention
explicitly:

```blot
let label = fn () =>
  <- text "Count: "
let save = fn () =>
  <- Button { .label = "Save"; .disabled = (); } []
<- div { .class = "counter"; .hidden = hidden; } [label, save]
```

The component decides whether and when to execute child computations. Property
records use ordinary structural record typing, and child suspension is explicit
rather than introduced by tag syntax.

`for` is a declaration rather than an expression because what it produces is an
effect on the enclosing scope: the names its body rebinds with `:=` are the
accumulator, and the last iteration's values escape. That is a fold with the
state inferred, which is how blot has loops while having no assignment — `:=`
was already "a new binding", not "a new value in the old one".

`:=` preserves the binding's stable type: rebinding one integer literal to
another widens the name to `Int`, while rebinding it to text is rejected. A
repeated binding is the explicit type-changing form:

```blot
let value = 1
let value = "now text"
```

```blot
let x = 1
for Iter.range (0, 5):          // run the body once per element
  x := x + 1
return x                        // 6

for n in source:                // bind each element
  ...
for #Some n in source:          // bind, and skip what does not match
  ...

for ever:
  x := x + 1
  if done x:
    break
```

A binder that cannot fail is a `let`. One that can becomes the `case` it looks
like, with the other arm handing the accumulator back untouched — so filtering
is one arm rather than a second construct.

A `case` arm may carry a guard, which is a refinement no pattern states:

```blot
case n of
  0 => "zero"
  m if m > 0 => "positive"
  _ => "negative"
```

A false guard falls through to the arms below, so the arms keep their order —
`5 => "five"` above a guard still wins for 5. A guarded arm never counts towards
coverage, because its guard may be false: the arms that remain have to cover the
target on their own, and a `case` whose arms are all guarded covers nothing.
Guards desugar during CST lowering like every other surface form, so what
reaches coverage, the evaluator, and the backend is ordinary arms.

`for` desugars to `rec`/`case` recursion during CST lowering, so there is no
loop in the AST, none in the evaluator, and none in the backend. `break` carries
the accumulator as it exists at that point; it can appear inside a standalone
`if`, targets the nearest `for`, and cannot cross a function or
value-conditional boundary. `return` instead crosses a `for` and exits the
current module or explicit expression block. A `for` names nothing, so a module
that loops over an iterator it wrote itself needs nothing in scope. Looping over
an _array_ needs `Iter.items`, but that is a call the program writes and can
see.

An iterator is a `.state` and a `.step`, where `step state` answers
`#Some (value, next_state)` or `#None`. The `Option` is not decoration: a step
returning `(value, state, Bool)` would have to produce a value in the case where
there is none, and for a polymorphic element no such value can be constructed —
the same hole that makes an empty `Store` need its own constructor. `Iter.range`
and `Iter.items` are ordinary prelude functions over that shape, and `ever` is
an ordinary iterator whose step always produces another unit. That is why
`for ever:` needs the prelude opened and no special grammar. A new kind of
sequence is a value someone writes. A state and a step rather than a closure
returning the next closure: both express the protocol, but the closure form
allocates one per element and leaves the compiler resolving a lambda set that
grows with the loop.

Array address order is also expressed through that protocol, without a second
`View` value or a temporary array. `Iter.affine (values, start, stop, stride)`
walks a half-open interval: a positive stride continues while `index < stop`, a
negative stride continues while `index > stop`, and zero produces no elements.
`Iter.slice` and `Iter.reverse` are ordinary specializations. The intended
surface remains `for`:

```blot
let total = 0

for value in Iter.slice (values, 2, 8):
  total := total + value

for value in Iter.reverse values:
  total := total + value * value

for value in Iter.affine (values, 0, Array.length values, 2):
  total := total + value       // every other element
```

These iterators borrow one logical array value. Runtime lowering gives a bound
dynamic array one Store identity, keeps the root and affine parameters
loop-invariant, and emits scalar induction plus `store.read`; selecting,
reversing, and striding do not allocate collections. Bounds remain total:
starting outside the Store or stepping to its edge ends the iterator. See
[`spec/AFFINE_ITERATION.md`](spec/AFFINE_ITERATION.md) for the lowering and
evidence contract.

Nothing is in scope that the module did not ask for. The prelude is an ordinary
module with no privilege, so every file begins by opening it:

```blot
open import "blot:prelude"
```

Selective binding and renaming use the ordinary record pattern instead:

```blot
const { .source = target; .value; } = library
```

`import "specifier"` evaluates one module instance with unit. A module that
declares `module with input` is instantiated explicitly with
`import "specifier" with value`.

Non-Blot files enter through `@include`. The second argument is an ordinary
compile-time function, so the program owns both parsing and representation:

```blot
const as_raw = fn source => source.text
const shader = @include "./shaders/main.wgsl" as_raw

open import "blot:prelude"
const config = @include "./config.json" as_json
const fixed_config = @include "./config.json" as_const_json
```

The function receives `{ .specifier; .path; .text; }`. Included files are
tracked compiler dependencies, and the result is compile-time-only: bind it with
`const`, then specialize whatever runtime value the program needs. `as_json`
widens JSON leaves to `Str`, `Int`, `Bool`, and `F64` while preserving object
fields. `as_const_json` retains literal compile-time values instead.

That line is what makes `+` work: the default fixity for `+` names `Num.add`,
and a fixity whose target is not in scope is useless. A module that skips it
does not have `+`.

A module's input is checked, and nothing separately declares it. The demand is
whatever its body reaches for: the record an importer hands over must carry
every field the module projects, and one that omits a field is a type error at
the import rather than a missing field at run time. It may carry _more_ — width
subtyping holds across the boundary in both directions, and such a record
lowers, because the field sets are settled once the whole program has been
checked rather than as each file finishes.

Types and effects do not need separate declaration forms because they are
ordinary compile-time values:

```blot
const I32 = I 32
const Message = #Ready | #Progress I32 | #Failed Str
const Point = struct { .x = I32; .y = I32; }
```

`struct` hands back the storage type _itself_, with its constructor and
accessors attached to it, so one binding is both the type and its namespace:

```blot
const Point = struct { .x = I32; .y = I32; }   // Point is (I32, I32)

sig p = Point
let p = Point.new { .y = 20; .x = 10; }        // (10, 20)
let x = Point.x p                              // and so is p.0
```

The members are invisible to typing — the bridge, equality, and inhabitation see
straight through — so `sig p = Point;` constrains `p` to the tuple and nothing
about the namespace reaches the lattice. The storage is a tuple rather than an
array because a tuple keeps one type per slot; `[I32, Str]` collapses to "an
array of int-or-text" the moment inference looks at it, and storage that is
imprecise is not predictable storage.

`<+` is what attaches the namespace, and it works on any type value:

```blot
const Meters = seal ("Meters", I32)
  <+ { .of = fn n => seal ("Meters", n); }
  <+ { .unit = "m"; };
```

A shape's fields are in declaration order and `reorder` rebuilds one in any
other, so choosing a placement is an operation on the shape rather than a second
entry point into `struct`. _Packing_ is a separate question — which bits a field
occupies rather than which slot — and stays a separate call:

```blot
const Pixel = { .red = U 8; .green = U 8; .mode = U 2; }
const bits = packed Pixel
// bits.bit_size == 18, bits.byte_size == 3
```

`I n` and `U n` are ordinary source functions that construct signed and unsigned
integer ranges and attach their declared width as transparent metadata. `packed`
is also prelude source: it reads that metadata and reports each field's bit
offset, width, and mask. It is a layout description, not another runtime
representation; `Int` arithmetic and the Core Wasm ABI remain signed 64-bit.

The name-to-slot mapping is compile-time knowledge, so `new` runs at compile
time and what reaches WebAssembly is the tuple and a projection at a fixed
index. A struct's namespace does not appear in its type, so a function that
takes a struct cannot read `.fields` off its parameter — hand it `Point.fields`
instead, which is what derivation wants anyway.

`struct` is prelude source — about forty lines over `@shape.*` and
`@type.attach` — not a compiler builtin. Types are sets, so `|`, `&`, and `\`
are bound to `Type.union`, `Type.intersect`, and `Type.diff` the same way `+` is
bound to `Num.add` — at a prelude record, never at a primitive. Because the
binding resolves by name at the use site, a module that defines its own `Type`
with those three fields rebinds all three operators for itself; structural width
subtyping is the whole of the dispatch, and there is no coherence rule because
there is no instance table. The runtime `Set` collection is a separate prelude
record and does not affect the type operators. Ranges, arrows, and seals are
ordinary calls too, and reflection over a shape's fields is a `fold`, which is
why `derive` is a function rather than a macro.

Effects are a shape of operation types handed to one primitive, and performing
one is an ordinary call, so the row is inferred rather than declared. It is
still writable: `sig report = Unit -> Str ~ { Console }` is a closed row and a
bare `->` is exactly empty. Higher-order signatures may name the rest of a row
with a signature-local tail such as
`(a -> b ~ { ..e }) -> a -> b ~ { Console,
..e }`; repeating the tail relates
those positions without granting authority to construct or handle the effects it
carries.

`x <- expression` sequences one. A nullary effect value is forced with `()`, so
it can be stored before it is executed; `let` remains a pure definition:

```blot
const Terminal = @effect { .read = Unit -> Str; }

let ask = fn () =>
  let effect = Terminal.read
  answer <- effect
  return answer <> "!"
```

```blot
const Console = @effect { .write = Str -> Unit; }

let report = fn () =>
  <- Console.write "one"
  return "done"

let joining = {
  .write = fn (message, ?resume) =>
    rest <- resume ()
    return message ++ rest
  ;
  .return = fn value => value;
}

@handle (Console, report, joining)   // "onedone"
```

`@handle` names the effect it discharges, which is what lets the checker
subtract it from the row: whatever `report` performs beyond `Console` is still
owed. `resume` is a real one-shot continuation: resuming collects the rest of
the computation, not resuming aborts it, and calling it twice is an error rather
than a convention.

Several handlers compose without manual nesting:

```blot
let handled = program
  |> @handle (Terminal, fake_terminal)
  |> @handle (Clock, fake_clock)
  |> @handle (Random, fake_random)
```

A two-argument `@handle (effect, handler)` is a computation transformer awaiting
its middle argument, so each `|>` step discharges one effect and produces
another nullary computation. The steps saturate to ordinary three-argument
`@handle` calls during CST lowering — static composition, not a runtime handler
registry.

An effect the _host_ implements is declared `@effect.host`, and its operations
become typed WebAssembly imports — so blot needs no raw import form, and its row
is the program's declared interface rather than something left unhandled:

```blot
const Console = @effect.host { .write = Str -> Unit; }
let report = fn () =>
  result <- Console.write "compiled"
  return result
// () -> () ~ { Console }
```

A handler the program did not write is a host capability. The entry module's
input is the entire authority it has — no ambient filesystem, no ambient clock,
nothing to import for more:

```blot
module with init

let printing = {
  .write = fn (message, resume) =>
    <- init.print message     // opaque; the program can only call it
    result <- resume ()
    return result
  ;
  .return = fn value => value;
}
```

Because a type is a value, inspecting one means inspecting a value, and there is
no type-level `case` — there is `@type.reflect`, which names which case of the
value domain a type is and hands back the parts as an ordinary tagged value:

```blot
const element_of = fn t => case reflect t of
  #Sealed s => if text_eq (s.name, "List"):
    return Some s.inner
  else:
    return None
  _ => None
```

`refines`, `Extract`, `Exclude`, `Pick`, and `Omit` are all prelude source over
that one primitive, and `Extract` filters a union by which members refine a
bound the way its TypeScript namesake does. `examples/reflect.blot` is the
catalog entry.

`examples/tour.blot` exercises every form the grammar accepts, and
`examples/rejected/` holds the programs that must be refused, split by whether
they fail at parse or during evaluation.

## Design

- **Types are values.** No type-level sublanguage, so no type sublanguage in the
  grammar either — twelve rules the reference grammar needs simply do not exist
  here.
- **Algebraic subtyping.** Biunification over a polar lattice, as in
  [1subml](https://github.com/Storyyeller/1subml). Effect rows are a lattice
  element like any other, so effect inference is not a separate pass. Structural
  width subtyping makes record compatibility direct rather than mediated by a
  nominal conformance table. A literal is a range whose bounds coincide, so
  `identity 42` infers `42`.
- **One parameter per function.** Juxtaposition is the only application form,
  keeping application and specialization uniform.
- **Higher-kinded abstraction is comptime.** Type constructors are comptime
  functions, so the inference lattice never needs kinds. Explicit predicative
  Rank-N types use `@forall`; quantified arguments are skolemized and quantified
  values are instantiated only at monotypes.
- **Immutability with ownership.** No assignment anywhere. `!` is linear and `&`
  borrows, checked by a flow analysis kept deliberately _outside_ the type
  lattice — that separation is what keeps biunification polynomial.

`docs/gpu-profile.md` records what the GPU profile cost the language, and what
it did not.
