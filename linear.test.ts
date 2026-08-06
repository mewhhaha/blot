// Linearity and ownership.
//
// `!` is exactly-once once its definition is demanded. An unused pure
// definition is discarded before ownership, so no resource exists to leak.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { checkFile } from "./src/check/mod.ts";
import { BlotError } from "./src/diagnostic.ts";

const scratch = await Deno.makeTempDir();

// Every snippet opens the prelude, because every module does: it has no
// privilege, and a fixture that skipped it would be testing a language where
// `+` is unbound.
const PRELUDE = `open @import "blot:prelude" ()
`;

async function analyze(source: string) {
  const path = `${scratch}/case_${crypto.randomUUID()}.blot`;
  await Deno.writeTextFile(path, PRELUDE + source);
  const checked = await checkFile(path);
  // The facts cover every module the backend would inline, the prelude
  // included, so a test about this snippet has to say which file it means.
  const own = [...checked.ownership].filter(([, fact]) => fact.path === path);
  return { checked, path, own };
}

function accepts(name: string, source: string): void {
  Deno.test(name, async () => {
    await analyze(source);
  });
}

function rejects(name: string, source: string, code: string): void {
  Deno.test(name, async () => {
    try {
      await analyze(source);
    } catch (error) {
      if (!(error instanceof BlotError)) throw error;
      assertStringIncludes(error.message, code);
      return;
    }
    throw new Error("expected this program to be rejected");
  });
}

const CONSUME = `let consume = fn !value => @int.add value 1
`;

accepts(
  "a linear value consumed once is accepted",
  `let consume = fn !value => @int.add value 1
let !token = 41
return consume (!token)
`,
);

rejects(
  "spending a linear value twice is rejected",
  `let consume = fn !value => @int.add value 1
let !token = 41
return @int.add (consume (!token)) (consume (!token))
`,
  "BLOT_LINEAR_CONSUMED_TWICE",
);

accepts(
  "an unused linear definition is discarded",
  `let !handle = 41
return 0
`,
);

accepts(
  "branches that both consume agree",
  `let consume = fn !value => @int.add value 1
let !token = 41
return if 1 < 2 : consume (!token)
else: consume (!token)
`,
);

Deno.test("ownership certificates publish every branch consumption", async () => {
  const { checked, path } = await analyze(
    `let consume = fn !value => @int.add value 1
let !token = 41
return if 1 < 2 : consume (!token)
else: consume (!token)
`,
  );
  const entry = checked.ownershipCertificate.entries.find((candidate) =>
    candidate.path === path && candidate.name === "token"
  );
  assert(entry !== undefined);
  assertEquals(entry.consumptions.length, 2);
  assertEquals(entry.reusableAt, entry.consumptions);
});

rejects(
  "branches that disagree about consuming are rejected",
  `let consume = fn !value => @int.add value 1
let !token = 41
return if 1 < 2 : consume (!token)
else: 0
`,
  "BLOT_LINEAR_BRANCH_DISAGREEMENT",
);

// Capturing does not refuse and does not spend in place: the obligation moves
// into the closure, which becomes linear itself. `go` is linear because of what
// it holds, not because anyone wrote `!` on it.
accepts(
  "a closure capturing a linear value is linear, and one call discharges it",
  `let consume = fn !value => @int.add value 1
let !token = 41
let go = fn () => consume (!token)
return go ()
`,
);

rejects(
  "calling a linear closure twice is rejected",
  `let consume = fn !value => @int.add value 1
let !token = 41
let go = fn () => consume (!token)
return @int.add (go ()) (go ())
`,
  "BLOT_LINEAR_CONSUMED_TWICE",
);

accepts(
  "an unused closure and its capture are discarded",
  `let consume = fn !value => @int.add value 1
let !token = 41
let go = fn () => consume (!token)
return 0
`,
);

rejects(
  "spending a capture twice inside the body is still caught",
  `let consume = fn !value => @int.add value 1
let !token = 41
let go = fn () => @int.add (consume (!token)) (consume (!token))
return go ()
`,
  "BLOT_LINEAR_CONSUMED_TWICE",
);

