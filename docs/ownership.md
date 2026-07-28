# Linearity and Ownership

```bash
blot check examples/tour.blot        # linearity is part of checking
blot ownership examples/tour.blot    # the facts the backend will consume
```

## Three qualifiers

```blot
let !token = 41;                        // linear: exactly once
let consume = (!value) => value + 1;    // takes ownership
let peek = (&p) => p.x + p.y;           // borrows; the caller keeps its value
let handler = (message, ?resume) => …;  // affine: at most once

consume (!token)
```

- **`!x` is linear.** It must be consumed exactly once on every path. Not
  once-or-fewer: a resource nothing consumes is a leak, and that is the failure
  the marker exists to catch. `blot check` rejects spending it twice, never
  spending it, and spending it on one branch but not another.
- **`?x` is affine**: at most once. Not a weaker linear but a different rule.
  The difference is whether _not_ spending is a leak or an abort, and for a
  continuation it is an abort — a handler that never resumes is discarding the
  rest of the computation on purpose. So affine branches need not agree, and
  never spending is fine; only the second spend is an error.
- **`&x` is a borrow.** It may be read and projected freely and may never be
  moved, so a borrowing function is one you can call without losing what you
  passed it.

`resume` is the reason `?` exists. One-shot handlers used to be a runtime check
and a promise in a comment; they are now a static one:

```blot
let collecting = {
  .write = (message, ?resume) => message ++ resume ();
  .return = value => value;
};
```

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

Branches are analysed from the same incoming state and must end in the same one.
A value consumed on one path and not another is consumed neither exactly once
nor never, so the disagreement is the error.

## Capturing makes the closure linear

A closure that captures a linear value **is linear**, and one that captures only
affine values is affine — a closure inherits the strongest obligation it took.
The obligation is not refused and is not discharged at the capture — it _moves
into the closure_, and whoever holds it owes exactly one call:

```blot
let !ticket = 7;
let deferred = () => consume (!ticket);   // deferred : linear
let settled = deferred ();                // discharged
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

## What is not proven

**A linear closure cannot be stored in a structure.** Putting one in a shape
would make that shape linear, and blot does not track linear structures yet.
Binding it to a name works, and so does calling it where it was built; anything
else reports `BLOT_LINEAR_CLOSURE_ESCAPES` rather than losing the obligation
quietly.

**Reuse is analysed but not applied.** The pass records the last use of every
binding and which linear bindings were proved spent exactly once. Rewriting a
rebuild into an in-place write needs a Core to rewrite, which arrives with the
backend. `blot ownership` prints the facts so the analysis is testable on its
own rather than deferred until something can act on it.
