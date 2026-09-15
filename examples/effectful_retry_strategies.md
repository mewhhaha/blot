# Effect-polymorphic retry strategies

`effectful_retry_strategies.blot` factors retry policy away from the operation being retried. The concrete motivation is a remote fetch that may fail transiently, but the same abstraction is also reused for a pure parser. Retry policy therefore does not need to know whether the operation performs effects.

The reusable API is `examples/lib/retry_strategy.blot`:

```blot
const Strategy = fn (State, Error) => {
  .initial = State;
  .next = (State, Error) -> #Retry State | #Stop Error;
}
```

`run` is quantified over the strategy state, operation input, success value, and error carrier. Its callback type and result repeat one signature-local open effect row:

```blot
((Input, State) -> Result (Output, Error) ~ { ..e })
  -> Result (Output, Error) ~ { ..e }
```

That relationship is the useful abstraction boundary. A retry wrapper cannot erase an effect performed by the operation, while a pure callback specializes the same API with an empty row. The strategy's `State` is also the exact state handed to every attempt and returned by `#Retry`, and the same `Error` carrier appears in the operation result, policy decision, and final result.

`bounded (max_retries, retryable)` supplies the common finite policy with `Int` retry state. A budget of zero stops after the first failed attempt. Positive values count retries after the initial attempt. The example uses two retries for a remote `FetchError` and one retry for a pure `ParseError`; the abstraction itself is unchanged.

## Compiler-enforced invariants

The compiler checks that the operation receives the strategy's exact state carrier, that strategy and operation use one compatible error carrier, and that the operation's full effect row remains visible through `run`. The rejection fixtures exercise each boundary: mismatched error types, mismatched state types, and an attempted pure wrapper around an effectful callback.

The compiler does not prove that an arbitrary user-defined `Strategy.next` eventually returns `#Stop`. That is a semantic law of a strategy implementation, not a property present in the structural type. The supported `bounded` constructor is finite by direct implementation, and the example does not claim termination for every possible `Strategy` value.

This tradeoff keeps the generic API small: strategies can express backoff counters, token-refresh stages, cursor changes, or other typed retry state without inventing a second effect system or weakening callback types. A stronger termination-indexed strategy would require additional evidence and ceremony that the concrete remote/pure reuse here does not need.

## Expected behavior

The effectful handler simulates three cases. `"flaky"` returns `#Transient` for attempts 0 and 1 and succeeds with `204` on attempt 2; `"rejected"` returns a non-retryable `#Rejected` immediately; and `"stable"` succeeds on the first attempt. The pure parser retries one `#Incomplete "eventual"` failure and then returns `42`, stops immediately on `#Invalid "bad"`, and the zero-budget policy returns the first `#Incomplete` without a retry.

Evaluator and emitted-Wasm observations are recorded independently under `examples/expected/`.

## Run

With a Rust/Wasm compiler artifact matching the checkout:

```sh
pnpm blot check examples/effectful_retry_strategies.blot
pnpm blot run examples/effectful_retry_strategies.blot
pnpm blot lint --check examples/lib/retry_strategy.blot examples/effectful_retry_strategies.blot
pnpm blot build examples/effectful_retry_strategies.blot
node --import tsx --test src/node/effectful_retry_strategies.test.ts
node scripts/check_abstractions.mjs
```

The supported executable belongs in `examples/`; the three fixtures are intentional source-level rejections exercised by the focused Node suite rather than supported catalog programs.
