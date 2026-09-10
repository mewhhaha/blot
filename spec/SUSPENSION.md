# Continuations and suspension lifetimes

Runtime HIR is the checked continuation graph. Calls are transitions carrying a
closed signature, explicit arguments, an explicit result edge, and the checked
suspension contract. Every continuation declares its parameters and exact live
captures. There is no separate suspension plan or instruction-segment graph. The
Rust graph constructor propagates suspension through direct callers and marks
callback entries and the callees of framed functions for cooperative polling. A
pure function can have a private frame while its ordinary export remains
synchronous; development links preserve actual suspension contracts.

Graph validation is the authority for closed instruction contracts in both fresh
compilation and restored graph caches. It checks operand arity and
representation, finite operation metadata, aggregate members, explicit Unit
payloads, initialized Store values, callback environments and entry signatures,
and constant vector selectors before emission. Calls, captures, result edges,
returns, and integer switch cases must agree with their declared tables. A
constant aggregate passes its already-closed component representations into
nested value emission, including empty arrays. A violated contract is
transported as an invariant failure; it is neither a source diagnostic nor a
target refusal.

Emission packs only the current continuation's parameters and captures into a
frame. Its capacity is the largest continuation state, not the sum of all SSA
definitions. Before a call, the frame saves the successor's captures and
explicit value arguments. Result parameters remain unwritten until the admitted
call completes. Parallel edge copies preserve the original arguments even when a
back edge swaps parameters. Completion advances to the successor exactly once;
it never replays preceding instructions or effects. A call forwarding its result
through empty continuations can reuse its caller's frame. Physical slot layout,
canonical adapters, and the Wasm trampoline consume graph facts; hosts schedule
requests and never interpret Runtime HIR.

Ownership rejects borrows live after calls that may suspend, including
transitive and open effect rows. Last-use analysis follows demanded expressions,
lexical aliases, closure captures, branch continuations, and recursive uses.
Borrowed operands already evaluated for a surrounding expression also remain
live until that expression consumes them. A concrete synchronous operation is
checked by its own contract even when its effect has other suspending
operations.

The hosted runtime drains each admitted host operation before releasing its
invocation. Cancellation signals the operation; a completion arriving afterward
is discarded before guest memory is written or execution resumes. `close()`
cancels outstanding work, drains it, and then completes scoped cleanup. A host
operation that never settles can therefore prevent shutdown from finishing. Host
implementations must settle after cancellation; a timeout cannot safely pretend
that an acquisition or an external side effect has stopped.

Each ABI 4 invocation carries a distinct allocation-scope token. Start, poll,
resume, cancel, release, canonical reallocation, and post-return validate that
identity. Public context words retain their canonical offsets; the private scope
identity follows them in the 32-byte context. Context release does not leave its
allocation scope. The host drains admitted work, releases the context, and
leaves its scope in that order.

Each continuation input owns a reference to every reachable private root. Its
last instruction use releases that reference. Selected edges transfer one
existing reference to their first destination and retain additional
destinations; roots absent from the selected successor are released. Direct
callees consume argument references and transfer result references. Host
adapters borrow the private roots while making canonical copies. A pending
result edge is not read until the result exists. Child completion transfers its
result before freeing its frame; returning the root result copies it canonically
before releasing the private result and frame. Tail calls transfer state into
reusable frame capacity.

Canonical request and response temporaries are released after their boundary
copies complete. Private immutable backing allocations are reference counted,
including nested initialized elements and interior Text slices. Released blocks
are reusable during a running invocation. Scope exit force-reclaims remaining
blocks after cancellation or traps; it cannot free or pin a sibling's state.
Memory capacity does not shrink, and live memory remains proportional to
retained state, pending work, and results. Host-resource cleanup is a separate
authority protocol and runs only after dependent work drains.

`pnpm test:suspension` exercises the real Wasm protocol, borrow refusal,
concurrent invocations, cancellation, resource cleanup, cooperative callback
execution, repeated scalar requests, and development links.

`Select.wait` is an ordinary source-declared host effect over channel receive,
event subscription receive, and explicitly granted clock timers. The host
validates the complete arm array and resource authority before admission. A
receive source offers a deferred take operation; selection commits its winner
before calling that operation, and takes the message before invoking timer
cancellation listeners that could reenter the source. An unselected offer must
not dequeue a buffered message or accept a rendezvous sender. Admission visits
arms in source order, giving the lowest ready receive index priority; later
readiness commits exactly once. Stream closure supplies absence, while source
failure rejects the selection. Loser registrations are unlinked, loser timers
are cancelled, and every admitted timer drains before the operation settles.
Unexpected timer drain failures remain cleanup evidence. Cancellation follows
the same drain obligation and does not consume a message.
