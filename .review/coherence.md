
## 12. Host observation and cached-fact integrity

The single Rust semantic authority does not exempt the host from preservation
obligations. The transport in [`COMPILER.md`](COMPILER.md), the caller relation
in [`RUNTIME.md`](RUNTIME.md), and fresh-equivalent observations in
[`INCREMENTAL.md`](INCREMENTAL.md) compose only when the host preserves both the
value delivered and the ownership of retained facts.

### 12.1 Length-delimited text is data

For a sequence `s` of Unicode scalar values, decoding its length-delimited UTF-8
encoding must return exactly `s`. Compiler-frame strings and ABI 2 Text have no
encoding-signature prefix. In either boundary a leading U+FEFF is a value, not
metadata to strip; repeated and interior U+FEFF values are preserved as well.
Decoding remains strict: overlong sequences, surrogate encodings, truncated
sequences, and out-of-range scalars are not made valid by this rule.

This is a preservation requirement for string payloads, not a change to source
file syntax, Unicode normalization, or the existing treatment of ill-formed
host UTF-16 input. The public ABI, compiler-host ABI, and frame schema are
unchanged.

### 12.2 Observations do not lend mutable cache authority

A validated resident Runtime-HIR graph belongs to its exact compiler revision.
`Compiler.prepare` returns a detached snapshot on both initial preparation and
cache hits. Caller writes to that snapshot, including nested types, signatures,
blocks, operations, spans, and exports, cannot change the resident graph or any
later snapshot. Exact scalar values, including BigInt constants, survive the
copy. Repeated reads may reuse the Rust preparation; copying is host observation
work rather than repeated checking or residualization.

Validation applies to the snapshot as delivered. A caller-modified snapshot is
not thereby a newly compiler-validated artifact and grants no authority to the
Rust compiler or an independent consumer. Neither TypeScript `readonly` nor a
shallow copy establishes this isolation. This rule extends the same ownership
principle already used for returned Wasm and manifest bytes.

The source/host dependency agreement required by `INCREMENTAL.md` section 2.1
continues to compare exact sets of specifier strings. Encodings used to test
that equality must be injective over those sets; a delimiter join is not, even
when the delimiter is uncommon in ordinary filesystem paths. An inconsistent
installation report remains an invariant failure, not a source diagnostic or a
license to configure a different graph.
