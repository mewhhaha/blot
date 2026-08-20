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
let publish = fn source => do:
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
let prepare = fn values => do:
  let values = filter (values, valid)
  let values = map (values, normalize)
  return values

let summarize = fn values => do:
  let total = 0
  for value in Iter.items values:
    total := total + value

  return { .values = values; .total = total; }

let run = fn source => do:
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

let clamp = fn value => do:
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

let calculate = fn values => do:
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

let warning = do:
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

A shape has named fields and should represent data whose fields have meaning:

```blot
let user = {
  .name = "Ada";
  .age = 36;
  .active = True;
}
```

A tuple should represent a small positional product whose positions are obvious:

```blot
let range = (start, stop)
let point = (x, y)
```

Use an array for a homogeneous sequence:

```blot
let names = ["Ada", "Grace", "Linus"]
let names = [...names, "Edsger"]
```

Use constructors for alternatives, not ad hoc tag fields:

```blot
const Result = #Ok Int | #Error Str

let render = fn result => case result of
  #Ok value => Text.of_int value
  #Error reason => reason
```

Patterns should destructure at the point where a value's shape becomes useful:

```blot
let { .name; .age; } = user
let (left, right) = range
```

Do not carry fields through temporary projection variables unless the names make
a later operation clearer.

## Prefer guards and early returns

A function that checks exceptional or terminating paths first is usually easier
to read than one that nests the successful path:

```blot
let classify = fn value => do:
  if value < 0:
    return #Negative

  if value == 0:
    return #Zero

  return #Positive value
```

Use `if let ... else:` when one variant must be present for the rest of the
function to make sense:

```blot
let first_or = fn values => do:
  if let #Some first = Array.get (values, 0) else:
    return #Missing

  return #Found first
```

The matched names remain available below the guard. That makes the main path
flat and avoids wrapping the rest of the function in a `case` arm.

A statement `if` may omit `else` when the false path naturally continues:

```blot
if trace:
  <- Console.write "starting"

return run ()
```

Use `case` instead when the branches choose a value:

```blot
let label = case status of
  #Ready => "ready"
  #Failed reason => reason
```

This split is one of the most useful readability rules in the language: `if`
reads as control flow; `case` reads as data elimination.

## Make statement blocks explicit

A function body and a `case` arm are value positions. Keep the common case as a
single expression:

```blot
let increment = fn value => value + 1

let describe = fn option => case option of
  #Some value => Text.of_int value
  #None => "none"
```

When that value needs declarations, rebinding, sequencing, statement control,
loops, `break`, or `return`, introduce the statement scope with `do:`:

```blot
let normalize = fn value => do:
  if value < 0:
    return 0

  let doubled = value * 2
  return doubled

let describe = fn option => case option of
  #Some value => do:
    let normalized = normalize value
    return Text.of_int normalized
  #None => "none"
```

Indentation after `=` or `=>` may continue an expression, but indentation alone
does not create a statement block. `do:` is the explicit lexical and `return`
boundary; `compdo:` is the same form when the whole statement scope must execute
at compile time.

## Use `case` to explain closed data

`case` is the normal way to consume a closed constructor union:

```blot
let describe = fn state => case state of
  #Waiting => "waiting"
  #Running progress => Text.of_int progress
  #Failed reason => reason
```

Prefer constructor names that describe domain states. Use `_` as the wildcard
only when the omitted distinctions truly do not matter:

```blot
let is_done = fn state => case state of
  #Done => True
  _ => False
```

A guarded arm should express an additional condition on a matched shape, not
replace a clear nested data split:

```blot
let bucket = fn result => case result of
  #Ok value if value >= 100 => #Large value
  #Ok value => #Small value
  #Error reason => #Rejected reason
```

Use exhaustive cases. A missing constructor is a checker error, and the explicit
coverage is useful documentation.

Keep `return` out of a case arm unless the arm intentionally returns from an
explicit surrounding `do:` scope. A simple case arm is already its value.

## Write loops as loops

Use `for` for ordinary traversal:

```blot
let total = 0
for value in Iter.items values:
  total := total + value
return total
```

Treat the names rebound with `:=` as the loop's inferred accumulator. Keep that
set small and obvious. A local `let` inside the loop is per-iteration scratch:

```blot
let total = 0
for value in Iter.items values:
  let weighted = value * 2
  total := total + weighted
return total
```

Use `break` when stopping is genuinely imperative and the accumulator already
contains the result you want:

```blot
let found = None
for value in Iter.items values:
  if matches value:
    found := Some value
    break
return found
```

Use a refutable loop pattern when a constructor pattern is the filter:

```blot
let total = 0
for #Some value in Iter.items choices:
  total := total + value
return total
```

Do not manually unwrap `.state` and `.step` unless implementing an iterator.
`for value in iterator:` is the consumer-facing form.

