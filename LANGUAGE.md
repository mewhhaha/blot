# The Blot Language

This document specifies the implemented Blot language. It describes source
syntax, evaluation, inference, ownership, modules, effects, the primitive
namespace, and the compilation boundaries to WebAssembly.

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
- a validated Runtime HIR path through gpupaper's Rust/WebAssembly emitter, with
  the GPU pipeline retained only as an explicit conformance check.

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
let const sig return
if else case of rec open
for in break do compdo fn
```

Reserved words and capitalized names remain valid field names: `.return`,
`.else`, `.Num`, and `.0` are all ordinary projections.

### 2.2 Literals

An integer literal contains decimal digits. Negative integers are prefix
negation rather than a distinct token. Literal spellings must fit the GPU
frontend's signed-32-bit input profile; wider values, including the bounds of
`I64`, can be computed at compile time.

Runtime integers are signed 64-bit values and trap on overflow. Compile-time
integer arithmetic is arbitrary precision.

The prelude functions `U bits` and `I bits` construct fixed-width integer ranges
at compile time. `bits` must be positive:

```text
U n = 0..(2^n - 1)
I n = -2^(n - 1)..(2^(n - 1) - 1)
```

`I8`, `I16`, `I32`, `I64`, `U8`, `U16`, `U32`, and `U64` are aliases for the
corresponding applications. These are range types, not additional runtime
numeric domains: arithmetic still uses signed 64-bit `Int`, does not wrap to a
range's width, and must prove a narrowed result when a signature requires one.
Each constructor attaches its positive `bits` argument as transparent
`.bit_width` namespace metadata; it does not add that metadata to the type
lattice. Because type construction runs with arbitrary-precision compile-time
integers, a range such as `U64` can describe storage bounds above the largest
runtime `Int`; that fact does not make those values representable by runtime
integer operations. A runtime signature containing such inhabitants is
`BLOT_UNREPRESENTABLE_INTEGER`. `U64` is therefore a valid storage descriptor,
not a signed-`Int` runtime type; a full-width unsigned runtime value would need
a distinct word domain and operations.

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

`F32x4`, `I32x4`, `I16x8`, and `I8x16` are 128-bit SIMD values. Their lane width
and count are part of the type; none is a tuple or record that can be projected
structurally. `Vec4`, `Int32x4`, `Int16x8`, and `Int8x16` are the prelude
namespaces for their operations. The emitted `wasm-simd128` artifact uses native
vector instructions. The gpufuck conformance path may implement an integer
vector lane by lane, but must produce the same value.

Integer lane arithmetic wraps modulo (2^{32}), (2^{16}), or (2^8). Shift amounts
are reduced modulo the lane width. Operations whose interpretation matters say
`signed` or `unsigned` in their name; the bits in the vector do not otherwise
carry signedness. Checked constructors accept `I32`, `I16`, or `I8` as
appropriate and preserve the integer they receive. The explicitly named
`of_wrapping`, `splat_wrapping`, and `with_*_wrapping` operations accept `Int`
and reduce it modulo the lane width. Arithmetic is inherently wrapping.
`Int32x4.of` constructs four lanes and its named projections and replacements
are `x`, `y`, `z`, `w` and `with_x`, `with_y`, `with_z`, `with_w`. The narrower
namespaces currently construct only with `splat`.

`F32x4` is opaque rather than ordered. `Int`, `Str`, `F64`, and `F32` are ranges
over an ordered domain; four lanes are not an interval, so there is no bound to
narrow against and no literal that names one. The only fact about the type is
its name: `F32x4` matches `F32x4` and nothing else, `@type.reflect` reports it
as `#Opaque` (§13.4), and `Reflect.refines` therefore answers `#False` for it,
having nothing to compare.

Lane comparisons produce separate opaque `F32x4Mask`, `I32x4Mask`, `I16x8Mask`,
and `I8x16Mask` types. A mask is accepted only by the matching vector namespace.
Integer `mask_bits` returns bit (i) for lane (i), while `all` and `any` reduce
the mask to `Bool`. Masks have no lane projection or module-boundary layout.
`Vec4.shuffle` selects four constant lanes from two vectors; `Vec4.swizzle` is
the one-vector spelling. Lane selectors are integers in `0..7` for shuffle and
`0..3` for swizzle, and must be known while compiling so they can become the
instruction immediate.

`Int32x4.lane vector selector` selects a lane whose integer selector is in
`0..3` and known at compile time. A singleton integer type alone is
insufficient: the selector must be a literal or a `const` value so lowering
receives an immediate certificate. The named `x`, `y`, `z`, and `w` operations
remain the shortest spelling for fixed positions.

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
module parameter         // optional

operators {             // optional
  infixl 60 (+) = Num.add;
}

