# The Blot Language

This document specifies the implemented Blot language. It describes source
syntax, evaluation, inference, ownership, modules, effects, the primitive
namespace, and the boundary to gpufuck and WebAssembly.

`grammar.baba` is the authority for concrete parse acceptance. This document is
the authority for what accepted source means. A disagreement between either one
and the compiler is a compiler or specification bug.

## 1. Design model

Blot is a strict, expression-oriented functional language with:

- eager unary functions and application by juxtaposition;
- immutable values and lexical shadowing;
- algebraic subtyping with inferred effects;
- compile-time values, including types and effects;
- separate flow analysis for linear, affine, and borrowed bindings;
- modules represented as unary functions;
- surface control forms lowered to ordinary recursion and cases; and
- one backend path through gpufuck's Functional Surface to WebAssembly.

There is no separate type language, type namespace, assignment operation,
exception syntax, implicit prelude, or ambient authority.

## 2. Source text and tokens

Blot source is UTF-8. Whitespace is insignificant except that it separates
tokens. A line comment begins with `//` and continues through the end of the
line.

### 2.1 Names

There are two identifier spellings:

```text
value name: [a-z_][A-Za-z0-9_]*
capitalized name: [A-Z][A-Za-z0-9_]*
```

Capitalization is a convention, not a namespace. Both spellings bind ordinary
values. Constructor names are capitalized and always carry a leading `#`, as in
`#Some`.

An intrinsic is one token:

```text
@[a-z_][A-Za-z0-9_]*(.[a-z_][A-Za-z0-9_]*)*
```

Examples are `@int.add`, `@type.range`, and `@handle`.

The reserved words are:

```text
module operators infixl infixr infix prefix
let const sig return do end
if then else case of rec comptime open
for in break try
```

Reserved words and capitalized names remain valid field names: `.return`,
`.end`, `.Num`, and `.0` are all ordinary projections.

### 2.2 Literals

An integer literal contains decimal digits. Negative integers are prefix
negation rather than a distinct token. Literal spellings must fit the GPU
frontend's signed-32-bit input profile; wider values, including the bounds of
`I64`, can be computed at compile time.

Runtime integers are signed 64-bit values and trap on overflow. Compile-time
integer arithmetic is arbitrary precision.

A float literal is decimal digits, a point, and decimal digits — both sides are
required. That is what keeps `1.5` a float while `pair.0` stays a projection:
the field after a dot has no digit before it and a float always does. There is
no exponent form and no negative literal; negation is the prefix operator.

Floats are IEEE 754 doubles. They do not trap: an operation that overflows
produces an infinity and one with no defined answer produces a NaN, both of
which are values a program may go on to use. This is the difference from
integer arithmetic, where the result would be a number the machine cannot hold.

`Float.cmp` refuses NaN rather than answering, because no ordering accepts it:
a diagnostic while compiling and a trap while running, the two shapes
`@int.div` by zero already takes. There is no float equality. Exact comparison
is `is_equal (Float.cmp a b)` — the same test with the NaN case left in, rather
than an equality that answers `#False` to a question the format says has no
answer. `Float.is_nan` is how a program asks first, and it is a primitive
because comparing is precisely what refuses.

There is no implicit conversion between the two numeric types, and no operator
serves both. An operator resolves to one binding by name (§4.6), so a `+` over
both would have to dispatch on a value's type at run time. `Float.of_int` and
`Float.truncate` cross explicitly; `truncate` rounds toward zero.

A text literal is delimited by `"`. The defined escapes are:

| escape | value           |
| ------ | --------------- |
| `\n`   | line feed       |
| `\t`   | horizontal tab  |
| `\r`   | carriage return |
| `\"`   | quotation mark  |
| `\\`   | reverse solidus |

There is no interpolation syntax.

### 2.3 Operators

An operator is a non-empty sequence drawn from:

```text
+ - * / < > = | & ^ % ! ? ~ $ : \
```

`//` begins a comment and is not an operator. Structural spellings such as `=`,
`=>`, `:=`, `<-`, `...`, `:`, and `;` are recognized by their grammar position.

The parser does not encode precedence. It produces a flat chain, and semantic
lowering folds that chain using the active fixity table.

## 3. Programs and modules

A file has this order:

```blot
module parameter;       // optional

operators {             // optional
  infixl 60 (+) = Num.add;
};

declarations
return result;
```

The `module` header, when present, must be first. The `operators` header, when
present, follows it. At least one declaration is required, and the final
declaration must be `return value;`.

A module is a unary function from its parameter to its returned value. A module
without an explicit header has a unit parameter that its body ignores; callers
invoke it with `()`.

```blot
const library = @import "./library.blot";
let exports = library ();
```

`@import` accepts a literal text specifier and returns the module function. It
does not call that function and has no implicit parentheses. Relative paths are
resolved from the importing file. A `blot:name` specifier resolves to the
corresponding compiler-supplied library module; `blot:prelude` is the standard
prelude. Import cycles are rejected.

Imports are resolved before evaluation. Importing a module grants it no
authority: the imported module can observe only the value passed as its module
argument. The entry module's parameter is therefore its complete host authority.

Nothing, including the prelude, is implicitly in scope. The conventional prelude
opening is:

```blot
open {} = @import "blot:prelude" ();
```

At compilation, imported module bodies are specialized and inlined. This does
not alter their source semantics as functions.

## 4. Scope and declarations

Scopes are lexical and declarations are processed in source order. A new binding
may shadow an existing binding. A block, lambda, conditional branch, and case
arm introduces a nested scope.

Every declaration ends in `;`.

### 4.1 Runtime and compile-time bindings

```blot
let pattern = value;
const pattern = value;
```

`let` evaluates its value in the current phase, matches the pattern, and binds
the pattern's names.

`const` evaluates its value at compile time even when the surrounding program is
running. A `const` must be computable without runtime input. Compile-time
closures may later be specialized into runtime code when called.

A `const` may not capture a `let`. Specializing a compile-time closure emits it
as a definition of its own, and a definition has no enclosing frame to read a
runtime binding out of, so a `const` whose body names a `let` is refused at the
capture. Bind the captured name with `const`, or bind the closure with `let`. A
`const` written inside a function body whose value depends on that function's
parameters is not a compile-time value at all — it is an ordinary runtime
binding, and captures like one.

A mismatch in a binding pattern is an error. Repeating `let` or `const`
explicitly shadows the earlier binding and may change its type:

