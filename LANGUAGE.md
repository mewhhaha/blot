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
- a validated Runtime HIR path through the Rust/WebAssembly emitter, with the
  GPU pipeline retained only as an explicit conformance check.

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
module with import
let const return use
if else case of rec open
for in break do fn
```

Reserved words and capitalized names remain valid field names: `.return`,
`.use`, `.else`, `.Int`, and `.0` are all ordinary projections.

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

`F64.cmp` refuses NaN rather than answering, because no ordering accepts it: a
diagnostic while compiling and a trap while running, the two shapes `@int.div`
by zero already takes. There is no float equality. Exact comparison is
`is_equal (F64.cmp a b)` — the same test with the NaN case left in, rather than
an equality that answers `#False` to a question the format says has no answer.
`F64.is_nan` is how a program asks first, and it is a primitive because
comparing is precisely what refuses.

`F32` is the narrower float, and a distinct type rather than a precision `F64`
sometimes has. There is no f32 literal — the grammar has one float token, and
`F32.of_float` is what makes the narrowing a step the program takes rather than
one performed on it. `F32.widen` goes back, exactly, because every `F32` is an
`F64`.

`F32x4`, `I32x4`, `I16x8`, and `I8x16` are 128-bit SIMD values. Their lane width
and count are part of the type; none is a tuple or record that can be projected
structurally. `F32x4`, `I32x4`, `I16x8`, and `I8x16` are the prelude namespaces
for their operations. The emitted `wasm-simd128` artifact uses native vector
instructions. An independent conformance oracle may implement an integer vector
lane by lane, but it must produce the same value.

Integer lane arithmetic wraps modulo (2^{32}), (2^{16}), or (2^8). Shift amounts
are reduced modulo the lane width. Operations whose interpretation matters say
`signed` or `unsigned` in their name; the bits in the vector do not otherwise
carry signedness. Checked constructors accept `I32`, `I16`, or `I8` as
appropriate and preserve the integer they receive. The explicitly named
`of_wrapping`, `splat_wrapping`, and `with_*_wrapping` operations accept `Int`
and reduce it modulo the lane width. Arithmetic is inherently wrapping.
`I32x4.of` constructs four lanes and its named projections and replacements are
`x`, `y`, `z`, `w` and `with_x`, `with_y`, `with_z`, `with_w`. The narrower
namespaces currently construct only with `splat`.

`F32x4` is opaque rather than ordered. `Int`, `Text`, `F64`, and `F32` are
ranges over an ordered domain; four lanes are not an interval, so there is no
bound to narrow against and no literal that names one. The only fact about the
type is its name: `F32x4` matches `F32x4` and nothing else, `@type.reflect`
reports it as `#Opaque` (§13.4), and `Reflect.refines` therefore answers
`#False` for it, having nothing to compare.

Lane comparisons produce separate opaque `F32x4Mask`, `I32x4Mask`, `I16x8Mask`,
and `I8x16Mask` types. A mask is accepted only by the matching vector namespace.
Every namespace provides `all` and `any` reductions to `Bool`; integer
`mask_bits` additionally returns bit (i) for lane (i). Masks have no lane
projection or module-boundary layout. `F32x4.shuffle` selects four constant
lanes from two vectors; `F32x4.swizzle` is the one-vector spelling. Lane
selectors are integers in `0..7` for shuffle and `0..3` for swizzle, and must be
known while compiling so they can become the instruction immediate.

`I32x4.lane vector selector` selects a lane whose integer selector is in `0..3`
and known at compile time. A singleton integer type alone is insufficient: the
selector must be a literal or a `const` value so lowering receives an immediate
certificate. The named `x`, `y`, `z`, and `w` operations remain the shortest
spelling for fixed positions.

There is no implicit conversion between the numeric types, and no operator
serves more than one. An operator resolves to one binding by name (§4.7), so a
`+` over both would have to dispatch on a value's type at run time. `F64.of_int`
and `F64.truncate` cross explicitly; `truncate` rounds toward zero.

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
lowering folds that chain using the fixed table in §7. Operator vocabulary is
part of the language contract rather than mutable module state.

## 3. Programs and modules

A file has this order:

```blot
module with parameter    // optional

declarations
return result             // optional
```

The `module` header, when present, must be first. Zero or more declarations
follow. The removed `operators` header is still recognized only so the compiler
can report `BLOT_REMOVED_OPERATOR_SECTION`; it never changes accepted syntax.

A module is an implicit `do` computation from an optional input to one result.
Its declarations execute in source order. `return value` exits the module with
that value, exactly as it exits an explicit `do` scope; reaching the end returns
unit. A returned record is the ordinary convention for a named module API. There
is no export declaration, live export binding, or separate module namespace.

`module with pattern` binds an explicit input. A file without that header
receives unit and does not name it. The implementation may represent a module as
a unary closure internally, but that closure is not a source value.

```blot
let library = import "./library.blot"
let configured = import "./configured.blot" with capabilities
```

`import "specifier"` instantiates the named module with unit and evaluates to
its returned value. `import "specifier" with value` instantiates it with the
explicit input. The specifier must be literal text. Relative paths are resolved
from the importing file. A `blot:name` specifier resolves to the corresponding
compiler-supplied library module; `blot:prelude` is the standard prelude. A bare
package specifier resolves through the nearest
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
input. The entry module's input is therefore its complete host authority.

An evaluated import occurrence creates one module instance and runs that
instance's top-level declarations once, in source order. Aliasing or returning
the resulting value through another module does not run it again. Two written
import occurrences denote two instances, even when their literal specifiers and
inputs are equal. A compiler may inline an instance, but it may not merge
distinct occurrences or replay one occurrence separately for several returned
fields.

An explicit import input is checked against the input demand inferred _inside_
that module. Nothing separately declares that requirement: the demand is
whatever its body reaches for. The importer's record must satisfy every field
the module projects off its input. A record missing one is `BLOT_TYPE_ERROR` at
the import expression, naming the field. A fresh variable in the input's place
would satisfy every argument, and the program would then read a field that is
not there. `examples/rejected/semantics/module_argument_missing_field.blot` is
the catalog entry.

The argument may carry _more_ fields than the module reads. Width subtyping
holds across the boundary in both directions: as the argument to a module, and
as an argument to a function that module returns. Such a program checks and
lowers — the record the importer built is what reaches the projection inside the
dependency, so the nominal the backend mints is the one the value has.
`examples/widened.blot` and `examples/lib/camera.blot` are the catalog entry.

Nothing, including the prelude, is implicitly in scope. The conventional prelude
opening is:

```blot
open import "blot:prelude"
```

At compilation, imported module bodies are specialized and inlined. This does
not alter module-instance identity or top-level execution order.

### 3.1 Development projects

A development project may assign reachable module roots to independently
reloadable units with a `blot-project` manifest:

```json
{
  "schema": "blot-project",
  "version": 1,
  "entryUnit": "game",
  "units": {
    "game": "./main.blot",
    "simulation": "./simulation.blot"
  }
}
```

Unit names begin with a lowercase letter and contain only lowercase letters,
digits, and `-`. Source paths are relative to and confined within the project
directory. Every unit root is unique and reachable from the entry root through
ordinary imports.

The manifest adds no source namespace or import form. Imports, inference,
staging, demand, effects, and ownership have their ordinary whole-program
meaning. The development compiler specializes demanded polymorphic functions at
their call sites, then turns a residual direct call whose definition belongs to
another configured root into a unit link. A closed first-order ABI value may
cross that link: unit, integers, floats, booleans, text, arrays, records,
variants, and seals. Functions, compiler-private storage or indirection,
continuations, and unresolved source effects cannot cross a reload boundary. The
development target refuses such a checked program rather than assigning it new
source semantics.

Each unit has independent runtime memory and module state. Activating a changed
unit creates a fresh instance, so its state resets. An unchanged unit retains
its existing instance. Values passed over a link are copied according to the
Core Wasm ABI; neither unit obtains an alias into the other's memory. A changed
link interface rebuilds its consumers. An implementation change behind an
unchanged interface replaces only the provider.

Development compilation and linking are an operational mode. `blot build`
continues to specialize and emit one whole-program production artifact.

### 3.2 Included files

`@include` makes a non-Blot file available to an ordinary compile-time Blot
function:

```blot
const as_raw = fn source => source.text
const shader = @include "./shaders/main.wgsl" as_raw
```

Schematically, for every result type `a`, its type is:

```blot
Text -> ({ .specifier = Text; .path = Text; .text = Text; } -> a) -> a
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
usual widened type recursively: text is `Text`, integers are `Int`, booleans are
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
exception is a recursive group (section 6.5): a run of adjacent `let rec` or
`const rec` bindings, whose names are all in scope in all of their bodies.

A name that is read before the block binds it is a scope error,
`BLOT_FORWARD_REFERENCE`, reported at the read. It is distinct from an unbound
name because the fix is different: the binding exists, and either it belongs
above the reader or the two belong in one recursive group.

Physical line breaks terminate declarations. A continuation may be indented, but
indentation opens a statement suite only after a suite introducer. The
introducers are `=`, `=>`, `<-`, `of`, and `:`. `do:` is the explicit
value-producing statement scope. A `const` binding, rather than a second block
keyword, requires its complete value to resolve at compile time. Parentheses
only group values or form tuples; they never introduce a statement suite. A
suite may use any indentation width, but every line at that depth must agree; a
dedent must return to an active suite width or to the introducer's width. Other
indentation is expression continuation and does not silently create a scope. A
closing delimiter does not select a suite width, so its indentation is ignored
and canonicalized by the formatter. The formatter writes the accepted structure
with two-space indentation and expands lines toward an 80-column limit. When a
binding, signature, or `return` line is too wide, its value moves as a whole to
the following line at one additional indentation level. That continuation does
not introduce a scope. A delimited value that is already multiline likewise
moves as a whole. A vertical delimiter indents its contents one level and closes
at the indentation of the expression that opened it; `<-` does not add another
delimiter level. The formatter writes a conditional vertically, giving each
branch a block whose explicit `return` supplies the value that branch
contributes. When the conditional is itself the terminal result of a scope, the
formatter omits the redundant outer `return` and lets those branch returns
target the scope directly. Arrays use one line when they fit within their value
scope and otherwise place one element on each line. A signature and its binding
have no empty line between them. Recursive-group members are likewise
contiguous, followed by one empty line when another declaration follows. After a
standalone `if` or `for` suite, or a multiline `case` arm, closes before another
statement or arm, the formatter writes one empty line to make the dedent
visible. It never separates an `else` from its `if`.

### 4.1 Runtime and compile-time bindings

```blot
let pattern = value
const pattern = value

let rec name = fn parameter => body
const rec name = fn parameter => body

let name :: type
let name = value

let rec name :: type
let rec name = fn parameter => body

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

`rec` is a binding modifier, not an expression operator. It appears immediately
after `let` or `const`, and the binding must name exactly one function. The old
expression-shaped spelling `let name = rec (fn ... )` is not accepted. Section
6.5 defines recursive groups and their lowering.

A signature header repeats the binding's complete header and replaces `=` with
`::`. It must be immediately followed by exactly that binding: `let` or `const`,
the presence of `rec`, and the name must all agree. A signature binds no value
and admits no declaration tags. Its type is an ordinary compile-time expression,
evaluated before the binding is checked.

A `const` takes its type from the value it evaluated to, not from the expression
that produced it. When that value is a function, its type is the type of the
lambda the evaluator selected. So a compile-time conditional over types is a
dispatch: each `const` bound from it is typed against the branch that ran, and
the branch that did not run contributes nothing to it.

```blot
const measuring = fn T => if refines (T, Text):
  return fn x => Text.length x
else:
  return fn x => x + 0

const measure_text = measuring Text   // Text -> Int, not joined with the other arm
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
path used to reach it. Aliasing or returning the function through another module
therefore preserves specialization. Each concrete call is inferred with fresh
variables; one importer's selection cannot constrain another's.

After a module has been checked, imported specialization uses its immutable
specialization capsule rather than the module's live inference environment. The
capsule contains closed lexical schemes and its deterministic compile-time
environment; mutable inference variables and pending constraints never cross the
module boundary. A module input is not cached: each import occurrence captures
and types the concrete input it received. Unchanged loader revisions may reuse a
capsule across root checks, while a source, include, transitive dependency, or
generative effect-identity change replaces it.

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
matched by the binding pattern and may have a different type. An adjacent
signature header constrains that final value. A `let` transform runs in the
binding's runtime phase and contributes its ordinary effects; a `const`
transform runs at compile time. Tags are not admitted on signature headers
because a signature binds no value.

Tags lower to ordinary descriptor bindings, function application, and a block. A
tagged `let rec` or `const rec` is first bound directly under its source name
inside that block, then transformed, so recursion gains no second evaluator,
typing, ownership, or backend rule.

Resolved tag names and metadata are available to compiler tools but are not part
of the runtime value or the Wasm ABI. `blot test` selects the semantic name
`"test"`, including aliases and descriptors built without the prelude. Each test
must be a named top-level binding usable as a pure `Unit -> Unit` function. Test
files have no explicit module input or ambient initializer effects. Every test
runs against a fresh evaluation of the declarations through its own binding,
failures do not stop later tests, imported modules contribute tests only when
passed directly to the command, and a run finding no tests fails. Normal
checking, evaluation, and building never execute tests.

### 4.3 Signatures

```blot
let name :: type_value
let name = value
```

A signature:

- names exactly one binding;
- must be immediately followed by a `let` or `const` of that name;
- must evaluate at compile time; and
- must evaluate to a value that can be interpreted as a type.

Within a signature value, `_` denotes a fresh inferred type for that occurrence.
The following binding constrains the hole exactly as it constrains an explicitly
written signature type. Separate `_` occurrences are independent, so a function
may leave only its parameter, only its result, or both for inference. A
signature hole is confined to that signature evaluation; it introduces neither a
value binding nor an implicit type namespace.

The binding's inferred type must be a subtype of the signature. A signature
constrains a binding; it does not introduce a name or evaluate at runtime.

A function type includes the effects it performs, so a signature for a binding
that performs names them: `Text -> Unit ~ { Console }` (§12.4). A bare `->` is
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

Function parameters, `let`/`const` bindings, names bound by `use pattern <-`,
loop binders, and successful `if let` binders introduce names in their frame.
`open` does not start a rebinding lineage; use `let` first when an opened name
should be rebound. In a curried function every arrow is a closure boundary, so
an inner closure must likewise start a local lineage before rebinding an outer
parameter.

The old and new types must constrain each other after singleton integer and text
literals are widened to their stable domains. The previous polymorphic scheme is
retained. Use another `let` or `const` to shadow a name with a different type.

Only a single name may appear to the left of `:=`. A `:=` in a `for` body
defines one of that loop's accumulator fields only when the target comes from
the enclosing scope, including when the rebinding is written inside a statement
conditional. A loop-pattern name or a name introduced in the body rebinds only
its iteration-local lineage. A `:=` inside a nested `for` belongs to the inner
loop instead.

### 4.5 Effect sequencing

```blot
use pattern <- expression
use expression
```

This is the only declaration form that admits an effectful expression. The form
with `<-` binds an ordinary binding pattern and executes the effect value on its
right exactly once. The pattern has the same matching and ownership rules as a
`let` pattern; a mismatch is an error, and every name it contains starts a local
rebinding lineage. Omitting the pattern and `<-` discards the result and is
exactly equivalent to `use _ <- expression`. The formatter uses `use expression`
as the canonical discard spelling.

```blot
use (status, body) <- Http.fetch request
use #Some value <- Cache.lookup key
```

An effect value has the erased representation `Unit -> A ~ E`. Sequencing it
supplies `()` and binds the resulting `A`, so it can be constructed, retained,
and executed later:

```blot
const Clock = @effect { .now = Unit -> Int; }
let effect = Clock.now
use time <- effect
```

An already-applied expression that performs while it is evaluated remains valid
on the right of `use pattern <-`; its result is bound directly. A projected
nullary operation is itself an effect value, so `use time <- Clock.now` and
`use time <- Clock.now ()` have the same result and effect row.

The result bound by `use pattern <-` is monomorphic. Later uses refine that one
runtime value, including the inferred result type of an entry-module capability;
an effectful computation is never generalized into a reusable polymorphic value.

`let`, `const`, `:=`, `open`, and function results written without a block are
pure value positions. The expression in `return value` is a tail computation of
its current module or explicit `do` scope and may contribute effects to that
scope. Pure `let` bindings may be reordered, inlined, or discarded when their
values are not demanded; sequencing an effect before the tail therefore requires
`use` even when its result is ignored.

### 4.6 Components are ordinary functions

Blot has no element syntax. A component is an ordinary function over ordinary
values, conventionally a property record followed by an array of nullary child
computations:

```blot
let component = fn properties => fn children =>
  for child in Iter.items children:
    use child

  return properties
