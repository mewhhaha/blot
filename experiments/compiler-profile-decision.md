# Compiler Wasm optimization profile decision

Status: current decision for compiler-host ABI 2.

The release compiler remains at `opt-level = "s"`. The controlled 10,000-edit
matrix in
[`compiler-profile-matrix.latest.json`](compiler-profile-matrix.latest.json) was
recorded on Node 24.19.0 / V8 13.6 with fat LTO, one codegen unit, aborting
panics, stripping, and an 8 MiB compiler stack.

| Profile | Compiler Wasm | Shipped compiler payload | Compile / instantiate |    Fresh / edit | Prepare / emit |  10k soak |     Pages |
| ------- | ------------: | -----------------------: | --------------------: | --------------: | -------------: | --------: | --------: |
| `s`     |   3,606,573 B |              3,989,551 B |        8.37 / 0.43 ms | 14.21 / 0.56 ms | 4.93 / 4.04 ms | 532.91 ms | 133 → 133 |
| `2`     |   4,706,760 B |              5,089,738 B |       10.48 / 0.76 ms | 18.08 / 0.97 ms | 6.19 / 4.55 ms | 477.65 ms | 133 → 133 |
| `3`     |   4,850,759 B |              5,233,737 B |       28.31 / 1.25 ms | 25.86 / 0.77 ms | 5.46 / 4.00 ms | 410.08 ms | 133 → 133 |

`2` is 30.5% larger and `3` is 34.5% larger than `s`. Their faster soak did not
offset that shipped-size cost: `s` was fastest for compilation, instantiation,
fresh check, semantic edit, and prepare in this run; emission was effectively
tied with `3`. None of the profiles grew guest memory during the soak. The
type-scaling rows report identical semantic work at every profile—2,565 type
nodes, 5,632 constraints, and 9,988 settle visits at 256 declarations—while
their wall times remain deliberately observational.

Artifact hashes:

- `s`: `155894e707afe722781516400ec0911923d8075febf00c89f329252e7cb8a492`
- `2`: `b1e02388044fec948ad8a6589b12742b0e8e1d7ed84ba1292a12a90056dd8901`
- `3`: `744e42e9db41343dbb406ea180d12e7715b6abf05a701b0bf33e306ef434b0df`

The scheduled performance workflow reruns the same controlled matrix after the
compiler build and uploads the JSON without turning ordinary timing variation
into a pull-request failure.
