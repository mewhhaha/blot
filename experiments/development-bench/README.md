# Development rebuild benchmark

This benchmark measures the development-mode latency target on a generated 5 MiB
project with 20 reachable units. The entry imports every unit, modeling a
project whose scenes and subsystems share one source graph, while demand selects
one gameplay unit for the current build. The edited unit is intentionally small;
the remaining source volume verifies that a known file change does not rescan or
recompile unrelated units.

Each of 20 warm samples changes the selected unit's implementation without
changing its interface. A sample fails if any other unit is emitted as changed.
The run fails when p95 is 100 ms or greater.

```bash
pnpm benchmark:development
```

This is not a claim about edits that change a unit interface or make another
large subsystem newly demanded. Those edits correctly invalidate more work and
need a separate workload if they become latency targets.
