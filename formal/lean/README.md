# Blot Core model

This Lake package pins the Lean version in `lean-toolchain` and models the
smallest trusted value/computation boundary. It deliberately omits modules,
reflection, storage layouts, and the ABI.

`Blot/Core.lean` separates pure values from computations, records effect order
as a trace, keeps handlers explicit in the syntax, and represents a handler
continuation with a one-shot state transition. Its initial checked lemmas state
that a pure definition contributes no observation, binds append traces in source
order, and a resumed continuation becomes spent.

Run `lake build` from this directory.
