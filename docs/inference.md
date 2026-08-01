# Inference

blot infers everything. There are no annotations anywhere in `examples/` except
where one is used to _narrow_ what inference already produced, and the prelude —
260 lines of it — carries none at all.

```bash
blot check examples/tour.blot
```

## Algebraic subtyping

The engine follows Parreaux's Simple-sub: mutable type variables carrying lower
and upper bounds, levels for `let`-polymorphism, and biunification by
propagating bounds rather than by unifying. Every program has a principal type,
and the algorithm is polynomial — which is what pays for keeping ownership and
linearity out of the lattice entirely.

Subtyping is not decoration. It is what makes three separate features into one:

| looks like a feature           | is really                                               |
| ------------------------------ | ------------------------------------------------------- |
| literals as singleton types    | a range whose bounds coincide                           |
| effect rows                    | a set ordered by inclusion — fewer effects is a subtype |
| `duck` contracts / typeclasses | record width subtyping                                  |

`identity 42` infers `42`, not `Int`. `#Ready` fits wherever `#Ready | #Failed`
does. A function that performs nothing gets an empty row without being told.

`:=` is deliberately stricter than `let`. It introduces a new binding for an
existing name, but the old and new types must flow into one another. Singleton
integer and text literals widen to their domains at that boundary, so
`value := value + 1` preserves `Int`; changing an integer binding to text
requires another `let value = ...`. The existing binding's scheme is retained,
so rebinding a polymorphic function does not accidentally make it monomorphic.

The one place subtyping is strictly _more_ general than Hindley-Milner is worth
seeing:

```blot
let twice = fn f => fn x => f (f x);
```

HM must unify the two uses of `f` and produces `('a -> 'a) -> 'a -> 'a`. blot
infers `('a -> 'b & 'b -> 'c) -> 'a -> 'c`, their intersection. Writing the
expected string down in `inference.test.ts` is what caught the assumption.

## Effects

There is no effect-inference pass. `infer` carries an ambient row; performing an
operation constrains that effect into it, and a lambda gives its body a fresh
row and puts it in its own type. Joining two rows is the join `constrain`
already knows how to compute, because a row is a lattice element like any other.

```blot
const Console = @effect { .write = Str -> Unit; };
const Clock = @effect { .now = Unit -> Int; };

let greet = fn name => Console.write name;   // Str -> () ~ { Console }
let quiet = fn n => @int.add n 1;            // Int -> Int
```

A row is written `~ { … }`: braces without a leading `.` on each member, because
a row is a _set of effect names_ where a record is a set of `.field = type`
pairs, and the two should not look alike. `e` is the rest of the row — a row
variable — and it is what makes a wrapper effect-polymorphic without saying so:

```blot
let logged = fn f => fn x => do let _ = Console.write "call"; in f x end;
// ('a -> 'b ~ { e }) -> 'a -> 'b ~ { Console, e }
```

`logged` adds `Console` to whatever its callback performs. Nothing there is
annotated.

`quiet` is pure because nothing made it otherwise. Nothing becomes effectful by
proximity.

An effect's type comes from _bridging its value_:
`const Console = @effect {...}` is evaluated at compile time, and the resulting
effect becomes a record of functions whose rows carry it. That is the whole
mechanism, and it is why blot needs no `perform`, no `<-`, and no effect
declaration form.

`@handle` names the effect it discharges, so the row arithmetic is real:

```blot
@handle (Console, computation, logging)
```

Everything the computation performs _except_ `Console` is still owed and flows
on into the ambient row, and the handler is checked against the effect's
operations — a typo in a clause name is a type error rather than a silent no-op
at run time. Earlier `@handle` took only the computation and the handler, which
made both of those unknowable: two effects may each declare `.write`, and a
shape of clauses does not say which one is meant.

A module whose row is non-empty at the top level is rejected, because nothing
would handle it. A _host_ effect is the exception: its operations become
WebAssembly imports, so its row is the program's declared interface rather than
something left unhandled.

## Types are values, so checking runs the evaluator

A `sig` is an ordinary expression. Checking one means evaluating it and bridging
the result into the lattice — there is no type-level sublanguage to translate
from. The same is true of a `const` whose value _is_ a type:

```blot
const Bit = 0 | 1;      // an ordinary union of two integers
sig b = Bit;
let b = 1;
```

