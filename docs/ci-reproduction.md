# Reproducing CI inputs

The **CI source snapshot** workflow publishes
`blot-validation-source-<commit>` for pull requests and pushes to `main`. It runs
independently of compiler validation, so a formatting, build, or test failure
does not hide the exact source that GitHub checked.

The artifact contains `source.tar.gz`, `commit.txt`, `tree.txt`, and
`SHA256SUMS`. The commit is the checked-out CI commit, including GitHub's test
merge commit for a pull request. It is not necessarily the PR head commit.

After downloading the artifact from the relevant workflow run:

```sh
sha256sum --check SHA256SUMS
mkdir blot-source
tar -xzf source.tar.gz -C blot-source
cat commit.txt tree.txt
```

Only Git-tracked files are archived. The archive excludes `.git`, checkout
credentials, dependency caches, and ignored compiler binaries. It is a source
snapshot, **not** a validated release or the runnable Node workspace. A green
snapshot job says only that the source was archived; the Rust/Wasm compiler CI
and other required checks remain authoritative for validation.

Install the pinned dependencies and toolchain described in `README.md`, then
run the failing command from the compiler CI log. Compiler binaries from another
run must pass the existing compiler-input, prelude, host ABI, and SHA-256 checks;
do not bypass artifact validation to make a reproduction run.

Snapshots expire after 14 days. The existing compiler and runnable-workspace
artifacts retain their own validation and retention policies.
