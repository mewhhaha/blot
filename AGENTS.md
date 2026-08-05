# AGENTS.md

## Goal

The simplest language that keeps the reference feature set, fits baba's WebGPU
frontend profile, and compiles without requiring WebGPU.

```txt
source -> baba CPU frontend -> compact CST -> fixity fold -> AST
       -> comptime evaluation -> biunification -> linearity/ownership
       -> specialize -> ClosedProgram -> direct Rust/WebAssembly emission
```

blot owns source elaboration, inference, comptime, ownership, Runtime HIR, ABI
policy, the module shell, and direct Rust/WebAssembly emission. baba owns lexing
and parsing; do not hand-write a lexer or parser. The compiler executes Baba's
generated compact plan inside its checked-in Rust-built Wasm. Gpupaper remains
an independent bounded conformance oracle, not a production compiler path. The
GPU paths remain explicit conformance tools, not compiler targets.

## Invariants

These are the decisions a change must not silently reverse.

**The frontend profile is a gate, not an aspiration.** `deno task generate`
must succeed with the version-3 general profile accepted and every grammar rule
declared as an island, because the CPU frontend's compact CST preserves island
nodes. If a grammar change needs a `metadata.parser.resolutions` entry to
generate, the grammar is wrong — every conflict so far had a design fix that
made the language better, not a metadata override. Record counter changes in
`docs/gpu-profile.md`.

**The language specification changes with the language.** `LANGUAGE.md` is the
normative description of accepted source and its meaning. Any change to syntax,
lowering semantics, inference, ownership, effects, modules, primitives, runtime
boundaries, or the prelude's public API must update `LANGUAGE.md` in the same
diff. Examples and implementation comments support the specification; they do
not replace it.

**The compiler specification changes with the compiler.** `spec/COMPILER.md`
defines the artifact graph and whole-compiler obligation; its focused references
own the detailed pass contracts. A change to a pass boundary, trusted fact,
certificate, cache key, target relation, or benchmark boundary must update the
corresponding specification in the same diff. Operational notes in `docs/` do
not replace that contract.

**The CPU compact CST is the parser contract.** Every accepted corpus program
must pass through Baba's `CpuFrontend` and Blot's CST materializer. The WebGPU
executor is an experimental comparison target, not a compiler fallback or a
release gate under the general profile.

**Nothing is implicitly in scope.** The prelude is an ordinary module reached
through `@import` and spread with `open`; it gets no seeding, no privileged
scope, and no exemption from its own type system. A default fixity names a
binding by string, so `+` works only because something opened `Num` — do not
reintroduce an implicit scope to make that line disappear.

**A loop is a fold, not an assignment.** `for` desugars during CST lowering:
the names its body rebinds with `:=` become the accumulator record, and nothing
downstream of the parser knows a loop exists. `break;` carries that record out
of the nearest `for`; `return` carries its value through the repeated body to
the nearest enclosing module or explicit `do` scope.
`ever` is an ordinary prelude iterator, not a keyword
or compiler special case. Do not give these forms AST nodes, typing rules, or
backend paths — each would be a second way to say what recursion and cases
already say. And do not add assignment to make a loop read more directly; that
would put mutation in a language whose ownership analysis assumes there is
none.

**`:=` preserves type.** It shadows an existing binding with another value of
the same stable type; singleton literals widen to their integer or text domain
when rebound. A repeated `let` or `const` is the explicit way to shadow a name
while changing its type.

**Surface forms desugar; they do not get machinery.** `for` becomes
`rec`/`case` recursion, `break;` becomes loop-local control, and early `return`
becomes an unspellable compiler-local tagged result eliminated by a `case` at
the nearest module or explicit `do` boundary. A standalone `if` becomes an ordinary
conditional over those results, and `x <- e` explicitly sequences the already
applied expression `e`, all during CST lowering. `try program with ... end`
likewise becomes named nullary
computations containing ordinary three-argument `@handle` calls; its bounded
left-hand `<-` binds that computation rather than using the general declaration
form. Nothing downstream of the parser knows these forms exist. A desugaring
emits the recursion rather than calling a prelude function that contains it: a
keyword whose meaning depends on a name being in scope is a dependency the
program cannot see. A new form earns an AST node only when no existing one can
say what it means — otherwise it is a second way to say something the language
already says, and every pass has to learn it.