`src/check/bridge.ts` is where that conversion lives. It returns `null` for a
value that is not a type — a closure, whose type comes from its body — and the
caller falls back to inference. Returning `null` rather than `⊤` is deliberate:
silently widening to "anything" would turn a missing case into a passing check.

The consequence is that `blot check` evaluates compile-time code. That is not an
implementation shortcut; it is what "types are values" means.

## A branch narrows without touching the lattice

`if n == 1` leaves the then-branch knowing `n : 1` and the else-branch knowing
`n : 2 | 3`. The obvious implementation — push `1` as an upper bound on `n`
inside the branch — is not available and should not be made available.
`Variable.upper` is a shared mutable array with no scope, no snapshot, and no
undo, so a bound pushed in a branch outlives it; and arbitrary intersections in
positive position plus complements in either are what turn an
algebraic-subtyping lattice into a boolean algebra and cost the polynomial
bound.

So narrowing pushes nothing. It shadows the name in a `childTypeEnv` with an
ordinary ground type, which is the mechanism `inferCase` already uses to type an
arm from its own pattern. The narrowed type is _computed_, never represented:
`(1 | 2 | 3) ∩ 1` is the type `1`, so there is no intersection constructor and
no complement constructor to add. `constrain` is not called at all, and
biunification cannot observe that the feature exists.

The set algebra is `src/check/setops.ts`, written over ground types only and
refusing everything else. It is deliberately not `@type.intersect` or
`@type.diff`, which filter members with the comptime `equal` — and `equal` on a
range compares exact bounds, so `@type.diff Int 1` answers `Int` and readmits
the value it was asked to remove.

What a condition proves comes from `src/check/narrow.ts`, and the interesting
part is that it is derived from the operator's compile-time _value_ rather than
from its name. `==` is a fixity entry naming `Eq.eq`, and any module may bind
that name to anything, so a checker that assumed `==` meant equality would prove
a false fact about a program that shadowed it — a program writable today.
Instead a value is accepted only when it is `fn p1 => fn p2 => body` with every
occurrence of both parameters inside one `@int.cmp p1 p2`. Then
`op(a, b) = H(cmp(a, b))` for some `H` the checker never sees, `@int.cmp` is
compiler-owned and total on integers with a three-element codomain, and three
probes tabulate `H` everywhere. That is why narrowing reaches `Int` and not just
an enumerable union: no sampling argument could.

Two guards carry the soundness, and both were measured rather than assumed. The
first is that the operator's value is read out of the _type_ environment, paired
with the exact `Typing` its binding installed — `context.values` is not written
by a plain `let` or by a lambda parameter, so reading the operator from there
would find the prelude's `Eq` under a runtime shadow of it, or under an `Eq` the
_caller_ supplies. The second is that the other operand must be a single
compile-time integer rather than a ground type: intersecting against a whole
type is sound and complementing against one is not, and `n == m` only ever said
that `n` equals this `m`.

## What is not yet proven

Stated plainly, because a checker that quietly admits these is worse than one
that says so.

**Range arithmetic.** `@int.add` returns the unbounded integer domain, because
it does not prove its result fits a width. So `sig f = I32 -> I32` over
arithmetic is a real proof obligation blot does not discharge, and `Int` is the
honest signature. Range-refining arithmetic — `(a..b) + (c..d) : (a+c)..(b+d)` —
is what would close it, and it is the same machinery that would turn
`if i < len` into a proof that an index is in bounds.

**Comptime-built shapes.** `@shape.get`, `@shape.set`, and `@shape.remove`
project a field named by a _value_. Their result is genuinely undetermined until
the name is known, which happens during specialization. Their result type is an
unconstrained variable: inference learns nothing and rejects nothing. This is
what a struct's accessors cost: `Point.x` is `@shape.get value "0"` with the
slot resolved at compile time, so inference cannot say what it returns even
though the evaluator can. The value is exact; the inferred type is a variable.

