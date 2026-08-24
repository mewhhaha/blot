# Unified compiler benchmark

This harness records named compiler boundaries in one deterministic JSON schema.
Each scenario first compares its semantic observation with a fresh compiler, so
unequal programs or artifacts are never reported as a performance comparison.

```bash
pnpm benchmark:compiler -- examples/minimal.blot --samples=9 \
  --output=experiments/compiler-bench/latest.json
```

Ordinary pull requests gate deterministic work counters. Wall time, RSS, and
compiler memory observations are trend data for scheduled runs.
