# Portable suspension

This contract owns the Rust target lowering of checked host suspension facts.
`LANGUAGE.md` owns source effect sequencing and `docs/abi.md` owns ABI 3 bytes.

## Checked inputs

A host operation has input/result ownership and a suspension mode: `never` or
`may-suspend`. Ordinary arrow descriptors normalize to `never`; an explicit
descriptor's optional `.suspension` field uses `#Never` or `#MaySuspend`,
defaulting to `never` when omitted. The mode participates in effect
identity, residual identity, and checked boundary encoding. Missing mode facts
are invalid Runtime HIR, not an invitation to infer a default in the host.

## Resumption relation

After specialization, Rust computes the least fixed point of functions that
perform a suspending host operation or call an affected function. Other
functions retain direct calls. Affected functions split only at those calls;
each resulting segment retains its original operations and control-flow edges.

A frame contains the current segment, parent activation, result destination,
and typed value slots. A direct child writes its private result into the
parent's slots. A host completion is decoded through the canonical adapter,
including constructor-order translation, before execution continues. Branch
arguments are transferred simultaneously using the existing Runtime HIR rules.
No operation before the current segment may execute again on resumption.

The dispatcher executes compiler-emitted segment functions. JavaScript receives
typed host requests and drives exported protocol operations; it neither
interprets Runtime HIR nor reconstructs source control flow. Tokens and request
identities are checked before touching suspended state. Released tokens cannot
resume a later activation.

## Ownership and current target boundary

The ownership pass rejects lexical borrows across possibly suspending calls,
including calls whose effect row has an open tail. Ordinary handlers and
one-shot source continuations retain their existing contracts.

The current host supports one active invocation per instance. Release reclaims
its entire allocation region. Ownership-bearing host capabilities require a
future checked cleanup contract and are explicitly refused for suspension;
release does not invent destructors. Structured task scheduling, worker entry
transfer, and resumable development links are subsequent extensions, not implied
by accepting a Promise from a marked operation.

Target closure separates representation refusals from compiler invariants using
a typed closure failure. In particular, arrays at a suspension boundary and
incompatible dynamic sum payload layouts are refused before emission. A failure
in an admitted segment remains a compiler invariant failure. The host must never
turn either class into a fabricated source diagnostic.