```blot
let value = 1;
let value = "now text";
```

### 4.2 Signatures

```blot
sig name = type_value;
let name = value;
```

A signature:

- names exactly one binding;
- must be immediately followed by a `let` or `const` of that name;
- must evaluate at compile time; and
- must evaluate to a value that can be interpreted as a type.

The binding's inferred type must be a subtype of the signature. A signature
constrains a binding; it does not introduce a name or evaluate at runtime.

### 4.3 Stable rebinding

```blot
name := value;
```

`:=` is immutable shadowing, not assignment. The name must already be in scope.
The old and new types must constrain each other after singleton integer and text
literals are widened to their stable domains. The previous polymorphic scheme is
retained.

Use another `let` or `const` to shadow a name with a different type.

Only a single name may appear to the left of `:=`. A `:=` in a `for` body also
defines one of that loop's accumulator fields, including one written inside a
statement conditional in that body. A `:=` inside a nested `for` defines a field
of the inner loop instead.

### 4.4 Nullary computation binding

```blot
name <- computation;
```

As an ordinary declaration, this form lowers exactly to:

```blot
let name = computation ();
```

It binds one name, not a pattern. The ordinary function and effect typing rules
therefore require `computation` to accept unit and propagate whatever effects
the call performs.

The left-hand binding in a `try` handler step is a separate bounded surface
form. Section 12.2 specifies how it binds the newly handled computation without
executing it.

### 4.5 Opening a record

```blot
open {} = record;
open { .source: target, .hidden: _ } = record;
```

The opened value must be a compile-time record. Every field not named by the
mask enters scope under its field name. A mask entry:

- `.source: target` renames `.source` to `target`; or
- `.source: _` suppresses `.source`.

Every source named in the mask must exist. A source may appear only once, and
two fields may not resolve to the same target. Opening introduces ordinary
lexical bindings and can shadow bindings from an outer scope.

The canonical empty mask is `{}`.

### 4.6 Return

```blot
return value;
```

At the end of a module, `return` supplies its export value. Inside a function
block, it exits the nearest source lambda. A return crosses statement
conditionals and `for` loops, but cannot escape through a value-producing `if`
or `case`.

## 5. Patterns

Patterns occur in bindings, lambda parameters, case arms, `for` binders, module
parameters, and `if let` guards.

| pattern                    | meaning                               |
| -------------------------- | ------------------------------------- |
| `name`                     | bind any value                        |
| `_`                        | match any value without binding       |
| `42`, `-1`, `"text"`, `()` | match that literal                    |
| `(left, right)`            | match a tuple of exactly that arity   |
| `[first, second]`          | match an array of exactly that length |
| `#Ready`                   | match a constructor without a payload |
| `#Some value`              | match a constructor and its payload   |
| `{ .x; .y = renamed; }`    | match required fields of a record     |

A shape pattern is width-subtyping: additional fields in the value are
permitted. `.x;` is shorthand for `.x = x;`. Tuple and array patterns require
exact arity or length.

`_` lexes as an ordinary lower-case identifier and is reclassified as a wildcard
during lowering.

### 5.1 Ownership qualifiers

A name pattern may carry:

| qualifier | obligation                       |
| --------- | -------------------------------- |
| `!name`   | linear: consume exactly once     |
| `?name`   | affine: consume at most once     |
| `&name`   | borrowed: may be read, not moved |

Qualifiers may appear recursively inside tuple, array, constructor, and shape
patterns.

## 6. Values and expressions

Evaluation is strict and left-to-right. Function position is evaluated before
its argument; collection and record members are evaluated in source order.

### 6.1 Unit, arrays, tuples, and shapes

`()` is the unit value.

Arrays are ordered homogeneous collections:

```blot
[first, second, ...rest]
```

An array spread must evaluate to an array. Arrays are immutable; `@array.set`
and `@array.push` return new arrays.

A tuple is a shape with fields `"0"`, `"1"`, and so on:

```blot
(first, second)
pair.0
```

Parentheses around one value only group that value. Tuples contain at least two
elements.

A shape is a structural record:

```blot
{
  .name = "blot";
  .count = 2;
  ...other;
}
```

Shape fields and spreads are applied from left to right. A later spread or field
replaces an earlier field with the same name. Writing the same explicit field
more than once is rejected.

A spread contributes the fields its operand is *known* to have. Where the
operand is a shape written nearby, that is all of them. Where it is a parameter,
it is none of them: `r => { ...r; .tag = 1; }` returns a shape with `.tag` and
nothing else, and reading any other field off the result is an error. Width
subtyping says what a function may *read* from a record it is handed; it does
not carry the unread fields through a spread, which would need a row variable
this lattice does not have. Naming the fields at the spread avoids the limit
entirely.

Field projection is postfix and may be chained:

```blot
value.namespace.member
```

Projecting a missing field is an error.

### 6.2 Constructors

`#Name` creates a constructor without a payload. Applying it once attaches one
payload:

```blot
#Ready
#Some value
#Pair (left, right)
```

A constructor already carrying a payload is not callable. Multiple logical
payload fields are represented by one tuple or shape payload.

Constructors are structurally grouped into variant types by their names and
payload types. There is no separate constructor declaration.

### 6.3 Functions and application

A function has one parameter pattern:

```blot
parameter => body
```

Application is juxtaposition and associates left:

```blot
f x y
// means
(f x) y
```

Multi-argument functions conventionally accept one tuple or shape:

```blot
(left, right) => left
```

A lambda body is an expression. Nested currying must make the inner lambda a
bounded value:

```blot
f => (x => f (f x))
```

### 6.4 Blocks

```blot
do
  declarations
  in value
end
```

A block evaluates its declarations in a nested scope and returns the value after
`in`. If `in value` is absent, the block returns `()`.

The `in` marker is mandatory when a block has a result; a bare trailing
expression is not permitted.

### 6.5 Recursion

`rec` is a prefix form that is valid only as the value of a binding to one name:

```blot
const factorial = rec (n =>
  if n < 2 then 1 else n * factorial (n - 1) end);
```

The bound name is visible inside the lambda body. `rec` applied outside such a
binding, applied to a non-lambda, or bound through a compound pattern is an
error.

### 6.6 Compile-time evaluation

```blot
comptime expression
```

`comptime` evaluates its operand in the compile-time phase. It may not depend on
runtime bindings. Compile-time and runtime evaluation otherwise use the same
language semantics.

