# Theory and implementation review: preserve the host boundary

## Verdict and scope

Reviewed main: `03de7962b8e72365c4bb918e60309bb98f6d9cdd`, including the merged
specialization-environment repair, product representation review, and workspace
graph repair. This is a new review, not another presentation of those fixes.

Keep Blot's separation of structural inference, checked compile-time bridges,
identity-sensitive safety and ownership, and representation-closing staging.
The new finding is that this architecture needs an equally explicit **host
preservation contract**. A correct Rust result can become an incorrect user
observation after decoding, copying, or comparing it in TypeScript. Naming Rust
as the semantic authority does not make those operations semantically inert.

This review cross-reads the integrated model and focused compiler, staging,
incremental, safety, predicate, and runtime contracts against the relevant Rust
and host boundaries. The implementation repair is narrower than that review:
three host defects, fifteen new regression cases, and a cross-spec contract in
[`spec/COHERENCE.md` section 12](../spec/COHERENCE.md). It changes no grammar,
source inference rule, primitive, residual identity, Wasm instruction selection,
public ABI version, compiler-host ABI version, or generated compiler artifact.
It adds no TypeScript semantic fallback.

The review is not an exhaustive audit of every Rust branch, a proof of the whole
compiler, or a claim of a green repository-wide suite. Reproduced failures that
remain outside the repair are recorded below rather than weakened into passing
tests.

## 1. Architectural assessment

### 1.1 Preserve separate judgments, not just separate source files

The distinctions in [`spec/PAPER.md`](../spec/PAPER.md) are useful: source
acceptance, ordinary type compatibility, phase availability, relational proof,
resource ownership, target representation, and public interoperability answer
different questions. A homogeneous runtime carrier does not establish any of
the other judgments. Conversely, a source-level product need not be a heap
allocation merely because a programmer gives it a name.

The implementation should continue to move explicit facts between those
judgments. In particular, a source binding's name cannot substitute for an
ownership certificate; a printed type cannot substitute for a generative effect
identity; and a matching Runtime-HIR layout cannot substitute for equivalence of
specialized closure environments. The recently merged residual identity repair
addresses that last mistake. It should not be simplified back to layout-only
sharing to regain cache hits.

The principality and complexity claims must retain their stated domain. The
open structural inference fragment, closed Boolean normalization, predicate
recognition, compile-time execution, specialization, and whole-program graph
loading do not automatically inherit one another's bounds. Limiting a proof
search makes the implementation bounded; it does not prove that a rejected
obligation is false or that arbitrary specialization is polynomial.

### 1.2 Types as values need checked bridges

Blot's type, effect, reflection, and layout values are coherent only with the
phase checks in [`spec/STAGING.md`](../spec/STAGING.md). Ordinary computation can
construct a value without making that value admissible as an erased type or a
runtime layout. Runtime data must not select an unrecorded compile-time branch
that changes a residual representation.

This is why the review does not propose a host-side workaround for unresolved
recursive signatures. Guessing a representation in TypeScript would create a
second compiler precisely where the Rust boundary has refused to establish one.
The correct repair belongs in signature settlement and representation closure,
with tests of both inferred interfaces and actual emitted behavior.

### 1.3 Demand, effects, and ownership must compose

The coherence rule that demand precedes ownership accounting remains essential.
An erased pure declaration cannot discharge a linear obligation merely because
its unused body contains a consuming call. Affine discard and linear exact use
on terminating exits are distinct; neither alone implements finalization.
Likewise, an empty algebraic-effect row does not establish totality, absence of
traps, or permission to reorder demanded calls.

These distinctions constrain a cache as much as an optimizer. Reusing a
compile-time fact is not permission to memoize a runtime effectful result.
Reusing a closed representation is not permission to merge generative
occurrences. The existing separation between ordinary effects and applicative
seals is worth retaining because equal-looking fields do not establish the same
identity rule for both.

### 1.4 The observation boundary extends past Wasm emission

The compiler correctness obligation includes values observed through canonical
adapters. A Wasm module can validate, compute the right bytes, and still be
misobserved by a host decoder. Tests that stop at `WebAssembly.validate` cannot
catch this. Tests that compare only evaluator display strings can also miss it,
because the evaluator and host legitimately use different escape conventions.

