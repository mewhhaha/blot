# Idiomatic Blot

This is the practical guide to writing Blot that reads like Blot. It is not the
language specification; [LANGUAGE.md](LANGUAGE.md) defines what programs mean.
This guide chooses among the legal spellings and shows the one a reader should
expect to encounter.

The short version is:

- ask explicitly for every name and capability;
- treat types, interfaces, effects, and namespaces as ordinary values;
- use `const` for compile-time knowledge and `let` for runtime values;
- shadow names freely as one logical value is refined or re-represented;
- use early `return` and guards so the main path stays flat;
- use `case` to explain data and statement `if` to explain control;
- prefer `for` for ordinary iteration and treat its `:=` names as the
  accumulator;
- sequence effects with `<-`, even when their result is discarded;
- pass interface implementations explicitly;
- use operators and prelude functions in application code, leaving `@`
  primitives at implementation boundaries; and
- let `blot fmt` decide layout.

Blot's house style is deliberately direct. Write the local steps a person would
say out loud. Reuse the domain name when a step replaces its meaning, use a
`for` when the code walks values, and return as soon as a path is finished. Do
not turn straightforward control flow into nested callbacks merely because the
language is functional: the compiler already lowers `for`, `if`, and `return` to
the smaller functional core.

## Pretend it is imperative; compose it functionally

Inside a function, code should read like an imperative procedure:

```blot
let publish = fn source =>
  values <- source.read ()
  let values = filter (values, fn value => value >= 0)
  let values = map (values, normalize)

  let total = 0
  for value in Iter.items values:
    total := total + value

  let report = render { .values = values; .total = total; }
  <- source.write report
  return report
```

The order is visible, obsolete versions are shadowed away, effects occupy their
actual position, and the accumulator has a domain name rather than a tuple slot.
Read it from top to bottom without mentally expanding combinators.

The implementation is still functional. Every `let` and `:=` introduces a new
immutable binding, `for` lowers to a fold, branches produce values, and effects
are explicit in `<-`. Nothing mutates an earlier value.

Compose at the larger scale. Functions take values and return values; modules
execute in source order from an optional input to one returned value:

```blot
let prepare = fn values =>
  let values = filter (values, valid)
  let values = map (values, normalize)
  return values

let summarize = fn values =>
  let total = 0
  for value in Iter.items values:
    total := total + value

  return { .values = values; .total = total; }

let run = fn source =>
  values <- source.read ()
  let values = prepare values
  let summary = summarize values
  <- source.write (render summary)
  return summary
```

The practical rule is: use imperative-looking control flow locally, then join
those local functions through ordinary functional composition. Do not simulate
mutation across boundaries, and do not make local code point-free merely to look
functional.

## Start every ordinary module explicitly

Nothing is implicitly in scope. Most application modules start by opening the
prelude:

```blot
open import "blot:prelude"

const Limit = 100

let clamp = fn value =>
  if value > Limit:
    return Limit

  return value

return { .clamp = clamp; }
```

Treat the returned record as the module's public surface. Keep support values
above it and return only what another module should depend on.

When a small module benefits from an explicit namespace, keep the prelude behind
a name instead:

```blot
const prelude = import "blot:prelude"

let answer = prelude.Num.add 20 22

return { .answer = answer; }
```

An import is a module instance. Supply capabilities or configuration with
`with`, then use its returned value:

```blot
let Counter = import "./counter.blot" with {
  .initial = 0;
  .limit = 100;
}

return { .run = Counter.run; }
```

## Open records in the smallest useful scope

`open` introduces ordinary lexical bindings and may shadow names outside its
scope. Keep a record behind its qualified name until a region actually benefits
from treating its fields as local vocabulary:

```blot
const prelude = import "blot:prelude"

let calculate = fn values =>
  open prelude

  let total = 0
  for value in Iter.items values:
    total := total + value

  return total

return { .calculate = calculate; }
```

