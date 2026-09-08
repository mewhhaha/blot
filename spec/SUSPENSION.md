# Suspension planning and lifetimes

The planner consumes validated Runtime HIR; it does not infer effects or
ownership. A checked operation's Boolean `suspends` contract, a development
link's suspension contract, and explicit resumable roots seed the affected
functions. Reverse direct-call edges propagate that set to callers. Callback
entries and all callees of framed functions receive frames for cooperative
polling, even when their ordinary exports remain synchronous.

Each planned segment retains its original block and operation range. A segment
ends after a host request or framed call; resumption begins at the next
operation without replaying preceding effects. Block-entry indices preserve
parallel branch arguments. Emission owns typed slot layout, canonical
conversion, tail-frame capacity, and the Wasm trampoline. Hosts schedule checked
requests; they never interpret Runtime HIR. Development partitioning consumes
the same framed graph before recording links and remapping roots.

Ownership rejects lexical borrows across calls that may suspend, including
transitive and open effect rows. A concrete synchronous operation is checked by
its own contract even when its effect has other suspending operations.

The hosted runtime drains each admitted host operation before releasing its
invocation. Cancellation signals the operation; a completion arriving afterward
is discarded before guest memory is written or execution resumes. `close()`
cancels outstanding work, drains it, and then completes scoped cleanup. A host
operation that never settles can therefore prevent shutdown from finishing. Host
implementations must settle after cancellation; a timeout cannot safely pretend
that an acquisition or an external side effect has stopped.

Canonical request/result slots and tail frames are reused. Other allocations,
including variable-length payloads and non-tail frames, remain in the shared
bump arena until all invocations and caller brackets end. Releasing one call
cannot rewind storage belonging to a still-running sibling. Closing the final
call reclaims the allocation region, but does not shrink Wasm's high-water
memory capacity. General long-lived actors with allocating workloads still need
finer allocation lifetimes; this protocol does not promise bounded memory for
them. Resource cleanup belongs to scopes and runs after dependent work drains.

`pnpm test:suspension` exercises the real Wasm protocol, borrow refusal,
concurrent invocations, cancellation, resource cleanup, cooperative callback
execution, repeated scalar requests, and development links.