rejects(
  "an owned aggregate cannot escape the module boundary",
  `let consume = fn !value => @int.add value 1
let !token = 41
return { .go = fn () => consume (!token); }
`,
  "BLOT_LINEAR_RESULT_ESCAPES",
);

accepts(
  "an aggregate carries a captured obligation into destructuring",
  `let consume = fn !value => @int.add value 1
let !token = 41
let holder = { .go = fn () => consume (!token); }
let { .go; } = holder
return go ()
`,
);

accepts(
  "a constructor carries a captured obligation into matching",
  `let consume = fn !value => @int.add value 1
let !token = 41
let holder = #Held (fn () => consume (!token))
return case holder of
  #Held go => go ()
`,
);

accepts(
  "owned record fields can be moved independently",
  `let consume = fn !value => @int.add value 1
let !left = 40
let !right = 41
let holder = {
  .first = fn () => consume (!left);
  .second = fn () => consume (!right);
  }
let first = holder.first ()
return @int.add first (holder.second ())
`,
);

rejects(
  "a partially moved record cannot be reused as a whole",
  `let consume = fn !value => @int.add value 1
let !left = 40
let !right = 41
let holder = {
  .first = fn () => consume (!left);
  .second = fn () => consume (!right);
  }
let first = holder.first ()
let consume_holder = fn !value =>
  let { .first; .second; } = !value
  let _ = first ()
  return second ()
return @int.add first (consume_holder holder)
`,
  "BLOT_LINEAR_PARTIAL_REUSE",
);

rejects(
  "a higher-order function cannot duplicate an owned closure",
  `let consume = fn !value => @int.add value 1
let twice = fn f => @int.add (f ()) (f ())
let !token = 41
let go = fn () => consume (!token)
return twice go
`,
  "BLOT_LINEAR_ARGUMENT_NOT_OWNED",
);

rejects(
  "an ordinary function parameter cannot discard an owned scalar",
  `let consume = fn !value => @int.add value 1
let ignore = fn value => 0
let !token = 41
return ignore (!token)
`,
  "BLOT_LINEAR_ARGUMENT_NOT_OWNED",
);

rejects(
  "a runtime shadow cannot impersonate a consuming numeric operation",
  `let Num = { .add = fn value => fn _ => 0; }
let !token = 41
return Num.add (!token) 1
`,
  "BLOT_LINEAR_ARGUMENT_NOT_OWNED",
);

accepts(
  "a linear function parameter promises one invocation",
  `let consume = fn !value => @int.add value 1
let once = fn !f => f ()
let !token = 41
let go = fn () => consume (!token)
return once go
`,
);

accepts(
  "a linear identity returns only the obligation supplied by its caller",
  `let identity = fn !value => value
return identity 1
`,
);

accepts(
  "a linear identity transfers its caller's owned value",
  `let consume = fn !value => @int.add value 1
let identity = fn !value => value
let !token = 41
let returned = identity (!token)
return consume (!returned)
`,
);

accepts(
  "an unannotated identity infers ownership transfer",
  `let consume = fn !value => @int.add value 1
let identity = fn value => value
let !token = 41
let returned = identity (!token)
return consume (!returned)
`,
);

accepts(
  "a destructured parameter transfers its linear component",
  `let consume = fn !value => @int.add value 1
let first = fn (!value, _) => value
let !token = 41
let returned = first ((!token), 0)
return consume (!returned)
`,
);

rejects(
  "an ordinary component in a destructured parameter rejects ownership",
  `let ignore = fn (value, result) => result
let !token = 41
return ignore ((!token), 0)
`,
  "BLOT_LINEAR_ARGUMENT_NOT_OWNED",
);

accepts(
  "a returned closure transfers an owned parameter through both calls",
  `let consume = fn !value => @int.add value 1
let defer = fn !value => fn () => value
let !token = 41
let later = defer (!token)
let returned = later ()
return consume (!returned)
`,
);

accepts(
  "a returned closure does not invent ownership for an ordinary argument",
  `let defer = fn !value => fn () => value
let later = defer 41
return later ()
`,
);

