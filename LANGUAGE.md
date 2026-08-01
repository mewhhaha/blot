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

`@[` opens a declaration tag rather than an intrinsic. The next character makes
the terminal identity fixed: an intrinsic continues with a lower-case name and a
tag continues with `[`. Section 4.2 defines declaration tags.

The reserved words are:

```text
module operators infixl infixr infix prefix
let const sig return do end
if then else case of rec comptime open
for in break try fn
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
which are values a program may go on to use. This is the difference from integer
arithmetic, where the result would be a number the machine cannot hold.

`Float.cmp` refuses NaN rather than answering, because no ordering accepts it: a
diagnostic while compiling and a trap while running, the two shapes `@int.div`
by zero already takes. There is no float equality. Exact comparison is
`is_equal (Float.cmp a b)` — the same test with the NaN case left in, rather
than an equality that answers `#False` to a question the format says has no
answer. `Float.is_nan` is how a program asks first, and it is a primitive
because comparing is precisely what refuses.

`F32` is the narrower float, and a distinct type rather than a precision `F64`
sometimes has. There is no f32 literal — the grammar has one float token, and
`Float32.of_float` is what makes the narrowing a step the program takes rather
than one performed on it. `Float32.widen` goes back, exactly, because every
`F32` is an `F64`.

`F32x4` is four `F32` lanes as one value, and a distinct type rather than a
tuple of four: the operations over it are single instructions, and a shape the
compiler could take apart field by field would not be. Lanes are read by name —
`Vec4.x` through `Vec4.w` — because the target has four extract instructions and
no way to choose between them at run time.

`F32x4` is opaque rather than ordered. `Int`, `Str`, `F64`, and `F32` are ranges
over an ordered domain; four lanes are not an interval, so there is no bound to
narrow against and no literal that names one. The only fact about the type is
its name: `F32x4` matches `F32x4` and nothing else, `@type.reflect` reports it
as `#Opaque` (§13.4), and `Reflect.refines` therefore answers `#False` for it,
having nothing to compare.

Lane comparisons produce the separate opaque `F32x4Mask` type. A mask can be
passed to `Vec4.select` but has no lane projection or module-boundary layout.
`Vec4.shuffle` selects four constant lanes from two vectors; `Vec4.swizzle` is
the one-vector spelling. Lane selectors are integers in `0..7` for shuffle and
`0..3` for swizzle, and must be known while compiling so they can become the
instruction immediate.

There is no implicit conversion between the numeric types, and no operator
serves more than one. An operator resolves to one binding by name (§4.7), so a
`+` over both would have to dispatch on a value's type at run time.
`Float.of_int` and `Float.truncate` cross explicitly; `truncate` rounds toward
zero.

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

Applying an imported module checks the argument against the parameter type
inference found _inside_ that module. Nothing declares that requirement — a
module never writes a signature for its parameter, and the demand is whatever
its bodies reach for — so the rule is that the importer's record must satisfy
every field the module projects off its parameter. A record missing one is
`BLOT_TYPE_ERROR` at the application, naming the field. A fresh variable in the
parameter's place would satisfy every argument, and the program would then read
a field that is not there.
`examples/rejected/semantics/module_argument_missing_field.blot` is the catalog
entry.

The argument may carry _more_ fields than the module reads. Width subtyping
holds across the boundary in both directions: as the argument to a module, and
as an argument to a function that module exports. Such a program checks and
lowers — the record the importer built is what reaches the projection inside the
dependency, so the nominal the backend mints is the one the value has.
`examples/widened.blot` and `examples/lib/camera.blot` are the catalog entry.

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

A declaration sees the declarations above it and not the ones below it. The one
exception is a recursive group (section 6.5): a run of adjacent `rec` bindings,
whose names are all in scope in all of their bodies.

A name that is read before the block binds it is a scope error,
`BLOT_FORWARD_REFERENCE`, reported at the read. It is distinct from an unbound
name because the fix is different: the binding exists, and either it belongs
above the reader or the two belong in one recursive group.

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

### 4.2 Declaration tags

One or more compile-time descriptors may transform a `let` or `const` value:

```blot
@[derive(add_accessors)]
const Point = struct { .x = I32; .y = I32; };

@[test]
let point_origin = fn () => expect (True, "origin");
```

A descriptor is a compile-time shape with these members:

```blot
{
  .name = "tool-name";
  .metadata = compile_time_value;
  .transform = fn value => replacement;
}
```

`.name` must be non-empty text, `.metadata` may be any compile-time value, and
`.transform` must be callable. Other fields are permitted. The prelude's
`tag (name, metadata, transform)` constructs this shape. `derive transform`
constructs one named `"derive"`, and `test` is one named `"test"` whose
transform is `identity`.

Descriptors are evaluated in source order before the declaration value and in
the scope preceding the declaration; they cannot refer to the name being bound.
Transforms apply from the nearest tag outward:

```blot
@[outer]
@[inner]
let value = source;
```

binds `outer.transform (inner.transform source)`. The replacement is the value
matched by the binding pattern and may have a different type. An adjacent `sig`
constrains that final value. A `let` transform runs in the binding's runtime
phase and contributes its ordinary effects; a `const` transform runs at compile
time. Tags are not admitted on `sig` because a signature binds no value.