Evaluation has a deterministic fuel limit. Exceeding it is an error rather than
non-deterministically hanging the compiler.

## 7. Operators and fixity

The optional operator header extends or overrides the default fixity table:

```blot
operators {
  infixl 65 (++) = Text.append;
  infixr 10 ($) = Fn.apply;
  infix 30 (===) = Eq.eq;
  prefix 90 (~) = negate;
};
```

The target is a qualified name or intrinsic. Using an operator requires both a
fixity entry and its target to be in scope. Default fixity does not implicitly
import the prelude target.

Default fixities, from loosest to tightest:

| level | spelling                    | associativity   | target                          |
| ----- | --------------------------- | --------------- | ------------------------------- |
| 10    | `$`                         | right           | `Fn.apply`                      |
| 20    | `\|>`                       | left            | `Fn.pipe`                       |
| 22    | `\|\|`                      | right           | `Logic.or`                      |
| 24    | `&&`                        | right           | `Logic.and`                     |
| 25    | `->`                        | right           | `@type.arrow`                   |
| 30    | `==` `/=` `<` `<=` `>` `>=` | non-associative | `Eq.*`, `Ord.*`                 |
| 40    | `\|` `\`                    | left            | `Set.union`, `Set.diff`         |
| 45    | `&`                         | left            | `Set.intersect`                 |
| 50    | `<+`                        | left            | `attach`                        |
| 55    | `<>`                        | right           | `Semigroup.append`              |
| 60    | `+` `-`                     | left            | `Num.add`, `Num.sub`            |
| 70    | `*` `/` `%`                 | left            | `Num.mul`, `Num.div`, `Num.rem` |
| 90    | `-`                         | prefix          | `Num.negate`                    |
| 90    | `!` `?` `&`                 | prefix          | `@linear.*`                     |

Operators are ordinary eager function calls. In particular, `&&` and `||`
evaluate both operands; use `if` for short-circuiting.

`?name` introduces an affine binding when it appears in a pattern. Affine names
are consumed by ordinary move positions; `?value` is not a separate ownership
operation.

## 8. Conditional control flow

### 8.1 Value-producing `if`

```blot
let label = if ready
  then "ready"
  else if waiting then "waiting"
  else "done"
end;
```

An expression `if`:

- requires an `else`;
- requires every condition to be `#True` or `#False`;
- evaluates and returns exactly one branch value; and
- is a closed value boundary through which `return` and `break` may not escape.

There is no truthiness and no `yield`.

### 8.2 Statement `if`

```blot
if condition then do
  statements
else if other then do
  statements
else do
  statements
end;
```

A statement conditional's `else` is optional. Branches are statement scopes, so
`return` and `break` retain their surrounding targets.

A branch is a scope for `let` but not for `:=`. A name a branch rebinds with
`:=` is rebound for the statements that follow the conditional: the name was
already in scope and keeps its type, so every path agrees on what it holds —
including a missing `else`, which passes the name through unchanged. A `let`
inside a branch stays local to that branch, shadowing any outer binding of that
name for the rest of the branch and escaping with nothing.

`then do` begins the branch body; the final `end;` closes the whole conditional.

### 8.3 Deconstructing guard

```blot
if let #Some value = candidate else do
  return fallback;
end;

// value is in scope here
```

On a successful match, the pattern's names are in scope for all following
statements in the surrounding body. On failure, the `else` statements run. That
path must leave through `return` or `break`; allowing it to continue would leave
the pattern names unbound.

The guard is a `case` with a wildcard alternative, so it types its names the
same way one does: `value` above has the type the matched constructor carries,
and the guard leaves the rest of the constructor set open.

This form has no `then` because success continues after the guard.

### 8.4 `case`

```blot
case value of
  #None => fallback,
  #Some inner => inner
end
```

The target is evaluated once. Arms are tested from left to right, each in a
scope containing its pattern bindings. The first matching arm supplies the case
value.

When the target's type is known, the union of the arm patterns must cover it. A
wildcard or name pattern is irrefutable. Reaching runtime without a matching arm
is an error.

Coverage over a constructor set and coverage over a literal set are the same
requirement read on the two kinds of set a type can be. A constructor set is
covered by subtyping: the arms name a variant, and the target must flow into it.
A literal set is covered by membership instead, because the arms are literals
rather than a type the target could be constrained to — so the members the arms
do not name are reported, and the target's own type is left alone.

```blot
sig rank = 1 | 2 | 3 -> Int;
let rank = level => case level of
  1 => 100,
  2 => 200
end;
```

is refused: `3` is a member of the target's type that no arm covers. Adding a
`3` arm, or any irrefutable arm, accepts it.

A target whose type has an _open end_ — `Int`, `Str`, any unbounded range —
holds infinitely many values, so no finite list of literal arms can exhaust it.
Such a `case` is refused rather than accepted in silence:

```blot
sig describe = Int -> Str;
let describe = n => case n of 1 => "one", 2 => "two" end;
// BLOT_INCOMPLETE_CASE: `Int` has more values than these arms can cover.
```

The choice is to narrow the target's type, add the missing arms, or write an
irrefutable arm. `@panic` is how that arm says why reaching it is impossible:

```blot
let describe = n => case n of
  1 => "one",
  2 => "two",
  _ => @panic "callers are checked against `1 | 2` upstream"
end;
```

`@panic` takes a text and returns the empty type, so it may stand where any
value is expected. It is not a caught failure: reaching it stops the program.
It survives to WebAssembly as an explicit fault carrying that text, which is
what distinguishes it from the arms the compiler proves unreachable: coverage
is checked, so a `case` with no matching arm is a path the checker ruled out,
and the emitted module marks it as unreachable rather than as a fault a program
can hit.

A target whose type inference has not pinned carries no coverage requirement,
since there is nothing to enumerate. Literal arms therefore still constrain
nothing on their own: without the `sig` above, `rank` accepts any argument and
owes no coverage at all.

An arm's pattern types the names the arm binds: what the target carries for a
constructor flows into that arm's payload pattern. An irrefutable arm leaves the
constructor set open rather than unknown — the named arms still say what their
payloads carry, so

```blot
let unwrap_or = m => case m of
  #Some inner => inner,
  _ => "none"
end;
```

has type `#Some 'a | .. -> ('a | "none")`, where `| ..` reads "and possibly
other constructors". A name arm matches every value, so it binds the target
itself.