Write a custom iterator as one shape with `.state` and `.step`:

```blot
let countdown = fn start => {
  .state = start;
  .step = fn current =>
    if current <= 0:
      return None
    else:
      return Some (current, current - 1)
  ;
}
```

The generic loop understands the protocol, not the name `countdown`.

Use a named recursive function when recursion is the algorithm rather than an
implementation of ordinary traversal:

```blot
sig factorial = Int -> Int
let rec factorial = fn value => do:
  if value <= 1:
    return 1

  return value * factorial (value - 1)
```

## Make effects visible in the statement stream

Create an effect once and thread it through types and handlers:

```blot
const Console = @effect {
  .write = Str -> Unit;
}
```

Bind an effect result with `<-`:

```blot
time <- Clock.now ()
```

Discard an effect result with the statement spelling:

```blot
<- Console.write "starting"
```

This is preferred to `_ <- ...`: the source says directly that the result is not
used.

Do not rely on a pure `let` for ordering. If an operation must happen before the
next operation, place it in the statement stream with `<-`.

Write effectful callbacks with the effect row in the signature when the boundary
matters:

```blot
sig report = Str -> Unit ~ { Console }
let report = fn text => do:
  <- Console.write text
  return ()
```

Handle at the narrowest useful boundary. A handler is a plain record of
operations and an optional return clause:

```blot
let buffered = computation |> @handle (Console, {
  .write = fn (resume, text) => resume ();
  .return = fn value => value;
})
```

Use `|>` for handler composition so the dataflow reads left to right. Keep
handlers next to the computation whose effects they explain.

## Pass interfaces explicitly

There is no trait registry, implicit dictionary, or instance search. Describe a
structural capability with a compile-time record:

```blot
const Comparable = {
  .compare = Int -> Int -> Ordering;
}
```

Pass the implementation as an ordinary value:

```blot
let sort = fn (comparable, values) => ...
let ordered = sort (IntOrder, values)
```

If the implementation is used throughout a small scope, open it locally:

```blot
let sort = fn (order, values) => do:
  open order
  return sort_by compare values
```

This keeps dependencies visible while allowing the implementation to read like a
small local vocabulary.

Use `@satisfies` when a value should be checked against a structural requirement
while remaining the same runtime value:

```blot
const Named = { .name = Str; }
let item = @satisfies value Named
```

## Use operators for algebra and composition

Declare an operator when the operation has a natural algebraic or pipeline
reading:

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

Decompose and classify ordinary arrays with the public operations:

```blot
operators {
  infixl 55 (<>) = Array.append;
}

let result = case Array.uncons values of
  #None => []
  #Some (first, rest) => do:
    let (small, large) = partition (rest, fn value => value <= first)
    return small <> [first] <> large
```

`partition` is one stable pass, while two filters visit and test every element
twice. These ordinary arrays are independent contiguous values: `<>` names the
array monoid but does not make partition and append a zero-copy split/rejoin.
Use `Slice.split` and `Slice.join` when the algorithm must retain one owned
backing Store and carry the recombination proof explicitly. `Array.uncons`
likewise serves ordinary value arrays. For an array containing owned elements,
prove `0 <= index < Array.length values` and use direct `@array.take` or
`@array.split`; their tuple result conserves every obligation without a failure
constructor.

When the result may be reordered and one backing Store should be reused, enter a
private consuming phase with `Slice`:

```blot
let region = Slice.claim values
let (!partitioned, boundary) =
  Slice.partition ((!region), fn value => value <= pivot)
return (Slice.freeze (!partitioned), boundary)
```

This is pure at the language boundary: `claim` consumes the input value,
`partition` consumes the old authority and returns its successor, and `freeze`
ends the private phase. If the input Store is proved unique, acquisition and
freeze are constant-time and partition rearranges that Store in place. A shared
input is copied once during `claim`, after which the same in-place algorithm is
used. Partition itself is one unstable `O(n)` pass with `O(1)` auxiliary element
storage and no element-Store allocation.

Use `Slice.partition_range ((!region), start, end, predicate)` when an algorithm
keeps a complete root and works over index ranges. It returns
`#Partitioned (!successor, boundary)` or
`#PartitionOutOfBounds (!original, start)`; an invalid range performs no
predicate call or swap. `examples/owned_quicksort.blot` uses this form, so its
recursive bookkeeping stays persistent while all element updates reuse the
private Store.

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
let rec build = fn (remaining, ?nodes, head) => do:
  if remaining == 0:
    return (nodes, head)
  else:
    let (nodes, next) = Arena.insert (?nodes, (remaining, head))
    return build (remaining - 1, nodes, next)

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
const build_table = fn count => map (upto (0, count), fn value => value * value)

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
  fn (state, id) => do:
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