declarations
return result
```

The `module` header, when present, must be first. The `operators` header, when
present, follows it. At least one declaration is required, and the final
declaration must be `return value`.

A module is a unary function from its parameter to its returned value. A module
without an explicit header has a unit parameter that its body ignores; callers
invoke it with `()`.

```blot
const library = @import "./library.blot"
let exports = library ()
```

`@import` accepts a literal text specifier and returns the module function. It
does not call that function and has no implicit parentheses. Relative paths are
resolved from the importing file. A `blot:name` specifier resolves to the
corresponding compiler-supplied library module; `blot:prelude` is the standard
prelude. A bare package specifier resolves through the nearest
`node_modules/<package>/blot.json`; the package name selects export `.` and a
package subpath selects the corresponding `./subpath` export. Package manifests
may name both ordinary source and a built `.blotc` module capsule. A valid built
capsule is preferred; a missing, corrupt, or unsupported capsule falls back to
the manifest's source target. Import cycles are rejected.

Package export paths are relative to and confined within their package
directory. Package JavaScript is not evaluated during Blot resolution. A
`.blotc` library capsule bundles its already checked package-owned lowered AST
graph, relative import edges, and included files without retaining module source
text. Package and `blot:` imports remain logical external edges so an
installation can share and version those dependencies. Loading validates the
compressed payload, every AST reference and span, graph acyclicity, and the
declared dependency edges. The importing program still typechecks and
specializes the graph at the call site, so a capsule is not final WebAssembly.
The artifact schema version is internal to the file and does not appear in
source specifiers or required directory names.

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
open @import "blot:prelude" ()
```

At compilation, imported module bodies are specialized and inlined. This does
not alter their source semantics as functions.

### 3.1 Included files

`@include` makes a non-Blot file available to an ordinary compile-time Blot
function:

```blot
const as_raw = fn source => source.text
const shader = @include "./shaders/main.wgsl" as_raw
```

Schematically, for every result type `a`, its type is:

```blot
Str -> ({ .specifier = Str; .path = Str; .text = Str; } -> a) -> a
```

The first argument must be a text literal at the call site. Relative paths are
resolved from the including module; absolute paths retain their usual file
meaning. The parser receives the exact written `.specifier`, a normalized
module-relative `.path` using `/` separators, and the file's UTF-8 `.text`. It
is an ordinary Blot function, so the program chooses the result type and
representation. A JSON parser can return a structural value, for example, while
a shader parser can return metadata and source text together. These are library
policies; only decoding operations that Blot cannot express from its current
text primitives require compiler support.

The prelude supplies the conventional JSON policies:

```blot
const config = @include "./config.json" as_json
const fixed_config = @include "./config.json" as_const_json
```

Both produce ordinary Blot values. JSON objects become records, arrays become
arrays, strings become text, integral numbers become `Int`, other numbers become
`F64`, booleans become `Bool`, and `null` becomes `()`. `as_json` assigns the
usual widened type recursively: text is `Str`, integers are `Int`, booleans are
`Bool`, and array elements are joined into one homogeneous element type. Object
field names remain structural because they are present in the file.
`as_const_json` instead preserves every text, integer, and boolean literal in
the compile-time type and preserves the exact compile-time array contents. `F64`
has no singleton types, and a runtime array remains homogeneous because Blot
does not encode array length in its type.

JSON decoding follows the platform JSON grammar, including last-field-wins for
duplicate object names. An integral token is read from its source spelling, so
compile-time integers do not lose precision through an intermediate JavaScript
number. A non-integral number outside finite `F64` and malformed JSON are
diagnostics at the `@include` call.

An include is compile-time-only and its result must be bound with `const` or
consumed by another compile-time expression. It grants no runtime filesystem
authority and never leaves an unresolved file read in emitted code. The loader
reads included files before evaluation, reports a missing file at its literal,
and records the file as a dependency. A resident compilation therefore
invalidates the including module and its importers when the included contents
change.

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

Physical line breaks terminate declarations. A continuation may be indented, but
indentation opens a statement suite only after a suite introducer. The
introducers are `=`, `=>`, `<-`, `of`, and `:`. `do:` is the explicit
value-producing statement scope, and `compdo:` is its compile-time counterpart.
Parentheses only group values or form tuples; they never introduce a statement
suite. A suite may use any indentation width, but every line at that depth must
agree; a dedent must return to an active suite width or to the introducer's
width. Other indentation is expression continuation and does not silently create
a scope. A closing delimiter does not select a suite width, so its indentation
is ignored and canonicalized by the formatter. The formatter writes the accepted
structure with two-space indentation and expands lines toward an 80-column
limit. When a binding or `return` line is too wide, its value moves to the
following line at one additional indentation level. A delimited value that is
already multiline likewise moves as a whole, so its opening and closing
delimiters share the value's indentation scope rather than the declaration's
prefix. A vertical delimiter indents its contents one level and closes one level
outside them. The formatter writes a conditional vertically, giving each branch
a block whose explicit `return` supplies the value that branch contributes. When
the conditional is itself the terminal result of a scope, the formatter omits
the redundant outer `return` and lets those branch returns target the scope
directly. Arrays use one line when they fit within their value scope and
otherwise place one element on each line. After a standalone `if` or `for` suite
closes before another statement, the formatter writes one empty line to make the
dedent visible.

### 4.1 Runtime and compile-time bindings

```blot
let pattern = value
const pattern = value

let descriptive_pattern =
  value
```

The indented continuation accepts a lambda or ordinary expression. An `if`
immediately after the newline begins the binding's existing block form, where it
is a statement conditional whose branches `return` the value the binding takes.
`case` is what selects a value in place (§8.1); there is no spelling that makes
the `if` itself the value. The continuation changes layout only and does not
introduce another scope.

