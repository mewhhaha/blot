# Packages and distributed modules

## 1. Separation of concerns

A registry package supplies transport, version selection, integrity, and a local
directory. Blot supplies module resolution and the meaning of its artifacts.
Registry code is never evaluated to import a Blot module.

A package directory contains a `blot.json` manifest. An export names both its
ordinary source and, optionally, a built module capsule:

```json
{
  "schema": "blot-package",
  "version": 4,
  "exports": {
    ".": {
      "source": "./src/mod.blot",
      "built": "./dist/mod.blotc"
    }
  }
}
```

The version is an artifact-schema discriminator. It is not part of the package
directory layout or the source import specifier.

## 2. Logical and physical identity

Let `P` be a resolved package instance, including the registry-selected package
version and integrity, and let `e` be one of its manifest export keys. The
logical identity of an imported root is

```text
PackageModule(P, e)
```

The local `node_modules` path is evidence for resolving that identity, not the
identity itself. Moving an unchanged installed graph does not change program
meaning. Distinct installed package instances may not share generative
identities merely because their source bytes happen to match.

Relative imports inside source modules retain their ordinary module-relative
meaning. A bare specifier selects `.`; a package subpath selects the
corresponding `./subpath` export. Export targets are relative paths confined to
the package directory.

Package names, subpaths, and the portion of an export key after `./` consist of
nonempty `/`-separated segments. A segment cannot be `.` or `..` and cannot
contain a backslash or NUL. A scoped name requires a nonempty scope after `@`
and a package-name segment. The root export key `.` remains valid. Malformed
specifiers are rejected before looking for a manifest, so path normalization
cannot turn a package name into a different package directory. This rule does
not constrain ordinary relative source imports.

## 3. Reusable module capsules

A reusable `.blotc` capsule is not final WebAssembly. Imported compile-time
functions may select result types and runtime projections from concrete values
known only in the consumer, so consumer-site checking and specialization remain
authoritative.

The capsule contains:

- the exact package-owned canonical AST module graph exported by Rust;
- resolved relative-import edges between graph nodes;
- logical external edges for package and `blot:` imports;
- exact included-file bytes and their source-visible paths;
- a schema version and a SHA-256 hash over the canonical gzip payload.

Producing it requires the source export to pass ordinary Rust checking. The AST
bytes are exported from that resident Rust session rather than re-encoded by a
host semantic pass. An absolute import, or a relative import that escapes the
package, is rejected rather than capturing an accidental build-machine path.
External package edges remain logical so the consumer's package installation can
share them and select their versions normally.

Loading validates the schema, compression, canonical hash, arena references,
spans, graph acyclicity, import uniqueness, include uniqueness, and agreement
between AST dependency expressions and declared edges before any module closure
is exposed. Dependency agreement compares the number and complete text of the
unique specifiers, not a delimiter-joined representation: a delimiter can itself
occur in text and cannot certify equality of two sets. External edges then
resolve as ordinary imports from the installed capsule's package location. Thus
the capsule removes package-owned source reads, lexing, parsing, CST
materialisation, fixity folding, and lowering. It does not claim to remove
consumer checking or specialization.

Later schemas may add a settled closed interface, specialization capsule, stable
generative identities, and reusable safety or ownership certificates. Such a
field is usable only after its decoder establishes the corresponding pass
contract from [`COMPILER.md`](COMPILER.md); an opaque serialization of live
compiler memory is not an artifact.

The compiler-distributed prelude snapshot is not a registry capsule extension.
Its semantic authority comes from being generated and shipped beside the checker
as part of one trusted compiler distribution. Physical separation from the
checker WebAssembly does not create a public certificate format. A registry
package cannot opt into that trust by copying the snapshot fields or recomputing
a content hash.

## 4. Validation and fallback

Write `decode(a) = A` when artifact bytes `a` validate as lowered module graph
`A`, and `lower(G) = A` when ordinary frontend processing lowers source graph
`G` to that graph. Sound artifact reuse requires

```text
decode(a) = A    lower(G) = A
-------------------------------- capsule-fidelity
compile_capsule(a) = compile_fresh(G)
```

The present implementation obtains this result by rebuilding ordinary module
closures from validated ASTs and edges, after which the same checker and
compiler run. Package construction checks `G` before writing `A`; the consumer
does not need `G` to establish that `A` is a well-formed compiler input.

If a package's built target is missing, corrupt, or uses an unsupported schema,
resolution uses its declared source target. Failure of both targets reports the
package, export, and attempted paths. An explicitly imported `.blotc` has no
implicit fallback because no manifest declared one.

Fallback is semantic, not heuristic: it may replace only the capsule with the
source graph from which that package export is defined. It cannot silently
select another package version or export.

## 5. Closed applications

A closed application artifact remains the emitted `.wasm` plus its canonical ABI
manifest. It has no consumer-site specialization boundary. Packages may ship
both reusable `.blotc` library exports and closed application artifacts, but
they are distinct products and are not interchangeable.

## 6. Determinism and future certification

Capsule modules, imports, includes, AST arenas, and JSON members have canonical
order. Host-owned module identifiers and import/include specifiers are ordered
lexicographically by UTF-16 code units, independently of the host locale. Export
and dependency traversal use the same order when assigning capsule identifiers.
Rust retains ownership of the canonical AST bytes; host ordering does not
reinterpret those bytes. The gzip encoding is deterministic. For a fixed checked
graph, two builds emit byte-identical capsules. The content hash covers every
compressed byte that can affect reconstructed source semantics.

The decoder continues to accept valid existing capsules regardless of the
producer's ordering. Canonicalizing future output does not change the capsule
schema, the AST contract, or the meaning of an existing content hash.

A future certificate-bearing capsule key additionally includes the compiler
semantic schema, generated parser plan, primitive catalog, dependency logical
identities, include transforms, and every target policy observed by the cached
phase. The cache laws in [`INCREMENTAL.md`](INCREMENTAL.md) apply unchanged.