rejects(
  "branch-produced records retain the obligation in their common field",
  `let consume = fn !value => @int.add value 1
let !token = 41
let holder = if 1 < 2 : { .go = fn () => consume (!token); .value = 1; }
else: { .go = fn () => consume (!token); .value = 2; }
let { .go; .value; } = holder
return value
`,
  "BLOT_LINEAR_NOT_CONSUMED",
);

rejects(
  "a branch-produced closure retains ownership in its call result",
  `let !token = 41
let chosen = if 1 < 2 : fn () => token
else: fn () => token
return chosen ()
`,
  "BLOT_LINEAR_RESULT_ESCAPES",
);

rejects(
  "partial destructuring cannot discard an owned field",
  `let consume = fn !value => @int.add value 1
let !left = 40
let !right = 41
let holder = {
  .first = fn () => consume (!left);
  .second = fn () => consume (!right);
  }
let { .first; } = holder
return first ()
`,
  "BLOT_LINEAR_PATTERN_DISCARDS",
);

rejects(
  "array push preserves the appended ownership position",
  `let consume = fn !value => @int.add value 1
let !token = 41
let values = @array.push [1] (fn () => consume (!token))
let [first, go] = values
return first
`,
  "BLOT_LINEAR_NOT_CONSUMED",
);

rejects(
  "an array spread cannot obscure an owned element position",
  `let consume = fn !value => @int.add value 1
let !token = 41
let initial = [1]
let values = [...initial, fn () => consume (!token)]
let [first, go] = values
return first
`,
  "BLOT_LINEAR_ARRAY_SPREAD",
);

accepts(
  "array take transfers a selected obligation and every remainder obligation",
  `let consume = fn !value => @int.add value 1
let !left = 40
let !right = 41
let values = [fn () => consume (!left), fn () => consume (!right)]
return case @array.take values 1 of
  #Taken (selected, remainder) => case remainder of
    [other] => @int.add (selected ()) (other ())

  #TakeOutOfBounds original => case original of
    [first, second] => @int.add (first ()) (second ())
`,
);

accepts(
  "array take gives a dynamic partition explicit obligations",
  `let consume = fn !value => @int.add value 1
let !token = 41
let values = [fn () => consume (!token)]
let index = if 1 < 2 : 0
else: 1
return case @array.take values index of
  #Taken (selected, remainder) =>
    return case remainder of
      _ => selected ()

  #TakeOutOfBounds original =>
    return case original of
      _ => 0
`,
);

accepts(
  "array split makes every dynamic partition component explicit",
  `${CONSUME}let !token = 41
let values = [fn () => consume (!token)]
let index = (if 1 < 2 : 0 else: 1)
return case @array.split values index of
  #Split (before, selected, after) =>
    return case before of
      _ => case after of
        _ => selected ()
  #SplitOutOfBounds original => case original of
    _ => 0
`,
);

rejects(
  "a record spread cannot obscure an owned field",
  `let consume = fn !value => @int.add value 1
let !token = 41
let source = { .go = fn () => consume (!token); }
let moved = { ...source; .value = 1; }
return moved.value
`,
  "BLOT_LINEAR_SHAPE_SPREAD",
);

accepts(
  "a wildcard pattern consumes the whole linear value it matches",
  `let !token = 41
return case token of
  _ => 0
`,
);

accepts(
  "a wildcard pattern may discard an affine value",
  `let ?token = 41
return case token of
  _ => 0
`,
);

// A borrow reads without spending, which is the whole reason to have one.
accepts(
  "a borrowed parameter may be projected",
  `let peek = fn &p => @int.add p.x p.y
return peek { .x = 1; .y = 2; }
`,
);

accepts(
  "a borrow may occupy one position of a structural parameter",
  `let peek = fn (&point, offset) => @int.add point.x offset
let consume_point = fn !value => case value of
  { .x; } => x
let !point = { .x = 40; }
return @int.add (peek ((&point), 1)) (consume_point (!point))
`,
);

rejects(
  "a borrowed parameter may not be moved",
  `let steal = fn &p => p
return steal { .x = 1; }
`,
  "BLOT_BORROW_MOVED",
);