`let` defines a value in the current phase, matches its pattern when demanded,
and binds the pattern's names.

`const` evaluates its value at compile time even when the surrounding program is
running. A `const` must be computable without runtime input. Compile-time
closures may later be specialized into runtime code when called.

A `const` takes its type from the value it evaluated to, not from the expression
that produced it. When that value is a function, its type is the type of the
lambda the evaluator selected. So a compile-time conditional over types is a
dispatch: each `const` bound from it is typed against the branch that ran, and
the branch that did not run contributes nothing to it.

```blot
const measuring = fn T => if refines (T, Str):
  return fn x => Text.length x
else:
  return fn x => x + 0

const measure_text = measuring Str   // Str -> Int, not joined with the other arm
```

This applies equally to a compile-time function reached through an imported
module record. If the callee and arguments are known at compile time, checking
evaluates the application and types the value it produced under the function's
defining module scope and concrete captures when the ordinary result has
alternative structural or function lower bounds, or carries an unevidenced
structural inspection. An evaluated record is typed field-by-field, so a
descriptor may contain a branch-selected function whose arrow differs from
another call's. The ordinary application is checked in either case: it remains
responsible for parameter, effect, and representation constraints. If the
application cannot be evaluated or its settled result is already precise, that
ordinary result remains authoritative.

The defining-module provenance belongs to the function value, not to the field
path used to reach it. Aliasing or re-exporting the function through another
module therefore preserves specialization. Each concrete call is inferred with
fresh variables; one importer's selection cannot constrain another's.

After a module has been checked, imported specialization uses its immutable
specialization capsule rather than the module's live inference environment. The
capsule contains closed lexical schemes and its deterministic compile-time
environment; mutable inference variables and pending constraints never cross the
module boundary. A module parameter is not cached: each module application
captures and types the concrete argument it received. Unchanged loader revisions
may reuse a capsule across root checks, while a source, include, transitive
dependency, or generative effect-identity change replaces it.

A recursive function is typed the same way. Its body names the binding being
defined, which is not a capture: the name is bound to a placeholder and the body
constrained against it. A `const` that _is_ a recursive group is still typed
with its group, whose names enter scope together; what this covers is a
recursive function that arrived as a value, selected by a compile-time
conditional or returned from a compile-time function. Functions captured
alongside it are typed the same way, so a local helper in scope does not prevent
it.

A `const` may appear inside a function and still means compile time. Generic
checking may defer its evaluation until a specialization supplies concrete
compile-time arguments, but the declaration never becomes an ordinary runtime
`let`. If the specialization still needs unresolved runtime data to evaluate the
`const`, compilation fails at that declaration. A `const` also may not capture a
runtime `let`; bind the dependency with `const`, or make the dependent binding a
`let`.

A mismatch in a binding pattern is an error. Repeating `let` or `const`
explicitly shadows the earlier binding and may change its type:

```blot
let value = 1
let value = "now text"
```

### 4.2 Declaration tags

One or more compile-time descriptors may transform a `let` or `const` value:

```blot
@[derive(add_accessors)]
const Point = struct { .x = I32; .y = I32; }

@[test]
let point_origin = fn () => expect (True, "origin")
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
let value = source
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
sig name = type_value
let name = value
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
name := value
```

`:=` is immutable shadowing, not assignment. It advances a lexical binding
lineage, so its target must have been introduced by a binder in the current
**rebinding frame**. A module or closure owns a frame; an explicit `do` value
and each value-producing `case` arm own a new frame as well. Statement control
flow (`if`, `if let`, and `for`) keeps the surrounding frame, which is why its
`:=` rebindings can be merged or threaded deterministically.

A captured binding from an enclosing frame may be read but cannot be advanced.
Start a local lineage explicitly when that is what is intended:

```blot
let x = x
x := update x
```

Function parameters, `let`/`const` bindings, named `<-` bindings, loop binders,
and successful `if let` binders introduce names in their frame. `open` does not
start a rebinding lineage; use `let` first when an opened name should be
rebound. In a curried function every arrow is a closure boundary, so an inner
closure must likewise start a local lineage before rebinding an outer parameter.

The old and new types must constrain each other after singleton integer and text
literals are widened to their stable domains. The previous polymorphic scheme is
retained. Use another `let` or `const` to shadow a name with a different type.

Only a single name may appear to the left of `:=`. A `:=` in a `for` body also
defines one of that loop's accumulator fields, including one written inside a
statement conditional in that body. A `:=` inside a nested `for` defines a field
of the inner loop instead.

### 4.5 Effect sequencing

```blot
name <- expression
<- expression
```

This is the only declaration form that admits an effectful expression. It binds
one name, not a pattern, and executes the effect value on its right. The leading
form discards the result and is exactly equivalent to `_ <- expression`; it is
sequencing syntax, not a prefix operator. The formatter uses the leading form as
the canonical spelling.

An effect value has the erased representation `Unit -> A ~ E`. Sequencing it
supplies `()` and binds the resulting `A`, so it can be constructed, retained,
and executed later:

```blot
const Clock = @effect { .now = Unit -> Int; }
let effect = Clock.now
time <- effect
```

