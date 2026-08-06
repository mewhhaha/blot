# Linearity and Ownership

```bash
blot check examples/tour.blot        # linearity is part of checking
blot ownership examples/tour.blot    # the facts the backend will consume
```

## Three qualifiers

```blot
let !token = 41;                        // linear when demanded: exactly once
let consume = fn !value => value + 1;   // takes ownership
let peek = fn &p => p.x + p.y;          // borrows; the caller keeps its value
let handler = fn (message, ?resume) => …; // affine when aborting is safe

consume (!token)
```

- **`!x` is linear.** Once its pure definition is demanded, it must be consumed
  exactly once on every path. An unused pure `let` is discarded before
  ownership, so it creates no resource to leak. `blot check` rejects spending a
  demanded value twice or spending it on one branch but not another.
- **`?x` is affine**: at most once. Not a weaker linear but a different rule.
  The difference is whether _not_ spending is a leak or an abort, and for a
  continuation it is an abort — a handler that never resumes is discarding the
  rest of the computation on purpose. So affine branches need not agree, and
  never spending is fine; only the second spend is an error.
- **`&x` is a borrow.** It may be read and projected freely and may never be
  moved, so a borrowing function is one you can call without losing what you
  passed it. It is a transient lexical view, not a value that can be stored or
  returned.

`resume` is the reason `?` exists. One-shot handlers are checked statically:

```blot
let collecting = {
  .write = fn (message, ?resume) =>
    rest <- resume ()
    return message ++ rest
  ;
  .return = fn value => value;
}
```

When the captured continuation owns a linear resource, aborting would leak that
resource. Its clause must instead bind `!resume` and call it exactly once.

## Not in the type lattice

This is a flow analysis over the AST, and keeping it out of the lattice is a
load-bearing decision rather than an implementation convenience. Biunification
is polynomial; putting `!` into the lattice would make subtyping decide resource
use and the algorithm would stop being the thing that pays for itself. The two
passes share nothing but the AST.

`src/linear/check.ts` runs after inference. A use-after-move reported on a
program that does not type-check would be the second-best diagnostic.

## How a name is reached

Three ways, and the distinction is the whole rule:

|           | meaning                                                                 | linear    | borrowed |
| --------- | ----------------------------------------------------------------------- | --------- | -------- |
| `move`    | travels somewhere that keeps it — an argument, a shape member, a result | spent     | rejected |
| `project` | its structure is read, as in `p.x`                                      | spent     | fine     |
| `borrow`  | written `&x`                                                            | untouched | fine     |

Projecting spends a linear value because what is left of it cannot be used
again. Reading is exactly what a borrow is for, so projecting a borrow is fine.

## Borrows do not escape

Blot has no lifetime parameters. Instead, the checker keeps `&value` as a
transient ownership fact and accepts it only for an immediate projection, a
read-only primitive, or the matching position of a parameter marked `&`:

```blot
let peek = fn &point => point.x + point.y
let consume = fn !point => case point of
  { .x; .y; } => x + y
let !point = { .x = 20; .y = 22; }
let total = peek (&point)
return total + consume (!point)
```

The fact follows tuple and record structure, so `fn (&values, index) => ...` can
borrow one component without borrowing the other. It may not enter a
declaration, an ordinary parameter, a function or module result, or a host
operation. A closure may capture a borrow only for an immediate call; binding
the closure would retain the view and is rejected. This conservative rule gives
borrows a lexical lifetime without putting regions into the type lattice.

Branches are analysed from the same incoming state and must end in the same one.
A value consumed on one path and not another is consumed neither exactly once
nor never, so the disagreement is the error.

## Capturing makes the closure linear

A closure that captures a linear value **is linear**, and one that captures only
affine values is affine — a closure inherits the strongest obligation it took.
The obligation is not refused and is not discharged at the capture — it _moves
into the closure_, and whoever holds it owes exactly one call:

```blot
let !ticket = 7
let deferred = fn () => consume (!ticket) // deferred : linear
let settled = deferred ()                // discharged
```

`deferred` is linear because of what it holds, not because anyone wrote `!` on
it. Restating the marker would be asking the programmer to repeat something the
checker already knows. Three things follow:

- calling it twice spends `ticket` twice — `BLOT_LINEAR_CONSUMED_TWICE`;
- never calling it leaks `ticket` — `BLOT_LINEAR_NOT_CONSUMED`;
- inside the body the capture is an ordinary linear binding, so spending it
  twice per call is still caught.