This makes `Iter`, `Some`, `map`, and the operator targets available only where
they are being used. Outside `calculate`, readers still see `prelude` as one
dependency rather than dozens of ambient names.

Open a domain vocabulary around the code written in that domain:

```blot
const Colours = {
  .red = { .r = 255; .g = 0; .b = 0; };
  .blue = { .r = 0; .g = 0; .b = 255; };
}

let warning =
  open Colours
  let foreground = red
  let background = blue
  return { .foreground = foreground; .background = background; }
```

Opening the prelude at file scope remains idiomatic when most of the file uses
it. For narrower dependencies, prefer a local `open`. If only two or three
fields are wanted, destructure them instead of opening everything:

```blot
const { .source = input; .value; } = library
```

Treat an `open` like entering a vocabulary scope, not like copying a record.
Smaller scopes make intentional shadowing obvious and prevent unrelated code
from accidentally depending on the opened names.

## Choose bindings by phase and intent

Use `const` when the compiler must know the value. Types, effects, interface
descriptions, derived layouts, and configuration included from disk normally
belong here:

```blot
open import "blot:prelude"

const UserId = seal ("UserId", I64)
const Message = #Ready | #Failed Str
const Console = @effect { .write = Str -> Unit; }
const Config = @include "./config.json" as_const_json
```

Use `let` for runtime values:

```blot
let user_id = seal ("UserId", 42)
let status = #Ready
```

Put a `sig` directly above the binding it constrains. Signatures document a
boundary; they are not a substitute for inference on every local:

```blot
sig describe = Message -> Str
let describe = fn message => case message of
  #Ready => "ready"
  #Failed reason => reason
```

Treat `:=` as same-type shadowing, not mutation. It is appropriate when a name
represents one evolving logical value:

```blot
let count = 0
count := count + 1
count := count + 1
return count
```

Use a repeated `let` when the new binding deliberately has a different type:

```blot
let response = 200
let response = "accepted"
return response
```

Shadow by default when each step replaces the previous representation of the
same domain value:

```blot
values <- Source.values ()
let values = filter (values, fn value => value >= 0)
let values = map (values, fn value => value * 2)
return values
```

This is the intended style, not a concession. It is preferable to names such as
`raw_values`, `filtered_values`, and `doubled_values` when only the final
collection remains relevant. Those suffixes force every later line to remember
an implementation history that the program has already left behind.

A guard can deliberately replace a wrapper with its payload under the same name:

```blot
let candidate = Array.get (values, index)
if let #Some candidate = candidate else:
  return fallback

return candidate
```

Keep separate names only when both values remain live, when comparing stages is
the point, or when the names describe genuinely different domain concepts.
Shadow to discard an obsolete distinction; do not preserve every intermediate
merely because many languages discourage rebinding.

Name runtime values and functions with descriptive `snake_case`. Capitalize
types, effects, and namespace-like compile-time values by convention, and keep
the `#` on constructors:

```blot
const RequestState = #Waiting | #Running | #Failed Str
const Console = @effect { .write = Str -> Unit; }

let retry_delay = 200
let describe_state = fn state => case state of
  #Waiting => "waiting"
  #Running => "running"
  #Failed reason => reason
```

Capitalization does not create a second namespace. These are all ordinary
bindings, so choose it to help the reader rather than to satisfy the parser.

## Write functions for their call sites

Use one structured parameter for an operation whose arguments belong together:

```blot
let distance = fn (from, to) => Num.abs (to - from)

let move = fn { .position; .velocity; } => {
  .x = position.x + velocity.x;
  .y = position.y + velocity.y;
}
```

This keeps calls readable:

```blot
let gap = distance (2, 40)
let next = move { .position = point; .velocity = speed; }
```

Use currying when partial application is itself useful. Operator targets are
curried for exactly this reason:

```blot
let add = fn left => fn right => left + right
let add_two = add 2
let answer = add_two 40
```

Do not curry every multi-argument function by habit. If nobody needs an
intermediate function, a tuple or named shape says more at the call site.