An already-applied expression that performs while it is evaluated remains valid
on the right of `<-`; its result is bound directly. A projected nullary
operation is itself an effect value, so `time <- Clock.now` and
`time <- Clock.now ()` have the same result and effect row.

`let`, `const`, `:=`, `open`, function results written without a block, and
module results are pure value positions. The expression in `return value` is a
tail computation of its current module or explicit indentation scope and may
contribute effects to the enclosing function. Pure `let` bindings may be
reordered, inlined, or discarded when their values are not demanded; sequencing
an effect before the tail therefore requires `<-` even when its result is
ignored.

### 4.6 Components are ordinary functions

Blot has no element syntax. A component is an ordinary function over ordinary
values, conventionally a property record followed by an array of nullary child
computations:

```blot
let component = fn properties => fn children =>
  for child in Iter.items children:
    <- child

  return properties
```

Children are suspended explicitly with nullary functions when suspension is
wanted. Construction, storage, reordering, and execution then use the same
function, record, array, and effect rules as the rest of the language:

```blot
let label = fn () =>
  <- text "Count: "

let button = fn () =>
  <- Button { .label = "Save"; .disabled = (); } []

let view = fn () =>
  <- div { .class = "counter"; } [label, button]
```

There is no special closed property-row rule, implicit child suspension,
renderer namespace, or backend representation. A component that wants a closed
configuration can encode that policy in its ordinary API; record calls otherwise
keep structural width subtyping. `examples/elements.blot` retains its historical
name as the corpus comparison for this element-free spelling.

### 4.7 Opening a record

```blot
open record
```

The opened value must be a compile-time record. Every field enters scope under
its existing name. Opening introduces ordinary lexical bindings and can shadow
bindings from an outer scope.

Selective binding and renaming use an ordinary record pattern, which leaves
unlisted fields out of scope:

```blot
const { .source = target; .value; } = record
```

### 4.8 Explicit blocks and return

```blot
let value = do:
  let local = 1
  return local

return value

return
  value
```

`do:` introduces a lexical scope whose ordinary fallthrough value is `()`. A
`return` inside it supplies the block value. The value may follow `return` on
the same line or in an indented continuation. `return` exits the nearest
enclosing module or explicit `do` block with that value. Statement conditionals
and `for` bodies do not establish return scopes, so a return crosses them. A
`case` expression is a separate result scope and does not inherit that
surrounding target. Its branches are values, so an indented branch may contain
statements; a return in that block supplies the branch, and therefore the
expression, rather than escaping farther.

## 5. Patterns

Patterns occur in bindings, lambda parameters, case arms, `for` binders, module
parameters, and `if let` guards.

| pattern                    | meaning                                       |
| -------------------------- | --------------------------------------------- |
| `name`                     | bind any value                                |
| `_`                        | match any value without binding               |
| `#(name)`                  | match the scalar value of an existing binding |
| `42`, `-1`, `"text"`, `()` | match that literal                            |
| `(left, right)`            | match a tuple of exactly that arity           |
| `[first, second]`          | match an array of exactly that length         |
| `#Ready`                   | match a constructor without a payload         |
| `#Some value`              | match a constructor and its payload           |
| `{ .x; .y = renamed; }`    | match required fields of a record             |

A shape pattern is width-subtyping: additional fields in the value are
permitted. `.x;` is shorthand for `.x = x;`. Tuple and array patterns require
exact arity or length.

`_` lexes as an ordinary lower-case identifier and is reclassified as a wildcard
during lowering.

`#(name)` is a pinned-value pattern. It reads the binding already in lexical
scope, compares the matched value with it, and binds nothing; in particular, it
does not shadow `name`. Pins currently admit bindings known to be `Int` or `Str`
at the pattern, the two scalar domains with exact equality in every execution. A
structural value still needs a structural pattern. A pin is refutable and never
contributes to exhaustiveness, even when the binding was initialized from a
literal, so a case normally needs another arm:

```blot
let wanted = 1
let label = case actual of
  #(wanted) => "wanted"
  _ => "other"
```

A direct `for` binder is the one exception: it is parsed as an expression and
reclassified after `in`, and a pin is not an expression.

### 5.1 Ownership qualifiers

A name pattern may carry:

| qualifier | obligation                                 |
| --------- | ------------------------------------------ |
| `!name`   | linear: consume exactly once when demanded |
| `?name`   | affine: consume at most once               |
| `&name`   | borrowed: may be read, not moved           |

Qualifiers may appear recursively inside tuple, array, constructor, and shape
patterns.

## 6. Values and expressions

Demanded expressions are evaluated strictly and left-to-right. Function position
is evaluated before its argument; collection and record members are evaluated in
source order. Before a block runs, lexical liveness removes unused pure
definitions. Every remaining pure declaration evaluates exactly once in source
order before the block result; Blot does not force it at first use and does not
allocate a run-time thunk. `<-` declarations are always live and retain source
order. Reordering a live definition is valid only when its trap and divergence
behavior is proved unchanged.

Typed Core retains a live host-effect capability when runtime code refers to it.
Other compile-time constants are specialized at their uses; Core never leaves an
ordinary variable for a host capability whose definition it removed.

### 6.1 Unit, arrays, tuples, and shapes

`()` is the unit value.

Arrays are ordered homogeneous collections:

```blot
[first, second, ...rest]
```

An array spread must evaluate to an array. Arrays are immutable; `@array.set`
and `@array.push` return new arrays.

`Arena` is the prelude convention for finite recursive data and graphs. It uses
a homogeneous array as a scratch arena and stable `Int` indices as addresses.
`Arena.singleton value` creates address zero, `Arena.insert (?arena, value)`
returns `(arena, address)`, and `Arena.get (arena, address)` returns `#Some` or
`#None`. Programs conventionally reserve address zero as a sentinel. The arena
is an ordinary array: its node type remains statically checked, and no pointer
or unchecked lifetime enters the source language.

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

An optional field is written `.name? = T`. It is surface syntax for
`.name = @type.union T ()`, conventionally written `.name = T | ()`; reflection
and inference therefore see an ordinary field whose value admits `Unit`, not a
second kind of record member.

When a record flows into an expected record type, an omitted field is supplied
as `()` only when that expected field explicitly contains `Unit`, either as `()`
itself or as a member of a union. Other missing fields are type errors. The
reference evaluator materializes the unit field at the call boundary. An exact
`Unit` field remains `Unit` in Core. Core uses a private absent/present sum so
`T | ()` has one HM representation; that sum is not source syntax and does not
cross the Wasm ABI.

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
operand. A lambda used as an entry in a parenthesized argument tuple needs no
second pair of parentheses around itself: the tuple's comma or closing delimiter
already marks its boundary, and the formatter removes a grouping used only for
that purpose.

The `=>` token is reserved for lambda parameters and case arms. A lambda written
without `fn` is therefore a syntax error rather than an operator chain.

A parameter written `~name` is deferred: the caller suspends the argument
expression and it is evaluated only where the body reads the name.

```blot
let unless = fn condition => fn ~fallback => case condition of
  #True => 0
  #False => fallback
```

Deferral is a property of the arrow, not of the call. `~A -> B` is the type of a
function whose parameter is deferred, `@type.defer` is the primitive the prefix
names, and the two arrows are unrelated: a strict function does not satisfy a
deferred signature and a deferred one does not satisfy a strict signature, in a
`sig`, at an application, and under `refines` alike. `~` is read as a prefix
here and as the row separator after a `->` in §12.4; the grammar position
decides which, and neither form can appear where the other is meant.

A deferred argument must be pure, and its parameter may be read at most once —
reading it twice is `BLOT_DEFERRED_DEMANDED_TWICE`, and forcing it once into an
ordinary `let` is how a program uses the value more than once.

Deferral is settled while compiling. A call that survives into the emitted
program is `BLOT_DEFERRED_AT_RUNTIME`, because WebAssembly has no representation
for a suspension and would run an argument the evaluator never demanded — the
two executions would then disagree about a program that traps.

### 6.4 Blocks

```blot
let result =
  declarations
  return value
```

Indentation after `=`, `=>`, `<-`, `of`, or a colon opens a suite. `do:` is the
explicit value-producing statement scope. A block evaluates its statements in a
nested scope. Falling through returns `()`; `return value` exits that block with
`value`. It may leave from a nested statement conditional, guard, or loop. The
block is the nearest return scope.

A bare trailing expression is not permitted. The explicit `return` keeps a
result beginning with a name distinct from `name := value`, and it keeps every
value that leaves a scope spelled one way, so a branch boundary stays visible
where its result is short.

### 6.5 Recursion

`rec` is a prefix form that is valid only as the value of a binding to one name:

```blot
const factorial = rec (fn n => if n < 2:
  return 1
else:
  return n * factorial (n - 1)
)
```

The bound name is visible inside the lambda body. `rec` applied outside such a
binding, applied to a non-lambda, or bound through a compound pattern is an
error.

A run of adjacent `rec` bindings of the same kind is one **recursive group**,
and every name the run binds is in scope in every member's body:

```blot
let is_even = rec (fn n => if n == 0:
  return True
else:
  return is_odd (n - 1)
)
let is_odd = rec (fn n => if n == 0:
  return False
else:
  return is_even (n - 1)
)
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

### 6.6 Compile-time blocks

```blot
const fields = compdo:
  let reflected = reflect T
  return field_names reflected
```

`compdo:` has the same statement and `return` rules as `do:`, but the complete
block must resolve in the compile-time phase. It may use ordinary `let`,
`const`, `if`, `case`, `for`, `:=`, and `return`; a demanded value that still
depends on unresolved runtime data is a staging error rather than residual code.
Lowering uses the existing internal compile-time expression form, so the
evaluator and backend gain no second block representation.

A single expression normally needs no block:
`const fields = field_names
(reflect T)` already carries the same must-resolve
obligation. Function-local `const` declarations follow that rule as well:
specialization may make a parameter compile-time-known, but an unresolved value
never silently becomes a runtime binding.

Compile-time and runtime evaluation otherwise use the same language semantics.
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
}
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
| 30    | `==` `!=` `<` `<=` `>` `>=` | non-associative | `Eq.*`, `Ord.*`                 |
| 40    | `\|` `\`                    | left            | `Type.union`, `Type.diff`       |
| 45    | `&`                         | left            | `Type.intersect`                |
| 50    | `<+`                        | left            | `attach`                        |
| 55    | `<>`                        | right           | `Text.append`                   |
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

### 8.1 Boolean value selection

Boolean value selection uses an ordinary exhaustive `case`:

```blot
let label = case ready of
  #True => "ready"
  #False => "waiting"