rejects(
  "a borrow cannot be stored in a binding",
  `let consume = fn !value => @int.add value 1
let !token = 41
let view = &token
return { .view = view; .consumed = consume (!token); }
`,
  "BLOT_BORROW_STORED",
);

rejects(
  "a borrow cannot be stored by stable rebinding",
  `let consume = fn !value => @int.add value 1
let !token = 41
let view = 0
view := &token
return @int.add view (consume (!token))
`,
  "BLOT_BORROW_STORED",
);

rejects(
  "a borrowing function cannot return a projected view",
  `let leak = fn &point => point.x
return leak { .x = 41; }
`,
  "BLOT_BORROW_RESULT_ESCAPES",
);

rejects(
  "an explicit borrow cannot pass through an ordinary parameter",
  `let consume = fn !value => @int.add value 1
let ignore = fn value => 0
let !token = 41
return @int.add (ignore (&token)) (consume (!token))
`,
  "BLOT_BORROW_ARGUMENT_ESCAPES",
);

rejects(
  "a borrow cannot cross a host effect boundary",
  `const Sink = @effect.host { .write = Int -> Unit; }
sig send = Int -> Unit ~ { Sink }
let send = fn &value =>
  _ <- Sink.write (&value)
return send
`,
  "BLOT_BORROW_ARGUMENT_ESCAPES",
);

rejects(
  "a pattern cannot bind part of a borrowed view",
  `let consume = fn !value => @int.add value 1
let !token = 41
let result = case #View (&token) of
  #View view => @int.add view 1
return @int.add result (consume (!token))
`,
  "BLOT_BORROW_STORED",
);

rejects(
  "a closure carrying a borrow cannot be stored",
  `let inspect = fn &point =>
  let later = fn () => @int.add point.x 0
  return later ()
return inspect { .x = 41; }
`,
  "BLOT_BORROW_STORED",
);

accepts(
  "an immediately called closure may inspect a borrow",
  `let inspect = fn &point => (fn () => @int.add point.x 0) ()
return inspect { .x = 41; }
`,
);

// `?` is affine — at most once. Not a weaker `!`: the difference is whether
// *not* spending is a leak or an abort, and for a continuation it is an abort.

accepts(
  "an affine value spent once is accepted",
  `let once = fn ?r => r 1
return once (fn x => x)
`,
);

accepts(
  "an affine value never spent is accepted, unlike a linear one",
  `let never = fn ?r => 0
return never (fn x => x)
`,
);

rejects(
  "spending an affine value twice is rejected",
  `let twice = fn ?r => @int.add (r 1) (r 2)
return twice (fn x => x)
`,
  "BLOT_LINEAR_CONSUMED_TWICE",
);

accepts(
  "affine branches need not agree, because either way it is at most once",
  `let some = fn ?r => if 1 < 2 : r 1
else: 0
return some (fn x => x)
`,
);

rejects(
  "an aborting handler cannot discard a continuation that owns a resource",
  `let consume = fn !value => @int.add value 1
const Ask = @effect { .ask = Unit -> Unit; }
let !token = 41
let work = fn () =>
  _ <- Ask.ask ()
  return consume (!token)
let aborting = { .ask = fn (_, ?resume) => 0; }
return @handle (Ask, work, aborting)
`,
  "BLOT_LINEAR_HANDLER_MAY_ABORT",
);

accepts(
  "a handler resumes exactly once when its continuation owns a resource",
  `let consume = fn !value => @int.add value 1
const Ask = @effect { .ask = Unit -> Unit; }
let !token = 41
let work = fn () =>
  _ <- Ask.ask ()
  return consume (!token)
let resuming = { .ask = fn (_, !resume) => resume (); }
return @handle (Ask, work, resuming)
`,
);

accepts(
  "a handler explicitly cancels a continuation that owns a resource",
  `let consume = fn !value => @int.add value 1
const Ask = @effect { .ask = Unit -> Unit; }
let !token = 41
let work = fn () =>
  _ <- Ask.ask ()
  return consume (!token)
let cancelling = { .ask = fn (_, !resume) =>
  _ <- Continuation.cancel resume
  return 0
; }
return @handle (Ask, work, cancelling)
`,
);

