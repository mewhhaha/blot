# Compiler Wasm optimization profile decision

Status: current decision for compiler-host ABI 2.

The release compiler remains at `opt-level = "s"`. The controlled 10,000-edit
matrix in
[`compiler-profile-matrix.latest.json`](compiler-profile-matrix.latest.json) was
recorded on Node 24.12.0 / V8 13.6 with fat LTO, one codegen unit, aborting
panics, stripping, and an 8 MiB compiler stack.

This schema-2 matrix installs and opens the distributed prelude snapshot inside
the fresh boundary before checking the root. It supersedes the historical
schema-1 result that measured a dependency-free root.

| Profile | Compiler Wasm | Shipped compiler payload | Compile / instantiate |    Fresh / edit | Prepare / emit |  10k soak |     Pages |
| ------- | ------------: | -----------------------: | --------------------: | --------------: | -------------: | --------: | --------: |
| `s`     |   4,095,350 B |              4,507,168 B |        4.57 / 0.17 ms | 57.51 / 0.68 ms | 2.61 / 2.00 ms | 498.62 ms | 249 → 249 |
| `2`     |   5,230,881 B |              5,642,699 B |        8.55 / 0.14 ms | 72.56 / 0.62 ms | 3.79 / 2.86 ms | 396.15 ms | 249 → 249 |
| `3`     |   5,371,184 B |              5,783,002 B |        5.83 / 0.39 ms | 59.20 / 0.59 ms | 5.25 / 4.85 ms | 369.98 ms | 249 → 249 |

`2` is 27.7% larger and `3` is 31.1% larger than `s`; including the common
snapshot, their shipped payloads are 25.2% and 28.3% larger. Their semantic-edit
and soak advantages do not offset that cost: `s` was fastest for compilation,
the fresh check, preparation, and emission. None of the profiles grew guest
memory during the soak. The type-scaling rows report identical semantic work at
every profile—2,565 type nodes, 5,632 constraints, and 9,730 settle visits at
256 declarations—while their wall times remain deliberately observational.

Artifact hashes:

- `s`: `f9476ab30fd3b8cc2b67e4249b68574e396d0167b7c901b4a1703e4462559121`
- `2`: `c5f00d519c072868c1f60e2300573fc80c603d7acb130247df1707b5f6806032`
- `3`: `4cab21a6caed6d881d15bf38dff9c9c4165f6fe1299c2e6c2b150c851a7b83ad`

The scheduled performance workflow reruns the same controlled matrix after the
compiler build and uploads the JSON without turning ordinary timing variation
into a pull-request failure.