```

The two arms normalize to the checker's internal conditional representation, so
branch refinement remains shared with standalone control flow. This is surface
normalization rather than a second Boolean semantics. There is no truthiness.

### 8.2 Statement `if`

```blot
if condition:
  statements
else if other:
  statements
else:
  statements
```

A statement conditional's `else` is optional. Its branches are lexical binding
scopes but not return or loop boundaries, so `return` and `break` retain their
surrounding targets.

A branch is a scope for `let` but not for `:=`. A name a branch rebinds with
`:=` is rebound for the statements that follow the conditional: the name was
already in scope and keeps its type, so every path agrees on what it holds —
including a missing `else`, which passes the name through unchanged. A `let`
inside a branch stays local to that branch, shadowing any outer binding of that
name for the rest of the branch and escaping with nothing.

The suite ends at the first dedent. `else` aligns with its `if`.

### 8.3 Deconstructing guard

```blot
if let #Some value = candidate else:
  return fallback

// value is in scope here
```

On a successful match, the pattern's names are in scope for all following
statements in the surrounding body. On failure, the `else` statements run. That
path must leave through `return` or `break`; allowing it to continue would leave
the pattern names unbound.

The guard is a `case` with a wildcard alternative, so it types its names the
same way one does: `value` above has the type the matched constructor carries,
and the guard leaves the rest of the constructor set open.

This form has no success suite because success continues after the guard.

### 8.4 `case`

```blot
case value of
  #None => fallback
  #Some inner => inner
```

The target is evaluated once. Arms are tested from left to right, each in a
scope containing its pattern bindings. The first matching arm supplies the case
value.

When the target's type is known, the union of the arm patterns must cover it. A
wildcard or name pattern is irrefutable. A pinned pattern is not: the binding
names the value to test, not all other values of its type. Reaching runtime
without a matching arm is an error.

Coverage over a constructor set and coverage over a literal set are the same
requirement read on the two kinds of set a type can be. A constructor set is
covered by subtyping: the arms name a variant, and the target must flow into it.
A literal set is covered by membership instead, because the arms are literals
rather than a type the target could be constrained to — so the members the arms
do not name are reported, and the target's own type is left alone.

```blot
sig rank = 1 | 2 | 3 -> Int
let rank = fn level => case level of
  1 => 100
  2 => 200
```

is refused: `3` is a member of the target's type that no arm covers. Adding a
`3` arm, or any irrefutable arm, accepts it.

A target whose type is not an explicitly enumerable set — `Int`, `Str`, or any
range with an open end — cannot be exhausted by listed literal arms. Such a
`case` is refused rather than accepted in silence:

```blot
sig describe = Int -> Str
let describe = fn n => case n of
  1 => "one"
  2 => "two"
// BLOT_INCOMPLETE_CASE: `Int` has more values than these arms can cover.
```

The choice is to narrow the target's type, add the missing arms, or write an
irrefutable arm. `@panic` is how that arm says why reaching it is impossible:

```blot
let describe = fn n => case n of
  1 => "one"
  2 => "two"
  _ => @panic "callers are checked against `1 | 2` upstream"
