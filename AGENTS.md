# AGENTS.md

## Goal

The simplest language that keeps the reference feature set, fits Baba's parser
profile, and has one semantic compiler implemented in Rust and shipped as Wasm.

```txt
source -> Baba Wasm lexer -> layout -> Baba lexical acceptance
       -> Baba CPU island parser -> compact CST -> AST
       -> comptime evaluation -> biunification -> linearity/ownership
       -> Runtime HIR -> ABI closure -> Rust/Wasm emission -> Wasm
```

Blot owns source elaboration, inference, comptime, ownership, Runtime HIR, ABI
policy, and the module shell. Baba owns lexing and parsing; do not hand-write a
lexer or parser. Rust/Wasm is the only semantic implementation. Node/TypeScript
hosts the compiler artifact, resolves source graphs, and owns syntax-only CLI,
formatter, and editor integration. Alternate oracles may consume validated
Runtime HIR, but they are not compiler targets or semantic authorities.

## Invariants

These are the decisions a change must not silently reverse.

**The frontend profile is a gate, not an aspiration.** Baba generation must
succeed with the version-3 general profile accepted and every grammar rule
declared as an island, because Baba's compact general-profile plan preserves island nodes. If a grammar change needs a `metadata.parser.resolutions` entry to
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

**Compiler failures are not source diagnostics.** A diagnostic requires source
evidence and a real source span. Unsupported target policy is a target refusal;
a failed fact after successful checking is an invariant failure. Never turn a
backend exception into a synthetic diagnostic at offset zero.

**Baba owns the complete syntax contract.** Every accepted program first passes
through the checked-in generated Wasm lexer, then through Baba's
`CpuFrontend` general-profile island executor and Blot's compact-CST
materializer. Baba's Wasm island parser is strict-profile-only and must not be
used to misinterpret the general plan. Blot must not implement an independent lexer or parser. The current CPU parser
API replays Baba's own lexer plan internally; that host-level replay is not a
second syntax contract. WebGPU remains a comparison target.

**Runtime HIR crosses the backend boundary.** The Node host resolves source,
packages, imports, and includes, then the Rust compiler performs layout,
CST-to-AST elaboration, checking, staging, specialization, and Runtime-HIR
validation. Conformance code may consume validated Runtime HIR, but compiler
code must not import `src/conformance/`. Gpupaper receives only validated
Runtime HIR lowered to its Core model. Its Rust/Wasm emitter owns final binary
planning and emission.

**Nothing is implicitly in scope.** The prelude is an ordinary module reached
through `import` and spread with `open`; it gets no seeding, no privileged
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
conditional over those results, and `use x <- e` explicitly sequences the already
applied expression `e`, all during CST lowering. Two-argument `@handle (effect, handler)` calls become computation
transformers, and `|>` composition saturates them to ordinary three-argument
`@handle` calls before inference. Nothing downstream of surface elaboration
knows that convenience exists. A desugaring
emits the recursion rather than calling a prelude function that contains it: a
keyword whose meaning depends on a name being in scope is a dependency the
program cannot see. A new form earns an AST node only when no existing one can
say what it means — otherwise it is a second way to say something the language
already says, and every pass has to learn it.

**Value conditionals do not transfer control.** An expression `if` or `case`
produces one of its branch values in a separate result scope that does not
inherit surrounding control targets. A branch's explicit `return` supplies the
expression result; `break` cannot escape it to reach an enclosing loop. A
standalone `if condition:` suite inherits the surrounding return and loop
targets. Expression `if` requires `else`; statement `if` does not.

**A deconstructing guard must leave on failure.**
`if let pattern = value else:` binds the pattern in the statements
that follow it. Its `else` path must `return` or `break`; allowing that path to
continue would put names in scope that were never bound. There is no success
suite because success continues after the guard rather than entering a block.

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

**Monomorphize before Runtime HIR.** Blot's algebraic-subtyping result is the
authority. Any independent oracle consumes the same specialized Runtime HIR; it
does not rerun inference or reinterpret an open source type.

**The executions agree.** The Rust evaluator and emitted Wasm run the same
language. `pnpm conformance` requires their focused runtime observations to
agree; a lowering that satisfies one and not the other is wrong.

**Rust/Wasm is the compiler.** Implement and debug semantic features in the Rust
phase that owns them. Node/TypeScript must not check, evaluate, specialize, prove
ownership, lower Runtime HIR, or emit a fallback artifact. Host tooling consumes
versioned Rust facts and fails explicitly when the compiler artifact is missing
or incompatible. Conformance compares the Rust evaluator, emitted Wasm, and the
explicit GPU oracle; it never compares two Blot checkers.

**The compiler binary is derived output.** Git tracks the Rust source and
generated prelude snapshot, not `generated/compiler/compiler.wasm`. CI builds
the binary once with the pinned Rust toolchain, records its SHA-256, host ABI,
prelude digest, and compiler-input identity, and publishes it both directly and
inside the runnable workspace artifact. A downloaded binary must match those
inputs before use. Every semantic compiler command requires the artifact and
must never fall back to TypeScript.

**The caller never sees backend-private values.** Blot Core Wasm ABI 1 is the stable
memory32, UTF-8 caller contract in `docs/abi.md`. Exports and host effects use
its canonical adapters; internal tagged words, constructor numbers, and heap
headers remain private. An incompatible layout, signature, ownership, import,
or semantic change requires another ABI major and a matching `LANGUAGE.md`
change. The sidecar and `blot:abi` custom-section bytes must stay identical.

**Inference feeds the backend.** Field sets, constructor sets, and compile-time
declaration values are recorded during checking, keyed by AST node identity,
because a nominal declaration needs the whole set and a residual block may
still contain a local compile-time binding. Do not re-derive them in the
backend — that is a second type checker and, for effects, would mint a different
identity. This is why `load` keeps one cache per process.

**Compiler commands must not touch WebGPU.** Node hosts Baba's generated lexer Wasm and general-profile CPU island parser,
then the Rust compiler artifact parses and compiles the resolved sources. Keep the split structural so
ordinary compiler, formatter, and language-server processes never initialize a
device or invoke a native Rust toolchain.

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

Node tests live next to the implementation they cover. `examples/` is the executable
catalog: one program per feature, including the ones that must be rejected and
the ones that must trap. Inference tests assert principal types as strings, so
a lattice change that widens an inferred type shows up as a diff rather than as
"still compiles".
