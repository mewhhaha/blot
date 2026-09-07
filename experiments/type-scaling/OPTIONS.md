# Type-scaling option contract

Options are validated before creating temporary sources or compiler sessions.
`--samples=N` accepts a positive, safe decimal integer and requires an odd count.
`--sizes=N,M,...` accepts positive, safe decimal integers in strictly increasing
order. A single size remains valid and has no slope. Empty values, partial
numbers, exponent notation, fractions, and duplicate or descending sizes fail.

Only explicitly registered family names are accepted; JavaScript prototype
properties are not families. Repeated family selections and repeated options
are rejected instead of silently accepting redundant selections or replacing an
earlier configuration. The `--` package-manager delimiter remains supported.

Defaults, generators, qualification, timed boundaries, and report schemas are
unchanged. The parser is pure, so invalid configurations can be regression-tested
without allocating a compiler or reporting misleading timing samples.

```sh
node --import tsx --test experiments/type-scaling/options.test.ts
```