One constructor may have several arms, and only the first that can match it
runs. A payload pattern that only binds cannot fail, so it settles what that
constructor carries and every later arm for it is unreachable. A literal payload
is a guard rather than a requirement and constrains nothing on its own.

Like expression `if`, `case` is a value boundary: `return` and `break` cannot
escape from an arm.

### 8.5 What a branch proves

A condition can narrow a name. Inside the branch it is taken, and inside every
branch reached because it was not, the name's type is the part of its declared
set that the condition allows.

```blot
sig name = 1 | 2 | 3 -> Str;
let name = n => if n == 1
  then case n of 1 => "one" end
  else case n of 2 => "two", 3 => "three" end
end;
```

`n` is `1` in the `then` branch and `2 | 3` in the `else`, so both `case`
expressions cover their target without a catch-all arm. An `else if` chain
accumulates: each condition is read knowing that none of the earlier ones fired,
and the final `else` knows that none of them did.

Narrowing is set algebra on the types that are already there. The proved type is
computed, not written down: `(1 | 2 | 3) ∩ 1` is the type `1`. There is no
intersection type, no complement type, and no difference operation on types.

**What proves it.** The condition must apply a function whose compile-time value
the checker can read and recognise as a comparison of two integers. Recognition
is a property of the function, not of the name it is bound to and not of the
operator spelled at the call site. `==` is an ordinary fixity entry naming the
binding `Eq.eq` (§7), so `if n == 1` and `if Eq.eq n 1` prove exactly the same
thing, and a module that binds `Eq` to something else gets whatever that
something else actually computes.

A value is recognised when it is `p1 => (p2 => body)` and every occurrence of
`p1` and `p2` in `body` lies inside a single application `@int.cmp p1 p2` — one
occurrence each, with no binder in `body` rebinding either name. The body may
then be evaluated only through that call, so the function is some decision on
`@int.cmp`'s three answers, and the checker determines which by applying it to
one pair of integers per answer. That is why narrowing reaches an unbounded
domain: `if n < 10` proves `..9` and `10..` without enumerating anything.

**What it is compared against.** The other operand must be a value the checker
can name without running the program, and there are two of them.

The first is a single compile-time integer — an integer literal, or a name whose
`const` value is one. `if 0 < n` reads the same as `if n > 0`.

The second is the length of an array a name in scope holds, written
`@array.len xs`. That one is not a number and does not have to be:

```blot
sig at = [Int] -> Int -> Int;
let at = xs => (n =>
  if n >= 0
  then (if n < @array.len xs then @array.get xs n else 0 end)
  else 0
  end);
```

`n` is `..len xs - 1` in the inner branch and `0..len xs - 1` inside both, where
`len xs` names the number of elements in the array the binding `xs` holds. An
array's type carries no length (§13.3) and this does not put one there: the
symbol is a range bound, so it is compared and never solved for.

A length is keyed to the _binding occurrence_, which is what makes it denote one
integer: blot has no assignment and arrays are immutable, so a binding holds one
value for its whole lifetime. Every consequence follows from that key.

- `:=` binds a new occurrence, so a length proved before it says nothing after
  it, in either direction.
- An alias is another occurrence. After `let ys = xs;`, `len ys` and `len xs`
  are two unrelated integers, and a comparison against one proves nothing about
  a read of the other.
- Two arrays are never related. `len xs` and `len ys` are not compared, ordered,
  added, or subtracted, and neither is a length compared against another array's
  index.
- The one thing assumed about a length nobody measured is
  `0 <= len xs <= 2147483647`, because an array's length is a 32-bit count. It
  is what lets `n >= 0` and `n < @array.len xs` compose: without it, `0` and
  `len xs` could not be ordered and the second comparison would prove nothing.

Narrowing never changes a program's type. It only lets a branch use a name at a
type the branch has proved, so a function's own signature is what it was.

**What it does not prove.** Narrowing is silent, not an error, wherever it
declines. A refused condition leaves every name exactly as wide as it was
declared, which is usually reported by something else — most often a `case` in
the branch failing to cover a set the condition would have shrunk.

- **A name the compile-time environment cannot see through.** A `let` binding
  and a function parameter give a name a type without giving it a compile-time
  value, so a `let`-bound or parameter-bound `Eq` is refused rather than read
  through to an outer one. This is what makes shadowing safe: the checker never
  reasons about a function the program does not call, and an operator record
  supplied by the _caller_ could never be reasoned about at all.
- **The other half of a junction.** `if a && b` proves what *both* halves prove
  about one name, and the branch it does not take proves nothing: failing a
  conjunction can mean failing either half. `||` is the mirror — its untaken
  branch proves both, its taken branch proves nothing. A junction is recognised
  by its truth table, tabulated over the four boolean inputs, so a shadowed
  `Logic.and` that is not conjunction proves nothing rather than being mistaken
  for one. Two halves that speak about *different* names also prove nothing: a
  proof narrows one name.
- **A length reached by anything but a name.** `@array.len box.values`,
  `@array.len (f ())`, and the prelude's `Array.length xs` name no binding
  occurrence, so there is no symbol to compare against. Only the primitive
  applied to a name in scope is a witness.
- **Two lengths.** `@array.len xs == @array.len ys` has a witness on both sides
  and a subject on neither.
- **A witness that is another runtime name.** `n == m` says `n` equals this `m`,
  not that `n` is somewhere in `m`'s type. Intersecting against a whole type
  would be sound and complementing against it would not, so neither is done.
- **A function whose body is not a single comparison.** `Ord.cmp`, `Ord.min` and
  `Ord.max` are refused, as is any equality written with two comparisons rather
  than one. Refusal here is a limitation, not a judgement: the function is fine,
  the checker just cannot say what it computes.
- **A body containing `open` or `rec`.** Both bind names that appear in no node
  of the body, so the occurrence count that licenses the whole argument cannot
  see them.
- **Text.** A text range cannot have a value cut out of its interior: range
  bounds are inclusive and text order is dense, so splitting `Str` at `"m"`
  would give `.."m" | "m"..` and readmit the value it was asked to remove.
  Integers are discrete, so the same split is exact for them and is performed. A
  recognised comparison is over `@int.cmp` in any case, which fails on text.