```

Children are suspended explicitly with nullary functions when suspension is
wanted. Construction, storage, reordering, and execution then use the same
function, record, array, and effect rules as the rest of the language:

```blot
let label = fn () =>
  use text "Count: "

let button = fn () =>
  use Button { .label = "Save"; .disabled = (); } []

let view = fn () =>
  use div { .class = "counter"; } [label, button]
```

There is no special closed property-row rule, implicit child suspension,
renderer namespace, or backend representation. A component that wants a closed
configuration can encode that policy in its ordinary API; record calls otherwise
keep structural width subtyping. `examples/elements.blot` retains its historical
name as the corpus comparison for this element-free spelling.

### 4.7 Opening compile-time members

```blot
open value
```

The opened value must be a compile-time record or effect. Every record field, or
every operation of an effect, enters scope under its existing name. Opening an
effect creates immutable aliases of its operations; it does not create another
effect identity. Opening introduces ordinary lexical bindings and can shadow
bindings from an outer scope:

```blot
const Console = @effect { .write = Text -> Unit; }
open Console
use write "hello"
```

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
inputs, and `if let` guards.

| pattern                    | meaning                                       |
| -------------------------- | --------------------------------------------- |
| `name`                     | bind any value                                |
| `_`                        | match any value without binding               |
| `^name`                    | match the scalar value of an existing binding |
| `42`, `-1`, `"text"`, `()` | match that literal                            |
| `(left, right)`            | match a tuple of exactly that arity           |
| `[first, second]`          | match an array of exactly that length         |
| `#Ready`                   | match a constructor without a payload         |
| `#Some value`              | match a constructor and its payload           |
| `{ .x; .y = renamed; }`    | match required fields of a record             |

A shape pattern is width-subtyping: additional fields in the value are
permitted. `.x;` is shorthand for `.x = x;`. Tuple and array patterns require
exact arity or length.

`_` lexes as an ordinary lower-case identifier. It is reclassified as a wildcard
in a pattern and as an inference hole in a signature value (§4.3). It does not
denote a value in any other expression.

`^name` is a pinned-value pattern. It reads the binding already in lexical
scope, compares the matched value with it, and binds nothing; in particular, it
does not shadow `name`. Pins currently admit bindings known to be `Int` or
`Text` at the pattern, the two scalar domains with exact equality in every
execution. A structural value still needs a structural pattern. A pin is
refutable and never contributes to exhaustiveness, even when the binding was
initialized from a literal, so a case normally needs another arm:

```blot
let wanted = 1
let label = case actual of
  ^wanted => "wanted"
  _ => "other"
```

In `for case ^name in iterator`, the same refutable-pattern rule skips values
that do not equal the existing binding. An ordinary `for ^name in iterator` is
rejected because ordinary loop heads require irrefutable patterns.

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
allocate a run-time thunk. `use` declarations are always live and retain source
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

`[A]` means `Array A`: every position has the same element constraint `A`. It is
not a tuple, a fixed-length vector, a list of alternatives, or an array whose
length appears in its type. In an inferred type, `['a]` binds one homogeneous
element variable; each polymorphic call freshens it. In a type-value expression,
`[Int, Text]` computes `[Int | Text]`. The empty type-value array is `[bottom]`,
while an ordinary runtime `[]` begins with a fresh element variable and receives
its element constraint from use. In a recursive homogeneous accumulator, that
empty origin contributes no inhabitant alternative of its own: yielded or pushed
values constrain the same element variable. The array may still be empty at
runtime because array types do not encode cardinality.

`[]` and `@array.empty` denote the same allocation-free polymorphic empty array.
An empty array has no backing Store authority to consume, so it may be reused
without `freeze` or `Array.copy`. The first operation that introduces an element
constructs a fresh Store for that result; separate growths from the same empty
value therefore cannot alias mutable implementation storage.

An array spread must evaluate to an array. Arrays have immutable value
semantics: `@array.set` and `@array.push` return successor arrays and never make
an earlier source binding observe the change. Their implementation may update a
uniquely owned Store in place under §11.

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

A computed field is written `.[name] = value`, where `name` must resolve at
compile time to `Text`. The resolved text is the structural field name; it is
not restricted to identifier spelling. The value remains an ordinary runtime
expression. Duplicate checking happens after resolving computed names, so a
computed field cannot repeat another computed or explicit field. A name that
remains dynamic is `BLOT_DYNAMIC_SHAPE_FIELD`.

An exact spread may occur anywhere. One spread whose complete width is unknown
may instead be the first member of a shape. Its unknown fields are retained by
the compiler's record-update relationship, and later explicit or computed fields
replace or add named fields without reconstructing the base from only the fields
visible through width subtyping. A second open spread, or an open spread after
another member, is `BLOT_OPEN_RECORD_SPREAD`; concatenating two unknown rows has
no principal type in Blot's lattice.

`Shape.entries record` enumerates its statically known fields in insertion order
as `(name, value)` pairs. `Shape.update (record, patch)` is ordinary prelude
source: it checks at specialization that every patch field exists in `record`
and that the patch value refines the corresponding field type, then rebuilds the
record with computed fields. The result preserves the record's type. Use a
leading spread directly when constructing an extension with new fields.

```blot
let original :: { .name = Text; .count = Int; }
let original = { .name = "old"; .count = 3; }
let renamed = Shape.update (original, { .name = "new"; })
let identified = { ...original; .id = 7; }
```

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

Every lambda contains `fn`; its parameter is an ordinary binding pattern, so
qualifiers, tuples, shapes, arrays, and constructor patterns are admitted there.

A declaration may ask the compiler to validate its Store-update cost contract
with the ordinary `assert.reuse` tag:

```blot
@[assert.reuse]
const transform = fn values => body
```

The tag is an identity transform. It does not consume a parameter, change a
type, choose a specialization, or authorize an update. After ownership checking
and residual lowering, every `store.write` and `store.grow` in the asserted
function frame must already carry `owned-reuse`; otherwise compilation reports
`BLOT_REUSE_NOT_PROVED` at the tag. A separately materialized nested or
recursive function carries its own tag. The complete contract is
[`spec/REUSE.md`](spec/REUSE.md).

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

A lambda whose body is an explicit `do:` block has another visible boundary: the
block's layout dedent. Such a bounded lambda may therefore be the
unparenthesized right operand of an infix operator:

```blot
let incremented = call $ fn value => do:
  return value + 1
```

This is not a special calling rule for `$`. The parser admits the bounded lambda
where any infix right operand can occur, then ordinary fixity lowering resolves
the written operator. An expression-bodied lambda remains outside an operator
chain and needs grouping: `call $ (fn value => value + 1)`.

The `=>` token is reserved for lambda parameters and case arms. A lambda written
without `fn` is therefore a syntax error rather than an operator chain.

A parameter written `~name` is deferred: the callee, rather than the caller,
decides whether to evaluate the argument expression by reading the name. This is
affine call-by-name, not general laziness.

```blot
let unless = fn condition => fn ~fallback => case condition of
  #True => 0
  #False => fallback
```

Deferral is a property of the arrow, not of the call. `A ~> B` is the type of a
function whose parameter is deferred, and `@type.deferred_arrow` is the
primitive the operator names. The two arrows are unrelated: a strict function
does not satisfy a deferred signature and a deferred one does not satisfy a
strict signature, in a signature header, at an application, and under `refines`
alike. Both arrows associate to the right, so `Bool -> Int ~> Int` describes a
strict first parameter followed by a deferred second parameter.

A deferred parameter may be read at most once along one execution path. Reading
it once in each side of a runtime branch is valid because the sides are
exclusive. Reading it twice on one path is `BLOT_DEFERRED_DEMANDED_TWICE`;
forcing it once into an ordinary `let` is how a body reuses the resulting value.
The function's effect at a call includes the argument's possible effects even
when a branch skips them, so effect checking is conservative while execution is
conditional.

Handing an expression to a deferred parameter transfers any affine ownership
captured by that expression at the call. Skipping the expression may skip work
and allocation, but it does not return transferred authority to the caller. This
keeps ownership independent of demand and prevents a later use from depending on
which runtime branch the callee chose.

Known deferred calls are normalized during specialization. A demanded argument
is emitted in the branch that demands it, and an omitted argument emits no work.
Runtime HIR and Wasm therefore contain ordinary control flow and no suspension
or heap thunk. A deferred function that escapes known call sites into an opaque
runtime value or the public ABI is refused with `BLOT_DEFERRED_AT_RUNTIME`.

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

`rec` marks a `let` or `const` binding whose single name is visible inside its
function body:

```blot
const rec factorial = fn n => if n < 2:
  return 1
else:
  return n * factorial (n - 1)
```

The modifier is syntactically unavailable outside a binding. A recursive binding
of a non-lambda or through a compound pattern is an error. Making recursion a
binding property reflects its scope: the name is introduced early; the anonymous
function is otherwise an ordinary lambda value.

The former `name = rec (fn ... )` spelling is a hard syntax error. There is no
compatibility alias and the formatter does not rewrite legacy source, so a
parser success always identifies recursive declarations from their binding
header.

A run of adjacent `let rec` or `const rec` bindings of the same kind is one
**recursive group**, and every name the run binds is in scope in every member's
body:

```blot
let rec is_even = fn n => if n == 0:
  return True
else:
  return is_odd (n - 1)
let rec is_odd = fn n => if n == 0:
  return False
else:
  return is_even (n - 1)
```

A group of one is ordinary self-recursion, so this states the existing rule for
a run rather than adding a second rule beside it. Membership is adjacency, not
participation: a binding marked `rec` that calls nobody is still a member of the
run it sits in.

A run ends at any declaration that is not a `let rec` or `const rec` binding of
a lambda to one name, and at a change of kind. A `let rec` run and a `const rec`
run are therefore separate groups, because a `const` may not capture a `let`
(section 4.1) and the members of a group are bound together.

A signature header neither joins a run nor ends one. Because it must be
immediately followed by the binding it constrains, a header written inside a run
belongs to that member.

A tagged binding (section 4.2) is not a member and ends a run. A tag replaces
the binding's value with the transform applied to it, so what the binding holds
is no longer a recursive root.

The names entering scope together fixes the rest of the rule:

- A member must be a function. Every name in the group is in scope from the
  first member onward, but none holds a value until all of them are bound. A
  function body can wait for that and a value cannot, so a recursive non-lambda
  binding is refused.
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

### 6.6 Compile-time statement blocks

```blot
const fields = do:
  let reflected = reflect T
  return field_names reflected
```

`do:` always has the same statement and `return` rules. The surrounding `const`
binding requires the complete block to resolve in the compile-time phase. It may
use ordinary `let`, `const`, `if`, `case`, `for`, `:=`, and `return`; a demanded
value that still depends on unresolved runtime data is a staging error rather
than residual code. A `let value = do:` block remains a runtime value. There is
no block-specific phase expression in either semantic AST.

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

Blot has one fixed operator table. Programs cannot declare punctuation or alter
precedence. A target is still an ordinary qualified binding: using an operator
requires that target to be in scope, and the table does not implicitly import
the prelude.

Fixed operators, from loosest to tightest:

| level | spelling                    | associativity   | target                          |
| ----- | --------------------------- | --------------- | ------------------------------- |
| 10    | `$`                         | right           | `Fn.apply`                      |
| 20    | `\|>`                       | left            | `Fn.pipe`                       |
| 21    | `~`                         | left            | `@type.performs`                |
| 22    | `\|\|`                      | right           | `Logic.or`                      |
| 24    | `&&`                        | right           | `Logic.and`                     |
| 25    | `->`                        | right           | `@type.arrow`                   |
| 25    | `~>`                        | right           | `@type.deferred_arrow`          |
| 30    | `==` `!=` `<` `<=` `>` `>=` | non-associative | `Int.*`                         |
| 40    | `\|` `\`                    | left            | `Type.union`, `Type.diff`       |
| 45    | `&`                         | left            | `Type.intersect`                |
| 50    | `<+`                        | left            | `attach`                        |
| 55    | `<>`                        | right           | `Text.append`                   |
| 60    | `+` `-`                     | left            | `Int.add`, `Int.sub`            |
| 70    | `*` `/` `%`                 | left            | `Int.mul`, `Int.div`, `Int.rem` |
| 90    | `-`                         | prefix          | `Int.negate`                    |
| 90    | `!` `?` `&`                 | prefix          | `@linear.*`                     |

Every operator lowers to an ordinary function call. `&&` and `||` target
`Logic.and` and `Logic.or`; those ordinary prelude functions take a deferred
second parameter and decide whether to demand it. No boolean operator has a
compiler-only control rule.

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
let rank :: 1 | 2 | 3 -> Int
let rank = fn level => case level of
  1 => 100
  2 => 200
```