Tags lower to ordinary descriptor bindings, function application, and a block. A
tagged `rec` is first bound directly under its source name inside that block,
then transformed, so recursion gains no second evaluator, typing, ownership, or
backend rule.

Resolved tag names and metadata are available to compiler tools but are not part
of the runtime value or the Wasm ABI. `blot test` selects the semantic name
`"test"`, including aliases and descriptors built without the prelude. Each test
must be a named top-level binding usable as a pure `Unit -> Unit` function. Test
files have no explicit module parameter or ambient initializer effects. Every
test runs against a fresh evaluation of the declarations through its own
binding, failures do not stop later tests, imported modules contribute tests
only when passed directly to the command, and a run finding no tests fails.
Normal checking, evaluation, and building never execute tests.

### 4.3 Signatures

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

A function type includes the effects it performs, so a signature for a binding
that performs names them: `Str -> Unit ~ { Console }` (§12.4). A bare `->` is
the empty row rather than an unwritten one.

### 4.4 Stable rebinding

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

### 4.5 Nullary computation binding

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

### 4.6 Opening a record

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

### 4.7 Return

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

A spread contributes the fields its operand is _known_ to have. Where the
operand is a shape written nearby, that is all of them. Where it is a parameter,
it is none of them: `fn r => { ...r; .tag = 1; }` returns a shape with `.tag`
and nothing else, and reading any other field off the result is an error. Width
subtyping says what a function may _read_ from a record it is handed; it does
not carry the unread fields through a spread, which would need a row variable
this lattice does not have. Naming the fields at the spread avoids the limit
entirely.

A spread whose fields are not known is rejected where any field is written
before it. Members apply left to right, so such a spread may replace one of
them, and nothing decides which value wins until the program runs: in
`fn r => { .tag = 1; ...r; }` the result's `.tag` is `r`'s where `r` carries one
and `1` where it does not, and width subtyping is exactly why the checker cannot
tell — a value typed `{ .x = Int; }` may carry a `.tag` as well. Saying `1`
would be a claim the run refutes rather than a type too wide, so the shape is
refused with `BLOT_SPREAD_MAY_OVERWRITE`. Writing the spread before those fields
decides the question, and so does naming the fields wanted from it. The
default-then-override idiom this reads as would need a type saying "`r`'s field
if it has one, this one otherwise", which is presence polymorphism rather than
width subtyping.

Braces with no leading `.` on their members are an effect row rather than a
shape:

```blot
{ Console, Timer }
```

A row is one or more comma-separated expressions. It is a list of the values
between the braces, and `~` is what gives that list its meaning (§12.4); `{}` is
the empty shape, and a row is never empty.

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

A function is written with `fn` and has one parameter pattern:

```blot
fn parameter => body
```

`fn` is the only lambda form. The keyword is what makes a lambda identifiable
from its first token, which is why the parameter is an ordinary binding pattern
— qualifiers, tuples, shapes, arrays, and constructor patterns are all admitted
there — rather than an expression reinterpreted after the fact.

Application is juxtaposition and associates left:

```blot
f x y
// means
(f x) y
```

Multi-argument functions conventionally accept one tuple or shape:

```blot
fn (left, right) => left
```

Currying needs no parentheses. A lambda's body may be another lambda:

```blot
fn f => fn x => f (f x)
```

The body extends as far to the right as it can, so an inner lambda that is
followed by more of the enclosing expression is parenthesized like any other
operand.

Because every character of `=>` is in the operator class, a lambda written
without `fn` is a well-formed operator chain rather than a syntax error. It is
reported as `BLOT_LAMBDA_WITHOUT_FN` when the chain reaches the fixity table.

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
const factorial = rec (fn n =>
  if n < 2 then 1 else n * factorial (n - 1) end);
```

The bound name is visible inside the lambda body. `rec` applied outside such a
binding, applied to a non-lambda, or bound through a compound pattern is an
error.

A run of adjacent `rec` bindings of the same kind is one **recursive group**,
and every name the run binds is in scope in every member's body:

```blot
let is_even = rec (fn n => if n == 0 then True else is_odd (n - 1) end);
let is_odd = rec (fn n => if n == 0 then False else is_even (n - 1) end);
```

A group of one is ordinary self-recursion, so this states the existing rule for
a run rather than adding a second rule beside it. Membership is adjacency, not
participation: a `rec` binding that calls nobody is still a member of the run it
sits in.

A run ends at any declaration that is not a `rec` binding of a lambda to one
name, and at a change of kind. A `let` run and a `const` run are therefore
separate groups, because a `const` may not capture a `let` (section 4.1) and the
members of a group are bound together.

A `sig` neither joins a run nor ends one. A signature must be immediately
followed by the binding it constrains, so a `sig` written inside a run is one
member's own signature.

A tagged binding (section 4.2) is not a member and ends a run. A tag replaces
the binding's value with the transform applied to it, so what the binding holds
is no longer a `rec`.

The names entering scope together fixes the rest of the rule:

- A member must be a function. Every name in the group is in scope from the
  first member onward, but none holds a value until all of them are bound. A
  function body can wait for that and a value cannot, so `rec` applied to a
  non-lambda is refused.
- A name may not be bound twice in one group. A repeated `let` shadows an
  earlier binding, and in a group there is no earlier one to shadow. Another
  declaration between the two ends the group and restores ordinary shadowing.
- A group may shadow names from an enclosing scope. All of its members shadow at
  once, so every member's body sees the group's binding rather than the outer
  one.

Only a group is mutually visible. Two plain `let` bindings are not, which is
what keeps `let value = value + 1;` reading the binding above it rather than
reading itself.

A member's type is inferred with the whole group's names bound monomorphically
and generalized afterwards, so recursion within a group is not polymorphic.

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
  prefix 90 (!!) = negate;
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
| 21    | `~`                         | left            | `@type.performs`                |
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
let rank = fn level => case level of
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
let describe = fn n => case n of 1 => "one", 2 => "two" end;
// BLOT_INCOMPLETE_CASE: `Int` has more values than these arms can cover.
```

