# blot

A functional language whose syntax is designed against a parallel GPU parser
from the start, rather than retrofitted to one.

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

Linearity and ownership (M3) landed too: `!` is checked exactly-once on every
path, `?` at most once — which is what makes `resume` one-shot statically rather
than by runtime check — `&` may be read but never moved, and a closure inherits
the strongest obligation it captured. `blot ownership` prints the last-use facts
the backend will consume. See [docs/ownership.md](docs/ownership.md).

Not done: the gpufuck backend (M4), so reuse is analysed but not yet applied.
The evaluator is the runtime for now, which is no accident — blot needs one
anyway, because types are values.

```bash
just run examples/tour.blot   # evaluate a program
just check-file examples/tour.blot  # infer its type and check ownership
just ownership examples/tour.blot   # last-use and linearity facts
just test                     # corpus goldens, rejections, profile gate
just parity                   # CPU oracle vs WebGPU frontend, needs an adapter
just generate                 # regenerate the parser; fails if the profile regresses
just inspect                  # the counters recorded in docs/gpu-profile.md
just install                  # Helix: grammar, queries, `.blot` association
```

`just install` builds the Tree-sitter grammar from the same `grammar.baba` as
the GPU parser, installs highlight, indent, textobject, tag, and rainbow
queries, and registers `.blot` in a managed block in
`~/.config/helix/languages.toml`. Re-running replaces that block rather than
appending a second copy. It finishes by proving the editor grammar and the
compiler agree about what the language is — see [docs/editor.md](docs/editor.md)
for why that check exists.

## The language

Three declaration forms, all `;`-terminated:

```blot
let name = expr;      // runtime binding
const name = expr;    // must evaluate at compile time
sig name = expr;      // optional constraint on the following binding
name := expr;         // shadow: new binding, type may change
return expr;          // module or block result, last
```

That is the whole of it. `type`, `interface`, `effect`, and `duck` do not exist
as declaration forms, because types are ordinary compile-time values:

```blot
const I32 = range (-2147483648, 2147483647);
const Message = #Ready | #Progress I32 | #Failed Str;
const Point = struct { .x = I32; .y = I32; };
```

`struct` is prelude source — about fifteen lines over `@shape.*` — not a
compiler builtin. `|` is an operator bound to `@type.union`. So is `+`, which
resolves to `Num.add`. Set algebra, ranges, arrows, and seals are all ordinary
calls, and reflection over a shape's fields is a `fold`, which is why `derive`
is a function rather than a macro.

Effects are a shape of operation types handed to one primitive, and performing
one is an ordinary call — the row is never written:

```blot
const Console = @effect { .write = Str -> Unit; };

let report = () => do
  const _ = Console.write "one";
  return "done";
end;

let joining = {
  .write = (message, resume) => message ++ resume ();
  .return = value => value;
};

handle (report, joining)   // "onedone"
```

There is no `try`, no `with`, no `handler` keyword, and no `<-`. `resume` is a
real one-shot continuation: resuming collects the rest of the computation, not
resuming aborts it, and calling it twice is an error rather than a convention.

A handler the program did not write is a host capability. The entry module's
parameter is the entire authority it has — no ambient filesystem, no ambient
clock, nothing to import for more:

```blot
module init;

let printing = {
  .write = (message, resume) => do
    const _ = init.print message;   // opaque; the program can only call it
    return resume ();
  end;
  .return = value => value;
};
```

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
  functions, so the inference lattice never needs kinds.
- **Immutability with ownership.** No assignment anywhere. `!` is linear and `&`
  borrows, checked by a flow analysis kept deliberately _outside_ the type
  lattice — that separation is what keeps biunification polynomial.

`docs/gpu-profile.md` records what the GPU profile cost the language, and what
it did not.