**Literal coverage stops where enumeration stops.** A `case` over a declared
literal union is checked for coverage by listing the union's members and
subtracting the arms, so `1 | 2 | 3` with only a `1` arm is refused. That works
because a declared union is the one type constructor inference never builds for
itself — when one reaches a `case`, it _is_ the set the program wrote down. It
does not extend to a target whose type is `Int`, `Str`, a range with an open
end, or a variable inference has not pinned: those enumerate no finite member
list, so `sig f = Int -> Str` with `case n of 1 => "one" end` is still accepted
and still traps. Closing that would need a difference operation on the lattice
(`Int \ 1`), which is a real design question — an intersection lives in negative
position and a complement in neither, so adding both is what would turn the
lattice into a boolean algebra and cost the polynomial bound.

**Narrowing stops at integers, and at one comparison.** A condition proves
something only when it applies a recognised comparison to a name whose type is
already a ground set of integers. `if flag then` does not prove `flag : #True`:
a `variant` carries its constructors and whether the set is open, so a negated
constructor set is unrepresentable, and a narrowed constructor set would also
disagree with the set `context.variants` records for the backend. `&&`, `||` and
`not` prove nothing, because a recognised value is one comparison rather than a
composition of them. Text is excluded by the lattice rather than by effort:
`Bound` is inclusive and text order is dense, so splitting `Str` at `"m"` gives
`.."m" | "m"..` and readmits `"m"`. And a branch whose narrowed type is empty is
unreachable; that is not yet a diagnostic, so the branch simply keeps the wider
type.

**Higher-kinded types** are not inference's problem by design: type constructors
are comptime functions that are specialized away, so the lattice never needs
kinds.

**Rank-N is explicit and predicative.** `@forall` evaluates its body with a
fresh type variable and produces a quantified type value. Bridging preserves
that quantifier; subsumption instantiates a quantified value on the left and
skolemizes one required on the right. A Rank-N parameter can therefore use its
argument at two different monotypes, while a monomorphic function is rejected.
The checker never binds an inference variable to a `forall`, so impredicative
instantiation remains deliberately outside the language.

## Operator precedence

The default levels, loosest first. They are grouped by what an operator _does_,
and two groups share a level only where mixing them without parentheses is
meaningless anyway.

| level | operators                   | assoc  | target                          |
| ----- | --------------------------- | ------ | ------------------------------- |
| 10    | `$`                         | right  | `Fn.apply`                      |
| 20    | `\|>`                       | left   | `Fn.pipe`                       |
| 22    | `\|\|`                      | right  | `Logic.or`                      |
| 24    | `&&`                        | right  | `Logic.and`                     |
| 25    | `->`                        | right  | `@type.arrow`                   |
| 30    | `==` `/=` `<` `<=` `>` `>=` | none   | `Eq.*`, `Ord.*`                 |
| 40    | `\|` `\\`                   | left   | `Set.union`, `Set.diff`         |
| 45    | `&`                         | left   | `Set.intersect`                 |
| 50    | `<+`                        | left   | `Type.attach`                   |
| 55    | `<>`                        | right  | `Semigroup.append`              |
| 60    | `+` `-`                     | left   | `Num.add`, `Num.sub`            |
| 70    | `*` `/` `%`                 | left   | `Num.mul`, `Num.div`, `Num.rem` |
| 90    | `-` `!` `?` `&`             | prefix | `Num.negate`, `@linear.*`       |

Three relationships are load-bearing and were each wrong once, so
`examples/operators.blot` pins them:

- **An arrow is looser than the type algebra around it**, so `A | B -> C` is
  `(A | B) -> C`. It used to bind tighter, which silently made the domain the
  last member of the union.
- **Intersection binds tighter than union**, mirroring product over sum, so
  `A | B & C` is `A | (B & C)`. They shared a level, which made it
  `(A | B) & C`.
- **Append binds tighter than comparison and looser than arithmetic**, so
  `a <> b == c` compares the joined value and `t <> x + y` appends the sum. It
  used to sit below comparison, which made `a <> b == c` a type error.

`&&` and `||` are boolean logic and are distinct from `&` and `|`, which are set
algebra. Both are ordinary curried functions, so **both arguments are
evaluated** — there is no laziness for an operator to exploit, and `if` is the
short-circuiting form. `a && perform ()` performs whatever `a` is.

`==` is `Ord.eq` over `@int.cmp` and compares integers. `Text.cmp` compares text
— the evaluator used to accept text through `@int.cmp` while the checker
rejected it, which is exactly the kind of divergence between the two executions
that has to be an error rather than a convenience.
