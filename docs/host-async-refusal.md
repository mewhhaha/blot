# Asynchronous host-result refusal

The scalar adapter remains synchronous. A handler returning a Promise or
thenable still fails the guest call with the existing synchronous-result
`TypeError`; neither its eventual value nor its effects are accepted as a guest
result.

Before refusing an object or function result, the adapter observes its Promise
rejection. This prevents an immediate or delayed rejection from escaping as an
unhandled rejection after the caller has already caught the contract error.
Promise assimilation also covers cross-realm Promises and rejecting thenables.
This is rejection cleanup, not guest suspension, cancellation, or rollback of
host work that has already started. It does not promise that a trapped guest
instance is reusable.

`src/node/host_async.test.ts` runs the real adapter in a separate Node process
with `--unhandled-rejections=strict`. It checks immediate, delayed, cross-realm,
and thenable rejection for both Int and Unit host results, requires the
synchronous refusal, and requires the process to survive. The abstraction
qualification runner includes this regression alongside the existing host tests.