rejects(
  "cancelling a handler continuation twice is rejected",
  `const Ask = @effect { .ask = Unit -> Unit; }
let work = fn () =>
  _ <- Ask.ask ()
let cancelling = { .ask = fn (_, !resume) =>
  _ <- Continuation.cancel resume
  _ <- Continuation.cancel resume
; }
return @handle (Ask, work, cancelling)
`,
  "BLOT_LINEAR_CONSUMED_TWICE",
);

rejects(
  "cancellation rejects an ordinary function",
  `let ordinary = fn value => value
return (
  _ <- Continuation.cancel ordinary
)
`,
  "BLOT_CANCEL_NOT_CONTINUATION",
);

rejects(
  "cancellation must be sequenced",
  `const Ask = @effect { .ask = Unit -> Unit; }
let work = fn () =>
  _ <- Ask.ask ()
let cancelling = { .ask = fn (_, !resume) =>
  let cancelled = Continuation.cancel resume
  return cancelled
; }
return @handle (Ask, work, cancelling)
`,
  "BLOT_UNSEQUENCED_EFFECT",
);

// A recursive group's names are in scope in every member's body, so the block
// cannot walk a member before its name exists the way it walks an ordinary
// binding — a sibling it has not reached yet would contribute no use at all,
// and a linear one would look unconsumed however many times the group spends
// it. Declaration order inside a group means nothing, so each of these is
// written with the sibling ahead of its definition.

accepts(
  "a member's linearity reaches a sibling the block has not reached yet",
  `let consume = fn !value => @int.add value 1
let !token = 41
let start = rec (fn n => hold n)
let hold = rec (fn n => consume (!token))
return start 1
`,
);

rejects(
  "a member that spends a sibling twice is counted twice",
  `let consume = fn !value => @int.add value 1
let !token = 41
let user = rec (fn n => @int.add (hold n) (hold n))
let hold = rec (fn n => consume (!token))
return user 1
`,
  "BLOT_LINEAR_CONSUMED_TWICE",
);

// The uncounted use was not only a wrong number: a second use elsewhere made
// the total come out right, and the program was accepted while spending the
// closure twice.
rejects(
  "a use elsewhere no longer balances a member the block spent",
  `let consume = fn !value => @int.add value 1
let !token = 41
let start = rec (fn n => hold n)
let hold = rec (fn n => consume (!token))
return @int.add (start 1) (hold 2)
`,
  "BLOT_LINEAR_CONSUMED_TWICE",
);

// A recursive edge can transfer a capture without consuming it locally when
// every recursive occurrence is in ownership-tail position. The base path is
// still checked by the ordinary exactly-once branch rules.
accepts(
  "an ownership-tail recursive function transfers its linear capture",
  `let consume = fn !value => @int.add value 1
let !token = 41
let go = rec (fn n => if n < 1 : consume (!token)
else: go (@int.sub n 1))
return go 3
`,
);

accepts(
  "mutual ownership-tail recursion shares one captured obligation",
  `let consume = fn !value => @int.add value 1
let !token = 41
let even = rec (fn n => if n < 1 : consume (!token)
else: odd (@int.sub n 1))
let odd = rec (fn n => even (@int.sub n 1))
return even 4
`,
);

rejects(
  "a recursive call nested inside another operation has no ownership proof",
  `let consume = fn !value => @int.add value 1
let !token = 41
let go = rec (fn n => if n < 1 : consume (!token)
else: @int.add (go (@int.sub n 1)) 0)
return go 3
`,
  "BLOT_RECURSIVE_OWNERSHIP_UNPROVED",
);

// Settling the qualifiers is a search, and a group with nothing spendable in
// reach has nothing to search for. Its members stay what they were written, and
// the group is walked once.
Deno.test("a group with no linear member owes and proves nothing", async () => {
  const { own } = await analyze(
    `let even = rec (fn n => if n < 1 : 1
else: odd (@int.sub n 1))
let odd = rec (fn n => if n < 1 : 0
else: even (@int.sub n 1))
return @int.add (even 4) (odd 3)
`,
  );
  const members = own.filter(([pattern]) =>
    pattern.name === "even" || pattern.name === "odd"
  );
  assertEquals(members.length, 2);
  for (const [pattern, fact] of members) {
    assertEquals(fact.spent, false, `${pattern.name} owed nothing to spend`);
    assert(fact.lastUse !== null, `${pattern.name} is read by its sibling`);
  }
});