- **Constructors.** `if flag then` does not prove `flag : #True`. A `variant`
  carries its constructors and whether the set is open, so "those others, minus
  `#A`" is unrepresentable, and a narrowed constructor set would also disagree
  with the set recorded for the backend.
- **An empty result.** A condition no value satisfies makes the branch
  unreachable. The branch keeps the wider type rather than being given the empty
  one; reporting unreachability is not yet a diagnostic.

A proof is a shadow of the name, so it lasts as long as the name does. Rebinding
the name inside the branch with `:=` replaces it under the ordinary rule (§4.3)
— the stable type, not the proved one — and the proof does not survive.

## 9. Iteration

`for` is a declaration, not an expression.

```blot
for iterator do
  statements
end;

for pattern in iterator do
  statements
end;
```

An iterator is a shape:

```blot
{
  .state = initial_state;
  .step = state => #Some (element, next_state); // or #None
}
```

The first form ignores each element. The second matches it against `pattern`. An
irrefutable pattern binds normally. A refutable pattern that does not match
skips that element rather than failing the loop.

The names rebound with `:=` in the loop body — including inside a statement
conditional in that body, but not inside a nested `for` — form an implicit
accumulator record:

- their incoming values initialize the accumulator;
- each iteration sees the previous iteration's accumulator;
- their final values shadow the incoming bindings after the loop;
- zero iterations preserve the incoming values; and
- a `let` inside the body is local to that iteration.

A `let` is local whether or not the name is taken outside. `let n = …` in the
body introduces a binding that ends with the body, so the outer `n` is
untouched and the local is free to hold a different type — only `:=` carries a
value out. Where a `let` shadows a name, every `:=` after it in that block
rebinds the local and therefore escapes nothing.

Rebinding a name with `:=` and then shadowing it with a `let` in the same block
is an error. The carried value is read where the block ends, which is inside
the shadow, so the local would leave under the accumulator's name; the two
readings of such a block are equally defensible and neither is chosen. Rename
the local, or write the `let` above the first `:=`.

This is a fold, not assignment. During CST lowering, `for` becomes ordinary
`rec`/`case` recursion. No loop node reaches inference, ownership, evaluation,
or the backend.

### 9.1 `break`

```blot
break;
```

`break` exits the nearest `for` with its accumulator as it exists at that point.
It may appear inside statement conditionals and guards. It cannot cross a lambda
or a value-producing `if` or `case`, and using it without an enclosing `for` is
an error.

An unbounded loop is ordinary iteration over the prelude's infinite iterator:

```blot
for ever do
  if finished then do
    break;
  end;
end;
```

`ever` is not syntax or a compiler special case. It must be explicitly brought
into scope like every other prelude value.

There is no `continue` form.

## 10. Types and inference

Types are compile-time values in the same value domain as runtime data. There is
no type declaration syntax and no separate type expression grammar.

Examples:

```blot
const Bit = 0 | 1;
const Message = #Ready | #Failed Str;
const Point = { .x = I32; .y = I32; };
const Meter = seal ("Meter", I32);
```

The principal inferred forms are:

- integer and text ranges, including singleton literals;
- `F64`, the float type;
- unit;
- functions with effect rows;
- structural records and tuples;
- homogeneous arrays;
- constructor variants;
- explicit ground unions;
- universally quantified types;
- opaque compile-time and host values;
- top and bottom; and
- inference variables with lower and upper bounds.

The checker uses algebraic subtyping and biunification:

- a wider record is a subtype of a record requiring fewer fields;
- a variant with fewer possible constructors is a subtype of a wider variant;
- a smaller range is a subtype of a containing range;
- function parameters are contravariant and results are covariant;
- fewer effects is a subtype of more effects; and
- `let` bindings are generalized and instantiated polymorphically.

Integer and text literals infer singleton ranges. `identity 42` therefore
returns type `42`, not merely `Int`.

Float literals do not. `1.5` infers `F64`, and `F64` is the only float type
there is. A singleton float would put a real number where the lattice keeps a
bound, and every operation it performs on bounds has no meaning there: there is
no next float after 1.5 for `difference` to name, nothing for coverage to
enumerate, and equality is not something to narrow on where NaN and rounding
exist. So a `case` over floats never becomes exhaustive without an irrefutable
arm, and a float pattern matches by equality without proving anything about the
scrutinee.

Type checking evaluates compile-time code because signatures and type
constructors are ordinary values. A compile-time value is bridged into the
inference lattice only when it denotes a type.

### 10.1 Display notation

Compiler output uses notation that is not additional source syntax:

| display                   | meaning                              |
| ------------------------- | ------------------------------------ |
| `Int`, `Str`, `1`, `"x"`  | ranges and singleton ranges          |
| `0..9`, `0..`             | bounded and half-bounded ranges      |
| `len xs`, `0..len xs - 1` | a range bounded by an array's length |
| `{ .x = Int; }`           | structural record                    |
| `[Int]`                   | homogeneous array                    |
| `#None \| #Some Int`      | constructor variant                  |
| `#Some Int \| ..`         | variant with an open set             |
| `A -> B`                  | pure function                        |
| `A -> B ~ { Console, e }` | function with an effect row          |
| `'a`, `'b`                | inferred type variables              |
| `forall 'q0. ...`         | explicit quantified type             |
| `⊤`, `⊥`                  | top and bottom                       |

`len xs` is printed, never written: it names the length of the array a binding
holds (§8.5), and a `sig` has no syntax for it. Where a range's two ends are the
lengths of two different arrays that share a name, each is printed with the
occurrence that distinguishes it — `len xs#7`.

Effect-row notation is printed by the checker and is not written in a `sig`.
Effectful function type values are produced from effect declarations and
inference.

### 10.2 Type-value primitives

The primitive type values are `@type.int`, `@type.float`, `@type.text`,
`@type.unit`, and `@type.unbounded`.

The type algebra includes:

- inclusive ranges;
- union, intersection, and difference;
- function arrows;
- structural shapes and arrays;
- nominal sealing and opening;
- namespace attachment;
- reflection;
- type-of;
- union construction from an array; and
- explicit predicative `@forall`.

An attached namespace is transparent to type checking. This is how the prelude
`struct` returns one value that is both a storage type and a namespace
containing `.new`, accessors, and layout metadata.

A sealed type is nominal and invariant. Its identity is its name together with
its carrier.

### 10.3 Deliberate inference limits

The implemented checker does not currently prove:

- range-refining arithmetic — `@int.add n 1` widens to `Int` whatever `n` was,
  so an index carried across an addition loses what a comparison proved about
  it;
- an index bound that came from anywhere but a comparison against a literal or
  against `@array.len` applied to a name (§8.5, §13.3);
- precise results of value-named `@shape.get`, `@shape.set`, and
  `@shape.remove`; or
- impredicative instantiation.

Rank-N types are explicit and predicative through `@forall`. Higher-kinded
abstraction is compile-time function application rather than a kind system.

## 11. Ownership and linearity

Ownership is a flow analysis after successful type inference. It is not part of
the subtype lattice.

A use has one of three meanings:

| use     | examples                 | linear value | borrowed value |
| ------- | ------------------------ | ------------ | -------------- |
| move    | argument, member, result | consumed     | rejected       |
| project | `value.field`            | consumed     | permitted      |
| borrow  | `&value`                 | retained     | permitted      |

`!value` explicitly moves a value and `&value` explicitly borrows it. Ordinary
argument and result positions are moves.

Every branch starts from the same ownership state and must end in an agreeing
state. A linear binding consumed on only one branch is rejected. An affine
binding may be consumed on zero or one branch but never twice.

A closure inherits the strongest obligation it captures:

- capturing a linear value makes the closure linear;
- capturing only affine values makes it affine; and
- calling the closure discharges that inherited obligation.

The marker need not be repeated on the closure binding. Captures may propagate
through nested closures.

Linear closures cannot currently be stored in arrays, tuples, or shapes, because
linear structures are not tracked. The compiler rejects such an escape. Last-use
and proved-consumption facts are recorded for the backend.

## 12. Effects and handlers

An effect is a compile-time value built from a shape of operation types:

```blot
const Console = @effect {
  .write = Str -> Unit;
};
```

Projecting an operation from an effect and calling it performs that operation:

```blot
Console.write "hello"
```

There is no `perform` keyword. The operation's effect enters the surrounding
inferred row.

An ordinary effect must be discharged before the module boundary. A host effect
declared with `@effect.host` may reach the boundary; its operations become typed
WebAssembly imports and therefore constitute part of the module interface.

### 12.1 Source handlers

```blot
let logging = {
  .write = (message, ?resume) => message <> resume ();
  .return = value => value;
};

@handle (Console, computation, logging)
```

`@handle` takes one tuple `(effect, computation, handler)`:

- `effect` is the specific compile-time effect being discharged;
- `computation` is a nullary function;
- `handler` is a statically known shape;
- each operation clause takes `(operation_argument, ?resume)`; and
- an optional `.return` clause transforms the computation's normal result.

`resume` is an affine one-shot continuation. Calling it continues the suspended
computation with the supplied operation result. Not calling it aborts the rest
of the computation. Calling it twice is rejected statically and also guarded
during evaluation.

Effects not named by the handler remain in the inferred row. Handler
specialization is lexical: the effect, computation, and clause shape must be
statically visible. gpufuck has no runtime handler representation.

### 12.2 Handler composition

`try` composes several statically known handlers around one nullary computation:

```blot
let result = try program then do
  program_without_terminal <- @handle (Terminal, fake_terminal);
  program_without_clock <- @handle (Clock, fake_clock);
  @handle (Random, fake_random)
end;
```

The body contains zero or more bound handler steps followed by one final handler
step. A step has the surface-only form `@handle (effect, handler)`; `try`
supplies its current computation as the omitted middle argument.

Each bound step creates a nullary computation containing the corresponding
ordinary three-argument `@handle`, binds that computation on the left of `<-`,
and makes it current for the next step. Binding `_` suppresses the visible name
without interrupting the composition. The final step executes the fully composed
computation and supplies the value of the `try` expression.

The example lowers to the equivalent of:

```blot
let program_without_terminal =
  () => @handle (Terminal, program, fake_terminal);
let program_without_clock =
  () => @handle (Clock, program_without_terminal, fake_clock);
@handle (Random, program_without_clock, fake_random)
```

Handler composition is a bounded list of handler steps, not a general `do` block
and not a dynamically scoped registry. Effect identities, handler shapes, and
the resulting effect rows remain statically visible. It can discharge source
effects; host effects remain caller capabilities.

### 12.3 Host boundary

The entry module parameter and host effects are the only sources of host
authority. No filesystem, clock, terminal, or network capability is ambient.

Host-effect operations may use the concrete first-order boundary values listed
in section 15: integers, text, unit, booleans, records, arrays, variants, and
seals. A host capability's source name is part of its external contract and is
not silently mangled.

## 13. Primitive namespace

Every intrinsic is curried like an ordinary Blot function except `@handle`,
which takes its three arguments in one tuple. The two-argument spelling inside
`try` is surface syntax described in section 12.2, not partial application.
Applying fewer arguments to other primitives returns a partially applied
primitive.

Everything not listed here belongs in source, normally the prelude.

### 13.1 Control, modules, and effects

| primitive      | meaning                                                 |
| -------------- | ------------------------------------------------------- |
| `@import`      | resolve a text module specifier and return its function |
| `@effect`      | create a fresh source effect from operation types       |
| `@effect.host` | create a fresh host effect                              |
| `@handle`      | discharge one effect from a nullary computation         |
| `@forall`      | evaluate a type function with a fresh rigid variable    |
| `@satisfies`   | return a value after proving it inhabits a type         |
| `@fail`        | refuse compile-time evaluation with a diagnostic        |
| `@panic`       | trap with a text message                                |

### 13.2 Numeric and text operations

| primitive        | meaning                                              |
| ---------------- | ---------------------------------------------------- |
| `@int.add`       | signed addition                                      |
| `@int.sub`       | signed subtraction                                   |
| `@int.mul`       | signed multiplication                                |
| `@int.div`       | division truncated toward zero                       |
| `@int.rem`       | remainder                                            |
| `@int.neg`       | negation                                             |
| `@int.cmp`       | return `#Less`, `#Equal`, or `#Greater` for integers |
| `@float.add`     | addition                                             |
| `@float.sub`     | subtraction                                          |
| `@float.mul`     | multiplication                                       |
| `@float.div`     | division                                             |
| `@float.rem`     | remainder                                            |
| `@float.neg`     | negation                                             |
| `@float.cmp`     | order two floats, refusing NaN                       |
| `@float.is_nan`  | test for the value no ordering accepts               |
| `@float.of_int`  | widen an integer to a float                          |
| `@int.of_float`  | truncate a float toward zero                         |
| `@text.concat`   | concatenate text                                     |
| `@text.len`      | count Unicode code points                            |
| `@text.cmp`      | compare text and return an ordering constructor      |
| `@text.contains` | test whether text contains a query                   |
| `@text.of_int`   | render an integer as decimal text                    |

