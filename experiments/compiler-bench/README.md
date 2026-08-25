# Unified compiler benchmark

This harness records named compiler boundaries in one deterministic JSON schema.
Scenarios run serially so they do not compete for one process. Cold-process
samples launch a new Node process, cold-compiler samples create a new compiler,
and warm uncached samples use a distinct source path for every revision. Each
scenario checks that its public type and effects remain unchanged.

```bash
pnpm benchmark:compiler -- examples/minimal.blot --samples=9 \
  --output=experiments/compiler-bench/latest.json
```

Ordinary pull requests gate deterministic work counters. Wall time, RSS, and
compiler memory observations are trend data for scheduled runs.