**Value conditionals do not transfer control.** An expression `if` or `case`
produces one of its branch values and does not itself establish a statement
control target. An explicit `do` branch is its own return scope; `break;` cannot
escape it to reach an enclosing loop. A standalone `if ... then ... end;`
inherits the surrounding return and loop targets. Expression `if` requires
`else`; statement `if` does not.

**A deconstructing guard must leave on failure.**
`if let pattern = value else ... end;` binds the pattern in the statements
that follow it. Its `else` path must `return` or `break`; allowing that path to
continue would put names in scope that were never bound. There is no `then`
because success continues after the guard rather than entering another block.

**Types are values.** There is no type-level sublanguage and no type namespace.
If a feature seems to need one, it belongs in the comptime evaluator instead.
This is what keeps the grammar small; do not reintroduce `type`, `interface`,
`effect`, or `duck` as declaration forms.

**`@handle` names its effect.** The checker must see that call site — the
effect being discharged is part of the typing rule — so `@handle` is the one
primitive that takes a tuple rather than being curried, and it has no prelude
wrapper. A wrapper would hide it behind a closure whose parameter is not a
compile-time value.

**Few primitives.** New capability goes in `src/prelude/*.blot` first. It earns
an `@`-primitive only when it cannot be written in blot at all. `struct`,
`packed`, `Bool`, `Option`, `fold`, and every operator are prelude source.

**Linearity is not in the type lattice.** Biunification stays polynomial only
if ownership and linearity remain a separate flow analysis over Core.

**Monomorphize before any conformance lowering.** blot's algebraic-subtyping
result is the authority. Anything sent to the gpufuck/gpupaper oracle must be
specialized enough for its independent checker to accept. An oracle inference
failure on a well-typed blot program is a lowering bug, never a type-system
disagreement to paper over.

**The three executions agree.** The comptime evaluator, gpufuck's GPU
evaluator, and the emitted Wasm run the same language. `just wasm` requires all
three to produce the same value; a lowering that satisfies one and not another
is wrong.

**The caller never sees gpufuck values.** Blot Core Wasm ABI 1 is the stable
memory32, UTF-8 caller contract in `docs/abi.md`. Exports and host effects use
its canonical adapters; gpufuck's tagged words, constructor numbers, and heap
headers remain private. An incompatible layout, signature, ownership, import,
or semantic change requires another ABI major and a matching `LANGUAGE.md`
change. The sidecar and `blot:abi` custom-section bytes must stay identical.

**Inference feeds the backend.** Field sets, constructor sets, and compile-time
declaration values are recorded during checking, keyed by AST node identity,
because a nominal declaration needs the whole set and a residual block may
still contain a local compile-time binding. Do not re-derive them in the
backend — that is a second type checker and, for effects, would mint a different
identity. This is why `load` keeps one cache per process.

**Compiler commands must not touch WebGPU.** Parsing executes Baba-generated
tables and compilation runs inside the checked-in Rust compiler Wasm. Keep the
split structural so ordinary compiler, formatter, and language-server processes
never initialize a device.

## Style

- No ternary expressions and no nullish coalescing.
- Do not silently default when compiler information is missing.
- Distinguish invariants from diagnostics. An invariant is a fact the compiler
  must already know — throw. A diagnostic is a problem with the user's program
  — accumulate and return, so a pass reports everything it found.
- A check that cannot infer a type stays silent rather than cascading one root
  cause into every derived expression.
- Inline a helper that only calls one other function.

## Tests

Deno tests next to the implementation they cover. `examples/` is the executable
catalog: one program per feature, including the ones that must be rejected and
the ones that must trap. Inference tests assert principal types as strings, so
a lattice change that widens an inferred type shows up as a diff rather than as
"still compiles".