Division and remainder by zero are errors. Runtime integer results outside
signed 64-bit range trap.

### 13.3 Arrays and shapes

| primitive       | meaning                                         |
| --------------- | ----------------------------------------------- |
| `@array.empty`  | polymorphic empty array                         |
| `@array.len`    | array length                                    |
| `@array.get`    | checked indexed read                            |
| `@array.set`    | checked immutable indexed replacement           |
| `@array.push`   | immutable append                                |
| `@shape.empty`  | empty shape                                     |
| `@shape.get`    | get a field named by text                       |
| `@shape.set`    | immutably set a field named by text             |
| `@shape.remove` | immutably remove a field named by text          |
| `@shape.names`  | field names in insertion order                  |
| `@shape.has`    | return `#True` or `#False` for field membership |

Array indexing is zero-based and bounds-checked.

#### A read that cannot succeed

`@array.get` and `@array.set` are rejected at check time with
`BLOT_OUT_OF_BOUNDS` when every index the source allows is outside the array,
instead of trapping when the program runs:

```blot
let xs = [1, 2, 3];
return @array.get xs 99;   // BLOT_OUT_OF_BOUNDS: Index 99 is outside an array of 3.
```

```blot
sig at = [Int] -> Int -> Int;
let at = xs => (n => if n >= @array.len xs then @array.get xs n else 0 end);
// BLOT_OUT_OF_BOUNDS: Index len xs.. is outside an array of len xs.
```

The second needs no number. `n >= @array.len xs` proves `n : len xs..` (§8.5),
whose smallest value is the first index past the end of `xs`, and the read names
the same binding — so the two bounds are the same integer whatever the caller
passes.

The index's type is _read_, never constrained. That is what keeps the rule from
changing any program's type: a signature is what it was, and an ordinary call
passing an unproved integer still checks. So nothing is ever proved to be _in_
bounds either. The answer is a diagnostic or silence, and `@array.get` still
emits a checked read in both cases — a proof here does not remove a run-time
check, and none of these forms is faster than any other.

The array's length is decided in one of two ways: as a number, when the array is
written out at the call site, the name denotes a compile-time array value, or
the name was bound to an array literal with no spread; and otherwise as the
symbol `len b` for the binding occurrence a plain name denotes. The index is
decided when it is a compile-time integer, or when it is a name whose type is
already a ground set of integers — one a `sig` declared, or one a branch proved.
A `let` generalizes, so a `let`-bound integer decides nothing, and neither does
anything computed.

Everything else is silent rather than approximated, and a read through it traps
at run time exactly as before:

- an index proved against one array and used to read another, an alias
  (`let ys = xs;`) included: two occurrences are two unrelated integers;
- an array reached by anything but a plain name — a field, a call result, an
  array written in place — which names no occurrence to compare against;
- an array written with a spread, whose element count includes one this cannot
  see. It still has an occurrence, so a comparison against its own `@array.len`
  still proves;
- a name rebound by `:=`, which binds a new occurrence and erases the number the
  old one had. A `:=` to an array literal records that literal's length;
- an index a comparison did not bound, and an index carried across arithmetic:
  `@int.add n 1` is `Int` whatever `n` was;
- an index bounded only by a literal, when the array's length is a symbol.
  `n < 5` proves `..4`, and whether `..4` is inside `0..len xs - 1` depends on
  an array nobody measured.

A loop is not a proof either. `for n in Iter.range (0, @array.len xs)` passes
the length to an ordinary prelude iterator, and what comes back out is `Int`; a
read inside the body is unproved and still bounds-checked.

A shadowed binding is measured by the binding that shadows it or not at all. A
lambda parameter, a pattern binder, and a later `let` each install a type of
their own, and a length is recorded against the one it was written beside — so
`let xs = [1, 2, 3]; let read = xs => @array.get xs 99;` reports nothing,
because the `xs` being read is the caller's.

All of this is for unqualified arrays. Every argument position is a move (§11),
and both of these forms name the array twice — once to measure and once to read
— so a linear or borrowed array cannot be written this way at all:
`let !xs = [1, 2, 3]; let n = @array.len xs; let v = @array.get xs 0;` is
`BLOT_LINEAR_CONSUMED_TWICE`, and this rule does not change that.

### 13.4 Type values

| primitive         | meaning                                     |
| ----------------- | ------------------------------------------- |
| `@type.unbounded` | open range bound                            |
| `@type.int`       | unbounded integer domain                    |
| `@type.text`      | unbounded text domain                       |
| `@type.float`     | the float domain, which has no bounds       |
| `@type.unit`      | unit type/value                             |
| `@type.range`     | inclusive range                             |
| `@type.union`     | flattened duplicate-free union              |
| `@type.intersect` | intersection of union members               |
| `@type.diff`      | difference of union members                 |
| `@type.arrow`     | function type value                         |
| `@type.of`        | structural singleton type of a value        |
| `@type.seal`      | nominally seal a carrier under a text name  |
| `@type.open`      | recover a sealed carrier                    |
| `@type.attach`    | attach one namespace member to a type value |
| `@type.members`   | recover attached namespace members          |
| `@type.reflect`   | inspect the representation of a type value  |
| `@type.union_of`  | union a non-empty array of type values      |

An empty intersection or difference, and `@type.union_of []`, are errors; Blot
has no value representing an empty compile-time union.

`@type.reflect` returns one of:

```text
#Int value
#Text value
#Unit
#Unbounded
#Tag { .name; .payload = #None | #Some value; }
#Range { .low; .high; .domain = #Int | #Text; }
#Union members
#Shape fields
#Array elements
#Arrow { .domain; .codomain; }
#Sealed { .name; .inner; }
#Opaque
```

### 13.5 Ownership markers

`@linear.own` and `@linear.borrow` are runtime identities whose meaning comes
from ownership analysis and the default prefix fixities `!` and `&`.
`@linear.maybe` is the reserved target of prefix `?`; affine obligations are
introduced by `?name` patterns, not by applying the primitive.

## 14. Standard prelude

