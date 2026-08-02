# blot

A functional language whose syntax is designed against a parallel GPU parser
from the start, rather than retrofitted to one.

See [LANGUAGE.md](LANGUAGE.md) for the complete language specification.
Executable application studies live in [case-studies/](case-studies/): a
grep-like file search, an interactive terminal program, an agent-style
conversation loop, and a 3D engine with a browser host and hot reload.

The TypeScript frontend is published as `@mewhhaha/blot`:

```ts
import { parse } from "@mewhhaha/blot";

const result = await parse("return 42;");
```

Run `deno task publish:dry-run` to verify the package before publishing.

`../binned` is the maximal version of this idea — 124k lines of TypeScript and a
language reference of 80k characters. `../baba/examples/gpu-duck` is the
opposite pressure: a grammar cut down until baba's WebGPU frontend can prove it
parallel-parseable. blot takes the second as the starting constraint and keeps
only what survives it.

The profile turns out to be a good editor. Almost everything it forbids —
contextual lexing, recursive precedence grammar, unbounded regions — is also
what made the reference language large.

## Status

It runs. M0 (the GPU-parseable grammar) and M1 (elaboration, the comptime
evaluator, and the prelude) are done. Every example in `examples/` evaluates to
a recorded value, and every program in the corpus — the prelude included — holds
byte parity between baba's CPU oracle and the WebGPU frontend.

Type inference (M2) landed too: `blot check` infers principal types with no
annotations anywhere, enforces `sig` by subsumption, and rejects unhandled
effects at the module boundary. See [docs/inference.md](docs/inference.md),
including what it does _not_ yet prove.

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

The gpufuck backend (M4) now lowers every accepted catalog program. `blot build`
emits stable Core WebAssembly plus a JSON ABI manifest without executing the
program. The identical manifest is embedded in the `blot:abi` custom section,
and generated adapters keep gpufuck's private heap representation out of the
caller contract. See [docs/abi.md](docs/abi.md). `just wasm` checks the
interpreter, gpufuck's GPU evaluator, and emitted Wasm against the same staged
runtime result. The CPU test suite sends the entire catalog through gpufuck as
well, so backend coverage does not require a WebGPU adapter. Compile-time-only
result fields are erased, runtime fields become named Wasm exports, host effects
become typed imports, and one-shot handlers are specialized through non-tail
resume and abort. See [docs/backend.md](docs/backend.md).

```bash
just run examples/tour.blot   # evaluate a program
just check-file examples/tour.blot  # infer its type and check ownership
just ownership examples/tour.blot   # last-use and linearity facts
just build examples/compiled.blot   # compile to WebAssembly
just serve                          # keep the GPU compiler resident
just build-service examples/compiled.blot
just wasm                           # interpreter vs GPU evaluator vs Wasm
just test                     # corpus goldens, rejections, profile gate
just parity                   # CPU oracle vs WebGPU frontend, needs an adapter
just generate                 # regenerate the parser; fails if the profile regresses
just inspect                  # the counters recorded in docs/gpu-profile.md
just install                  # Helix: grammar, queries, `.blot` association
```

An adjacent gpupaper checkout is an explicit experimental target:

```bash
deno run --allow-read --allow-write \
  src/cli.ts build --target=gpupaper \
  examples/minimal.blot examples/arithmetic.blot
```

Blot still owns parsing, checking, staging, specialization, and Runtime HIR
production. Gpupaper validates that HIR and emits each cache-miss plan through
its checked-in Rust/WebAssembly emitter. The target therefore requires no GPU.
It is intentionally local-checkout-only for now and does not support
compiler-service mode. Multiple paths are prepared independently and cache
misses retain stable input order. A source failure remains local to its path; an
emitter failure rejects every admitted miss rather than returning partially
trusted artifacts. Successful outcomes identify `wasmEmitter` as `rust-wasm`.

`just build` is an isolated direct build and releases its GPU device on exit.
For repeated local builds, run `just serve` in one terminal and use
`just build-service file.blot` from another. The service binds loopback only,
retains the parser, checked module graph, lowered Surface, GPU device, compiler
pipelines, and Wasm caches, and invalidates an edited module together with its
importers. `build-service` is a small `curl` client: it does not start Deno or
load either compiler. Both modes call the same compiler session and emit
identical Wasm and manifest bytes.

`just install` builds the Tree-sitter grammar from the same `grammar.baba` as
the GPU parser, installs highlight, indent, textobject, tag, and rainbow
queries, and registers `.blot` in a managed block in
`~/.config/helix/languages.toml`. Re-running replaces that block rather than
appending a second copy. It finishes by proving the editor grammar and the
compiler agree about what the language is — see [docs/editor.md](docs/editor.md)
for why that check exists.

## The language

Declarations are all `;`-terminated:

```blot
let name = expr;      // runtime binding
const name = expr;    // must evaluate at compile time
sig name = expr;      // optional constraint on the following binding
open {} = expr;      // spread every field into scope
open { .a: b, .c: _ } = expr; // rename .a to b and suppress .c
for src do … end;     // loop; see below
for ever do … end;    // iterate the prelude's infinite iterator
break;                // exit the nearest `for`
if c then do … end;   // conditional control flow
if let p = x else do … end; // bind p or leave through the else branch
name := expr;         // shadow an existing binding, preserving its type
name <- expr;         // sequence an effectful expression and bind its result
return expr;          // exit the nearest function or module
```

An expression `if` always has an `else` and produces one of its branch values:

```blot
let label = if ready then "ready" else "waiting" end;
```

There is no `yield`: the selected branch expression is the conditional's value.
It is a closed value computation: `return` and `break` cannot escape through one
of its branches. A standalone conditional is surrounding control flow, has an
optional `else`, and may transfer control:

```blot
let describe = fn value => do
  if value < 0 then do
    return "negative";
  end;
  in "non-negative"
end;
```

A deconstructing guard binds its pattern on the path that follows:

```blot
if let #Some value = candidate else do
  return fallback;
end;
// value is in scope here
```

This form has no `then`: its success path is the following statements, not a
second block. The `else` body must leave that path with `return` or `break`, so
every name in the pattern is known to exist afterward.

`do` is an expression block. Its semicolon-terminated statements are separated
from its value by `in`; without `in`, its value is `()`. The marker is required
by the strict GPU grammar because a bare trailing name and the start of
`name := ...;` have the same one-token prefix.

Element statements are ordinary effectful component calls with property records
and a nullary child computation:

```blot
<div .class="counter" .hidden={hidden}>
  _ <- text "Count: ";
  <Button .disabled=True />;
</div>;
```

This lowers to `div { .class = "counter"; .hidden = hidden; } children` under
`<-`. Both `div` and `Button` are ordinary lexical bindings; the syntax supplies
no implicit renderer or text operation. The body contains ordinary statements,
so effect order stays explicit, and a component renders its children by
sequencing `children ()`. A component's expected record makes ordinary fields
required. Writing `.field? = T` in that record means `.field = T | ()`, so the
field may be omitted and receives `()` at the call.

`for` is a declaration rather than an expression because what it produces is an
effect on the enclosing scope: the names its body rebinds with `:=` are the
accumulator, and the last iteration's values escape. That is a fold with the
state inferred, which is how blot has loops while having no assignment — `:=`
was already "a new binding", not "a new value in the old one".

`:=` preserves the binding's stable type: rebinding one integer literal to
another widens the name to `Int`, while rebinding it to text is rejected. A
repeated binding is the explicit type-changing form:

```blot
let value = 1;
let value = "now text";
```

```blot
let x = 1;
for Iter.range (0, 5) do        // run the body once per element
  x := x + 1;
end;
return x;                       // 6

for n in source do … end;       // bind each element
for #Some n in source do … end; // bind, and skip what does not match

for ever do
  x := x + 1;
  if done x then do
    break;
  end;
end;
```

A binder that cannot fail is a `let`. One that can becomes the `case` it looks
like, with the other arm handing the accumulator back untouched — so filtering
is one arm rather than a second construct.

A `case` arm may carry a guard, which is a refinement no pattern states:

```blot
case n of
  0 => "zero",
  m if m > 0 => "positive",
  _ => "negative"
end
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
nearest function. A `for` names nothing, so a module that loops over an iterator
it wrote itself needs nothing in scope. Looping over an _array_ needs
`Iter.items`, but that is a call the program writes and can see.

An iterator is a `.state` and a `.step`, where `step state` answers
`#Some (value, next_state)` or `#None`. The `Option` is not decoration: a step
returning `(value, state, Bool)` would have to produce a value in the case where
there is none, and for a polymorphic element no such value can be constructed —
the same hole that makes an empty `Store` need its own constructor. `Iter.range`
and `Iter.items` are ordinary prelude functions over that shape, and `ever` is
an ordinary iterator whose step always produces another unit. That is why
`for ever do` needs the prelude opened and no special grammar. A new kind of
sequence is a value someone writes. A state and a step rather than a closure
returning the next closure: both express the protocol, but the closure form
allocates one per element and leaves gpufuck resolving a lambda set that grows
with the loop.

Nothing is in scope that the module did not ask for. The prelude is an ordinary
module with no privilege, so every file begins by opening it:

```blot
open {} = @import "blot:prelude" ();
```

The empty mask keeps every field's name. A mask only describes exceptions:
`.source: target` renames one field and `.value: _` suppresses one, while every
unlisted field still enters scope unchanged. Renames may not collide with an
unlisted field; suppress or rename that field explicitly when both exist.
`@import` returns the imported module function, and the final `()` supplies its
empty module parameter.

That line is what makes `+` work: the default fixity for `+` names `Num.add`,
and a fixity whose target is not in scope is useless. A module that skips it
does not have `+`.

A module's parameter is checked, and nothing declares it. No module writes a
signature for its own parameter, so the demand is whatever its bodies reach for:
the record an importer hands over must carry every field the module projects,
and one that omits a field is a type error at the application rather than a
missing field at run time. It may carry _more_ — width subtyping holds across
the boundary in both directions, and such a record lowers, because the field
sets are settled once the whole program has been checked rather than as each
file finishes.