is refused: `3` is a member of the target's type that no arm covers. Adding a
`3` arm, or any irrefutable arm, accepts it.

A target whose type is not an explicitly enumerable set — `Int`, `Text`, or any
range with an open end — cannot be exhausted by listed literal arms. Such a
`case` is refused rather than accepted in silence:

```blot
let describe :: Int -> Text
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

Comma-separated subjects spell the demand-driven form of the same matrix:

```blot
case first, second, fallback of
  #True, _, _ => 1
  #False, #Some value, _ => value
  #False, #None, value => value
```

Every arm must write one pattern for every subject. Subjects are captured in the
surrounding scope before any arm binds names, then an arm tests its columns from
left to right. A wildcard does not demand its subject. Every other pattern
demands the subject when that column is first reached, and the resulting value
is shared by later arms on that execution path. Thus the first arm above never
evaluates `second` or `fallback`. Subject expressions retain their written scope
even when a preceding column binds the same name.

This is distinct from `case (first, second, fallback) of`: constructing that
tuple evaluates all three elements before matching it. Both forms use the same
row ordering, pattern bindings, guards, result typing, and cross-product
coverage rule. A guarded row still contributes nothing to coverage.

Comma-separated cases are surface syntax. Lowering captures each subject as an
affine deferred argument, caches a demanded argument in an ordinary strict
binding, and emits ordinary nested `case`, `if`, application, and block nodes.
The checker also sees a non-executed decision tree made from the unguarded rows,
so exhaustiveness is proved without making the executable path eager. No
multi-subject case node reaches inference, ownership, evaluation, Runtime HIR,
or a backend. The editor linter offers this form when nested single-subject
cases form the same decision matrix without depending on an outer arm's
bindings.

Coverage reads the columns. The arms taken together must cover the
cross-product: a combination of columns no arm accepts is
`BLOT_INCOMPLETE_CASE`, exactly as a constructor no arm names is for a single
target. So

```blot
let join :: (Option Int, Option Int) -> Int
let join = fn pair => case pair of
  (#Some a, #Some b) => a + b
  (#Some a, #None) => a
  (#None, #Some b) => b
  (#None, #None) => 0
```

is total with no irrefutable arm at all, and dropping its last arm is refused
with `` No arm covers `(#None, #None)` ``.

The signature supplies the finite domains there. Without it, a column the
checker cannot enumerate must be covered by an irrefutable pattern. No checked
closed `case` retains a path to `BLOT_NO_MATCH`.

Each column is covered on its own terms. A column whose type is a constructor
set must have every constructor named in it, and the arms are what close a
column no signature declared: a column naming `#Some` and `#None` makes the
scrutinee's column that union, so a target declared wider is refused there. A
column whose type has more values than arms can list — `Int`, `F64`, an opaque
type, a shape — can only be covered by an irrefutable pattern in that column, so

```blot
let pick :: (Int, Option Int) -> Int
let pick = fn pair => case pair of
  (1, #Some a) => a
  (_, #None) => 0
```

is refused with `` No arm covers `(_, #Some)` ``: the first arm cannot help with
an integer other than `1`, and the arm that can does not name `#Some`.

Nested tuples and constructor payloads are columns like any other, and are read
the same way when a signature says what they hold. Where nothing does, an inner
column carries no requirement — only a column of the scrutinee's own tuple is
closed by its arms.

`case` is a separate result scope. An indented arm block's `return` supplies the
selected arm and therefore the case result; `break` cannot escape an arm to
reach an enclosing loop.

An effectful `case` remains a value expression. Select the effectful branch and
sequence the selected expression once at the surrounding scope:

```blot
use case choice of
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
let name :: 1 | 2 | 3 -> Text
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
binding `Int.eq` (§7), so `if n == 1` and `if Int.eq n 1` prove exactly the same
thing, and a module that binds `Int` to something else gets whatever that
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

The second is the length of an array or owned region a name in scope holds,
written directly as `@array.len xs` / `@region.length region`, or through a
verified wrapper such as `Array.length xs` or `Slice.length (&region)`.
Inference records that value relationship in the refinement context rather than
in the integer's type:

```blot
let at :: [Int] -> Int -> Int
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

A wrapper contributes this fact only when its compile-time closure value is
structurally verified to return the array or region length of one of its curried
parameters, optionally with a literal affine offset or through another verified
wrapper. For example, `fn _ => fn xs => Array.length xs - 1` summarizes the
second parameter. The spelling `Array.length` is not privileged: aliases keep
the verified summary, while a shadowed function with that name proves nothing.
The summary is erased and does not change the function's ordinary arrow type.

A length is keyed to the immutable array value a binding denotes. blot has no
assignment and arrays are immutable, so that identity denotes one length for its
whole lifetime. Every consequence follows from that key.

- `:=` binds a new occurrence, so a length proved before it says nothing after
  it unless the new value is an alias of the old one.
- An immutable alias keeps the identity. After `let ys = xs;`, a comparison
  against `@array.len xs` may prove a direct access through `ys`.
- A measured length may itself be bound. `let length = @array.len xs;` keeps the
  relationship, as do aliases of `length` and affine shifts by an integer
  literal such as `length - 1`. When such a binding is compared with a literal,
  it remains the comparison subject: the untaken side of `length < 2` records
  `2 <= length`, and that fact can prove literal index `0` against `xs`.
  Arbitrary arithmetic widens back to `Int`.
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
  value, so a `let`-bound or parameter-bound `Int` is refused rather than read
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
  and a subject on neither. Binding both lengths does not change that: a bound
  affine relationship becomes a subject only when its other operand is a
  compile-time integer.
- **A witness that is another runtime name.** `n == m` says `n` equals this `m`,
  not that `n` is somewhere in `m`'s type. Intersecting against a whole type
  would be sound and complementing against it would not, so neither is done.
- **A function whose body is not a single comparison.** `Int.cmp`, `Int.min` and
  `Int.max` are refused, as is any equality written with two comparisons rather
  than one. Refusal here is a limitation, not a judgement: the function is fine,
  the checker just cannot say what it computes.
- **A body containing `open` or a recursive binding.** Both bind names that
  appear in no node of the body, so the occurrence count that licenses the whole
  argument cannot see them.
- **Text.** A text range cannot have a value cut out of its interior: range
  bounds are inclusive and text order is dense, so splitting `Text` at `"m"`
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

for case pattern in iterator:
  statements
```

An iterator is a shape:

```blot
{
  .state = initial_state;
  .step = fn state => #Some (element, next_state); // or #None
}
```

The first form ignores each element. The second requires an irrefutable pattern
and binds it. The `for case` form opts into filtering: a refutable pattern that
does not match skips that element. Keeping the distinction explicit prevents a
pattern edit from silently changing iteration cardinality.

The names from the enclosing scope that are rebound with `:=` in the loop body —
including inside a statement conditional in that body, but not inside a nested
`for` — form an implicit accumulator record:

- their incoming values initialize the accumulator;
- each iteration sees the previous iteration's accumulator;
- their final values shadow the incoming bindings after the loop;
- zero iterations preserve the incoming values; and
- a `let` inside the body is local to that iteration.

A loop-pattern name is local to its iteration. Rebinding it with `:=` changes
the value seen by later statements in that iteration but does not initialize or
escape through the accumulator. A `let` is likewise local whether or not the
name is taken outside. `let n = …` in the body introduces a binding that ends
with the body, so the outer `n` is untouched and the local is free to hold a
different type. Where a `let` shadows a name, every `:=` after it in that block
rebinds the local and therefore escapes nothing.

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

Relationship evidence may be nested in ordinary tuples, shapes, and constructor
payloads. Destructuring or projecting those values opens the hidden package and
restores its `Phi` facts. A checked function also publishes a finite structural
transform when its result only moves parameter data through those forms:

```blot
let carry = fn value => { .payload = value; }
let unwrap = fn package => package.payload

// Inside an Iter.indexed success arm:
let package = carry (index, value)
let (proved_index, selected) = unwrap package
let same = @array.get values proved_index
```

The transform is derived from the closure body, is name-independent, crosses a
module value, and is included in the sealed-interface fingerprint. It can select
a curried parameter, build a tuple/shape/constructor, project one, or compose
another verified structural transform. The ordinary arrow and record types are
unchanged; the transform and package are erased before Runtime HIR.

This is existential packaging without an `exists` constructor in the subtype
lattice: the hidden refinement variables travel with compiler evidence, and a
pattern opens them only in its lexical `Phi`. Rebuilding validates by evidence
provenance. Moving a proved field preserves its proof; constructing the same
runtime shape from unrelated integers has no package and a proof-required
operation rejects it. An opaque or overwriting spread forgets earlier package
fields unless the spread itself has a known record relationship.

The supported relationship language is intentionally finite. It transports
compiler-produced facts; it does not infer arbitrary user predicates, publish
solver variable identities, or let a source annotation assert a relationship.
Broader relations need a checked producer and an erasure rule, not an unchecked
`assume`.

An immutable field path derives its identity from its parent value and field
name. A comparison against `@array.len box.values` therefore proves access to
that same `box.values`, including through an immutable alias. It proves nothing
about `box.other`; rebinding the parent mints another identity and invalidates
the previous relationship.

### 9.3 Affine address iteration

The prelude expresses slices, reversal, and striding as address-order iterators
rather than as another collection or view type:

```blot
for value in Iter.slice (values, 2, 8):
  use value

for value in Iter.reverse values:
  use value

for value in Iter.affine (values, start, stop, stride):
  use value
```

`Iter.affine (values, start, stop, stride)` uses `start` as its integer state. A
positive stride yields the element at each in-bounds state while the state is
less than the exclusive `stop`; a negative stride does the same while the state
is greater than `stop`. Each successful step advances by `stride`. A zero stride
is empty. Reaching an out-of-bounds state ends the iterator, so every
combination of integer arguments is total rather than trapping.

`Iter.slice (values, start, stop)` is the stride-`1` specialization.
`Iter.reverse values` starts at `Array.length values - 1`, stops at `-1`, and
uses stride `-1`. These functions return the ordinary `.state` / `.step` shape;
they allocate no result array and introduce no syntax, AST node, type
constructor, ownership mode, Runtime-HIR operation, or ABI value.

The generic `for` desugaring does not recognize these names. Specialization
exposes a scalar induction variable and checked reads of one immutable Store. A
dynamically materialized array captured by the iterator keeps the Store SSA
identity established at its binding, rather than being reconstructed per step or
per capture. This identity justifies sharing reads and length facts; it does not
grant write authority. Destructive traversal still requires separate linear or
affine ownership evidence.

## 10. Types and inference

Types are compile-time values in the same value domain as runtime data. There is
no type declaration syntax and no separate type expression grammar.

Examples:

```blot
const Bit = 0 | 1
const Message = #Ready | #Failed Text
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

F64 literals do not. `1.5` infers `F64`, and `F64` is the only float type there
is. A singleton float would put a real number where the lattice keeps a bound,
and every operation it performs on bounds has no meaning there: there is no next
float after 1.5 for `difference` to name, nothing for coverage to enumerate, and
equality is not something to narrow on where NaN and rounding exist. So a `case`
over floats never becomes exhaustive without an irrefutable arm, and a float
pattern matches by equality without proving anything about the scrutinee.

Type checking evaluates compile-time code because signatures and type
constructors are ordinary values. A compile-time value is bridged into the
inference lattice only when it denotes a type.

### 10.1 Unknown-first constraint solving

Inference starts with unknowns, not guessed concrete types. An unannotated
function initially has the schematic shape `'a -> 'b`; using its parameter or
return value adds constraints to those variables. A call freshens quantified
variables, relates arguments to parameters, relates the result to its use site,
and only then settles enough of the graph to choose a representation.

```blot
// Before its body is checked: 'a -> 'b
// The field projection adds: 'a <: { .name = 'n; }, result = 'n.
let name_of = fn value => value.name

// Calling it supplies the remaining facts.
let ada = name_of { .name = "Ada"; .age = 36; }
```

`Int`, `[Element]`, records, variants, arrows, and effect rows are canonical
constraints over such unknowns. They are not privileged declaration forms and
they do not require an eager nominal choice. In particular, `[a]` means one
homogeneous persistent array whose elements all satisfy `a`; it says nothing
about length, ownership, or physical stride. An omitted or inferred `a` remains
an unknown until uses constrain it, array length lives in `Phi`, ownership lives
in `Omega`, and a concrete Store layout is selected only after settling:

```blot
let count = fn values => Array.length values // ['a] -> Int
let apply = fn (function, value) => function value
// apply : ('a -> 'b, 'a) -> 'b, with the callback's effect row preserved
```

A signature header is a constraint program written with ordinary compile-time
type values. Each use instantiates its `@forall` binders freshly. Structural
records provide trait-like behavior by width subtyping, while effect rows
describe callable behavior separately from parameter and result representation:

```blot
const Named = { .name = Text; }

let label :: @forall (fn T => Named -> T -> Text)
let label = fn named => fn _ => named.name

const Console = @effect { .write = Text -> Unit; }
let map_logged ::
  (Int -> Int ~ { ..e }) ->
  Int -> Int ~ { Console, ..e }
let map_logged = fn transform => fn value => transform value
```

Layout and proof facts remain explicit layers. `I32` is the ordinary integer
range with a `.bit_width` namespace member; refining it narrows inhabitants
while preserving that layout metadata. Branches and recognized boolean
predicates add duplicable `Phi` facts such as `0 <= i < Array.length xs`;
ownership stays in the separate affine `Omega` judgment. Typestate needs no new
lattice constructor: closed/open states are ordinary variants in `Gamma`, a
transition arrow names its effects, and `Omega` consumes the old state exactly
once. Unary facts may cross a function boundary as canonical refined
parameter/result types, while identity-dependent relations travel through
recognized predicates and direct proof-producing operations rather than being
hidden in a representation type.

This is the sense in which types are constraints over unknowns: the solver never
places an arbitrary source closure in its graph. Predicate declarations must
normalize to the same finite range, array, record, variant, arrow/effect-row, or
nominal constraints the solver already understands, and all predicate machinery
erases before Runtime HIR and layout selection.

### 10.2 Predicate-defined integer types

`refine (base, predicate)` constructs an integer type from an ordinary pure
compile-time function:

```blot
const Natural = refine (Int, fn value => value >= 0)
const Byte = refine (Int, fn value => value >= 0 && value <= 255)
const NonZero = refine (Int, fn value => value != 0)
```

The first argument must be an integer type. The predicate may compare its one
parameter with compile-time integer witnesses using any function that factors
through `@int.cmp`. The compiler records the subset of `#Less`, `#Equal`, and
`#Greater` for which that function answers true; all eight subsets are valid, so
`<`, `!=`, and the other prelude operators are conventions rather than a closed
compiler enumeration. Boolean conjunction, disjunction, and negation are
recognized by their complete truth tables in the same way. A shadowed operator
therefore contributes no proof unless its value independently satisfies the
factorization and truth-table checks.

```blot
const separated = fn left => fn right => case @int.cmp left right of
  #Less => True
  #Equal => False
  #Greater => True

const NonZero = refine (Int, fn value => separated value 0)
```

The parameter may be observed only through those comparisons. An effect,
recursion, a run-time capture, an opaque call, or any other observation is
`BLOT_REFINEMENT_PREDICATE`. An empty result is `BLOT_EMPTY_REFINEMENT` because
the source type-value domain has no bottom value.

The compiler normalizes the predicate exactly to existing integer ranges and
ground unions, intersects that result with `base`, and then forgets the
predicate. No refinement object reaches inference, Runtime HIR, WebAssembly, or
the ABI. Branch comparison facts can prove that an `Int` inhabits such a type in
exactly the same way they prove an explicitly written range.

This operation does not turn value relationships into ordinary types. Facts such
as `i < length(values)` remain in the refinement context described in §8.5, and
ownership remains a separate flow judgment. The formal boundary and erasure
obligation are specified in
[`spec/PREDICATE_REFINEMENTS.md`](spec/PREDICATE_REFINEMENTS.md).

### 10.3 Display notation

Compiler output uses notation that is not additional source syntax:

| display                     | meaning                          |
| --------------------------- | -------------------------------- |
| `Int`, `Text`, `1`, `"x"`   | ranges and singleton ranges      |
| `0..9`, `0..`               | bounded and half-bounded ranges  |
| `{ .x = Int; }`             | structural record                |
| `[Int]`                     | homogeneous array                |
| `#None \| #Some Int`        | constructor variant              |
| `#Some Int \| ..`           | variant with an open set         |
| `A -> B`                    | pure function                    |
| `A -> B ~ { Console, ..e }` | function with an open effect row |
| `A ~> B`                    | deferred parameter (§6.3)        |
| `'a`, `'b`                  | inferred type variables          |
| `forall 'q0. ...`           | explicit quantified type         |
| `⊤`, `⊥`                    | top and bottom                   |

Array lengths and affine relations are not display types. Diagnostics that need
to explain a failed proof render propositions such as `index < length(values)`
directly from `Phi`; a signature cannot name them.

An effect row is the one piece of this notation that is also source:
`A -> B ~ { Console }` is a closed row, while `A -> B ~ { Console, ..e }` names
the rest of the row inside a signature header (§12.4). The checker prints
inferred open rows with the same `..e` notation.

### 10.4 Type-value primitives

The primitive type values are `@type.int`, `@type.float`, `@type.float32`,
`@type.f32x4`, `@type.text`, `@type.unit`, and `@type.unbounded`.

The type algebra has two deliberately different normalization layers:

- open inference uses Simple-sub bounds, structural records and arrays,
  variants, arrows, and effect rows; a join of open values is several lower
  bounds rather than an arbitrary Boolean formula;
- closed type values use exact set normalization: unions are flattened, `bottom`
  is removed, `top` absorbs, duplicates disappear, and members are ordered by an
  alpha-aware structural fingerprint rather than printer output; supported
  ground intersections/differences are computed to ranges, closed variants,
  unit, or `bottom`.

This is the useful part of Boolean-algebraic subtyping without putting arbitrary
intersection and negation into the mutable inference graph. There is no
intersection or complement type constructor in open inference. A closed
operation that the representable algebra cannot answer exactly is rejected
rather than approximated.

The closed type-value surface includes inclusive ranges; union, supported exact
intersection and difference; function arrows and effect rows; structural shapes
and arrays; nominal sealing and opening; namespace attachment; reflection;
type-of; union construction from an array; pure integer predicate refinement;
and explicit predicative `@forall`.

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
reflection and `layout`. It describes a requested source layout and does not by
itself change the positional tuple returned by `struct`, the runtime
representation of an integer, or the Core Wasm ABI.

Physical reuse is guarded independently. Runtime HIR derives a closed layout
witness `(fingerprint, size, alignment, stride)` for every settled type. Direct
inline recursion is rejected; recursion must cross an indirect or Store
boundary. An operation marked `owned-reuse` is valid only when ownership proves
the old Store unobservable and the source/result layout fingerprints agree. Thus
source layout descriptions, logical refinements, and allocator evidence remain
coherent without pretending they are the same type fact.

A namespace member is a compile-time value, and projecting one is typed by that
value rather than by the ordinary record-field rule. A member that is itself a
type projects to that type. A callable member retains the arrow inferred for its
closure or primitive, so an ordinary runtime call is checked by the same
application rule as any other function. If all inputs are compile-time values,
evaluation may additionally compute the result value and refine its type; that
staging opportunity is an optimization and never a prerequisite for accepting
the call.

The same application rule handles a callable field of an ordinary record. This
remains true when the record is reached through a namespace member:
`World.Position.insert entity` types `Position` as the attached record and
`insert` as its ordinary callable field. Compile-time projection follows the
whole chain; it does not force games to bind each intermediate record before
using it.

A sealed type is nominal and invariant. Its identity is its name together with
its carrier.

### 10.5 Deliberate inference limits

The implemented checker does not currently prove:

- range-refining arithmetic — `@int.add n 1` widens to `Int` whatever `n` was,
  so an index carried across an addition loses what a comparison proved about
  it;
- an index bound that came from anywhere but a comparison against a literal or
  against `@array.len` applied to a name (§8.5, §13.3);
- the result of `@shape.get` or `@shape.remove` whose field name is a runtime
  value (§13.3);
- anything about a namespace member call whose arguments are not compile-time
  values (§10.4);
- impredicative instantiation; or
- a first-class recursive type value such as
  `const Json = #Null | #Array [Json]`.

The constraint graph may itself be cyclic: recursive functions and recursive
flows are checked by revisiting ordered constraints at most once. That internal
graph recursion is not an equi-recursive source type constructor. Rank-N types
are explicit and predicative through `@forall`. Higher-kinded abstraction is
compile-time function application rather than a kind system.

There is no record row variable, and there is not going to be one. The lattice
has width subtyping, which says what a function may _read_ from a record, and
the restricted leading-spread relation separately retains what one value
carries. The effect row in `A -> B ~ { Console, e }` is a row over a set of
labels with no types under them; a record row would be a second sort with types,
and the operations shape syntax can write over it — in particular concatenating
two unknown rows — has no principal solution in this lattice.

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

A borrow is a lexical view, not a first-class reference. It may appear only as
an immediate projection, as the argument position corresponding to an
`&parameter`, or as input to a read-only primitive operation. The ownership
checker carries that transient evidence through tuples and records so a nested
borrowing parameter can accept it. A declaration may not store the view, a
function or module may not return it, and a call whose corresponding parameter
is ordinary may not receive it. These rules also prevent a borrow from crossing
a host-effect boundary. A closure may inspect a captured borrow only when it is
called immediately; storing that closure is storing the borrow and is rejected.
Blot deliberately has no inferred lifetimes or first-class borrowed values.

Every branch starts from the same ownership state and must end in an agreeing
state. A linear binding consumed on only one branch is rejected. An affine
binding may be consumed on zero or one branch but never twice.

When both arms of a runtime branch return a successor carrying the same affine
Store authority, the joined value carries that authority. The arms are
exclusive, so joining them does not create an alias. If either arm shares or
loses the Store, the join is shared or rejected by the ordinary agreement rule.

Every fresh array has one affine Store authority even though its type is still
ordinary `[T]`. An unqualified Array parameter begins as an authority candidate
and consumes it only when the checked body updates, returns, captures, or passes
it to another consuming contract. `!` remains reserved for exact linear
protocols such as a Region and its rejoin witness. An Array parameter written
`&values` guarantees a borrow. Returning the consumed parameter, or the
successor produced by `Array.set` or `Array.push`, transfers the same authority
to the result.

`freeze values` consumes owned Store authorities and returns the same immutable,
possibly shared arrays in `O(1)` time. It is rejected if the value contains a
non-Store linear or affine resource. `Array.copy values` is the explicit
shared-to-owned boundary with `O(n)` source semantics; a last-reference proof
may elide its physical copy. A shared Array cannot be passed to a consuming
Array parameter or updated directly. Passing an owned Array to a resolved
non-consuming contract may share it in `O(1)` and leave the caller's binding
shared; `&parameter` preserves caller uniqueness instead. The compiler never
inserts a hidden copy.

A closure inherits the strongest obligation it captures:

- capturing a linear value makes the closure linear;
- capturing only affine values makes it affine; and
- calling the closure discharges that inherited obligation.

The marker need not be repeated on the closure binding. Captures may propagate
through nested closures.

Ownership propagates through arrays, tuples, variants, and shapes. Destructuring
transfers each known component obligation to the corresponding binding. Moving
an aggregate consumes it. Moving an owned record field marks that path moved
while leaving sibling paths live; the whole record cannot subsequently be used,
but another live field may be moved or borrowed. Continuing branches must agree
on the live path set. A partial destructuring pattern is rejected when it has no
subpattern for an owned component. A direct array read cannot copy a known owned
element, and replacement cannot discard one. Appending to an array with known
elements preserves the appended component's obligation. An array or record
spread is rejected when an owned component would lose the position or field
identity needed for later consuming extraction.

A known function parameter is an ownership contract. The contract records both
the inferred input authority and the structural result. Unqualified positions
whose settled runtime type is Array begin with affine Store authority, but the
published input retains it only when the body demands ownership; explicit `!`,
`?`, and `&` positions retain their written meaning. Tuple and shape parameter
positions are matched structurally. The result summary follows statically known
consuming calls, fixed field projections, and direct `case` or declaration
destructuring, and an importer substitutes the caller's concrete authority
through it. The identity transform of `@[assert.reuse]` preserves that exact
contract even when the tagged declaration is local or recursive; the tag cannot
erase or add an ownership promise. Unknown and host-supplied functions remain
conservative. This usage summary is separate from the type lattice and keyed by
exact module and closure identity, never by a binding name. A module or host
result freezes remaining owned Stores implicitly because that transition copies
no bytes; non-Store linear resources remain forbidden. Last-use and
proved-consumption facts are recorded for the backend.

An Array position records element shareability separately from its backing-Store
access requirement. Specialization may prove that concrete elements carry no
ownership and thereby admit a shared-safe observer such as iteration; it cannot
weaken `Unique` access required by `@array.set`, `@array.push`, extraction, or a
callee that performs one of those operations. A `Shared` Store satisfies only a
`Shared` access requirement. No call boundary inserts an implicit copy.

A function may itself publish a finite ownership requirement for a
function-valued parameter. Calling an otherwise opaque parameter with an
explicit `!` or `?` ownership handoff is accepted only when the result is
immediately bound by a declaration pattern or eliminated by a `case`. The `!`
and `?` binders in the direct result pattern or every named constructor arm
state the positions that receive the consumed authorities; input and output
ownership leaves pair in structural left-to-right order, and every alternative
must return the complete compatible set. The enclosing function's certificate
records the callback parameter path, the owned input tree, and the result
alternatives. At application, the actual callback's already checked contract is
substituted with that input tree and must equal the required result tree. The
requirement is erased before Runtime HIR and does not enter the type lattice.

This rule does not infer forwarding from equal types, authorize an unresolved or
host callback, or let an opaque owned result escape its immediate binding. A
callback that drops, shares, replaces, duplicates, or moves an authority to an
unmarked result position fails the relation. The existing qualifiers are proof
binders in the generic implementation, not extra call-site syntax.

A recursive Array or Region function may publish one provisional result only
when exactly one parameter position supplies the matching authority. Every
non-recursive result path must return that same Store authority or complete
Region root; otherwise `BLOT_RECURSIVE_OWNERSHIP_RESULT` rejects the function.
For a Region whose element type cannot carry ownership, the certificate erases
its empty element tree while retaining root lineage. This is the induction step
that lets the successor from one recursive call feed another without treating an
arbitrary recursive result as owned. A residual direct call reattaches that
certified result authority after lowering; the runtime representation alone
never upgrades a plain Store or Region.

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

**A closure holding a spendable value may call its recursive group only through
an ownership-tail edge.** Every occurrence of a group member must be the final
ownership action of its branch. The call transfers the group's shared capture to
the next invocation; a base branch must consume a linear capture exactly once
under the ordinary branch rules:

```blot
let rec go = fn n => if n < 1:
  return consume (!token)
else:
  return go (n - 1)
return go 3
```

is accepted. The same certificate covers mutual recursion: the SCC is one owned
knot, so calling one external entry consumes the knot and its internal edges
transfer rather than duplicate it.

A recursive call nested in another operation, stored, returned, passed to an
unknown function, used in a condition, or accompanied by another recursive edge
on the same path is `BLOT_RECURSIVE_OWNERSHIP_UNPROVED`. The compiler does not
guess a call count outside this class. Calling two external entries of the same
owned SCC is still an ordinary second consumption.

`examples/recursive_ownership.blot` is an accepted mutual transfer.
`examples/rejected/semantics/recursive_linear_capture.blot` puts work after the
recursive call, and
`examples/rejected/semantics/recursive_group_consumed_twice.blot` consumes an
owned group twice.

### 11.2 Facts recorded for the backend

A recorded last use is where the pass stopped seeing a name. Inside a closure
that is not where the binding dies, because the closure's body runs when the
closure is called, and nothing in declaration order dates that call. Where a
binding is read across a closure boundary _and_ read somewhere else too, the
pass records that it cannot date the read, and an owned in-place store update is
refused rather than guessed. A binding a closure holds the only read of keeps
its last use, because how often that closure runs is exactly what the linear
proof is about.

When the proved consumption of an owned Store is the array operand of
`@array.set` or `@array.push`, the backend reuses that Store. Fresh arrays and
consuming Array parameters begin with this authority, and the update result
carries its successor. This is an implementation permission published in an
ownership certificate. A separate checker rejects duplicate binding identities,
invalid spans, reentrant reads, or a reuse site absent from the complete set of
path-specific consumptions before lowering consults it. Authorization is keyed
to the exact binding identity and source occurrence, so one branch's consumption
cannot authorize another branch's update. This is not mutation in the language:
the source binding is unavailable after the consuming use. Updating a shared
Array is rejected rather than implemented by an implicit persistent copy; source
requests that boundary with `Array.copy`.

`@[assert.reuse]` asks the compiler to verify that every Store update in that
function's residual frame used precisely this already-proved path. It does not
turn a last use into consumption, trust a callee name, or grant ownership.

### 11.3 Regions and `Slice`

`Slice.of T` is an opaque linear authority over an interval of one private array
Store. Its backing Store, interval bounds, and recombination identities cannot
be projected by source. The prelude exposes the ordinary source wrapper `Slice`;
only its `@region.*` bodies are primitive:

- `Slice.copy values` explicitly enters a private `Slice` phase. Its source
  meaning copies the array into a private Store; the compiler may elide that
  physical copy only when ownership proves the input Store uniquely reusable;
- `Slice.length (&slice)` and `Slice.get ((&slice), index)` borrow authority;
- `Slice.set ((!slice), index, value)` and `Slice.swap ((!slice), left, right)`
  consume and return the same authority;
- `Slice.partition ((!slice), belongs_left)` consumes one authority, classifies
  its complete interval in place, and returns `(!slice, boundary)`;
- `Slice.partition_range ((!slice), start, end, belongs_left)` does the same for
  a checked subrange and returns either `#Partitioned (!slice, boundary)` or
  `#PartitionOutOfBounds (!slice, start)`;
- `Slice.partition_in ((!slice), bounds, belongs_left)` is the ordinary
  `Slice.Range` wrapper over `partition_range`;
- `Slice.whole (&slice)` returns the checked `Slice.Range` value `[0,length)`,
  while `Slice.range ((&slice), start, end)` validates an arbitrary half-open
  range and returns `#Range bounds` or `#RangeOutOfBounds`;
- `Slice.range_length`, `.range_last`, `.range_before`, and `.range_after`
  perform ordinary half-open-range arithmetic. `range_before (bounds, pivot)` is
  `[bounds.start,pivot)` and `range_after` is `[pivot+1,bounds.end)`;
- `Slice.expect_get` and `Slice.swap_or_keep` are invariant-oriented wrappers
  over the total operations above. An invalid read traps; an invalid consuming
  operation returns its unchanged authority, which a linear helper cannot
  discard merely because its caller violated an invariant;
- `Slice.replace ((!slice), index, (!value))` consumes both inputs and returns
  either `#Replaced (!old, !slice)` or `#ReplaceOutOfBounds (!value, !slice)`,
  so replacement never drops an owned element;
- `Slice.split ((!slice), offset)` consumes the parent and returns either
  `#Split (!left, !right, !rejoin)` or `#SplitOutOfBounds !original`;
- `Slice.join ((!rejoin), (!left), (!right))` consumes the exact sibling
  authorities and their witness and returns their parent; and
- `Slice.reassociate_left ((!outer), (!inner))` and
  `Slice.reassociate_right ((!outer), (!inner))` rotate a nested split proof
  tree while preserving its Store, ordered boundaries, and root; and
- `Slice.freeze (!slice)` consumes a complete root authority and returns an
  immutable array.

Every total failure returns the authority it received. A successful split's left
and right intervals are disjoint, adjacent, in bounds, and an exact cover of the
parent. Its linear `rejoin` witness records that sibling relation; reversal,
substitution of an unrelated part, duplicate use, or loss of the witness is
rejected. Only a complete root may freeze, so a part cannot discard the rest of
its Store.

`Slice.copy` is the only persistent-array-to-`Slice` allocation boundary. No
other `Slice` operation implicitly copies its backing Store. A compiler reuse
proof may only remove the physical work requested by that explicit operation; it
may not introduce a hidden copy elsewhere.

Ownership-transforming closures publish a structural contract keyed by their
defining module and lambda body. The contract records the parameter pattern and
the ownership value produced by the body. An importer resolves an ordinary
source closure and substitutes the caller's concrete authority through that
contract, so a user wrapper in another module behaves exactly like the same
wrapper locally. No `Slice` module, binding, or field name is recognized by the
checker. Unknown and host-supplied functions retain the conservative ordinary
call rule.

Regions and rejoin witnesses are compiler-private values. Blot Core Wasm ABI 2
has no encoding for either and refuses a live one at a public boundary. Internal
Runtime HIR lowers a Region to private Store-plus-bounds data, erases the
witness after checking, uses persistent acquisition for shared inputs, and may
emit owned Store writes only for authority proven unique by ownership. The
ownership analysis separately carries the region's positional element
obligations. Copy transfers them from a consumed array when the elements are
owned, while split and swap partition or permute them, replace exchanges exactly
one obligation, join restores the parent tree, and freeze returns them with the
resulting array. This hidden accounting does not alter `Slice.of T` or make
ownership a type.

Replacement is constant-time: one bounds check, one Store read, and one Store
write. Split and join copy no elements. Witness reassociation is erased and
emits no runtime operation. `Slice.copy` is semantically explicit and linear in
the input length; a certified Store-reuse optimization can make its physical
cost constant-time without changing the program's meaning.

Partition is a pure consuming update. A successful partition preserves the
multiset of elements in the selected interval, places every predicate-true
element before the returned boundary and every predicate-false element after it,
and leaves positions outside the selected interval unchanged. The predicate is
called once per selected element. The operation is unstable, linear in the
selected length, uses constant auxiliary element storage, and allocates no
element Store. Range validation precedes predicate evaluation; an invalid range
returns the unchanged authority and supplied start boundary. The whole-slice
form cannot be out of bounds.

These source operations are ordinary prelude compositions of `length`, `get`,
and `swap`. They introduce no intrinsic and no observable mutation. Their
meaning is the persistent result of the same permutation; Store reuse is an
implementation permission justified by the consumed authority.

`Slice.Range` is ergonomic checked metadata, not ownership authority and not a
dependent type. Blot is structural, so code can construct the same `{start,end}`
shape directly, and a range may be carried to a different `Slice`. Code submits
its fields to the total `Slice.partition_range`, which validates them again
against the borrowed region before reading or writing. The trusted permission
remains the `Slice` itself; an invalid range performs no Store access and
returns the unchanged authority. This keeps the helpers in ordinary prelude
source rather than adding another `@region` primitive.

### 11.4 Owned ordered text maps

`OrderedTextMap` is an ordinary prelude adapter over `Slice`, not a second
compiler primitive family. `OrderedTextMap.entry V` is an attached structural
type stored as the tuple `(Text, V)`; `OrderedTextMap.of V` is the region type
whose elements have that entry type.

An input is valid when every adjacent key pair is strictly increasing under
`Text.cmp`. This implies unique keys and makes every physical Slice interval a
contiguous key range. `OrderedTextMap.validate (&entries)` checks the invariant
without acquiring authority. `OrderedTextMap.copy entries` performs the same
check, traps with `BLOT_PANIC` when it fails, and otherwise acquires the full
region. The input parameter is persistent, so shared inputs retain Slice's
copy-safe acquisition semantics.

The public operations are:

- `length (&map)` borrows and returns the entry count;
- `lower_bound ((&map), key)` returns the first relative position whose key is
  greater than or equal to `key`;
- `get ((&map), key)` performs binary search and returns an `Option`;
- `replace ((!map), key, value)` returns either `#MapReplaced (previous, !map)`
  or `#MapMissing (value, !map)`;
- `split_before ((!map), key)` lower-bounds the key and delegates to
  `Slice.split`, returning its `#Split` or `#SplitOutOfBounds` result;
- `join`, `reassociate_left`, and `reassociate_right` preserve the exact Slice
  witness rules; and
- `freeze !map` requires a complete root and returns the ordered entry array.

No operation inserts, removes, reorders, or replaces a key. Successful
replacement writes the stored entry key together with the new value, preserving
strict ordering. Values carrying affine or linear obligations are not admitted
by this first adapter: validation and binary search must inspect an entry to
read its key, and a borrowed entry read cannot copy an owned value.

The public type is structural. Passing an independently copied, unsorted `Slice`
of the same entry type to these functions deliberately violates their
sorted-input precondition; it does not create or enlarge region authority.
`copy` is the checked construction path.

Validation is linear. Lookup, replacement focus, and `split_before` use
logarithmic binary search; replacement then performs one constant-time owned
Store write. Split, join, witness reassociation, and freeze add no element Store
copy after acquisition.

## 12. Effects and handlers

An effect is a compile-time value built from a shape of operation types:

```blot
const Console = @effect {
  .write = Text -> Unit;
}
```

An operation may instead use an ordinary compile-time descriptor record:

```blot
const Resource = @effect {
  .acquire = Effect.produces (Unit -> Handle);
  .release = Effect.consumes (Handle -> Unit);
  .exchange = Effect.operation {
    .signature = (Handle, Int) -> Result;
    .input = (#Linear, #Unrestricted);
    .result = #Affine;
  };
}
```

The descriptor has exactly `.signature`, `.input`, and `.result`. Its ownership
summaries use `#Unrestricted`, `#Affine`, or `#Linear` at any root. A tuple or
record may instead carry an exact field-for-field summary, and a closed variant
may carry an exact record of its constructor cases. Arrays, seals, functions,
and unresolved generic positions admit only a root mode. Borrowing is not an
effect-boundary mode; a borrow cannot cross an operation request.

`Effect.operation`, `Effect.consumes`, and `Effect.produces` are ordinary
prelude functions that construct those records. `@effect` interprets their
compile-time result, not the builder's name. A direct arrow remains shorthand
for unrestricted input and result. The normalized ownership contract is part of
the generative effect identity together with the operation signatures.

Ordinary effects are generative by semantic occurrence. Two written calls of an
effect-producing function create distinct effect values even when their
arguments print alike, while aliasing one result preserves its identity.
Re-evaluating the same written occurrence in the same source and dependency
revision recovers that occurrence's identity. A changed operation signature,
source revision, observable dependency revision, or module-import occurrence
creates a different identity.

Projecting an operation from an effect and calling it performs that operation:

```blot
Console.write "hello"
```

There is no `perform` keyword. Calling an operation produces an effectful
expression; `use` sequences it into the surrounding inferred row.

Calling an ownership-bearing operation applies the same separate flow contract
as a source function. A consuming input requires an explicit `!` or `?` handoff,
and a produced linear or affine result carries that obligation even when the
receiving binding has no written qualifier. This changes no type or effect-row
lattice relation.

An ordinary effect must be discharged before the module boundary. A host effect
declared with `@effect.host` may reach the boundary; its operations become typed
WebAssembly imports and therefore constitute part of the module interface.

### 12.1 Source handlers

```blot
let logging = {
  .write = fn (message, ?resume) =>
    use rest <- resume ()
    return message <> rest
  ;
  .return = fn value => value;
}

@handle (Console, computation, logging)
```

`@handle` takes one tuple `(effect, computation, handler)`:

- `effect` is the specific compile-time effect being discharged;
- `computation` is a nullary function;
- `handler` is a statically known shape;
- each operation clause takes `(operation_argument, ?resume)` normally, or
  `(operation_argument, !resume)` when its suspended continuation owns a linear
  resource; and
- an optional `.return` clause transforms the computation's normal result.

The operation argument pattern must exactly match the operation's input
ownership summary. A handler may pass a fresh unrestricted value to `resume`; if
it explicitly hands an owned value to `resume`, that value must match the
operation result summary. These checks make the source handler an implementation
of the declared request/response ownership protocol rather than an escape from
it.

`resume` is one-shot. It is affine when aborting the rest of the computation
discards no linear obligation. If the suspended computation captures one, every
operation clause binds `!resume` and must resume exactly once; an aborting
clause is `BLOT_LINEAR_HANDLER_MAY_ABORT` unless it explicitly cancels that
continuation:

```blot
let cancelling = {
  .write = fn (_, !resume) =>
    use Continuation.cancel resume
    return replacement
  ;
}
```

`Continuation.cancel resume` consumes the one-shot continuation without running
the suspended computation. It is operational: it must be integrated by `use`,
cannot be stored as a first-class function, and accepts only a named affine or
linear binding proved to be the resume parameter of a statically known handler.
An alias of that same immutable binding retains the proof. Resuming or
cancelling a continuation after either operation has consumed it is rejected
statically and also guarded during evaluation.

Effects not named by the handler remain in the inferred row. Handler
specialization is lexical: the effect, computation, and clause shape must be
statically visible. Runtime HIR has no general runtime handler representation.

### 12.2 Handler composition

Composing handlers is ordinary function composition. `@handle (effect, handler)`
is a surface-only handler step: a computation transformer awaiting the middle
argument. Piping a nullary computation through a sequence of steps discharges
one effect per step, written inner-to-outer:

```blot
let handled = program
  |> @handle (Terminal, fake_terminal)
  |> @handle (Clock, fake_clock)
  |> @handle (Random, fake_random)
```

Each step produces another nullary computation, so `handled` is a computation
like `program` and is executed by sequencing it with `use`. Composition performs
nothing on its own, and a composed computation may be executed more than once.

A piped step lowers during CST lowering to the ordinary three-argument `@handle`
around the computation on its left. The example lowers to the equivalent of:

```blot
let program_without_terminal =
  fn () => @handle (Terminal, program, fake_terminal)
let program_without_clock =
  fn () => @handle (Clock, program_without_terminal, fake_clock)
let handled =
  fn () => @handle (Random, program_without_clock, fake_random)
```

The computation reaches `@handle` as itself rather than through the step's own
parameter, so the ownership rule in section 12.1 answers to the written
computation: clauses bind `?resume` unless that computation owns a linear
resource. A step used as a first-class value keeps its transformer form, and its
parameter is owned because it consumes that computation exactly once.

Handler composition is a bounded sequence of statically known steps, not a
dynamically scoped registry. Effect identities, handler shapes, and the
resulting effect rows remain statically visible. It can discharge source
effects; host effects remain caller capabilities.

### 12.3 Host boundary

The entry module input and host effects are the only sources of host authority.
No filesystem, clock, terminal, or network capability is ambient.

Host-effect operations may use the concrete first-order boundary values listed
in section 15: integers, text, unit, booleans, records, arrays, variants, and
seals. A host capability's source name is part of its external contract and is
not silently mangled.

Every host operation carries its normalized input and result ownership contract
through Runtime HIR into the Core Wasm manifest. The WebAssembly call remains
synchronous and its memory parameters remain borrowed for the duration of the
call. The ownership contract instead governs the logical Blot values: consuming
input transfers source authority to the host, and a linear or affine result
transfers a fresh obligation back to the program. A conforming host must obey
that protocol even when the boundary carrier is a scalar with no allocated
memory.

### 12.4 Written effect rows

A function type carries the row it performs, and a signature header writes that
row the way the checker prints it:

```blot
const Console = @effect { .write = Text -> Unit; }

let map_logged ::
  (Int -> Int ~ { ..e }) ->
  Int -> Int ~ { Console, ..e }
let map_logged = fn callback => fn value =>
  use Console.write "call"
  return callback value
```

`~` is the ordinary `@type.performs` operator. Its right operand is a row of
compile-time effect values, optionally ending in one tail `..name`.
`{ Console
}` is closed. `{ ..e }` requires no named effect but leaves the row
open through `e`. A function that performs exactly nothing is still written with
bare `->`; `{}` remains the empty shape rather than an effect row.

A tail name is scoped to the immediately containing signature header. Every
occurrence of the same tail name in that signature denotes the same inferred
effect-row variable, and the tail must appear in at least two positions. That
repeated-use rule prevents a signature from introducing an unconstrained row
variable that could admit arbitrary effects. A row has at most one tail and the
tail is last. This facility is specific to effect-label sets; it does not add
record row polymorphism.

A written row remains an upper bound. The binding's inferred type must be a
subtype of the signature, and fewer effects is a subtype, so a body may perform
fewer named effects than its signature promises. A closed
`let quiet :: Int -> Int ~ { Console }` over a pure body is therefore accepted
when immediately followed by `let quiet = ...`. Conversely, bare `->` is the
exactly-empty row, so a body that performs is rejected when its signature omits
`~`.

Only effects in scope can be named directly. A tail can nevertheless preserve an
effect identity supplied by a callback or dependency without making that effect
constructible or handleable by name. Nameability and authority therefore remain
separate: `..e` carries the rest of a row; it grants no capability.

The row lands on the last arrow. `A -> B -> C ~ { Console }` is the function
that performs when its second argument arrives, which is where the printer puts
a row. A second `~` fills the next arrow outwards, so
`A -> B -> C ~ { Inner } ~
{ Outer }` reads back as itself; a `~` on a chain
whose arrows all carry rows is an error.

Reflection (§10.4) describes an arrow's `.domain`, `.codomain`, and `.effects`,
but an effect itself reflects as `#Opaque` — nothing in Blot takes one apart.
Open row tails remain type-checking evidence and do not add a runtime value,
Runtime-HIR representation, or ABI field.

## 13. Primitive namespace

Every intrinsic is curried like an ordinary Blot function except `@handle`,
which takes its three arguments in one tuple. The two-argument spelling is the
handler step described in section 12.2, not partial application. Applying fewer
arguments to other primitives returns a partially applied primitive.

Everything not listed here belongs in source, normally the prelude.

### 13.1 Control, files, and effects

| primitive      | meaning                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| `@include`     | parse a dependency-tracked file at compile time                           |
| `@json.parse`  | decode JSON under an explicit compile-time inference policy               |
| `@effect`      | create a fresh source effect from operation types                         |
| `@effect.host` | create a fresh host effect                                                |
| `@handle`      | discharge one effect from a nullary computation                           |
| `@forall`      | evaluate a type function with a fresh rigid variable                      |
| `@satisfies`   | refine an open value by a type, or prove its closed type with a predicate |
| `@fail`        | refuse compile-time evaluation with a diagnostic                          |
| `@panic`       | trap with a text message                                                  |

### 13.2 Numeric and text operations

| primitive                                   | meaning                                              |
| ------------------------------------------- | ---------------------------------------------------- |
| `@int.add`                                  | signed addition                                      |
| `@int.sub`                                  | signed subtraction                                   |
| `@int.mul`                                  | signed multiplication                                |
| `@int.div`                                  | division truncated toward zero                       |
| `@int.rem`                                  | remainder                                            |
| `@int.neg`                                  | negation                                             |
| `@int.cmp`                                  | return `#Less`, `#Equal`, or `#Greater` for integers |
| `@float.add`                                | addition                                             |
| `@float.sub`                                | subtraction                                          |
| `@float.mul`                                | multiplication                                       |
| `@float.div`                                | division                                             |
| `@float.rem`                                | remainder                                            |
| `@float.neg`                                | negation                                             |
| `@float.cmp`                                | order two floats, refusing NaN                       |
| `@float.is_nan`                             | test for the value no ordering accepts               |
| `@f32.add`                                  | single-precision addition                            |
| `@f32.sub`                                  | single-precision subtraction                         |
| `@f32.mul`                                  | single-precision multiplication                      |
| `@f32.div`                                  | single-precision division                            |
| `@f32.neg`                                  | single-precision negation                            |
| `@f32.cmp`                                  | order two `F32`, refusing NaN                        |
| `@f32.is_nan`                               | test an `F32` for NaN                                |
| `@f32.of_float`                             | narrow an `F64`, which may lose the value            |
| `@float.of_f32`                             | widen an `F32`, which never does                     |
| `@f32x4.of`                                 | gather four `F32` into one vector                    |
| `@f32x4.splat`                              | one `F32` into every lane                            |
| `@f32x4.add`                                | lane-wise addition                                   |
| `@f32x4.sub`                                | lane-wise subtraction                                |
| `@f32x4.mul`                                | lane-wise multiplication                             |
| `@f32x4.div`                                | lane-wise division                                   |
| `@f32x4.eq`                                 | lane-wise equality mask                              |
| `@f32x4.less`                               | lane-wise less-than mask                             |
| `@f32x4.select`                             | choose lanes from two vectors by mask                |
| `@f32x4.shuffle`                            | four constant lanes selected from two vectors        |
| `@f32x4.mask_{all,any}`                     | reduce a float comparison mask                       |
| `@f32x4.sum`                                | add the four lanes together                          |
| `@f32x4.x`                                  | read lane zero, and `.y`, `.z`, `.w` for the rest    |
| `@i32x4.of`                                 | gather four checked `I32` lanes                      |
| `@i32x4.of_wrapping`                        | gather four `Int` values modulo 2³²                  |
| `@i{8,16,32}xN.splat`                       | copy one width-checked integer into every lane       |
| `@i{8,16,32}xN.splat_wrapping`              | copy one explicitly wrapped `Int` into every lane    |
| `@i{8,16,32}xN.{add,sub}`                   | lane-wise wrapping arithmetic                        |
| `@i{16,32}xN.mul`                           | lane-wise wrapping multiplication                    |
| `@i{8,16,32}xN.{and,or,xor,not}`            | lane-wise bit operations                             |
| `@i{8,16,32}xN.{shl,shr_s,shr_u}`           | lane-wise shifts by a scalar amount                  |
| `@i{8,16,32}xN.{eq,lt_s,lt_u}`              | lane comparison producing its mask                   |
| `@i32x4.{ne,gt_s,gt_u,le_s,le_u,ge_s,ge_u}` | remaining comparisons                                |
| `@i{8,16}xN.ne`                             | lane-wise inequality                                 |
| `@i{8,16}xN.{gt,le,ge}_{s,u}`               | remaining ordered comparisons                        |
| `@i{8,16,32}xN.{min_s,min_u,max_s,max_u}`   | lane-wise extrema                                    |
| `@i{8,16,32}xN.select`                      | select lanes from two vectors by matching mask       |
| `@i{8,16,32}xN.mask_{bitmask,all,any}`      | reduce a matching mask                               |
| `@i32x4.lane`                               | read a compile-time-selected lane in `0..3`          |
| `@i32x4.laneN`                              | read constant lane `N`; `with_laneN` replaces it     |
| `@float.of_int`                             | widen an integer to a float                          |
| `@int.of_float`                             | truncate a float toward zero                         |
| `@text.concat`                              | concatenate text                                     |
| `@text.len`                                 | count Unicode code points                            |
| `@text.scalar_at`                           | read one validated Unicode scalar                    |
| `@text.slice`                               | slice at validated Unicode scalar bounds             |
| `@text.find_from`                           | find a substring from a Unicode scalar offset        |
| `@text.cmp`                                 | compare text and return an ordering constructor      |
| `@text.contains`                            | test whether text contains a query                   |
| `@text.of_int`                              | render an integer as decimal text                    |

Division and remainder by zero are errors. Runtime integer results outside
signed 64-bit range trap.

### 13.3 Arrays and shapes

| primitive              | meaning                                             |
| ---------------------- | --------------------------------------------------- |
| `@array.empty`         | polymorphic empty array                             |
| `@array.len`           | array length                                        |
| `@array.copy`          | explicit shared-to-owned array copy                 |
| `@array.get`           | proof-required indexed read                         |
| `@array.set`           | proof-required immutable indexed replacement        |
| `@array.push`          | immutable append                                    |
| `@array.indexed`       | iterator yielding an index proof and selected value |
| `@array.take`          | proof-required consuming value and remainder        |
| `@array.split`         | proof-required consuming prefix, value, and suffix  |
| `@continuation.cancel` | consume a handler continuation without resuming it  |
| `@shape.empty`         | empty shape                                         |
| `@shape.get`           | get a field named by text                           |
| `@shape.remove`        | immutably remove a field named by text              |
| `@shape.names`         | field names in insertion order                      |
| `@shape.has`           | return `#True` or `#False` for field membership     |

Array indexing is zero-based. Direct primitive access is accepted only with a
static bounds proof; the prelude's total `Array.get` and `Array.set` return an
`Option`.

#### A field named by a value

`@shape.get` and `@shape.remove` name their field with a text value rather than
with a literal, so no signature can state what they produce. They are typed at
the call site instead, by the name:

- when the whole projection can be evaluated at compile time, what it produced
  is the result's type;
- otherwise, when the name alone can be, the call is an ordinary field
  projection and is typed as one. `@shape.get r "a"` has the type of `r.a` and
  is refused when `r` has no `.a`; `@shape.remove` answers with the target's
  fields minus that field.

```blot
let r = { .a = 7; }
let z :: 0
let z = @shape.get r "a"
// BLOT_TYPE_ERROR: `7` is outside `0`.
```

A name known only at run time has no structural result type: a heterogeneous
record has no one element type, and width subtyping hides its complete field
set. Runtime `@shape.get` or `@shape.remove` with such a name is
`BLOT_DYNAMIC_SHAPE_FIELD`. Compile-time shape folds may use dynamic names while
evaluating; their unevidenced result variables cannot prove a signature. Runtime
dynamic keys belong in the prelude's homogeneous `Map` abstraction. Computed
shape fields are the construction form for names that settle at compile time.

`Map.of (K, V)` is represented by an association array of `(K, V)` pairs.
`Map.with equal` supplies key equality explicitly and returns the operations for
that equality. The first matching key is visible. Its operations are ordinary
prelude source:

- `empty` and `singleton (key, value)` construct maps;
- `get (entries, key)` and `has (entries, key)` observe a map;
- `put (entries, key, value)` returns `(previous, updated)`;
- `remove (entries, key)` returns `(removed, updated)`;
- `alter (entries, key, transform)` transforms `#Some previous` or `#None`;
- `update (entries, key, transform)` invokes its transform only when present;
- `append left right` inserts the right map's entries into the left map; and
- `fold`, `map`, `filter`, `length`, `keys`, `values`, and `items` provide the
  collection operations.

The previous or removed value is an `Option`. Returning it is significant for
ownership: replacing or removing an owned value does not silently discard it.
`alter` and `update` also return `(previous, updated)`. An alter callback
removes the visible key by returning `#None` and inserts or replaces by
returning `#Some value`; an update callback returns the same `Option` result but
is not called for a missing key. Starting from `empty`, these operations keep
keys unique. A manually built association array with duplicate keys has defined
first-match behavior; `put` or `remove` affects only that visible entry. `Dict`
is `Map.with` text equality, so `Dict.of V` remains the concise type constructor
for `(Text, V)` maps. `OrderedTextMap` is the distinct owned, strictly ordered
API described in §11.4; it does not change `Map` or `Dict` representation or
iteration order.

#### Safe indexed access

There are two indexed APIs, chosen explicitly.

`Array.get (xs, index)` and `Array.set (xs, index, value)` are total. They
return `#Some result` when `index` is in bounds and `#None` otherwise. Their
guard is ordinary prelude source.

`@array.take xs index` and `@array.split xs index` consume the input while
preserving every element. They are proof-required direct operations:

```text
@array.take  : ([A], refined Int) -> (A, [A])
@array.split : ([A], refined Int) -> ([A], A, [A])
```

Here `refined Int` is not a second integer representation or a dependent runtime
type. It means the call-site refinement context proves
`0 <= index < Array.length xs` for the same immutable array identity. `take`
returns the selected value and an ordered remainder. `split` returns the ordered
prefix, selected value, and ordered suffix. No result constructor or failure
payload remains because an unproved call is rejected before execution. The
operations must be saturated at their source site and cannot be hidden behind an
alias or ordinary prelude closure, just like direct `@array.get` and
`@array.set`.

These are the extraction operations for an array whose elements carry ownership
obligations. Their meaning is identical for staged and runtime arrays: making
the array or index host-dynamic changes when decomposition runs, not which
programs the compiler accepts or which tuple it produces.

`Array.uncons xs` is the index-free total decomposition used by structural array
algorithms. It consumes `xs` and returns `#None` exactly when it is empty;
otherwise it establishes `0 < Array.length xs` and returns
`#Some (first, remainder)` through direct `@array.take xs 0`. The remainder
preserves the order of every element after `first`. Its ordinary parameter
admits arrays whose elements have no ownership obligation. Owned extraction uses
a proved direct `@array.take` or `@array.split` call so every obligation is
returned without copying.

`Array.partition (xs, belongs_left)` classifies an array in one stable pass. It
calls `belongs_left` exactly once for each element and returns `(left, right)`;
`left` contains the elements for which the predicate returned `#True`, `right`
contains the rest, and relative order is preserved within both outputs. This is
a value-level collection operation, distinct from the partition witnesses of
owned regions: it produces two independent arrays rather than two authorities
over one backing Store.

With the current contiguous Store representation, `uncons` takes linear time and
allocates the remainder, while `partition` takes linear time and allocates two
output Stores containing a total of `Array.length xs` elements. Stable partition
cannot generally reuse the input Store as either output without moving the other
class or retaining a view. `Array.append left right` visits `right` and produces
one contiguous result; the generic monoid operation does not itself promise that
either input allocation is reused. Append neither aliases both inputs nor
restores a Store previously separated by `partition`. Zero-copy split/rejoin is
the separate `Slice`/region operation and carries its proof explicitly.

`Array.get` and `Array.length` bind their array parameter with `&`: observing an
array does not consume it. An explicitly borrowed array must be passed in that
position directly; the borrow cannot be retained by an intervening binding.

`Range` is the ordinary half-open `{ .start; .end; }` metadata also exposed as
`Slice.Range`; it carries no ownership authority. `Range.whole (&values)` is
`[0, Array.length values)`, and `length`, `last`, `before`, `after`, and
`shorter_first` are pure metadata operations.

`Array.quicksort (values, before_or_equal)` consumes the Array Store directly
and returns its sorted successor. It performs no entry copy and is unstable. Its
prelude kernel partitions in place, recursively evaluates the shorter range
first, and tail-calls the longer range, bounding non-tail recursion by
`O(log n)`. The expected comparison count is `O(n log n)` and the worst case is
`O(n^2)`; owned `set` operations reuse the Store, subject only to ordinary
capacity behavior. The kernel carries `@[assert.reuse]`, so a future lowering
that introduces a persistent update is rejected.

`Scratch.of T` is the opaque affine builder type for an Array of `T`.
`Scratch.with_capacity n` creates an empty builder with room for at least the
non-negative capacity `n`; its element type is inferred from later pushes or the
surrounding signature. `Scratch.push (scratch, value)` consumes the old builder
and initializes its next position. `Scratch.finish scratch` consumes the builder
and returns its initialized prefix as an owned Array without a copy.
`Scratch.recycle values` consumes an owned Array, discards its droppable
elements, and retains its allocation as an empty builder. Recycling an Array
whose element ownership tree contains an exact linear obligation is rejected.
Scratch values cannot be shared or cross a host boundary. Capacity and the
uninitialized suffix are never source values.

`Array.build (capacity, fill)` is the ordinary source-level builder path. `fill`
receives an `Array.Builder.of T`, advances it with
`Array.Builder.push (builder, value)`, and returns the resulting builder.
`Array.build` consumes it and returns an immutable `[T]`. The abstraction erases
to the same Scratch allocation and owned writes; an unfinished builder cannot
cross the public ABI.

`Array.merge_sort (values, before_or_equal)` is stable and consumes the input
Store. It performs bottom-up merging between one Array and one Scratch builder,
recycling the previous source after each pass. It takes `O(n log n)` comparisons
and initialized writes, allocates one `O(n)` scratch element buffer, and emits
no persistent element-Store update after acquisition.

`Array.radix_sort (values, key, strategy)` consumes an Array, calls the pure
`key : T -> Int` exactly once for each element, and orders by the cached signed
integer keys. `Radix.unstable` uses an in-place base-256 American-flag
permutation with one `O(n)` cached-entry Store and fixed bucket metadata.
`Radix.stable` uses base-256 stable scatter between two initialized cached-entry
Stores; it preserves the input order of equal keys and uses two `O(n)` auxiliary
allocations: the cached-entry Store and its scatter Store. The final projection
reuses the consumed input allocation. Both strategies handle the complete signed
integer range without negating `Int` minimum. Actual cached extrema bound the
digit work, so non-negative and narrow refined keys skip irrelevant sign and
high-digit passes without a callee-name specialization.

`@array.get xs index`, `@array.set xs index value`, `@array.take xs index`, and
`@array.split xs index` are the direct path. The checker accepts them only when
every value of `index` is inside `0..@array.len xs - 1`. An index known to be
outside reports `BLOT_OUT_OF_BOUNDS`; an index with no sufficient proof reports
`BLOT_UNPROVEN_INDEX` and points to the total API:

```blot
let xs = [1, 2, 3]
return @array.get xs 99   // BLOT_OUT_OF_BOUNDS: Index 99 is outside an array of 3.
```

The proof belongs to the saturated primitive call. These primitives cannot be
aliased or partially applied: doing so would separate the eventual index from
the site that must carry its certificate and is `BLOT_ARRAY_ACCESS_NOT_DIRECT`.
`get` and `set` have total `Array.get` and `Array.set` wrappers. Consuming
`take` and `split` deliberately do not: replacing their proof with an empty
fallback would either discard an owned element or encode an optional element as
an unconstrained array.

```blot
let at :: [Int] -> Int -> Int
let at = fn xs => fn n => if n >= 0 && n < @array.len xs:
  return @array.get xs n
else:
  return 0
```

The second needs no concrete length. The conjunction adds `0 <= n` and
`n < len xs` to the branch's refinement context (§8.5), and the read names the
same immutable array value. The primitive records an erasable `array-index`
certificate containing normalized literal-or-identity terms and the affine
assumptions used to prove the interval. The certificate contains no inference
type, and a separate difference-constraint checker must replay it before
lowering may emit the Store access or decomposition. After replay, the direct
Runtime-HIR emitter omits a second bounds decision: an invalid index must have
been refused by the checker, while a total prelude read or write reaches the
direct primitive only through its ordinary successful guard. Gpufuck's range
lowering applies the same erasure to the certified residual comparison.

`@array.indexed xs` is the proof-producing traversal path (§9.2). Its `.step`
performs one bounds decision to decide whether another element exists. A
successful step packages the already selected element with its index proof, so
reusing that index for the same immutable array requires no second check. The
package is compiler evidence, not a source constructor, and is erased before the
Runtime-HIR boundary.

The relationship survives ordinary immutable bindings:

```blot
let ys = xs
let length = @array.len xs
let last = length - 1
if n >= 0 && n <= last:
  return @array.get ys n
else:
  return 0
```

It does not become part of `[T]` or attach to an unstable value identity. It may
cross an ordinary function result only through the verified structural package
transform described in §9.2; an arbitrary call publishes no relationship. A `:=`
to a different value invalidates facts about the previous value. These cases
fail closed with `BLOT_UNPROVEN_INDEX` rather than leaving a possible runtime
trap.

For iteration, `Iter.items xs` yields each value and `Iter.indexed xs` yields
`(index, value)`. Both perform one total termination test per iteration, so a
loop body does not repeat the source-level test or perform another lookup:

```blot
for (index, value) in Iter.indexed xs:
  use visit (index, value)
```

### 13.3.1 Applying a requirement

The checker has one judgment, `subject satisfies requirement`. Both a signature
header and `@satisfies` use it; the header additionally drives bidirectional
checking of a following lambda and therefore requires the canonical type form.

`@satisfies value requirement` is the expression form. It returns `value`
unchanged and accepts either form of requirement. The compiler retains a
canonical requirement as representation evidence, so an empty array refined to
`[T]` still has the element layout needed by residual code:

1. A canonical type value constrains the subject's open inferred type.
2. A compile-time predicate receives the subject's closed, reifiable inferred
   type and must answer `#True` or `#False`.

```blot
// Canonical requirements refine unknowns and grant the operations they name.
let name_of = fn value =>
  let named = @satisfies value { .name = Text; }
  return named.name

let int_store = fn values => @satisfies values [Int]

const Console = @effect { .write = Text -> Unit; }
let command = fn callback =>
  @satisfies callback (Text -> Unit ~ { Console })

// Predicates compose over a closed inferred type.
const is_shape = fn type => case reflect type of
  #Shape _ => True
  _ => False
const has_name = fn type => refines (type, { .name = Text; })
const named_shape = fn type => is_shape type && has_name type

let person = { .name = "Ada"; .age = 36; }
let checked = @satisfies person named_shape

// Requirements can themselves be staged and specialized.
const require = fn requirement => fn value => @satisfies value requirement
let also_checked = require { .name = Text; } person
```

The distinction is semantic, not syntactic sugar. Canonical values—integer
ranges, arrays, records, variants, arrows and their effect rows, seals, and
attached layout namespaces—normalize through the existing type bridge and add
ordinary lattice constraints. They may therefore refine a fresh variable.
Predicates are arbitrary pure source composition over `reflect`, `refines`,
`type_equal`, and quantifier elimination, but they only inspect a type that has
already settled. They may reject it; they cannot grant a field, choose a layout,
insert an effect, or add an opaque closure to the solver.

A false predicate is `BLOT_DOES_NOT_SATISFY`. An open subject given to a
predicate is `BLOT_TYPE_NOT_REIFIABLE`; use the canonical record, array, arrow,
or scalar type value as the requirement when the purpose is to constrain that
subject. A requirement unavailable until generic specialization is deferred and
checked when the concrete call supplies it.

`@type.of` is different: it evaluates a compile-time value and returns that
value's type. `@satisfies` can inspect the inferred type of an ordinary runtime
expression without evaluating the expression itself.

The prelude keeps `Is expected` and `Has shape` as ordinary one-line
compatibility predicates over `type_equal` and `refines`. They add no
type-system mechanism; new code can spell the underlying question directly, as
the examples above do.

### 13.4 Type values

| primitive              | meaning                                           |
| ---------------------- | ------------------------------------------------- |
| `@type.unbounded`      | open range bound                                  |
| `@type.int`            | signed 64-bit runtime integer domain              |
| `@type.text`           | unbounded text domain                             |
| `@type.float`          | the double domain, which has no bounds            |
| `@type.float32`        | the single-precision domain                       |
| `@type.f32x4`          | four single-precision lanes, an opaque type       |
| `@type.f32x4_mask`     | four comparison lanes, an opaque type             |
| `@type.unit`           | unit type/value                                   |
| `@type.range`          | inclusive range                                   |
| `@type.refine`         | normalize a pure integer predicate into a type    |
| `@type.equal`          | exact alpha-equivalent equality of type values    |
| `@type.instantiate`    | eliminate one outer quantified type variable      |
| `@type.probe`          | eliminate one binder with a kind-correct witness  |
| `@type.union`          | flattened duplicate-free union                    |
| `@type.intersect`      | intersection of union members                     |
| `@type.diff`           | difference of union members                       |
| `@type.arrow`          | function type value                               |
| `@type.deferred_arrow` | deferred function type value                      |
| `@type.performs`       | attach an effect row to a function type           |
| `@type.of`             | structural singleton type of a compile-time value |
| `@type.seal`           | nominally seal a carrier under a text name        |
| `@type.open`           | recover a sealed carrier                          |
| `@type.attach`         | attach one namespace member to a type value       |
| `@type.members`        | recover attached namespace members                |
| `@type.reflect`        | inspect the representation of a type value        |
| `@type.union_of`       | union a non-empty array of type values            |

An empty intersection or difference, and `@type.union_of []`, are errors; Blot
has no value representing an empty compile-time union.

`@type.reflect` returns one of:

```text
#Int value
#Text value
#Unit
#Unbounded
#Tag { .name; .payload = #None | #Some value; }
#Range { .low; .high; .domain = #Int | #Text | #F64 | #F32; }
#Union members
#Shape fields
#Array elements
#Arrow { .domain; .codomain; .effects = [effect]; }
#Forall
#Sealed { .name; .inner; }
#Opaque
```

A saturated reflection that evaluates at compile time receives the exact type of
this result. A generic payload which cannot yet be related to the reflected
input is marked unevidenced: compile-time generic code may manipulate it, but it
cannot discharge a runtime signature. A fresh inference variable is therefore
never permission to claim an arbitrary reflection payload type.

`#Forall` deliberately carries no payload. The compiler's binder identity and
the open body are not source values: use `@type.instantiate quantified argument`
to substitute one chosen closed argument, then reflect the result. Generic
structural predicates that do not care about the binder's kind use
`@type.probe quantified`: it substitutes `Unit` for an ordinary type binder or
the empty row for an effect-row binder. Passing a value whose outer constructor
is not `forall`, or explicitly substituting a non-effect into an effect-row
variable, is `BLOT_TYPE_INSTANTIATE`.

Deferred parameters are an elaboration modality and therefore do not appear in
reflection or exact type-value equality. Their demand discipline is still
checked from the lambda and signature syntax before residual lowering.

`@type.equal left right` compares exact type values while treating quantified
binder names as irrelevant, unions and effect rows as sets, and attached source
namespaces as transparent. It is primitive because reflection intentionally
hides binders, opaque identities, and effect internals. Higher questions remain
ordinary source predicates:

```blot
const both_types = fn (left, right) => fn type => left type && right type
const is_shape = fn type => case reflect type of
  #Shape _ => True
  _ => False
const is_named_shape = both_types (
  is_shape,
  fn type => refines (type, { .name = Text; })
)
```

`#Opaque` is everything with no parts to report: a closure, a primitive, a host
function, an effect, and `F32x4`, whose whole content is its name.

### 13.5 Ownership markers

`@linear.own`, `@linear.maybe`, `@linear.borrow`, and `@linear.freeze` are
runtime identities whose meaning comes from ownership analysis. The first three
back the default prefix fixities `!`, `?`, and `&`; `freeze` is the prelude name
for the fourth. A `?name` pattern introduces an at-most-once obligation;
`?expression` explicitly transfers that affine value to a parameter which
promises at-most-once use. The expression marker does not make a shared value
unique: ownership analysis still rejects a second move or a callee without the
matching affine parameter contract. `@linear.freeze` consumes Array Store
authority without copying bytes and rejects embedded non-Store resources.

## 14. Standard prelude

The standard prelude is ordinary Blot source at `blot:prelude`. Its public
record currently exports:

Focused modules `blot:array`, `blot:collections`, `blot:iter`, `blot:memory`,
`blot:sort`, and `blot:types` expose smaller ordinary records over the same
values. They are import conveniences, not privileged scopes or independent
implementations. [STDLIB.md](STDLIB.md) is the generated exact export index.

- function tools: `Fn`, `identity`, `always`, `compose`, `flip`, `freeze`;
- effect contract tools: `Effect.operation`, `Effect.consumes`, and
  `Effect.produces`;
- declaration-tag tools: `tag`, `derive`, `test`, and `assert.reuse`;
- booleans: `Bool`, `True`, `False`, `Logic`, `not`, `expect`;
- ordering and arithmetic: `Ordering`, `is_equal`, `is_less`, `is_greater`, and
  the operations attached to `Int`;
- floats and lanes: operations attached to `F64`, `F32`, `F32x4`, `I32x4`,
  `I16x8`, and `I8x16`;
- branch hints: `likely` and `unlikely` (§15.1);
- structural interfaces: `Empty`, `Length`, `Semigroup`, `Monoid`, `Mappable`,
  `Foldable`, `Filterable`, and `Iterable`;
- text: `Text`, `text_eq`;
- arrays: `Array` (including `copy`, `quicksort`, and checked range helpers),
  `Range`, `fold`, `each`, `map`, `filter`, `partition`, `sum`, `upto`, `any`,
  `every`, and `sort_by`;
- collections: `List`, `Map`, `Set`, `Shape` (`entries` and `update`), and the
  text-keyed `Dict` specialization;
- iterators: `ever`, `Iter` (`range`, `items`, `indexed`, `affine`, `slice`,
  `reverse`, `iterate`, and `collect`), `iterate`, and `collect`;
- variants: `Option`, `None`, `Some`, `unwrap_or`, `Result`, `Ok`, `Error`;
- type tools: `Type`, `attach`, `seal`, `unseal`, `Reflect`, `reflect`,
  `type_equal`, `instantiate`, `refines`, `Is`, `Has`, `members`, `union_of`,
  `Extract`, `Exclude`, `Pick`, `Omit`, `opened`, and `range`;
- storage tools: `struct`, `reorder`, `layout`, `aligned`, `bit_width`, and
  `packed`; and
- standard types and integer range constructors: `I`, `I8`, `I16`, `I32`, `I64`,
  `U`, `U8`, `U16`, `U32`, `U64`, `Nat`, `Int`, `Text`, `Unit`, `F64`, `F32`,
  `F32x4`, and `F32x4Mask`.

`Empty T`, `Length T`, `Semigroup T`, and `Monoid T` are structural interface
types:

```blot
const Empty = fn T => { .empty = T; }
const Length = fn T => { .length = T -> Int; }
const Semigroup = fn T => { .append = T -> T -> T; }
const Monoid = fn T => { .empty = T; .append = T -> T -> T; }
```

They do not perform implicit dispatch. An implementation is an ordinary record
passed explicitly or named directly. `Text` satisfies both `Length Text` and
`Monoid Text`. `Array` satisfies `Length [T]` and `Monoid [T]`; its `length`
implementation borrows the array, while its `append` is prelude source over
`fold` and `@array.push`. `Arena` supplies `singleton`, affine `insert`,
borrowed `length`, and safe `get` over the same array representation. Ownership
remains a separate flow property rather than part of the structural interface
type. The fixed `<>` is the concrete text operation `Text.append`; arrays use
the named `Array.append` operation. Fixed vocabulary keeps parsing, formatting,
tooling, and review independent of a module-local operator environment.

Collection interfaces are structural too:

```blot
const Mappable = fn (F_A, F_B, A, B) => {
  .map = (F_A, (A -> B)) -> F_B;
}
const Foldable = fn (F_A, A, S) => {
  .fold = (F_A, S, ((S, A) -> S)) -> S;
}
const Filterable = fn (F_A, A) => {
  .filter = (F_A, (A -> Bool)) -> F_A;
}
const Iterable = fn (F_A, A, S) => {
  .items = F_A -> { .state = S; .step = S -> Option (A, S); };
}
```

Blot has no higher-kinded inference variable, so these interfaces describe one
concrete source and result instantiation. A polymorphic namespace such as `List`
or `Array` structurally satisfies every compatible instantiation; callers still
pass or name that namespace explicitly.

`List.of A` is an immutable arena-backed list. Its representation is an array of
`(A, Int)` nodes paired with the head address; `-1` is empty. `List.view A` is
`#Nil | #Cons (A, List.of A)`, and `List.uncons` produces that one-step view for
pattern matching. `List` also supplies `empty`, `singleton`, `prepend`,
`append`, `fold`, `map`, `filter`, `reverse`, array conversion, `length`, and an
`items` iterator. These are ordinary source functions and can execute during
comptime evaluation.

`Set.of A` is an insertion-ordered array of unique values. `Set.with equal`
returns operations for the supplied equality: construction, membership,
`insert`, `remove`, `append`/`union`, `intersect`, `diff`, `fold`, `filter`,
`map`, `map_with`, `length`, and `items`. `insert` and `remove` return
`(previous, updated)` so replacing or removing an owned value never silently
discards it. `map` uses the namespace's equality for an endomorphic transform.
When mapping changes the element type, `map_with` takes the result equality
explicitly and removes mapped duplicates:

```blot
set.map_with (values, mapped_equal, transform)
```

`Map.with` and `Set.with` require curried equality. `Int.eq` already has that
shape; text equality can be adapted explicitly:

```blot
Set.with (fn left => fn right => text_eq (left, right))
```

Equality selection is visible at the construction site; there is no implicit
instance lookup.

Important conventional values include:

```blot
const Bool = #True | #False
const Option = fn value => #None | #Some value

const ever = {
  .state = ();
  .step = fn _ => #Some ((), ());
}
```

`Iter.range (low, high)` iterates from `low` inclusive to `high` exclusive.
`Iter.items array` iterates an array. `Iter.affine`, `Iter.slice`, and
`Iter.reverse` traverse one array in affine address order without constructing
an intermediate array (§9.3). `struct` builds positional storage with a named
constructor, accessors, and metadata attached to the type value.

Changing the prelude's public record is a language-library change and must
update this specification.

## 15. Runtime and compilation

The Rust evaluator gives runtime and compile-time code the same semantics, apart
from integer representation and phase restrictions. A valid compiled program
must agree between the Rust evaluator and emitted WebAssembly. Independent
oracles may consume validated Runtime HIR, but they do not define acceptance.

Before Runtime-HIR lowering, Blot:

- evaluates and erases compile-time-only values;
- elaborates live block declarations into explicit Core `define` and `bind`
  steps with `return` or effectful tail results;
- records each residual node's settled type through a graph-form Core `TyRep`
  table, including recursive inference bounds and effect rows;
- represents imports, constructors, checked pass-through values, static members,
  and intrinsic applications directly instead of assigning invented function
  types to their erased surface syntax;
- specializes algebraic-subtyping results into concrete Core uses;
- lowers shapes and tuples to nominal records;
- lowers constructor sets to nominal variants;
- lowers arrays to backend `Store` values;
- marks a Store update owned only when it consumes a proved linear or affine
  array;
- lowers each recursive group to one local `let-rec` group;
- specializes source handlers with selective CPS; and
- turns host effects and entry-module projections into typed imports.

Runtime exports require a concrete first-order ABI. Supported boundary values
include integers, text, unit, booleans, concrete records, arrays, variants,
seals, and functions over supported values. Types and effects remain
compile-time manifest entries and have no invented runtime encoding. An exported
function's curried source domains become ordered ABI parameters; calling it
enters the same residual function graph used by internal direct and recursive
calls. Its parameters and result therefore obey the same trapping, effect, and
immutable-Store semantics as an in-module application.

Residual recursion becomes a direct runtime function call. Runtime values that
are lexically free in the recursive closure become additional internal function
parameters and are passed at every recursive edge; compile-time free values stay
erased. Recursion residualizes when either its explicit argument or one of those
free values is runtime-known. Inferred closure signatures are checked facts
attached to the defining module and lambda body, including when that module is
loaded from the compiler-distributed prelude snapshot. Higher-order applications
instantiate their representation variables before a nested recursive closure is
lowered. Checked application-result types supply the same representation fact to
the production compiler. If the ownership certificate proves that a recursive
result is exactly one linear parameter component, lowering may carry that
component's representation through the recursive call without a copy. These
transformations change neither source scope nor the public ABI.

Call-site representation substitution traverses tuples, shapes, variants, and
non-empty arrays. A runtime element in an otherwise staged array therefore
settles the array element representation before a generic recursive callee is
lowered. Lowering may not ignore that settled representation and reject the same
well-typed call merely because one aggregate component is residual.

A positive recursive result equation is closed automatically. Runtime HIR schema
6 represents its root as one private indirect word whose target is allocated in
the export call's scratch arena; constructor payloads may refer back to that
root. Constructor matching loads the target before inspecting its tag, while a
recursive edge copies only the indirect word. The representation is entirely
compiler-owned: source programs do not name boxes, pointers, regions, or
lifetimes. A recursive value may be used internally to produce an ABI-supported
result, but the indirect root itself cannot cross Blot Core Wasm ABI 2. A
self-only result equation with no constructor case is refused rather than given
an invented inhabitant.

A residual structurally polymorphic function is specialized to a concrete record
shape before Runtime HIR. The shape is the one that _flows_ to the projection,
not the narrower one the body reads: inference follows what flowed into the
projected variable, across the instantiation a `let`-bound scheme makes for each
of its callers, so `let get_x = fn v => v.x;` takes its record from the call
sites. When nothing flows in — a parameter whose caller is outside the program —
the fields the body demands decide instead, and they are unioned.

An immutable alias does not hide the lambda being specialized. Function-valued
leaves retain that identity through nested records, tuples, and literal arrays,
including immutable aliases of a nested aggregate. A statically known
higher-order function may pass such a value through a named parameter and return
one of its statically selected leaves; the compiler follows that result and
still clones the original lambda at each concrete call shape. A run-time
conditional whose alternatives are statically known lambdas retains a single
evaluated selector and specializes both alternatives at each concrete call
shape. The same rule follows a known higher-order function whose direct body is
that conditional: its argument is evaluated once, remains available to closures
returned by either branch, and supplies the selector. A closure whose source set
cannot be recovered from known whole-program control remains a residual
representation boundary.

A shape parameter destructured in place is specialized by the same rule. For
example, separate calls to `fn { .x = value; } => value` with `{ .x; .y; }` and
`{ .x; .z; }` lower the parameter pattern against the respective concrete
nominals rather than against an invented one-field record.

Those call sites may be in another module. A record crosses into a module
carrying more fields than that module reads and lowers there (§3), because the
field sets are settled after every module in the program has been checked rather
than as each one finishes: the answer for a projection in one file is decided by
a call site in another.

A shape nested inside a tuple `case` uses the concrete element type from the
specialized call. Thus `case pair of ({ .x; }, _) => x end` may receive tuples
whose first elements carry additional fields, and separate calls may carry
different additional fields; each clone destructures the nominal actually passed
to that call.

Two different records reaching one runtime `let` lambda produce one specialized
body per call shape. Each clone projects from the nominal actually passed at
that call; the compiler neither merges the field sets nor invents a wider
record. A structurally polymorphic function crossing the external ABI still
needs a concrete signature, because an unknown caller cannot be whole-program
specialized.

A compile-time array of field names may drive a residual structural fold. The
compiler evaluates the fold's recursive control while the name and index are
static, but retains operations over runtime values. Thus a fold containing
`@shape.get value name` becomes one direct projection per name followed by the
residual scalar operations; neither the recursive iterator nor a dynamic field
name reaches Runtime HIR. This is ordinary partial evaluation of `fold`, not an
ECS-specific lowering rule. If the field-name array is not known at compile
time, the ordinary dynamic-shape refusal still applies.

### 15.1 Core WebAssembly ABI

`blot build` validates Blot Runtime HIR, constructs the ABI adapters specified
here, and emits the resulting plan through the checked Rust/WebAssembly emitter.
The compiler parses through Baba 9's CPU frontend and materializes its compact
CST without initializing WebGPU. When Baba reports only its built-in signed-I32
literal policy, Blot re-ingests those already-identified token spans with
offset-preserving zero spellings and materializes the original I64 text; no
tokenization rule is duplicated. The external conformance tools may exercise
alternate frontends or evaluators, but they are not compiler targets. Generated
modules implement Blot Core Wasm ABI 2.0. Backend-private values and heap
objects never cross the generated adapters, which expose the synchronous
memory32, UTF-8 subset of the Component Model Canonical ABI.

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

Text primitives are module-local Wasm operations, not host imports. Public
indices are Unicode scalar positions. `Text.scalar_at`, `Text.slice`, and
`Text.find_from` return `Option` for invalid bounds or a missing substring;
their checked prelude paths guard the lower-level scalar-at, slice, and search
operations. Runtime and compile-time evaluation use the same scalar semantics.
`Text.split`, `Text.lines`, `Text.trim`, `Text.scalars`, starts/ends-with, and
`Text.replace` are ordinary prelude functions over those operations.

The backend retains UTF-8 internally: scalar count and offset helpers scan lead
bytes, while substring matching scans bytes only after both input texts and the
starting scalar boundary are validated. Consequently a match cannot begin in a
continuation byte and returned indices remain scalar positions.

The JSON sidecar and the `blot:abi` custom section contain identical bytes. The
manifest is the authoritative structural contract for exports, imports,
operation input and result ownership, record fields, variant cases, and seals.
ABI 2 layout and meaning are stable within major version 2; an incompatible
change requires another major. The byte-level layouts and host calling example
are in [docs/abi.md](docs/abi.md).

## 16. Complete example

```blot
module with init

open import "blot:prelude"

const Console = @effect.host {
  .write = Text -> Unit;
}

const Message = #Ready | #Failed Text

let describe = fn message => case message of
  #Ready => "ready"
  #Failed reason => reason

let attempts = 0
for ever:
  attempts := attempts + 1
  if attempts >= 3:
    break

let report = fn () =>
  let text = describe #Ready <> Text.of_int attempts
  use Console.write text
  return text

return {
  .attempts = attempts;
  .report = report;
}
```

This module receives its authority through `init`, explicitly opens the prelude,
constructs types as values, uses `for` as a fold with an inferred accumulator,
declares a host effect as its interface, and returns a concrete record suitable
for staging and WebAssembly lowering.