The standard prelude is ordinary Blot source at `blot:prelude`. Its public
record currently exports:

- function tools: `Fn`, `identity`, `always`, `compose`, `flip`;
- booleans: `Bool`, `True`, `False`, `Logic`, `not`, `expect`;
- ordering and arithmetic: `Ordering`, `is_equal`, `is_less`, `is_greater`,
  `Ord`, `Eq`, `Num`;
- text: `Text`, `Semigroup`, `text_eq`;
- arrays: `Array`, `fold`, `each`, `map`, `filter`, `sum`, `upto`, `any`,
  `every`, and `sort_by`;
- iterators: `ever`, `Iter`, `iterate`, and `collect`;
- variants: `Option`, `None`, `Some`, `unwrap_or`, `Result`, `Ok`, `Error`;
- type tools: `Type`, `Set`, `attach`, `seal`, `unseal`, `Reflect`, `reflect`,
  `refines`, `members`, `union_of`, `Extract`, `Exclude`, `Pick`, `Omit`,
  `opened`, and `range`;
- storage tools: `struct`, `reorder`, `layout`, `aligned`, and `packed`; and
- standard types: `I32`, `I64`, `U8`, `Nat`, `Int`, `Str`, and `Unit`.

Important conventional values include:

```blot
const Bool = #True | #False;
const Option = value => #None | #Some value;

const ever = {
  .state = ();
  .step = _ => #Some ((), ());
};
```

`Iter.range (low, high)` iterates from `low` inclusive to `high` exclusive.
`Iter.items array` iterates an array. `struct` builds positional storage with a
named constructor, accessors, and metadata attached to the type value.

Changing the prelude's public record is a language-library change and must
update this specification.

## 15. Runtime and compilation

The reference evaluator gives runtime and compile-time code the same semantics,
apart from integer representation and phase restrictions. A valid compiled
program must agree across:

1. the reference evaluator;
2. gpufuck's GPU evaluator; and
3. emitted WebAssembly.

Before gpufuck lowering, Blot:

- evaluates and erases compile-time-only values;
- specializes algebraic-subtyping results into concrete Core uses;
- lowers shapes and tuples to nominal records;
- lowers constructor sets to nominal variants;
- lowers arrays to gpufuck `Store`;
- lowers `rec` to local `let-rec`;
- specializes source handlers with selective CPS; and
- turns host effects and entry-module projections into typed imports.

Runtime exports require a concrete first-order ABI. Supported boundary values
include integers, text, unit, booleans, concrete records, arrays, variants,
seals, and functions over supported values. Types and effects remain
compile-time manifest entries and have no invented runtime encoding.

A residual structurally polymorphic function must be specialized to a concrete
record shape before gpufuck. The shape is the one that *flows* to the
projection, not the narrower one the body reads: inference follows what flowed
into the projected variable, across the instantiation a `let`-bound scheme makes
for each of its callers, so `let get_x = v => v.x;` takes its record from the
call sites. When nothing flows in — a parameter whose caller is outside the
module — the fields the body demands decide instead, and they are unioned.

Two *different* records reaching one projection decide nothing, and that
includes a narrower and a wider one: a value of each is really built, Core
records are invariant, so the two are distinct nominal types and their union is
a record neither call site writes. `BLOT_SHAPE_DISAGREEMENT` names both of them
at that projection rather than inventing a third. This is a lowering refusal and
not a type error: the program is well typed under width subtyping, and
`blot check` still accepts it and reports its principal type. Exporting an
unconstrained structural function is rejected rather than assigned an arbitrary
nominal ABI.

### 15.1 Core WebAssembly ABI

`blot build` emits Blot Core Wasm ABI 1.0. gpufuck's tagged words and heap
objects are private implementation details; generated adapters expose the
synchronous memory32, UTF-8 subset of the Component Model Canonical ABI.

Each runtime field is exported as `blot:<field>`. Host effects import their
operations from `blot:host/<capability>`. The module exports `memory`,
`cabi_realloc`, and immutable `blot:abi-major` and `blot:abi-minor` globals. An
indirect result also exports `cabi_post_blot:<field>`, which the caller must
invoke exactly once after reading the result.

The boundary representations are:

- `()` as no flat value and a zero-sized memory value;
- `Int` as signed `i64`;
- `Bool` as `i32` or one byte in memory, restricted to zero or one;
- `Text` as a pointer and UTF-8 byte length;
- arrays as a pointer and element count;
- records as source-name-sorted fields with canonical alignment;
- variants as a source-name-sorted discriminant and joined payload; and
- seals as their transparent carrier, while retaining their nominal source name
  in the manifest.

At most 16 flat parameters and one flat result are used. Larger parameter lists
and results use canonical record memory. Parameters are borrowed. Indirect
results and their nested buffers are owned until the declared post-return call.
Malformed UTF-8, booleans, discriminants, lengths, pointers, and alignments
trap.

`@text.len`, `@text.of_int`, `@text.cmp`, and `@text.contains` are module-local
Wasm intrinsics, not host imports. Length counts Unicode scalar values,
comparison is lexicographic by Unicode scalar value, and containment searches
the UTF-8 representation, which preserves substring boundaries for valid text.

The JSON sidecar and the `blot:abi` custom section contain identical bytes. The
manifest is the authoritative structural contract for exports, imports,
ownership, record fields, variant cases, and seals. ABI 1 layout and meaning are
stable within major version 1; an incompatible change requires another major.
The byte-level layouts and host calling example are in
[docs/abi.md](docs/abi.md).

## 16. Complete example

```blot
module init;

operators {
  infixl 65 (++) = Text.append;
};

open {} = @import "blot:prelude" ();

const Console = @effect.host {
  .write = Str -> Unit;
};

const Message = #Ready | #Failed Str;

let describe = message => case message of
  #Ready => "ready",
  #Failed reason => reason
end;

let attempts = 0;
for ever do
  attempts := attempts + 1;
  if attempts >= 3 then do
    break;
  end;
end;

let report = () => do
  let text = describe #Ready ++ Text.of_int attempts;
  let _ = Console.write text;
  in text
end;

return {
  .attempts = attempts;
  .report = report;
};
```

This module receives its authority through `init`, explicitly opens the prelude,
constructs types as values, uses `for` as a fold with an inferred accumulator,
declares a host effect as its interface, and returns a concrete record suitable
for staging and WebAssembly lowering.