That is the whole of it. `type`, `interface`, `effect`, and `duck` do not exist
as declaration forms, because types are ordinary compile-time values:

```blot
const I32 = I 32;
const Message = #Ready | #Progress I32 | #Failed Str;
const Point = struct { .x = I32; .y = I32; };
```

`struct` hands back the storage type _itself_, with its constructor and
accessors attached to it, so one binding is both the type and its namespace:

```blot
const Point = struct { .x = I32; .y = I32; };   // Point is (I32, I32)

sig p = Point;
let p = Point.new { .y = 20; .x = 10; };        // (10, 20)
let x = Point.x p;                              // and so is p.0
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
const Pixel = { .red = U 8; .green = U 8; .mode = U 2; };
const bits = packed Pixel;
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
are bound to `Set.union`, `Set.intersect`, and `Set.diff` the same way `+` is
bound to `Num.add` — at a prelude record, never at a primitive. Because the
binding resolves by name at the use site, a module that defines its own `Set`
with those three fields rebinds all three operators for itself; structural width
subtyping is the whole of the dispatch, and there is no coherence rule because
there is no instance table. `examples/sets.blot` does exactly that over arrays.
Ranges, arrows, and seals are ordinary calls too, and reflection over a shape's
fields is a `fold`, which is why `derive` is a function rather than a macro.

Effects are a shape of operation types handed to one primitive, and performing
one is an ordinary call, so the row is inferred rather than declared. It is
still writable: `sig report = Unit -> Str ~ { Console };` says exactly what the
printer prints, a bare `->` is the empty row rather than an unwritten one, and a
row names effects that are in scope, so it is closed — there is no way to write
the row variable inference uses for a callback's effects.

`x <- expression;` sequences one. The expression is evaluated as written, so a
nullary operation keeps its explicit `()`; `let` remains a pure definition:

```blot
const Terminal = @effect { .read = Unit -> Str; };

let ask = fn () => do
  answer <- Terminal.read ();
  in answer <> "!"
end;
```

```blot
const Console = @effect { .write = Str -> Unit; };

let report = fn () => do
  _ <- Console.write "one";
  in "done"
end;

let joining = {
  .write = fn (message, ?resume) => do
    rest <- resume ();
    in message ++ rest
  end;
  .return = fn value => value;
};

@handle (Console, report, joining)   // "onedone"
```

`@handle` names the effect it discharges, which is what lets the checker
subtract it from the row: whatever `report` performs beyond `Console` is still
owed. `resume` is a real one-shot continuation: resuming collects the rest of
the computation, not resuming aborts it, and calling it twice is an error rather
than a convention.

Several handlers compose without manual nesting:

```blot
let result = try program then do
  program_without_terminal <- @handle (Terminal, fake_terminal);
  program_without_clock <- @handle (Clock, fake_clock);
  @handle (Random, fake_random)
end;
```

Each bound step names the nullary program with that source effect discharged;
the final step executes the composition. This is static sugar for nested
three-argument `@handle` calls, not a runtime handler registry.

An effect the _host_ implements is declared `@effect.host`, and its operations
become typed WebAssembly imports — so blot needs no raw import form, and its row
is the program's declared interface rather than something left unhandled:

```blot
const Console = @effect.host { .write = Str -> Unit; };
let report = fn () => do
  result <- Console.write "compiled";
  in result
end; // () -> () ~ { Console }
```

A handler the program did not write is a host capability. The entry module's
parameter is the entire authority it has — no ambient filesystem, no ambient
clock, nothing to import for more:

```blot
module init;

let printing = {
  .write = fn (message, resume) => do
    _ <- init.print message;     // opaque; the program can only call it
    result <- resume ();
    in result
  end;
  .return = fn value => value;
};
```

Because a type is a value, inspecting one means inspecting a value, and there is
no type-level `case` — there is `@type.reflect`, which names which case of the
value domain a type is and hands back the parts as an ordinary tagged value:

```blot
const element_of = fn t => case reflect t of
  #Sealed s => if text_eq (s.name, "List") then Some s.inner else None end,
  _ => None
end;
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
  width subtyping means `duck` contracts and typeclasses are unnecessary. A
  literal is a range whose bounds coincide, so `identity 42` infers `42`.
- **One parameter per function.** Juxtaposition is the only application form,
  which matches gpufuck's unary Core exactly.
- **Higher-kinded abstraction is comptime.** Type constructors are comptime
  functions, so the inference lattice never needs kinds. Explicit predicative
  Rank-N types use `@forall`; quantified arguments are skolemized and quantified
  values are instantiated only at monotypes.
- **Immutability with ownership.** No assignment anywhere. `!` is linear and `&`
  borrows, checked by a flow analysis kept deliberately _outside_ the type
  lattice — that separation is what keeps biunification polynomial.

`docs/gpu-profile.md` records what the GPU profile cost the language, and what
it did not.
