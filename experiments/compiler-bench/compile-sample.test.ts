import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { parseCompilationSampleOptions } from "./compile-sample.ts";

test("complete compilation defaults to cold, not cached preparation", () => {
  assert.deepEqual(
    parseCompilationSampleOptions(["--entry=examples/minimal.blot"]),
    {
      entry: resolve("examples/minimal.blot"),
      mode: "cold",
      wasm: undefined,
      snapshot: undefined,
      output: undefined,
    },
  );
});

test("diagnostic compilers require an explicit matched snapshot", () => {
  for (const extra of ["--wasm=compiler.wasm", "--snapshot=prelude.snapshot"]) {
    assert.throws(
      () => parseCompilationSampleOptions(["--entry=main.blot", extra]),
      /both/,
    );
  }
  const options = parseCompilationSampleOptions([
    "--entry=main.blot",
    "--wasm=compiler.wasm",
    "--snapshot=prelude.snapshot",
    "--mode=split",
  ]);
  assert.equal(options.mode, "split");
  assert.equal(options.wasm, "compiler.wasm");
});

test("invalid modes and duplicate or unknown options cannot relabel samples", () => {
  for (
    const args of [
      [],
      ["--entry=main.blot", "--mode=warm"],
      ["--entry=main.blot", "--mode=cold", "--mode=resident"],
      ["--entry=main.blot", "--samples=5"],
      ["--entry="],
    ]
  ) assert.throws(() => parseCompilationSampleOptions(args));
  assert.equal(
    parseCompilationSampleOptions(["--entry=main.blot", "--mode=resident"])
      .mode,
    "resident",
  );
});
