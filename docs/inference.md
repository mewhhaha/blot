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

The one place subtyping is strictly _more_ general than Hindley-Milner is worth
seeing:

```blot
let twice = f => (x => f (f x));
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

let greet = name => Console.write name;   // Text -> () ~ { Console }
let quiet = n => @int.add n 1;            // Int -> Int
```

A row is written `~ { … }`: braces without a leading `.` on each member, because
a row is a _set of effect names_ where a record is a set of `.field = type`
pairs, and the two should not look alike. `e` is the rest of the row — a row
variable — and it is what makes a wrapper effect-polymorphic without saying so:

```blot
let logged = f => (x => do const _ = Console.write "call"; return f x; end);
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

**Higher-kinded types** are not inference's problem by design: type
constructors are comptime functions that are specialized away, so the lattice
never needs kinds.

**Rank-N is not implemented.** `@forall` exists as a primitive and is the
identity function in both the evaluator and the checker — it carries no
quantifier, performs no skolemization, and checks nothing. A `sig` written with
it is rejected as not a type. Building it means: a value form for the
quantifier, `bridge` turning it into a scheme, and subsumption at the
application site (skolemize the argument's quantifier, instantiate the
parameter's). None of that exists, and nothing in the corpus depends on it.

## Operator precedence

The default levels, loosest first. They are grouped by what an operator *does*,
and two groups share a level only where mixing them without parentheses is
meaningless anyway.

| level | operators | assoc | target |
|---|---|---|---|
| 10 | `$` | right | `Fn.apply` |
| 20 | `\|>` | left | `Fn.pipe` |
| 22 | `\|\|` | right | `Logic.or` |
| 24 | `&&` | right | `Logic.and` |
| 25 | `->` | right | `@type.arrow` |
| 30 | `==` `/=` `<` `<=` `>` `>=` | none | `Eq.*`, `Ord.*` |
| 40 | `\|` `\\` | left | `Set.union`, `Set.diff` |
| 45 | `&` | left | `Set.intersect` |
| 50 | `<+` | left | `Type.attach` |
| 55 | `<>` | right | `Semigroup.append` |
| 60 | `+` `-` | left | `Num.add`, `Num.sub` |
| 70 | `*` `/` `%` | left | `Num.mul`, `Num.div`, `Num.rem` |
| 90 | `-` `!` `?` `&` | prefix | `Num.negate`, `@linear.*` |

Three relationships are load-bearing and were each wrong once, so
`examples/operators.blot` pins them:

- **An arrow is looser than the type algebra around it**, so `A | B -> C` is
  `(A | B) -> C`. It used to bind tighter, which silently made the domain the
  last member of the union.
- **Intersection binds tighter than union**, mirroring product over sum, so
  `A | B & C` is `A | (B & C)`. They shared a level, which made it
  `(A | B) & C`.
- **Append binds tighter than comparison and looser than arithmetic**, so
  `a <> b == c` compares the joined value and `t <> x + y` appends the sum.
  It used to sit below comparison, which made `a <> b == c` a type error.

`&&` and `||` are boolean logic and are distinct from `&` and `|`, which are
set algebra. Both are ordinary curried functions, so **both arguments are
evaluated** — there is no laziness for an operator to exploit, and `if` is the
short-circuiting form. `a && perform ()` performs whatever `a` is.

`==` is `Ord.eq` over `@int.cmp` and compares integers. `Text.cmp` compares
text — the evaluator used to accept text through `@int.cmp` while the checker
rejected it, which is exactly the kind of divergence between the two executions
that has to be an error rather than a convenience.