Use parentheses for a tuple, for an explicit grouping that changes precedence,
or around a prefix operand where the grammar needs the boundary. Do not wrap a
lambda merely because it is an argument:

```blot
let total = fold (
  values,
  0,
  fn (state, value) => state + value
)
```

## Treat shapes, tuples, arrays, and variants differently

A shape has named fields and supports width subtyping. Use it for domain data
whose field names matter:

```blot
let point = { .x = 20; .y = 22; }
let moved = { ...point; .x = point.x + 1; }
let { .x; .y = height; } = moved
```

A tuple is a small positional product. Use it when position already carries the
meaning and the values travel together briefly:

```blot
let bounds = (0, 100)
let (low, high) = bounds
```

An array is a homogeneous sequence:

```blot
let values = [1, 2, 3]
let extended = [0, ...values, 4]
let doubled = map (values, fn value => value * 2)
```

A constructor describes which kind of value exists. Prefer a variant over a
record with a status field and conditionally meaningful fields:

```blot
const Result = fn value => #Ok value | #Error Str

let render = fn result => case result of
  #Ok value => Text.of_int value
  #Error reason => reason
```

Match a variant with `case`. The patterns should make the valid states visible
without requiring the reader to remember a Boolean convention.

Use `Option` for expected absence and `Result` for an expected failure that
carries an explanation. Handle either at the boundary where recovery is
possible:

```blot
let read_or = fn (values, index, fallback) =>
  if let #Some value = Array.get (values, index) else:
    return fallback

  return value
```

Use `@fail` for a compile-time refusal with a reason and `@panic` for a runtime
path that should be unreachable. Do not encode an expected failure as a panic.

## Use `case` to explain data

Prefer one `case` to a chain of equality tests:

```blot
let name = fn phase => case phase of
  #Starting => "starting"
  #Running => "running"
  #Stopped reason => reason
```

The linter offers this rewrite for equality ladders, including a terminal
statement ladder and one nested directly under `else`. Equality may put the
literal on either side; the generated `case` still evaluates the shared target
once.

Use a guarded arm when a pattern identifies the data and a predicate refines
that arm:

```blot
let classify = fn result => case result of
  #Score value if value >= 100 => "excellent"
  #Score value if value >= 50 => "passing"
  #Score _ => "retry"
  #Missing => "missing"
```

Keep specific arms above general ones. A false guard falls through to the arms
below it, and guarded arms do not prove exhaustiveness.

## Distinguish value conditionals from control flow

A conditional on the right of `let`, inside an argument, or otherwise used as a
value has an `else`. Each branch is its own result scope:

```blot
let label = if ready:
  return "ready"
else:
  return "waiting"
```

Treat those branch returns as supplying the conditional's value. They do not
return from the surrounding function.

Write a direct fallback decision as `else if`, not as another `if` nested in an
otherwise empty `else` suite. The linter flattens that shape for both value and
statement conditionals, while leaving a suite with additional work nested.

When a function is choosing its final result, skip the outer value conditional
and return directly from statement branches:

```blot
let minimum = fn (left, right) =>
  if left < right:
    return left
  else:
    return right
```

Use early returns for exceptional or terminal paths, then leave the main path
flat:

```blot
let describe = fn value =>
  if value < 0:
    return "negative"

  if value == 0:
    return "zero"

  return "positive"
```

Use a deconstructing guard when failure leaves and success continues:

```blot
let unwrap_or = fn (candidate, fallback) =>
  if let #Some value = candidate else:
    return fallback

  return value
```

The success path is the code after the guard. Do not add a success suite, and do
not let the failure branch continue: the pattern's names would not exist there.

## Treat `return` and `break` as different exits

`return value` exits the current module or function result scope. It crosses a
statement `if` and a `for`:

```blot
let find = fn (values, wanted) =>
  for value in Iter.items values:
    if value == wanted:
      return Some value

  return None
```

`break` exits only the nearest `for` and carries that loop's current accumulator
state:

```blot
let count = 0
for ever:
  count := count + 1
  if count >= 10:
    break

return count
```

Do not use `break` from a value conditional. A value conditional is a separate
result scope, so it cannot transfer control to an outer loop.

## Treat every `for` as a fold

Prefer `for` over a hand-written `fold` or recursive iterator whenever the
intent is “visit these values and update this local state.” The surface form is
not less functional: lowering turns it into recursion with an explicit
accumulator before inference.

Names rebound with `:=` are the loop accumulator. Initialize them before the
loop and make every update obvious:

```blot
let total = 0
let count = 0
for value in Iter.items values:
  total := total + value
  count := count + 1

return { .total = total; .count = count; }
```

A `let` inside the body is local to one iteration:

```blot
let total = 0
for value in Iter.items values:
  let squared = value * value
  total := total + squared

return total
```

A refutable binder is an idiomatic filter:

```blot
let total = 0
for #Some value in Iter.items candidates:
  total := total + value

return total
```

Prefer the loop even with several accumulator fields. Named state is easier to
scan than tuple positions threaded through a callback:

```blot
let total = 0
let smallest = None
for value in Iter.items values:
  total := total + value
  smallest := case smallest of
    #None => Some value
    #Some current => Some (Ord.min current value)

return { .total = total; .smallest = smallest; }
```

Use `map` or `filter` when one familiar collection operation says the whole
thing. Use `fold` when implementing a reusable collection operation, when the
fold itself is the value being composed, or when its state transition is the
abstraction the caller cares about:

```blot
let total = fold (
  values,
  0,
  fn (state, value) => state + value
)
```

An iterator is just `{ .state; .step; }`. Define one as an ordinary value rather
than asking the compiler for another loop kind:

```blot
const halving = fn start => {
  .state = start;
  .step = fn value =>
    if value < 1:
      return None
    else:
      return Some (value, value / 2)
  ;
}
```

## Keep effects visible in the statement order

Use `<-` for an effectful expression. It is the sequencing operation, not a
decorated `let`:

```blot
let greet = fn () =>
  name <- Terminal.read_line ()
  <- Terminal.write ("Hello, " <> name)
  return name
```

Bind a meaningful result by name. Use a leading `<-` when the result is
intentionally discarded; `_ <- expression` is the explicit equivalent but is
usually noisier. Never use `let` merely to force an effect to happen; pure `let`
values may be discarded or reordered.

An effect value can be retained and explicitly executed:

```blot
let effect = Assets.generation
generation <- effect
<- effect
```

Stored effects can be passed to a parent as children without executing them or
adding another suspension:

```blot
let foreground = <Mesh />
let lighting = <DirectionalLight />
let scene =
  <Camera>
    {foreground}
    {lighting}
  </Camera>
```

Define an effect as a compile-time operation shape:

```blot
const Console = @effect {
  .write = Str -> Unit;
}

sig report = Unit -> Str ~ { Console }
let report = fn () =>
  <- Console.write "working"
  return "done"
```

A handler is an ordinary shape. Give every operation its argument and affine
continuation, and include `.return` when the result needs a final transform:

```blot
let collecting = {
  .write = fn (message, ?resume) =>
    rest <- resume ()
    return message <> rest
  ;
  .return = fn value => value;
}

let transcript = @handle (Console, report, collecting)
```

Treat `?resume` as genuinely one-shot. Calling it continues the suspended
computation; omitting it aborts that computation; calling it twice is an error.

## Pass interfaces explicitly

Interfaces are structural types, not an implicit instance registry. State the
required operations in a signature and accept the implementation as an ordinary
argument:

```blot
sig join = Monoid [Int] -> [Int] -> [Int] -> [Int]
let join = fn implementation => fn left => fn right =>
  return implementation.append left right

let combined = join Array [1, 2] [3, 4]
```

Use a narrower interface when it says enough:

```blot
sig count = Length [Int] -> [Int] -> Int
let count = fn implementation => fn values =>
  return implementation.length values

let size = count Array values
```