The choice is to narrow the target's type, add the missing arms, or write an
irrefutable arm. `@panic` is how that arm says why reaching it is impossible:

```blot
let describe = fn n => case n of
  1 => "one",
  2 => "two",
  _ => @panic "callers are checked against `1 | 2` upstream"
end;
```

`@panic` takes a text and returns the empty type, so it may stand where any
value is expected. It is not a caught failure: reaching it stops the program. It
survives to WebAssembly as an explicit fault carrying that text, which is what
distinguishes it from the arms the compiler proves unreachable: coverage is
checked, so a `case` with no matching arm is a path the checker ruled out, and
the emitted module marks it as unreachable rather than as a fault a program can
hit.

A target whose type inference has not pinned carries no coverage requirement,
since there is nothing to enumerate. Literal arms therefore still constrain
nothing on their own: without the `sig` above, `rank` accepts any argument and
owes no coverage at all.

An arm's pattern types the names the arm binds: what the target carries for a
constructor flows into that arm's payload pattern. An irrefutable arm leaves the
constructor set open rather than unknown — the named arms still say what their
payloads carry, so

```blot
let unwrap_or = fn m => case m of
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

A target may be a tuple, which is how a join over two values is written:

```blot
case (left, right) of
  (#Some a, #Some b) => a + b,
  (#Some a, #None) => a,
  _ => 0
end
```

Each arm is a row and each element is a column. Arms are tested in source order
and an arm's columns left to right; an arm that fails any column falls to the
next _arm_, not to the next column, and an arm that matches binds every name in
it. A column is an ordinary pattern, so it may be a constructor, a literal, a
name, a wildcard, or another tuple.

Coverage reads the columns. The arms taken together must cover the
cross-product: a combination of columns no arm accepts is
`BLOT_INCOMPLETE_CASE`, exactly as a constructor no arm names is for a single
target. So

```blot
sig join = (Option Int, Option Int) -> Int;
let join = fn pair => case pair of
  (#Some a, #Some b) => a + b,
  (#Some a, #None) => a,
  (#None, #Some b) => b,
  (#None, #None) => 0
end;
```

is total with no irrefutable arm at all, and dropping its last arm is refused
with `` No arm covers `(#None, #None)` ``.

The `sig` is load-bearing there, and this is the one place a tuple target is
weaker than a single one. A column is enumerated from the type declared for it,
and where nothing declares one the arms close each column of the sub-matrix they
are read in rather than the column as a whole — so the same four arms without
the `sig`, minus the last, are accepted and reach `BLOT_NO_MATCH` at run time.
Declare the scrutinee to get the cross-product checked.

Each column is covered on its own terms. A column whose type is a constructor
set must have every constructor named in it, and the arms are what close a
column no `sig` declared: a column naming `#Some` and `#None` makes the
scrutinee's column that union, so a target declared wider is refused there. A
column whose type has more values than arms can list — `Int`, `F64`, an opaque
type, a shape — can only be covered by an irrefutable pattern in that column, so

```blot
sig pick = (Int, Option Int) -> Int;
let pick = fn pair => case pair of
  (1, #Some a) => a,
  (_, #None) => 0
end;
```

is refused with `` No arm covers `(_, #Some)` ``: the first arm cannot help with
an integer other than `1`, and the arm that can does not name `#Some`.

Nested tuples and constructor payloads are columns like any other, and are read
the same way when a `sig` says what they hold. Where nothing does, an inner
column carries no requirement — only a column of the scrutinee's own tuple is
closed by its arms.

Like expression `if`, `case` is a value boundary: `return` and `break` cannot
escape from an arm.

A standalone `case` is control flow in the surrounding body rather than a value:

```blot
case choice of
  1 => do
    answer <- first_effect;
  end,
  _ => do
    answer <- other_effect;
  end
end;
```

The target is still evaluated once and the patterns have the same order, scopes,
typing, and exhaustiveness rule. `=> do` opens an arm's statement body, the
arm-local `end` closes it, and the final `end;` closes the whole case. An arm
may perform effects, `return` from the surrounding source function, or `break`
from the surrounding `for`.

As in a statement `if`, a `let` inside an arm stays local while a name rebound
with `:=` is rebound for the statements after the case. Every arm must produce
the same stable rebound-name record, and exhaustiveness means there is no
implicit pass-through arm. The form lowers during CST lowering to an ordinary
value `case` whose arms are blocks returning that record; no statement-case node
reaches inference, ownership, evaluation, or the backend.

An arm may carry a **guard**, which is a refinement no pattern states:

```blot
case n of
  0 => "zero",
  m if m > 0 => "positive",
  _ => "negative"
end
```

`pattern if condition => body` is taken when the pattern matches _and_ the
condition holds. The condition is an ordinary expression of type `Bool`, in the
arm's own scope, so it reads what the pattern bound. A guard that does not hold
falls through to the arms below, which is what a nested `if` inside the arm
cannot do: the arms keep the order they are written in, so

```blot
case n of
  5 => "five",
  m if m > 0 => "positive",
  _ => "other"
end
```

answers `"five"` for 5 even though the guard below would hold.

The statement form writes the same guard before `=> do`; a false guard falls
through before any statement in that arm runs.

**A guarded arm does not count towards coverage.** Its guard may be false, so it
can never be the arm that is guaranteed to match, and the arms that remain must
cover the target on their own. Every rule above then applies unchanged to those
arms:

```blot
let describe = fn option => case option of
  #Some n if n > 0 => "positive",
  #None => "none"
end;
return describe (#Some 1);
```

is refused, because with the guarded arm set aside the only constructor named is
`#None`, so the argument is not one the arms close. The call is what makes it
report: like every coverage rule here, a target inference has not pinned carries
no requirement, and this one reports through subtyping —
`` `#Some` is not one
of #None `` — because a constructor set is covered by
subtyping (above). A `case` whose arms are _all_ guarded covers nothing and is
`BLOT_INCOMPLETE_CASE` however many arms it has. A tuple target is read the same
way: a guarded row is not one of the rows that cover the cross-product.

A guard cannot refine a **linear or borrowed** target. Falling through means
testing the target again, and a linear value is spent by the first test, so the
second is `BLOT_LINEAR_CONSUMED_TWICE`. Match such a target once and put the
condition inside the arm.

### 8.5 What a branch proves

A condition can narrow a name. Inside the branch it is taken, and inside every
branch reached because it was not, the name's type is the part of its declared
set that the condition allows.

```blot
sig name = 1 | 2 | 3 -> Str;
let name = fn n => if n == 1
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

A value is recognised when it is `fn p1 => fn p2 => body` and every occurrence
of `p1` and `p2` in `body` lies inside a single application `@int.cmp p1 p2` —
one occurrence each, with no binder in `body` rebinding either name. The body
may then be evaluated only through that call, so the function is some decision
on `@int.cmp`'s three answers, and the checker determines which by applying it
to one pair of integers per answer. That is why narrowing reaches an unbounded
domain: `if n < 10` proves `..9` and `10..` without enumerating anything.

**What it is compared against.** The other operand must be a value the checker
can name without running the program, and there are two of them.

The first is a single compile-time integer — an integer literal, or a name whose
`const` value is one. `if 0 < n` reads the same as `if n > 0`.

The second is the length of an array a name in scope holds, written
`@array.len xs`. That one is not a number and does not have to be:

```blot
sig at = [Int] -> Int -> Int;
let at = fn xs => fn n =>
  if n >= 0
  then (if n < @array.len xs then @array.get xs n else 0 end)
  else 0
  end;
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
- **The other half of a junction.** `if a && b` proves what _both_ halves prove
  about one name, and the branch it does not take proves nothing: failing a
  conjunction can mean failing either half. `||` is the mirror — its untaken
  branch proves both, its taken branch proves nothing. A junction is recognised
  by its truth table, tabulated over the four boolean inputs, so a shadowed
  `Logic.and` that is not conjunction proves nothing rather than being mistaken
  for one. Two halves that speak about _different_ names also prove nothing: a
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
the name inside the branch with `:=` replaces it under the ordinary rule (§4.4)
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
  .step = fn state => #Some (element, next_state); // or #None
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
body introduces a binding that ends with the body, so the outer `n` is untouched
and the local is free to hold a different type — only `:=` carries a value out.
Where a `let` shadows a name, every `:=` after it in that block rebinds the
local and therefore escapes nothing.

Rebinding a name with `:=` and then shadowing it with a `let` in the same block
is an error. The carried value is read where the block ends, which is inside the
shadow, so the local would leave under the accumulator's name; the two readings
of such a block are equally defensible and neither is chosen. Rename the local,
or write the `let` above the first `:=`.

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
- `F64` and `F32`, the float types;
- `F32x4`, four `F32` lanes as one value, opaque and matched by name;
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

An effect row is the one piece of this notation that is also source:
`A -> B ~ {
Console }` is written in a `sig` exactly as it is printed (§12.4). A
row _variable_ — the `e` in `A -> B ~ { Console, e }` — is printed and not
written; a written row names effects and is closed.

### 10.2 Type-value primitives

The primitive type values are `@type.int`, `@type.float`, `@type.float32`,
`@type.f32x4`, `@type.text`, `@type.unit`, and `@type.unbounded`.

The type algebra includes:

- inclusive ranges;
- union, intersection, and difference;
- function arrows, and the effect row an arrow performs;
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

A namespace member is a compile-time value, and projecting one is typed by that
value rather than by the field rule. A member that is itself a type projects to
that type. A member that is a function has no arrow to read off it and projects
to `⊤`. Calling one is typed by evaluating the whole application at compile
time, and the value produced is the result type. The arguments must therefore be
values the checker can compute: a literal, a `const`, or a binding whose value
it already computed to type an earlier member call. A call it cannot evaluate
has result type `⊤`, so nothing can be done with the result and no `sig` is
satisfied by it.

A sealed type is nominal and invariant. Its identity is its name together with
its carrier.

### 10.3 Deliberate inference limits

The implemented checker does not currently prove:

- range-refining arithmetic — `@int.add n 1` widens to `Int` whatever `n` was,
  so an index carried across an addition loses what a comparison proved about
  it;
- an index bound that came from anywhere but a comparison against a literal or
  against `@array.len` applied to a name (§8.5, §13.3);
- the result of `@shape.get`, `@shape.set`, or `@shape.remove` whose field name
  is a runtime value (§13.3);
- anything about a namespace member that is a function, or about a call to one
  whose arguments are not compile-time values (§10.2);
- the fields a spread carries through from an operand whose own fields are not
  known where the spread is written (§6); or
- impredicative instantiation.

Rank-N types are explicit and predicative through `@forall`. Higher-kinded
abstraction is compile-time function application rather than a kind system.

There is no record row variable, and there is not going to be one; the reasoning
is in `docs/roadmap.md`. The lattice has width subtyping, which says what a
function may _read_ from a record, and that is a different fact from what a
value _carries_ — a spread needs the second. The effect row in
`A -> B ~ { Console, e }` is a row over a set of labels with no types under
them; a record row would be a second sort with types, and the operations shape
syntax can write over it — concatenating two unknown rows, or overriding a field
that may or may not be there — have no principal solution in this lattice.

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

### 11.1 A recursive group

A recursive group's names are in scope in every member's body (§6.5), and that
includes here. A reference to a sibling is a use of it wherever the sibling is
declared, so declaration order inside a group changes neither what the program
means nor whether it is accepted.

A member's qualifier is not what is written on it. A member that captured a
linear value is linear, and a sibling that holds such a member is linear in
turn: the obligation is relocated, not restated. That is the rule an ordinary
binding already had (above), applied to the whole group at once because the
group's names are bound at once.

**A closure holding a spendable value may not be called from inside its own
recursive group, including from its own body.** A recursive call is a second
call, and a closure owing exactly one call cannot promise it:

```blot
let go = rec (fn n =>
  if n < 1 then consume (!token) else go (n - 1) end);
return go 3;
```

is `BLOT_LINEAR_CONSUMED_TWICE`, naming `go`. This refuses a program that may in
fact spend the value once — the pass counts uses and cannot count calls — and
refusing is the conservative side. An affine member is refused the same way for
the same reason, because a second call is a second consumption there too; what
differs is that leaving the group's closures uncalled is a leak for neither, so
an affine member no caller reaches is accepted where a linear one is only
accepted because its own recursive call is counted as the consumption it owed.

`examples/rejected/semantics/recursive_linear_capture.blot` is a group of one
and `examples/rejected/semantics/recursive_group_consumed_twice.blot` is a group
of two.

### 11.2 Facts recorded for the backend

A recorded last use is where the pass stopped seeing a name. Inside a closure
that is not where the binding dies, because the closure's body runs when the
closure is called, and nothing in declaration order dates that call. Where a
binding is read across a closure boundary _and_ read somewhere else too, the
pass records that it cannot date the read, and an owned in-place store update is
refused rather than guessed. A binding a closure holds the only read of keeps
its last use, because how often that closure runs is exactly what the linear
proof is about.

When the proved consumption of a linear binding is the array operand of
`@array.set` or `@array.push`, the backend may reuse that array's Store. This is
an implementation permission, not mutation in the language: the source binding
is unavailable after the consuming use, and updates of ordinary shared arrays
remain persistent with the immutable behavior specified in §6.1.

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
  .write = fn (message, ?resume) => message <> resume ();
  .return = fn value => value;
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
  fn () => @handle (Terminal, program, fake_terminal);
let program_without_clock =
  fn () => @handle (Clock, program_without_terminal, fake_clock);
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

### 12.4 Written effect rows

A function type carries the row it performs, and a `sig` writes that row the way
the checker prints it:

```blot
const Console = @effect { .write = Str -> Unit; };

sig greet = Str -> Unit ~ { Console };
let greet = fn name => Console.write name;
```

`~` is an ordinary infix operator (`@type.performs`, precedence 21) whose right
operand is a **row**: one or more comma-separated expressions between braces,
each of which must evaluate at compile time to an effect. A row's members carry
no leading `.` where a shape's members always do, which is what tells
`{ Console
}` and `{ .x = Int; }` apart; `{}` is the empty shape, and a row is
never empty because a function that performs nothing is written without `~`.

An effect is an ordinary compile-time value, so only an effect that is in scope
can be named. A module that acquires authority by importing a library — the
library declares the effect and does not export it — receives that effect in its
own inferred rows and cannot write them.

Four rules decide what a written row means.

**A written row is an upper bound.** The binding's inferred type must be a
subtype of the signature, and fewer effects is a subtype, so a body may perform
fewer effects than its signature names. `sig quiet = Int -> Int ~ { Console };`
over a body that performs nothing is accepted, and callers are told what the
signature says.

**A bare `->` is the empty row.** It is a claim, not the absence of one, so a
`sig` without `~` on a body that performs is rejected. Reading it as "says
nothing about effects" would make the row a variable that every later constraint
satisfies — and since the binding takes its signature as its type, the effect
would pass the check and then be missing from what every caller is told.

**A written row is closed.** There is no way to write a row variable: `e` in a
printed `~ { Console, e }` is the rest of the row inference found, and a
signature naming one would be an unconstrained variable admitting every effect.
The cost is that a function polymorphic in a callback's row —
`('a -> 'b ~ { e
}) -> 'a -> 'b ~ { Console, e }` — can be given a signature
only by fixing that row.

**The row lands on the last arrow.** `A -> B -> C ~ { Console }` is the function
that performs when its second argument arrives, which is where the printer puts
a row. A second `~` fills the next arrow outwards, so
`A -> B -> C ~ { Inner } ~
{ Outer }` reads back as itself; a `~` on a chain
whose arrows all carry rows is an error.

Reflection (§10.2) describes an arrow's `.domain`, `.codomain`, and `.effects`,
but an effect itself reflects as `#Opaque` — nothing in blot takes one apart. So
the prelude's `refines` decides an arrow's row only when the narrow side
performs nothing, and refuses rather than guesses otherwise. Rows are decided by
the checker, at the `sig`.

## 13. Primitive namespace

Every intrinsic is curried like an ordinary Blot function except `@handle`,
which takes its three arguments in one tuple. The two-argument spelling inside
`try` is surface syntax described in section 12.2, not partial application.
Applying fewer arguments to other primitives returns a partially applied
primitive.

Everything not listed here belongs in source, normally the prelude.

### 13.1 Control, modules, and effects

| primitive         | meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| `@import`         | resolve a text module specifier and return its function       |
| `@effect`         | create a fresh source effect from operation types             |
| `@effect.host`    | create a fresh host effect                                    |
| `@handle`         | discharge one effect from a nullary computation               |
| `@forall`         | evaluate a type function with a fresh rigid variable          |
| `@satisfies`      | return a value after proving it inhabits a type               |
| `@type.satisfies` | return a value after proving its _type_ satisfies a predicate |
| `@fail`           | refuse compile-time evaluation with a diagnostic              |
| `@panic`          | trap with a text message                                      |

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
| `@f32.add`       | single-precision addition                            |
| `@f32.sub`       | single-precision subtraction                         |
| `@f32.mul`       | single-precision multiplication                      |
| `@f32.div`       | single-precision division                            |
| `@f32.neg`       | single-precision negation                            |
| `@f32.cmp`       | order two `F32`, refusing NaN                        |
| `@f32.is_nan`    | test an `F32` for NaN                                |
| `@f32.of_float`  | narrow an `F64`, which may lose the value            |
| `@float.of_f32`  | widen an `F32`, which never does                     |
| `@f32x4.of`      | gather four `F32` into one vector                    |
| `@f32x4.splat`   | one `F32` into every lane                            |
| `@f32x4.add`     | lane-wise addition                                   |
| `@f32x4.sub`     | lane-wise subtraction                                |
| `@f32x4.mul`     | lane-wise multiplication                             |
| `@f32x4.div`     | lane-wise division                                   |
| `@f32x4.eq`      | lane-wise equality mask                              |
| `@f32x4.less`    | lane-wise less-than mask                             |
| `@f32x4.select`  | choose lanes from two vectors by mask                |
| `@f32x4.shuffle` | four constant lanes selected from two vectors        |
| `@f32x4.sum`     | add the four lanes together                          |
| `@f32x4.x`       | read lane zero, and `.y`, `.z`, `.w` for the rest    |
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

#### A field named by a value

`@shape.get`, `@shape.set` and `@shape.remove` name their field with a text
value rather than with a literal, so no signature can state what they produce.
They are typed at the call site instead, by the name:

- when the whole projection can be evaluated at compile time, what it produced
  is the result's type;
- otherwise, when the name alone can be, the call is an ordinary field
  projection and is typed as one. `@shape.get r "a"` has the type of `r.a` and
  is refused when `r` has no `.a`; `@shape.set` and `@shape.remove` answer with
  the target's fields, with that one added, replaced, or dropped.

```blot
let r = { .a = 7; };
sig z = 0;
let z = @shape.get r "a";
// BLOT_TYPE_ERROR: `7` is outside `0`.
```

A name that is only known at run time — `@shape.get value name` inside a fold
over `@shape.names` — leaves the result unconstrained, and a `sig` written over
one of those is believed rather than checked.

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
let at = fn xs => fn n => if n >= @array.len xs then @array.get xs n else 0 end;
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
`let xs = [1, 2, 3]; let read = fn xs => @array.get xs 99;` reports nothing,
because the `xs` being read is the caller's.

All of this is for unqualified arrays. Every argument position is a move (§11),
and both of these forms name the array twice — once to measure and once to read
— so a linear or borrowed array cannot be written this way at all:
`let !xs = [1, 2, 3]; let n = @array.len xs; let v = @array.get xs 0;` is
`BLOT_LINEAR_CONSUMED_TWICE`, and this rule does not change that.

### 13.3.1 Asking about a type

`@satisfies (value, type)` proves that a compile-time _value_ inhabits a type.
`@type.satisfies (value, predicate)` asks a different question: whether the
_type_ of an expression satisfies a compile-time predicate.

```blot
let reading = { .value = Source.read (); .label = "depth"; };
let checked = @type.satisfies (reading, Has { .value = Int; });
```

The predicate is an ordinary compile-time function from a type value to a
`Bool`, so it may ask anything `reflect` and `refines` can answer. The value
passes through unchanged; this asserts, it does not coerce. A predicate that
answers `#False` is `BLOT_DOES_NOT_SATISFY` while compiling.

It takes its two arguments as one tuple rather than curried, for the reason
`@handle` does: the checker has to see the whole call to type it, and a
partially applied one would be a closure whose parameter is not a compile-time
value.

`@type.of` cannot stand in for this. It answers the type of a _value_, so it
evaluates one — on an expression whose value only exists at run time that is an
unhandled effect rather than a type. The type of such an expression lives only
in the lattice, and reaching it is the whole reason this primitive exists.

The type must have a compile-time reading. An inference variable with no single
lower bound, an effect row, and an open variant do not, and each is
`BLOT_TYPE_NOT_REIFIABLE` naming the type rather than a silently permissive
answer.

The prelude supplies the two predicates that would otherwise be written inline:
`Is` for an exact type and `Has` for a subset of fields. Both are one line over
`refines` and neither is machinery.

### 13.4 Type values

| primitive          | meaning                                           |
| ------------------ | ------------------------------------------------- |
| `@type.unbounded`  | open range bound                                  |
| `@type.int`        | unbounded integer domain                          |
| `@type.text`       | unbounded text domain                             |
| `@type.float`      | the double domain, which has no bounds            |
| `@type.float32`    | the single-precision domain                       |
| `@type.f32x4`      | four single-precision lanes, an opaque type       |
| `@type.f32x4_mask` | four comparison lanes, an opaque type             |
| `@type.unit`       | unit type/value                                   |
| `@type.range`      | inclusive range                                   |
| `@type.union`      | flattened duplicate-free union                    |
| `@type.intersect`  | intersection of union members                     |
| `@type.diff`       | difference of union members                       |
| `@type.arrow`      | function type value                               |
| `@type.performs`   | attach an effect row to a function type           |
| `@type.of`         | structural singleton type of a compile-time value |
| `@type.seal`       | nominally seal a carrier under a text name        |
| `@type.open`       | recover a sealed carrier                          |
| `@type.attach`     | attach one namespace member to a type value       |
| `@type.members`    | recover attached namespace members                |
| `@type.reflect`    | inspect the representation of a type value        |
| `@type.union_of`   | union a non-empty array of type values            |

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
#Arrow { .domain; .codomain; .effects = [effect]; }
#Sealed { .name; .inner; }
#Opaque
```

`#Opaque` is everything with no parts to report: a closure, a primitive, a host
function, an effect, and `F32x4`, whose whole content is its name.

### 13.5 Ownership markers

`@linear.own` and `@linear.borrow` are runtime identities whose meaning comes
from ownership analysis and the default prefix fixities `!` and `&`.
`@linear.maybe` is the reserved target of prefix `?` and is not a primitive the
checker knows: `?expression` is `BLOT_UNKNOWN_PRIMITIVE`. Affine obligations are
introduced by `?name` patterns, and there is no expression form for them —
unlike `!` and `&`, prefix `?` is a fixity entry with nothing behind it.

## 14. Standard prelude

The standard prelude is ordinary Blot source at `blot:prelude`. Its public
record currently exports:

- function tools: `Fn`, `identity`, `always`, `compose`, `flip`;
- declaration-tag tools: `tag`, `derive`, and `test`;
- booleans: `Bool`, `True`, `False`, `Logic`, `not`, `expect`;
- ordering and arithmetic: `Ordering`, `is_equal`, `is_less`, `is_greater`,
  `Ord`, `Eq`, `Num`;
- floats and lanes: `Float`, `Float32`, and `Vec4`;
- branch hints: `likely` and `unlikely` (§15.1);
- text: `Text`, `Semigroup`, `text_eq`;
- arrays: `Array`, `fold`, `each`, `map`, `filter`, `sum`, `upto`, `any`,
  `every`, and `sort_by`;
- iterators: `ever`, `Iter`, `iterate`, and `collect`;
- variants: `Option`, `None`, `Some`, `unwrap_or`, `Result`, `Ok`, `Error`;
- type tools: `Type`, `Set`, `attach`, `seal`, `unseal`, `Reflect`, `reflect`,
  `refines`, `members`, `union_of`, `Extract`, `Exclude`, `Pick`, `Omit`,
  `opened`, and `range`;
- storage tools: `struct`, `reorder`, `layout`, `aligned`, and `packed`; and
- standard types: `I32`, `I64`, `U8`, `Nat`, `Int`, `Str`, `Unit`, `F64`, `F32`,
  `F32x4`, and `F32x4Mask`.

Important conventional values include:

```blot
const Bool = #True | #False;
const Option = fn value => #None | #Some value;

const ever = {
  .state = ();
  .step = fn _ => #Some ((), ());
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
- marks a Store update owned only when it consumes a proved linear array;
- lowers each recursive group to one local `let-rec` group;
- specializes source handlers with selective CPS; and
- turns host effects and entry-module projections into typed imports.

Runtime exports require a concrete first-order ABI. Supported boundary values
include integers, text, unit, booleans, concrete records, arrays, variants,
seals, and functions over supported values. Types and effects remain
compile-time manifest entries and have no invented runtime encoding.

A residual structurally polymorphic function must be specialized to a concrete
record shape before gpufuck. The shape is the one that _flows_ to the
projection, not the narrower one the body reads: inference follows what flowed
into the projected variable, across the instantiation a `let`-bound scheme makes
for each of its callers, so `let get_x = fn v => v.x;` takes its record from the
call sites. When nothing flows in — a parameter whose caller is outside the
program — the fields the body demands decide instead, and they are unioned.

Those call sites may be in another module. A record crosses into a module
carrying more fields than that module reads and lowers there (§3), because the
field sets are settled after every module in the program has been checked rather
than as each one finishes: the answer for a projection in one file is decided by
a call site in another.

A record does not flow through a tuple `case`. Where a record reaches a
projection only by having been an element of a tuple target, what is recorded is
the narrower set the projection's own body reads, and the nominal built from it
is not the one the value was built with — so such a program is refused at
lowering rather than compiled against the wrong record. Matching the record's
own option directly is what keeps the wider set.

Two _different_ records reaching one projection decide nothing, and that
includes a narrower and a wider one: a value of each is really built, Core
records are invariant, so the two are distinct nominal types and their union is
a record neither call site writes. `BLOT_SHAPE_DISAGREEMENT` names both of them
at that projection rather than inventing a third. This is a lowering refusal and
not a type error: the program is well typed under width subtyping, and
`blot check` still accepts it and reports its principal type. Exporting an
unconstrained structural function is rejected rather than assigned an arbitrary
nominal ABI.

The same value read at one place from two modules is now the common way to reach
this. Two importers passing differently-shaped records to one library projection
are `BLOT_SHAPE_DISAGREEMENT` naming both field sets — previously unreachable
across a boundary, because neither caller's record arrived at the projection at
all.

### 15.1 Core WebAssembly ABI

`blot build` emits Blot Core Wasm ABI 1.0. gpufuck's tagged words and heap
objects are private implementation details; generated adapters expose the
synchronous memory32, UTF-8 subset of the Component Model Canonical ABI.

Each runtime field of a record module result is exported as `blot:<field>`. A
module whose result is not a record has one export, `blot:default`, which is
that result. Host effects import their operations from `blot:host/<capability>`.
The module exports `memory`, `cabi_realloc`, and immutable `blot:abi-major` and
`blot:abi-minor` globals. An indirect result also exports
`cabi_post_blot:<field>`, which the caller must invoke exactly once after
reading the result.

The boundary representations are:

- `()` as no flat value and a zero-sized memory value;
- `Int` as signed `i64`;
- `F32` as canonical `f32` and `F64` as canonical `f64`;
- `Bool` as `i32` or one byte in memory, restricted to zero or one;
- `Text` as a pointer and UTF-8 byte length;
- arrays as a pointer and element count;
- records as source-name-sorted fields with canonical alignment;
- variants as a source-name-sorted discriminant and joined payload; and
- seals as their transparent carrier, while retaining their nominal source name
  in the manifest.

`F32x4` and `F32x4Mask` stay private to the compiled artifact. Publishing either
is `BLOT_VECTOR_AT_BOUNDARY`; extract lanes or select a vector before exporting.

At most 16 flat parameters and one flat result are used. Larger parameter lists
and results use canonical record memory. Parameters are borrowed. Indirect
results and their nested buffers are owned until the declared post-return call.
Malformed UTF-8, booleans, discriminants, lengths, pointers, and alignments
trap.

`@branch.likely condition` and `@branch.unlikely condition` are boolean
identities. In an `if` condition they additionally emit WebAssembly branch-hint
metadata for the consequent or alternate respectively. Engines that ignore the
custom section observe identical semantics. The prelude exports them as `likely`
and `unlikely`.

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

let describe = fn message => case message of
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

let report = fn () => do
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