For this review, text cases compare the evaluator's structured value with the
expected Unicode scalar sequence, then independently execute emitted Wasm and
parse the host's formatted result. Neither implementation is allowed to serve
as a lossy oracle for the other. Nested arrays and variant payloads exercise the
same requirement recursively.

## 2. Reproduced defect: leading U+FEFF disappears

### Counterexample

For a source Text containing U+FEFF followed by `hello`, the Rust evaluator
returns those six scalar values. Before the repair, `runArtifact` returns the
formatted string `"hello"`. A Text containing only U+FEFF becomes empty. Two
leading U+FEFF values become one. Interior U+FEFF is preserved, which makes
ordinary text examples poor coverage for this failure.

The independent compiler-frame codec has the same error:

```ts
const encoder = new BinaryEncoder();
encoder.string("\uFEFFhello");
const decoder = new BinaryDecoder(encoder.finish());
// Before: "hello". Required: "\uFEFFhello".
const actual = decoder.string("text");
```

Both decoders used `new TextDecoder("utf-8", { fatal: true })`. Strict decoding
rejects malformed bytes, but does not disable encoding-signature handling. The
[WHATWG Encoding Standard](https://encoding.spec.whatwg.org/#interface-textdecoder)
specifies the separate BOM-handling flag. With its default setting, a leading
U+FEFF is consumed rather than emitted. `ignoreBOM: true` preserves it as data;
the option's name is easy to misread.

### Correct obligation and repair

For a sequence `s` of Unicode scalar values, a length-delimited string boundary
must satisfy:

```text
strict_decode(utf8_encode(s)) = s
```

Compiler-frame strings and ABI Text have an explicit byte length. Neither
reserves an initial scalar as an encoding signature. The repair adds
`ignoreBOM: true` to the frame decoder and Node canonical Text reader, retaining
`fatal: true` in both. There is no normalization, replacement-character
fallback, or source-file BOM policy change.

The frame regression compares with the original well-formed strings, not with a
second default `TextDecoder`; the latter would reproduce the defect in the
expected value. Existing malformed-frame and offset tests remain. The new ABI
negative control places malformed overlong UTF-8 after a valid U+FEFF prefix and
still requires rejection.

The observed impact is wrong host-visible Text and a lossy internal string
codec. This review does not claim an additional demonstrated exploit involving
module handles or a Rust emitter bug. The actual emitted Text bytes already
contain the expected scalar sequence.

## 3. Reproduced defect: callers can poison prepared HIR

### Counterexample

`Compiler.prepare` retained the decoded Runtime-HIR module in `revision.hir` and
returned that same object on both the initial request and cache hits. A
JavaScript caller could change `schemaVersion`, delete operations, replace a
constant or source span, or rename an export. The next `prepare` for unchanged
source returned the modified object.

This is observable even for `examples/minimal.blot`. Its genuine constant is
`42n`; editing the returned graph does not edit the source, but used to change
later HIR observations. A fresh session still returns the original graph.
TypeScript's `readonly` annotations do not prevent JavaScript or reflective
writes.

The scope matters: this counterexample poisons the host's prepared-HIR cache.
It does not demonstrate that the Rust emitter consumes the caller's object or
that emitted Wasm can be replaced through `prepare`. The compiler continues to
emit `42`; the inconsistency is between source, a validated observation, and
later supposedly equivalent observations.

### Correct obligation and repair

Fresh equivalence requires more than a complete input key. It also requires
that a cached fact retain its original contents between validation and reuse:

```text
resident = validate(prepare_Rust(revision))
public_i = detached_snapshot(resident)
mutate(public_i) does not mutate resident or public_j
```

`Compiler.prepare` now returns `structuredClone(revision.hir)` on both paths.
The resident decoded graph stays private. A shallow array or object copy would
leave nested aliases; JSON round-tripping would not preserve the BigInt-valued
constants in this representation. The tests explicitly exercise that scalar
kind and mutate nested operations, spans, signature arrays, type entries, and
exports, as well as a top-level field.

The tests also distinguish two incomplete repairs. Copying only the initial
result would leave the cache-hit path vulnerable. Repreparing in Rust for every
request would avoid one alias but discard useful cache reuse. A scoped call
counter requires exactly two Rust preparations across two fresh sessions,
regardless of the repeated reads of the first session. A separate test covers
different roots and an edited revision.

### Cost and authority

The added host work is proportional to the returned graph and its data on each
observation. It does not change Rust checking or specialization work. Retaining
many snapshots naturally retains many copies; this is caller-owned memory, not
an unbounded new resident compiler cache. No whole-compiler speedup is claimed.

Deep freezing a shared graph is a possible different API, but it changes how
existing JavaScript consumers can use returned data. Detached snapshots preserve
the ability to annotate a result locally without lending mutable authority over
the compiler's cache. A caller-modified snapshot is not a newly validated HIR
artifact. Any independent consumer that accepts modifications still needs its
own validation policy.

## 4. Reproduced defect: graph agreement is not set equality

The implementation of `requireSameDependencies` sorted and deduplicated each
side, then compared the strings obtained by joining with NUL. This contradicts
the already explicit rule in
[`spec/INCREMENTAL.md` section 2.1](../spec/INCREMENTAL.md).

The encoding is not injective:

```text
join_NUL([])          = join_NUL([""])
join_NUL(["a", "b"]) = join_NUL(["a\0b"])
```

It therefore cannot establish equality of sets, even if a downstream filesystem
usually rejects NUL. This check's purpose is to reject disagreement between the
compiler's installation report and the graph already resolved by the host. It
must not assume that an inconsistent report already satisfies the conclusion
it is meant to check.

The repair keeps the existing deterministic sorting and deduplication, compares
cardinality, and then compares each complete string. There is no delimiter,
locale-dependent comparison, or change to import occurrence semantics. The
existing invariant-failure class is preserved.

The regressions use real Rust parsing and source inspection plus real temporary
files. They inject an inconsistent report only at semantic installation by
scoping a wrapper around `shareCompilerSessionModule`. Both import and include
sets are tested with the empty and delimiter collisions. Before the repair the
inconsistent reports were accepted. Afterward they fail with the source-graph
agreement invariant; restoring the genuine report allows a retry.

Positive controls reorder and duplicate genuine reported specifiers. They must
still succeed because this particular agreement check compares sets, not
occurrence order or multiplicity. Other graph identities retain their own
occurrence-sensitive contracts. The tests restore the prototype in `finally`.

This is a demonstrated internal validation hole, not a claim that an ordinary
user can create a NUL-containing file and obtain code execution.

## 5. What the fixes establish, and what they do not

The three repairs share one principle: **boundary representations must preserve
meaning and authority, not merely look compatible**. A valid byte string can be
decoded incorrectly; a correctly keyed graph can be mutated after validation;
and two compact encodings can be equal while their source sets differ.

The new cross-spec section makes these requirements explicit without declaring
another source language. Runtime scalar preservation, cache observation
ownership, and exact graph agreement are obligations of the host that connects
the existing Rust judgments.

Finite tests establish the listed counterexamples and their repairs. They do
not establish general termination, arbitrary host-memory safety, all predicate
normalization cases, or progress-sensitive simulation for every accepted source
program. In particular, the
[Lean model's own scope statement](../formal/lean/README.md) excludes a proved
translation from the production compiler and the public ABI. Its local
preservation and ownership results do not automatically certify these
TypeScript adapters. The model and executable boundary tests are complementary.

## 6. Remaining findings and priorities

### Recursive closure settlement and effectful returns remain blockers

The complete Node test directory, including the recently added inline-product
tests, has the same three failures with and without these repairs:

- `a module may directly return an effectful computation`: `BLOT_NO_FIELD`,
  reporting that `()` has no `.add` field.
- `agent-style recursion remains dynamic runtime control flow and compiles`:
  `BLOT_UNSUPPORTED_LOWERING`, with `go$` lacking a settled signature.
- `owned radix sorts preserve signed order and stable equal-key order`:
  `BLOT_UNSUPPORTED_LOWERING`, with `count` lacking a settled signature.

The broader selected compiler/runtime suite also fails the existing
`static product fields are written by name, not runtime order` test with
`BLOT_TYPE_ERROR: Text does not flow into "x" | "y".` Restoring all three
original production files reproduces that failure.

These failures belong in a Rust typing/staging investigation, not in a host
fallback or a changed expected value. Representation refusal is preferable to
emitting an unchecked layout, but these executable examples still prevent a
claim of complete implementation coverage. Exact principal types and
runtime-input observations should accompany the eventual settlement repair.

### Refinement resource exhaustion has the wrong public class

A separate reproduction constructs 513 declarations and ends with
`return @array.get [1] 0`. On the matching compiler it throws a `BlotError`
carrying `BLOT_REFINEMENT_BUDGET`, with a message identifying the 512-term and
2048-edge limits. It is not a `CompilerLimitDiagnostic`.

The Rust classifier in
[`compiler/src/diagnostic.rs`](../compiler/src/diagnostic.rs) recognizes
`BLOT_EVALUATION_LIMIT` as a limit but otherwise defaults this code to a source
diagnostic. The existing native test
`affine_refinement_budget_refuses_an_unbounded_proof_graph` even asserts that
source-diagnostic payload. This conflicts with the separation between an
incomplete bounded proof search and a proof of source invalidity.

Static inspection also finds the predicate normalizer's 256-node exhaustion
branch returning its generic unsupported-predicate diagnostic, while
[`spec/PREDICATE_REFINEMENTS.md` section 8](../spec/PREDICATE_REFINEMENTS.md)
requires a limit result. That second observation is a code/spec finding, not a
claim that this review executed a 256-node predicate counterexample.

A follow-through should fix the Rust failure taxonomy and native expectations,
then test cold/warm requests and the public host and CLI classifications. It
must distinguish an unsupported predicate form from a supported form whose
normalization exhausted its budget. This PR deliberately does not relabel
Rust source errors in TypeScript or weaken the normative contract to match the
current bug.

### Proof and performance claims need boundary-specific evidence

The next review priority is not a larger umbrella theorem stated in prose. It
is executable correspondence at the unstable boundaries: recursive signature
settlement, budget classification, malformed public adapters, and exact retained
fact ownership. A source-level success test, an HIR validation test, an actual
Wasm observation, a compiler-work counter, and a mechanized local lemma answer
different questions. Their counts should not be added together as though they
were one correctness proof.

## 7. Validation and provenance

Local execution uses Node 22.16.0 and the genuine compiler published by main CI
run `34024233424`, artifact `9986592579`. That compiler was built for
`e9f32423502bfbe4d927608b98c96211f71ecf96`; its Rust inputs are unchanged in the
reviewed main. The matching source and prelude are used, and normal artifact
integrity checks remain enabled.

Compiler Wasm SHA-256:

```text
229853467420e86753fdca3a7ff119a677cf760da925a85ba395ee023f9d7ac9
```

Compiler-input SHA-256 from the manifest:

```text
703d062da53820e839620315f9f569e31e7854a7931887e912412116eb8af77e
```

The dependency workspace initially came from run `33986435635`. Source was
reconciled using the later staging-validation source artifact, then the merged
workspace changes and inline-product tests were reconciled to their exact
current-main blobs before the final runs. In particular, `src/load.ts` is
`7417b12cd02bfc2966dfbb8ac4929177c399e301` and `src/workspace_graph.ts` is
`550bf82480053e5082d75e5a8d8a2ba85e229fab`. These baseline reconciliations are not
part of the PR diff. The three modified production files were also checked
against their current-main blob identities.

Results on the final candidate:

| Check | Result |
| --- | --- |
| Focused frame, HIR/graph-boundary, and Node result suites | 25 passed |
| Same focused tests with original production files | 14 passed, 11 failed |
| Complete `src/node/*.test.ts` | 107 passed, 3 baseline failures |
| Selected compiler, Runtime-HIR, and development-runtime suites | 94 passed, 1 baseline failure |
| Strict scoped TypeScript no-emit check | Passed |
| Current implementation manifest freshness | Passed |
| `git diff --check` | Passed |

The fifteen added cases include positive controls; eleven fail on the original
implementation. These suite counts overlap and are not additive. The focused
compiler suite includes the existing deterministic performance gates.

Reproduction commands, after installing the repository's dependencies and
matching compiler distribution:

```sh
node --import tsx --test \
  src/compiler/binary_frame.test.ts \
  src/compiler/host_boundaries.test.ts src/node/run.test.ts

node --import tsx --test src/node/*.test.ts

node --import ./src/node/deno_test_compat.mjs --import tsx --test \
  src/compiler/*.test.ts src/runtime/hir.test.ts \
  src/development_runtime*.test.ts
```

The local artifact workspace additionally uses its `.pnp.cjs` through
`NODE_OPTIONS`. Native Rust tests/build, Lean, Deno formatting/lint/full
checking, the complete regression corpus, and all supported Node versions are
not certified by this run. The ordinary PR CI remains unchanged and must
establish merge readiness; none of its gates or existing tests is disabled.