Captures chain. A use two lambdas deep is captured by the outer lambda from the
defining scope and then by the inner one from the outer, so both closures come
out linear — which is the right answer, and it falls out of resolving one link
at a time rather than being a special case.

An owned value may cross a higher-order call only when the callee promises an
appropriate parameter use. `fn !f => f ()` promises exactly one consumption; an
ordinary parameter may duplicate or discard its argument and therefore cannot
accept an owned scalar, aggregate, or closure. If a linear parameter is
returned, its ownership summary is instantiated with the caller's actual
argument, so `fn !value => value` transfers ownership without inventing it for
an unrestricted argument. The same substitution continues through returned
closures.

## Aggregates carry obligations

Records, tuples, arrays, and constructor payloads inherit the obligations of
their contents. Destructuring transfers each component to the matching binding:

```blot
let !ticket = 7
let holder = { .go = fn () => consume (!ticket); }
let { .go; } = holder
return go ()
```

Projecting one field is rejected when another owned field would be discarded. A
partial destructuring pattern is rejected when it omits an owned field. A direct
array read is likewise rejected when it would copy an owned element.

`@array.push` preserves an appended obligation when the input's element
positions are known. Array and record spreads are conservative boundaries: if
either the spread input or another result component is owned, the spread is
rejected because flattening or overwriting would erase the location needed to
transfer that obligation later.

## A recursive group is one scope

A recursive group's names are in scope in every member's body, and the pass sees
it that way: a reference to a sibling is a use of it wherever the sibling
stands. Declaration order inside a group decides nothing. Each of these is one
spend of `token`, and each is counted whether `hold` is written above `start` or
below:

```blot
let start = rec (fn n => hold n)
let hold = rec (fn n => consume (!token))
```

An ordinary declaration is walked before its name exists, which is right for a
binding nothing before it can mention. A group's members mention each other, so
walking one that way meets a name the scope has never heard of and its uses go
uncounted — a linear sibling then looks unconsumed however many times the group
spends it. That was not merely a wrong number: a second use elsewhere made the
total come out right, and the program was accepted while spending the closure
twice.

Declaring the names first is not enough on its own, because a member's qualifier
is not written on its pattern. It is _discovered_ from its body, and a sibling
that holds a member discovered linear is linear in turn. So the qualifiers are
settled against a throwaway analysis first — raising each member until walking
the bodies stops raising any — and the group is then walked once for real
against them.

**A closure holding a spendable value may not be called from inside its own
group.** Its own body is inside its own group, so this reaches plain recursion:

```blot
let go = rec (fn n => if n < 1:
  return consume (!token)
else:
  return go (n - 1)
)
return go 3
```

is `BLOT_LINEAR_CONSUMED_TWICE` on `go`. A recursive call is a second call, and
a closure owing exactly one call cannot promise it. The pass counts uses and
cannot count calls, so this refuses a program that may in fact spend the value
once — the conservative side, and the same answer for an affine member, where a
second call is a second consumption too. What the two do not share is what
happens when nothing outside the group calls it: for affine that was never a
leak, and for linear the group's own recursive call is what discharges the
obligation, so neither reports. `examples/rejected/semantics/` carries both
shapes, as `recursive_linear_capture.blot` and
`recursive_group_consumed_twice.blot`.

## What is not proven

**Owned arrays do not yet have consuming random access.** Ordinary array reads
would copy an owned element, while replacement could discard it. Those cases
remain rejected until a `take` or `split` operation can return the selected
element together with a remainder carrying every other obligation.

**Reuse requires the stronger proof.** The pass records both traversal-order
last uses and the linear bindings proved consumed exactly once on every path.
Only the second fact licenses Store reuse: when that proved consumption is the
array operand of `@array.set` or `@array.push`, lowering marks the update owned.
gpufuck may then write through the source allocation. An ordinary array, an
affine binding consumed on only some paths, or a use that does not match the
proved consumption stays persistent.

**A last use is not a death.** It is where the pass stopped seeing the name.
Inside a closure that is not where the binding dies, because the body runs when
the closure is called and nothing in declaration order dates that call — a
recursive group is only the sharpest case of that, since its members call each
other in an order the block never wrote down. So a binding read across a closure
boundary _and_ read somewhere else has no last read this pass can name; the fact
says so, and anything that would read a death off it has to refuse rather than
guess. A binding a closure holds the only read of keeps its last use, because
how often that closure runs is what the linear proof is about.
