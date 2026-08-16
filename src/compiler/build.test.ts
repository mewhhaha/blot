import { buildBatch } from "./build.ts";

Deno.test("Blot compiler batches admitted modules around a local source failure", async () => {
  const paths = [
    new URL("../../examples/minimal.blot", import.meta.url).pathname,
    new URL(
      "../../examples/rejected/syntax/if_expression_without_else.blot",
      import.meta.url,
    ).pathname,
    new URL("../../examples/arithmetic.blot", import.meta.url).pathname,
  ];
  const outcomes = await buildBatch(paths);

  assertEquals(
    outcomes.map((outcome) => outcome.status).join(","),
    "built,failed,built",
  );
  for (const [ordinal, outcome] of outcomes.entries()) {
    assertEquals(outcome.path, paths[ordinal]);
    if (outcome.status === "failed") continue;
    assertEquals(outcome.wasmEmitter, "rust-wasm");
    assertEquals(WebAssembly.validate(Uint8Array.from(outcome.wasm)), true);
  }
  if (outcomes[0].status !== "built" || outcomes[2].status !== "built") {
    throw new Error("admitted Blot modules did not survive the batch");
  }
  assertEquals(outcomes[0].wasm.buffer === outcomes[2].wasm.buffer, false);
});

Deno.test("Blot compiler artifact reuse owns its published bytes", async () => {
  const path = `${await Deno.makeTempDir({ dir: "/tmp" })}/stable.blot`;
  await Deno.writeTextFile(
    path,
    `export 41
`,
  );

  const [first] = await buildBatch([path]);
  if (first === undefined || first.status !== "built") {
    throw new Error("initial stable module did not compile");
  }
  assertEquals(first.artifactSource, "compiled");
  const wasm = first.wasm.slice();
  const manifestBytes = first.manifestBytes.slice();
  first.wasm[0] = 0;
  first.manifestBytes[0] = 0;
  (first.capabilities as string[]).push("caller-mutation");

  const [repeated] = await buildBatch([path]);
  if (repeated === undefined || repeated.status !== "built") {
    throw new Error("repeated stable module did not compile");
  }
  assertEquals(repeated.artifactSource, "revision-cache");
  assertByteArraysEqual(repeated.wasm, wasm);
  assertByteArraysEqual(repeated.manifestBytes, manifestBytes);
  assertEquals(repeated.capabilities.length, 0);
  assertEquals(repeated.wasm.buffer === first.wasm.buffer, false);
  assertEquals(
    repeated.manifestBytes.buffer === first.manifestBytes.buffer,
    false,
  );
});

Deno.test("Blot compiler artifact reuse misses after a direct edit", async () => {
  const path = `${await Deno.makeTempDir({ dir: "/tmp" })}/direct-edit.blot`;
  await Deno.writeTextFile(
    path,
    `export 41
`,
  );
  const [first] = await buildBatch([path]);
  if (first === undefined || first.status !== "built") {
    throw new Error("initial direct-edit module did not compile");
  }

  await Deno.writeTextFile(
    path,
    `export 42
`,
  );
  const [edited] = await buildBatch([path]);
  if (edited === undefined || edited.status !== "built") {
    throw new Error("edited direct-edit module did not compile");
  }
  assertEquals(edited.artifactSource, "compiled");
  assertByteArraysDiffer(edited.wasm, first.wasm);

  const [repeated] = await buildBatch([path]);
  if (repeated === undefined || repeated.status !== "built") {
    throw new Error("repeated edited module did not compile");
  }
  assertEquals(repeated.artifactSource, "revision-cache");
  assertByteArraysEqual(repeated.wasm, edited.wasm);
});

Deno.test("Blot compiler artifact reuse misses after a dependency edit", async () => {
  const directory = await Deno.makeTempDir({ dir: "/tmp" });
  const dependency = `${directory}/dependency.blot`;
  const root = `${directory}/root.blot`;
  await Deno.writeTextFile(
    dependency,
    `module with capabilities
export { .run = capabilities.base; }
`,
  );
  await Deno.writeTextFile(
    root,
    `let application = import "./dependency.blot" with { .base = 41; }
export application.run
`,
  );
  const [first] = await buildBatch([root]);
  if (first === undefined || first.status !== "built") {
    let cause = "missing outcome";
    if (first !== undefined) cause = String(first.cause);
    throw new Error(
      `initial importing module did not compile: ${cause}`,
    );
  }

  await Deno.writeTextFile(
    dependency,
    `module with capabilities
export { .run = 42; }
`,
  );
  const [edited] = await buildBatch([root]);
  if (edited === undefined || edited.status !== "built") {
    throw new Error("edited importing module did not compile");
  }
  assertEquals(edited.artifactSource, "compiled");
  assertByteArraysDiffer(edited.wasm, first.wasm);
});

Deno.test("Blot compiler compiles only misses in stable mixed batches", async () => {
  const directory = await Deno.makeTempDir({ dir: "/tmp" });
  const stablePath = `${directory}/stable.blot`;
  const editedPath = `${directory}/edited.blot`;
  await Deno.writeTextFile(
    stablePath,
    `export 1
`,
  );
  await Deno.writeTextFile(
    editedPath,
    `export 2
`,
  );
  const warmed = await buildBatch([stablePath, editedPath]);
  assertEquals(
    warmed.map((outcome) => {
      if (outcome.status === "built") return outcome.artifactSource;
      return "failed";
    }).join(","),
    "compiled,compiled",
  );

  await Deno.writeTextFile(
    editedPath,
    `export 3
`,
  );
  const mixed = await buildBatch([editedPath, stablePath]);
  assertEquals(
    mixed.map((outcome) => outcome.path).join(","),
    [
      editedPath,
      stablePath,
    ].join(","),
  );
  assertEquals(
    mixed.map((outcome) => {
      if (outcome.status === "built") return outcome.artifactSource;
      return "failed";
    }).join(","),
    "compiled,revision-cache",
  );
});

Deno.test("Blot compiler does not cache a failed source revision", async () => {
  const path = `${await Deno.makeTempDir({ dir: "/tmp" })}/repaired.blot`;
  await Deno.writeTextFile(path, "export ;");
  const [failed] = await buildBatch([path]);
  let failedStatus: string | undefined;
  if (failed !== undefined) failedStatus = failed.status;
  assertEquals(failedStatus, "failed");

  await Deno.writeTextFile(
    path,
    `export 42
`,
  );
  const [repaired] = await buildBatch([path]);
  if (repaired === undefined || repaired.status !== "built") {
    throw new Error("repaired module did not compile");
  }
  assertEquals(repaired.artifactSource, "compiled");
});

function assertByteArraysEqual(
  actual: Uint8Array,
  expected: Uint8Array,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((byte, index) => byte !== expected[index])
  ) {
    throw new Error(
      `expected ${expected.length} identical bytes; received ${actual.length}`,
    );
  }
}

function assertByteArraysDiffer(left: Uint8Array, right: Uint8Array): void {
  if (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  ) {
    throw new Error(`expected ${left.length} bytes to differ`);
  }
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}; received ${String(actual)}`);
  }
}
