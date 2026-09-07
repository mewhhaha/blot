# Regression runner failures are not empty successes

Run `pnpm test:regression` from the repository root. The runner discovers regular
`.test.ts` files recursively, prints each selected path, and runs files in sorted
order in separate Node processes. The Node host and explicitly excluded
standalone/package suites retain their dedicated commands.

An empty discovery result is an error. Running from the wrong directory, or
accidentally excluding every test, must not produce a successful CI result.
Hidden directories, dependency/build output, auxiliary repositories, symlinks,
and dedicated suites remain excluded; the runner does not relax discovery to
invent a nonempty result.

`BLOT_TEST_TIMEOUT_MS` accepts a positive decimal integer no larger than
2147483647; the default is 300000 milliseconds per file. Node's parent test
runner enforces the deadline even if synchronous compiler Wasm blocks a test's
event loop. A failed or timed-out file stops the run before subsequent files.
This per-file deadline does not replace the enclosing workflow's job timeout.

The runner tests cover ordinary successful runs, assertion failures, blocked
synchronous work, invalid deadlines, empty directories, and directories that
contain only excluded tests.