Treat `Array`, `Text`, and similar records as implementations that happen to
carry more operations than a function requires. Width subtyping lets them
satisfy the smaller structural interface.

Operators do not perform implicit interface lookup. The default `*` names the
concrete `Num.mul`; floating-point code names `Float.mul` or `Float32.mul`.
Declare another fixity when a module intentionally wants another concrete
meaning.

## Create operators for composition

Operators are ordinary curried functions with a local fixity declaration. Make
one when a domain operation is repeatedly composed, chained, combined, or
transformed. The operator lets the source show the algebra while the qualified
target remains available when it needs to be passed as a value.

```blot
operators {
  infixl 20 (>>>) = Pipeline.then;
}

open import "blot:prelude"

const Pipeline = {
  .then = fn left => fn right => fn input => right (left input);
}

let prepare = decode >>> validate >>> normalize
let result = prepare input

return result
```

Prefer the operator once it exists. Repeating
`Pipeline.then (Pipeline.then decode validate) normalize` makes the mechanism
louder than the composition it represents.

Put operator targets in a domain namespace and choose precedence by what the
operation means:

```blot
operators {
  infixr 55 (<++>) = Document.append;
  infixl 20 (|>>) = Decoder.then;
}
```

Targets must be curried so partial application remains possible. Keep the
primitive, host call, or lower-level implementation behind that target; code in
the rest of the module should use the operator.

Create operators aggressively for genuine composition and algebra: pipelines,
domain addition, alternatives, merging, sequencing, and set-like operations are
good candidates. Keep a named call for an action whose arguments have different
roles and read better with names. `account |> validate |> save` is composition;
`transfer { .from; .to; .amount; }` is a domain command, not an excuse to invent
punctuation.

An operator declaration is file-level syntax, but its target still follows
ordinary lexical scope. Keep the namespace named or open the record that exports
it only where that operator vocabulary is intended to work.

## Prefer public operations to primitives

Application code should use operators and prelude namespaces:

```blot
let area = width * height
let remainder = total % columns
let same = left == right
let length = Array.length values
```

Keep `@` primitives at the boundary that implements those operations. The
integer multiplication chain is deliberately:

```text
* -> Num.mul -> @int.mul
```

`Num.mul` must call `@int.mul` once to bottom out. Code outside that
implementation should normally use `*` or explicitly name `Num.mul` when partial
application is the point.

The same rule applies to collection operations. Prefer `Array.empty`,
`Array.length`, and `Array.append` in ordinary code. Reach for `@array.*` when
implementing the abstraction, when ownership-specific behavior is the subject,
or when no prelude operation can express the capability.

## Treat types as compile-time values

There is no separate type namespace or declaration form:

```blot
const Identifier = I64
const State = #Idle | #Running | #Failed Str
const Pair = { .left = Int; .right = Int; }
```

Use set operations to construct and refine types:

```blot
const Small = 1 | 2 | 3
const NonZero = Int \ 0
const Readable = { .read = Unit -> Str; }
```

Use `struct` when you want predictable positional storage with named
construction and accessors:

```blot
const Point = struct { .x = I32; .y = I32; }

sig origin = Point
let origin = Point.new { .x = 0; .y = 0; }
let x = Point.x origin
```

Treat `Point` as the storage type and `Point.new`, `Point.x`, and `Point.fields`
as its attached compile-time namespace. The namespace is transparent to the type
lattice.

Attach domain operations to a type value when they belong with it:

```blot
const Meters = seal ("Meters", I32) <+ {
  .of = fn value => seal ("Meters", value);
  .unit = "m";
}
```

Keep packing separate from runtime representation. `packed Shape` describes
offsets and masks; it does not turn the program's values into packed integers.

## Use ownership qualifiers at transfer points

Use `!` for exactly-once ownership, `?` for at-most-once bindings such as
continuations, and `&` for a borrow that cannot be moved:

```blot
let consume = fn !value => value + 1
let inspect = fn &point => point.x + point.y

let !token = 41
let answer = consume (!token)
let sum = inspect { .x = 20; .y = 22; }
```

Transfer an affine binding with the matching `?` marker. It means “this callee
may consume the value at most once,” not “silently copy it”:

```blot
let (nodes, address) = Arena.insert (?nodes, node)
```

Treat ownership as flow, not as part of the inferred type. A closure inherits
the obligation of what it captures:

```blot
let !ticket = 7
let redeem = fn () => consume (!ticket)
let value = redeem ()
```

Move only the field you need when a record carries independent owned paths.
After moving a field, do not use the whole partially moved record again.

For arrays, arrange the last update around the last use when storage reuse
matters. Keeping an older alias alive makes the persistent update copy, which is
correct but may be more expensive.

Use `Arena` for finite linked structures and graphs whose lifetime is one
operation. Store stable integer addresses in nodes, reserve address zero as a
sentinel, and make the arena affine so appends may reuse its scratch storage:

```blot
sig build = (Int, [(Int, Int)], Int) -> ([(Int, Int)], Int)
let build = rec (fn (remaining, ?nodes, head) =>
  if remaining == 0:
    return (nodes, head)
  else:
    let (nodes, next) = Arena.insert (?nodes, (remaining, head))
    return build (remaining - 1, nodes, next)
)

let nodes = Arena.singleton (0, 0)
let (nodes, head) = build (count, nodes, 0)
```

Borrow the finished arena while traversing it with `Arena.get`. Prefer this
indexed form when the structure does not cross the module ABI: node shapes stay
statically checked, allocation is reclaimed with the outer call's scratch arena,
and no raw pointer or lifetime enters the source language. Use an ordinary
persistent array when older versions must remain observable.

## Let compile time do compile-time work

Use `comptime` for an expression whose result must be known while compiling:

```blot
const build_table = fn count =>
  return map (upto (0, count), fn value => value * value)

const Squares = comptime build_table 16
```

Use `@include` with an explicit parser for non-Blot source:

```blot
open import "blot:prelude"

const Config = @include "./config.json" as_const_json
```

Treat an include as a tracked compiler input, not runtime file I/O. Convert it
to the smallest runtime value the program actually needs.

## Format around structure

Use two spaces per indentation level and leave a blank line after an indented
scope before the surrounding flow resumes:

```blot
if current != generation:
  transforms <- load_transforms ()
  models <- load_models ()
  generation := current

transforms := advance transforms
```

Keep a collection or call on one line when it fits. Once it does not, put its
elements or arguments vertically and indent inside every delimiter:

```blot
store <- fold (
  upto (0, count),
  Array.empty,
  fn (state, id) =>
    entry <- Assets.entry id
    return E.attach (
      state,
      {
        .kind = entry.kind;
        .colour = entry.colour;
      }
    )
)
```

The closing delimiter belongs to the construct that opened it. Nested vertical
delimiters should not collapse into an ambiguous wall of equally indented `)`.

Do not hand-align code or preserve a personal wrapping style. Run:

```bash
deno task blot fmt path/to/file.blot
```

The formatter owns the 80-column bias, redundant parentheses, vertical arrays
and arguments, scope indentation, and blank lines after suites.

## Use tooling as part of the writing loop

Run the checker while shaping a boundary, the formatter before review, and the
linter for mechanical improvements:

```bash
just check-file path/to/file.blot
deno task blot fmt path/to/file.blot
just test
```

In Helix, hover values to see their inferred signature and compact definition.
Hover syntax and operators for documentation and active fixity. Prefer the
language server's code action when a lint offers one; actions that require
compiler evidence are validated before they are published.

The executable catalog in [examples/](examples/) is the next source of idioms.
Start with [examples/tour.blot](examples/tour.blot), then read the focused file
for the feature you are using. Use [LANGUAGE.md](LANGUAGE.md) when the question
is what a form means rather than which form to prefer.
