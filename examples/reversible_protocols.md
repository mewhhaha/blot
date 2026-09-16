# Reversible protocol transitions

`reversible_protocols.blot` models a workflow whose state type changes at each
stage while preserving enough typed evidence to walk the workflow backwards. The
concrete article pipeline moves through `Draft -> Reviewed -> Published`.
Reviewing also produces an `Approval`, and publishing consumes exactly that
carrier; the composed transition therefore checks both the state boundary and
the value boundary between the two steps.

The reusable abstraction takes one named compile-time descriptor:

```blot
Transition {
  .from = From;
  .input = Input;
  .to = To;
  .output = Output;
  .undo = Undo;
}
```

The descriptor is ordinary Blot data whose fields are type values. Named fields
make five related carriers readable without turning the API into a large
positional type tuple. A transition's `forward` operation returns the new state,
its output value, and operation-specific undo evidence. `backward` accepts
exactly the resulting state and that same evidence. `compose` quantifies over
the whole relationship and shares the intermediate `Middle` state plus `Through`
value between adjacent steps. The resulting transition pairs the two undo
carriers and runs them in reverse order when rolling back.

This is stronger than a same-state reversible update: the compiler rejects
publishing from a `Draft`, feeding a `Reviewed` value to the full workflow, or
supplying the undo tuple in the wrong order. It is also different from a one-way
state transition: a successful composed run carries precisely the evidence
needed to reconstruct the original stage. The compiler enforces carrier
compatibility; the semantic inverse law remains an executable contract rather
than a theorem of the type system.

The article states use constructors instead of progressively wider structural
records. Blot's record width subtyping is useful for capabilities and views, but
it intentionally means a record with extra fields can flow to a narrower record
type. Constructors make protocol stages disjoint when that exclusivity matters.

## Run it

From a checkout with the exact matching Rust/Wasm compiler artifact:

```sh
node --import tsx src/node/cli.ts check examples/reversible_protocols.blot
node --import tsx src/node/cli.ts run examples/reversible_protocols.blot
node --import tsx src/node/cli.ts lint --check \
  examples/lib/reversible_protocol.blot \
  examples/lib/article_protocol.blot \
  examples/reversible_protocols.blot
node --import tsx src/node/cli.ts build examples/reversible_protocols.blot
node --import tsx --test src/node/reversible_protocols.test.ts
```

The executable demonstrates the review step independently and then reuses it in
the composed workflow. It checks full round-trip restoration, a lossy publish
step whose reverse direction needs stored body/reviewer evidence, an empty body,
and Unicode text. The focused test also checks evaluator/Wasm agreement and
three intentional rejection cases: reversed composition, a wrong starting state,
and reversed undo evidence.

## Tradeoffs

The undo tuple reflects the composition tree. That is precise and makes reverse
order explicit, but larger public workflows should normally hide the raw tuple
behind a domain API rather than expose its association as application data.
Likewise, the type system proves that `backward` consumes the right carriers; it
cannot prove that a hand-written `backward` implementation is mathematically the
inverse of `forward`. Round-trip tests remain necessary for that law.
