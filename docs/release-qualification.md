# Exact-revision release qualification

A built compiler artifact is not evidence that its integration tests passed.
Release qualification uses one frozen source commit, its successful standard CI
run, complete job evidence, and the compiler bytes built for that same commit.
Do not substitute a green result from an earlier revision or a diagnostic
workspace uploaded before tests ran.

## Evidence check

Obtain the selected run and its jobs from the authenticated GitHub API. Fetch
the complete collection: a truncated jobs response is deliberately rejected.
Download the compiler artifact from that run and extract its manifest and Wasm.

```sh
gh api repos/mewhhaha/blot/actions/runs/RUN_ID > run.json
gh api 'repos/mewhhaha/blot/actions/runs/RUN_ID/jobs?per_page=100' > jobs.json
pnpm release:check \
  --commit FULL_COMMIT_SHA \
  --run run.json \
  --jobs jobs.json \
  --compiler generated/compiler/compiler-artifact.json \
  --wasm generated/compiler/compiler.wasm
```

`RUN_ID` and `FULL_COMMIT_SHA` are explicit placeholders to replace, not
inferred from the newest uploaded artifact. The checker requires a completed
successful push or manually dispatched standard `ci.yml` run. Pull-request merge
candidates are not silently treated as the source branch's commit: their merge
checkout and branch head can have different identities. Use a frozen
push/dispatch revision for release evidence.

The checker corroborates `head_commit.id` and `head_commit.tree_id` from the run
against the selected commit and compiler source tree. Missing or malformed head
metadata is refused. Every returned job must have a unique positive safe-integer
ID, including additional jobs outside the mandatory set.

The checker rejects mismatched run/compiler commits or trees, incomplete job
pagination, wrong run attempts, duplicate jobs, absent or skipped required steps,
unfinished or failed runs, and a development-profile compiler. Required evidence includes
formal checks, native compiler tests, package checks, the normal Node suite,
frontend generation, deterministic performance gates, and both Node target
profiles. It validates the artifact's manifest and the actual Wasm byte length,
header, and SHA-256 using the existing artifact validator.

This is an evidence-consistency check over supplied files, not a signed
attestation and not a proof that arbitrary JSON is authentic. Obtain those files
from the authenticated repository connection, review the exact workflow/source
revision, and preserve the full unchanged CI gate. Step names alone cannot prove
that someone has not changed a workflow's commands. This tool neither publishes
a package, changes branch protection, nor merges a pull request.

## Abstraction qualification

```sh
pnpm test:abstractions
```

The focused runner tests refactoring, closure capture identity, inline products,
checked predicate helpers, source-free packages, resident/fresh compiler
agreement, language claims, the scalar host adapter, and the live-report host.
Each suite runs in its own process with a 120-second deadline because a Node
callback timeout cannot interrupt synchronous Wasm. Exceeding that deadline is a
failed qualification, never a skipped or accepted expected failure.

The independent `Abstraction contracts` Actions workflow builds from its exact
checkout and runs this qualification even when an unrelated native integration
failure blocks later steps in standard CI. Its early workspace upload is marked
by purpose as diagnostic evidence, not a successful release. Both workflows must
be interpreted at their exact commits; the focused workflow does not replace the
standard compiler CI.

## Current integration blockers

Issue #96 remains open. The native unsettled-Scratch-helper failure was
reproduced against the reviewed compiler source during this implementation. No
assertion was weakened, no failing compiler test was deleted, and no timeout was
recast as success. Bounded predicate-helper acceptance and host-tool tests do
not establish that qualified-operator lowering, recursive results, or the engine
scaling issue are repaired. A release still needs a completed standard run on
its final frozen source and an explicit disposition for every reported blocker.