// The facts the backend consumes. `storeUpdateOptions` turns the linear one
// into an in-place Store update, so both the parameter and the binding are
// asserted here: `fn !value => ...` is as linear as `let !token`, and the pass
// proves each of them spent exactly once.
Deno.test("every linear binding proved spent is recorded", async () => {
  const { own } = await analyze(
    `let consume = fn !value => @int.add value 1
let !token = 41
return consume (!token)
`,
  );
  const spent = own
    .filter(([, fact]) => fact.spent)
    .map(([pattern]) => pattern.name);
  assertEquals(spent.sort(), ["token", "value"]);
});

Deno.test("the last use of each binding is recorded", async () => {
  const { own } = await analyze(
    `let a = 1
let b = @int.add a 2
return @int.add b 3
`,
  );
  const read = own
    .filter(([, fact]) => fact.lastUse !== null)
    .map(([pattern]) => pattern.name);
  assertEquals(read.sort(), ["a", "b"]);
});

// A name is not an identity. Keyed by name, the lambda's `x` and the module's
// `x` are one entry and the surviving span belongs to whichever was walked
// last — a fact about one binding reported for the other. Keyed by the pattern
// that bound each, they stay apart, and that is what a consumer needs before it
// can act on either.
Deno.test("two bindings sharing a name keep separate facts", async () => {
  const { own } = await analyze(
    `let x = 1
let f = fn x => @int.add x 1
return @int.add x (f 2)
`,
  );
  const read = own
    .filter(([, fact]) => fact.lastUse !== null)
    .map(([pattern]) => pattern.name);
  assertEquals(read.sort(), ["f", "x", "x"]);
});

// A last use is where the pass stopped walking past a name, and inside a
// closure that is not where the binding dies: the body runs when the closure is
// called, and a recursive group's members call each other in an order the block
// never wrote down. So a binding one closure reads and something else reads too
// has no last read to act on, and the fact says so rather than naming one.
Deno.test("a binding a closure and a sibling both read has no last read", async () => {
  const { own } = await analyze(
    `open @import "blot:prelude" ()
let !cells = [7, 2, 3]
let peek = rec (fn n => case Array.get ((&cells), n) of
  #Some value => value
  #None => 0
)
let write = rec (fn n => @array.set cells 0 n)
let [first, _, _] = write 1
return @int.add first (peek 0)
`,
  );
  const cells = own.find(([pattern]) => pattern.name === "cells");
  assert(cells !== undefined);
  assertEquals(cells[1].spent, true);
  assertEquals(cells[1].reentrant, true);
});

// One read is one read wherever it stands. A closure holding the only read of a
// linear value is reached by calling it, and how often that happens is what the
// linear proof is about — so this one keeps a last read the backend can spend.
Deno.test("a binding read once inside a group keeps its last read", async () => {
  const { own } = await analyze(
    `open @import "blot:prelude" ()
let !cells = [7, 2, 3]
let start = rec (fn n => case Array.get (bump n, 0) of
  #Some value => value
  #None => 0
)
let bump = rec (fn n => @array.set cells 0 n)
return start 4
`,
  );
  const cells = own.find(([pattern]) => pattern.name === "cells");
  assert(cells !== undefined);
  assertEquals(cells[1].spent, true);
  assertEquals(cells[1].reentrant, false);
  assert(cells[1].lastUse !== null);
});

// The backend inlines an imported module into its importer, so an importer
// whose facts stopped at its own file would have none about most of the code it
// emits. Every fixture opens the prelude, so the prelude is the evidence.
Deno.test("ownership facts cover every module that contributed code", async () => {
  const { checked, path } = await analyze(`let a = 1
return a
`);
  const paths = new Set(
    [...checked.ownership.values()].map((fact) => fact.path),
  );
  assert(paths.has(path));
  assert(paths.size > 1);
});