```

`@panic` takes a text and returns the empty type, so it may stand where any
value is expected. It is not a caught failure: reaching it stops the program. It
survives to WebAssembly as an explicit fault carrying that text, which is what
distinguishes it from the arms the compiler proves unreachable: coverage is
checked, so a `case` with no matching arm is a path the checker ruled out, and
the emitted module marks it as unreachable rather than as a fault a program can
hit.

A target whose type inference has not pinned cannot prove coverage. Literal arms
do not narrow an unconstrained parameter to the literals they happen to name;
instead, the `case` requires an irrefutable arm or a finite declared target
type.

An arm's pattern types the names the arm binds: what the target carries for a
constructor flows into that arm's payload pattern. An irrefutable arm leaves the
constructor set open rather than unknown — the named arms still say what their
payloads carry, so

```blot
let unwrap_or = fn m => case m of
  #Some inner => inner
  _ => "none"
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
  (#Some a, #Some b) => a + b
  (#Some a, #None) => a
  _ => 0
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
sig join = (Option Int, Option Int) -> Int
let join = fn pair => case pair of
  (#Some a, #Some b) => a + b
  (#Some a, #None) => a
  (#None, #Some b) => b
  (#None, #None) => 0
```

is total with no irrefutable arm at all, and dropping its last arm is refused
with `` No arm covers `(#None, #None)` ``.

The `sig` supplies the finite domains there. Without it, a column the checker
cannot enumerate must be covered by an irrefutable pattern. No checked closed
`case` retains a path to `BLOT_NO_MATCH`.

Each column is covered on its own terms. A column whose type is a constructor
set must have every constructor named in it, and the arms are what close a
column no `sig` declared: a column naming `#Some` and `#None` makes the
scrutinee's column that union, so a target declared wider is refused there. A
column whose type has more values than arms can list — `Int`, `F64`, an opaque
type, a shape — can only be covered by an irrefutable pattern in that column, so

```blot
sig pick = (Int, Option Int) -> Int
let pick = fn pair => case pair of
  (1, #Some a) => a
  (_, #None) => 0
```

is refused with `` No arm covers `(_, #Some)` ``: the first arm cannot help with
an integer other than `1`, and the arm that can does not name `#Some`.

Nested tuples and constructor payloads are columns like any other, and are read
the same way when a `sig` says what they hold. Where nothing does, an inner
column carries no requirement — only a column of the scrutinee's own tuple is
closed by its arms.

`case` is a separate result scope. An indented arm block's `return` supplies the
selected arm and therefore the case result; `break` cannot escape an arm to
reach an enclosing loop.

An effectful `case` remains a value expression. Select the effectful branch and
sequence the selected expression once at the surrounding scope:

```blot
<- case choice of
  1 => first_effect ()
  _ => other_effect ()
```

An arm may carry a **guard**, which is a refinement no pattern states:

```blot
case n of
  0 => "zero"
  m if m > 0 => "positive"
  _ => "negative"
```

`pattern if condition => body` is taken when the pattern matches _and_ the
condition holds. The condition is an ordinary expression of type `Bool`, in the
arm's own scope, so it reads what the pattern bound. A guard that does not hold
falls through to the arms below, which is what a nested `if` inside the arm
cannot do: the arms keep the order they are written in, so

```blot
case n of
  5 => "five"
  m if m > 0 => "positive"
  _ => "other"
```

answers `"five"` for 5 even though the guard below would hold.

The statement form writes the same guard before `=>` and an indented block; a
false guard falls through before any statement in that arm runs.

**A guarded arm does not count towards coverage.** Its guard may be false, so it
can never be the arm that is guaranteed to match, and the arms that remain must
cover the target on their own. Every rule above then applies unchanged to those
arms:

```blot
let describe = fn option => case option of
  #Some n if n > 0 => "positive"
  #None => "none"
return describe (#Some 1)
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
sig name = 1 | 2 | 3 -> Str
let name = fn n =>
  if n == 1:
    return case n of
      1 => "one"
  else:
    return case n of
      2 => "two"
      3 => "three"
```

`n` is `1` in the first branch and `2 | 3` in the `else`, so both `case`
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
`@array.len xs`. Inference records that value relationship in the refinement
context rather than in the integer's type:

```blot
sig at = [Int] -> Int -> Int
let at = fn xs => fn n =>
  if n >= 0:
    if n < @array.len xs:
      return @array.get xs n
    else:
      return 0
  else:
    return 0
```

The inner branch retains `n : Int` and records `n < length(identity(xs))`;
inside both branches it additionally records `0 <= n`. An array's type carries
no length (§13.3), and neither does the integer type. These propositions live
only in `Phi`, the refinement context consumed by proof-required operations.

A length is keyed to the immutable array value a binding denotes. blot has no
assignment and arrays are immutable, so that identity denotes one length for its
whole lifetime. Every consequence follows from that key.

- `:=` binds a new occurrence, so a length proved before it says nothing after
  it unless the new value is an alias of the old one.
- An immutable alias keeps the identity. After `let ys = xs;`, a comparison
  against `@array.len xs` may prove a direct access through `ys`.
- A measured length may itself be bound. `let length = @array.len xs;` keeps the
  relationship, as do aliases of `length` and affine shifts by an integer
  literal such as `length - 1`. Arbitrary arithmetic widens back to `Int`.
- Two arrays are never related. `len xs` and `len ys` are not compared, ordered,
  or solved against one another merely because their array types agree.
- The one thing assumed about a length nobody measured is
  `0 <= len xs <= 2147483647`, because an array's length is a 32-bit count. It
  is what lets `n >= 0` and `n < @array.len xs` compose: without it, `0` and
  `len xs` could not be ordered and the second comparison would prove nothing.

Literal narrowing may give a branch a smaller ordinary value type. Relational
narrowing never changes a program's type: it adds propositions to `Phi`, so a
function's published signature remains independent of the values it relates.

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
- **A length reached by an unstable expression.** `@array.len box.values`,
  `@array.len (f ())`, and the prelude's `Array.length xs` name no stable value
  identity, so there is no symbol to compare against. The primitive applied to a
  name, or a binding that retained such a measurement, is a witness.
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
- **Constructors.** `if flag:` does not prove `flag : #True`. A `variant`
  carries its constructors and whether the set is open, so "those others, minus
  `#A`" is unrepresentable, and a narrowed constructor set would also disagree
  with the set recorded for the backend.
- **An empty result.** A condition no value satisfies makes the branch
  unreachable. The branch keeps the wider type rather than being given the empty
  one; the type checker does not report that fact. The editor linter separately
  reports a `case` arm made unreachable by an earlier syntactically covering
  arm, which needs no inferred empty type.

A proof is a shadow of the name, so it lasts as long as the name does. Rebinding
the name inside the branch with `:=` replaces it under the ordinary rule (§4.4)
— the stable type, not the proved one — and the proof does not survive.

## 9. Iteration

`for` is a declaration, not an expression.

```blot
for iterator:
  statements

for pattern in iterator:
  statements
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
break
```

`break` exits the nearest `for` with its accumulator as it exists at that point.
It may appear inside statement conditionals and guards. It cannot cross a lambda
or a value-producing `case`, and using it without an enclosing `for` is an
error.

`break` never carries a value. `return value` is the scoped value exit specified
in §§4.8 and 6.4; inside a loop it crosses the repeated statement body and exits
the nearest enclosing module or explicit block.

An unbounded loop is ordinary iteration over the prelude's infinite iterator:

```blot
for ever:
  if finished:
    break
```

`ever` is not syntax or a compiler special case. It must be explicitly brought
into scope like every other prelude value.

There is no `continue` form.

### 9.2 Proof-producing iteration

`Iter.indexed values` has the ordinary iterator shape and yields
`(index, value)` pairs. Its implementation is `@array.indexed`, because source
code cannot manufacture proof authority. In the successful `.step` result the
checker carries an erased relationship package proving
`0 <= index < @array.len values` and that `value` is the selected element.
Pattern matching and tuple projection propagate the package into the loop body,
where the index may be reused by `@array.get` or `@array.set` without another
run-time bounds decision.

The `for` lowering does not recognize `Iter.indexed`, `.step`, or any lexical
name. It remains the generic iterator fold described above. The proof comes from
the primitive value and follows ordinary aliases and pattern bindings; a source
record with the same fields carries no authority.

An immutable field path derives its identity from its parent value and field
name. A comparison against `@array.len box.values` therefore proves access to
that same `box.values`, including through an immutable alias. It proves nothing
about `box.other`; rebinding the parent mints another identity and invalidates
the previous relationship.

## 10. Types and inference

Types are compile-time values in the same value domain as runtime data. There is
no type declaration syntax and no separate type expression grammar.

Examples:

```blot
const Bit = 0 | 1
const Message = #Ready | #Failed Str
const Point = { .x = I32; .y = I32; }
const Meter = seal ("Meter", I32)
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

| display                     | meaning                          |
| --------------------------- | -------------------------------- |
| `Int`, `Str`, `1`, `"x"`    | ranges and singleton ranges      |
| `0..9`, `0..`               | bounded and half-bounded ranges  |
| `{ .x = Int; }`             | structural record                |
| `[Int]`                     | homogeneous array                |
| `#None \| #Some Int`        | constructor variant              |
| `#Some Int \| ..`           | variant with an open set         |
| `A -> B`                    | pure function                    |
| `A -> B ~ { Console, ..e }` | function with an open effect row |
| `~A -> B`                   | deferred parameter (§6.3)        |
| `'a`, `'b`                  | inferred type variables          |
| `forall 'q0. ...`           | explicit quantified type         |
| `⊤`, `⊥`                    | top and bottom                   |

Array lengths and affine relations are not display types. Diagnostics that need
to explain a failed proof render propositions such as `index < length(values)`
directly from `Phi`; a `sig` cannot name them.

An effect row is the one piece of this notation that is also source:
`A -> B ~ { Console }` is a closed row, while `A -> B ~ { Console, ..e }` names
the rest of the row inside a `sig` (§12.4). The checker prints inferred open
rows with the same `..e` notation.

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

The prelude's `bit_width` reads the transparent width metadata attached by `I`
and `U`. A plain `range` makes no storage-width promise and has no width for
this function to return. `packed shape` applies `bit_width` to every field in
declaration order and returns a compile-time layout descriptor:

```blot
packed {
  .red = U 8;
  .green = U 8;
  .mode = U 2;
}
```

The result has `.order`, `.bit_size`, `.byte_size`, `.trailing_bits`, `.fields`,
and `.bit_offset`. Each field reports `.name`, `.bit_offset`, `.bit_width`, and
an unshifted `.mask`; the example occupies 18 meaningful bits and three bytes,
with six unused bits at the end. `packed` is ordinary prelude source over
reflection and `layout`. It describes storage and does not change the positional
tuple returned by `struct`, the runtime representation of an integer, or the
Core Wasm ABI.

A namespace member is a compile-time value, and projecting one is typed by that
value rather than by the field rule. A member that is itself a type projects to
that type. A member that is a function has no arrow to read off it and projects
to `⊤`. Calling one is typed by evaluating the whole application at compile
time, and the value produced is the result type. The arguments must therefore be
values the checker can compute: a literal, a `const`, or a binding whose value
it already computed to type an earlier member call. A call it cannot evaluate
has result type `⊤`, so nothing can be done with the result and no `sig` is
satisfied by it.

The same application rule specializes a callable field of an ordinary record
whose value is known at compile time. Unlike an attached namespace, that record
also has an ordinary structural type. Consequently an unevaluable call falls
back to its inferred arrow rather than becoming `⊤`. This remains true when the
record is reached through a namespace member: `World.Position.insert entity`
types `Position` as the attached record and `insert` as its ordinary callable
field. Compile-time projection follows the whole chain; it does not force games
to bind each intermediate record before using it.

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
- anything about a namespace member call whose arguments are not compile-time
  values (§10.2);
- the fields a spread carries through from an operand whose own fields are not
  known where the spread is written (§6); or
- impredicative instantiation.

Rank-N types are explicit and predicative through `@forall`. Higher-kinded
abstraction is compile-time function application rather than a kind system.

There is no record row variable, and there is not going to be one; the reasoning
