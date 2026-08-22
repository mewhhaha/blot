import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler } from "./session.ts";

test("Rust compiler host exposes check, prepare, compile", async () => {
  const compiler = await Compiler.create();
  try {
    const checked = await compiler.check("examples/minimal.blot");
    assert.equal(checked.type, "42");

    const runtime = await compiler.prepare("examples/minimal.blot");
    assert.equal(runtime.schemaVersion, 3);

    const artifact = await compiler.compile("examples/minimal.blot");
    const wasm = Uint8Array.from(artifact.wasm).buffer;
    assert.equal(WebAssembly.validate(wasm), true);
    assert.equal(artifact.artifactSource, "compiled");
  } finally {
    compiler.destroy();
  }
});

test("reuse assertion tags publish only discharged Store updates", async () => {
  const compiler = await Compiler.create();
  try {
    const runtime = await compiler.prepare(
      "examples/lib/reuse_clear_first.blot",
    );
    assert.equal(runtime.functions[0]?.reuse, "checked");

    const quicksort = await compiler.prepare(
      "examples/lib/reuse_quicksort.blot",
    );
    const updatingFunctions = quicksort.functions.filter((function_) =>
      function_.blocks.some((block) =>
        block.operations.some((operation) =>
          operation.kind === "store.write" || operation.kind === "store.grow"
        )
      )
    );
    assert.ok(updatingFunctions.length >= 1);
    for (const function_ of updatingFunctions) {
      assert.equal(function_.reuse, "checked");
      for (
        const operation of function_.blocks.flatMap((block) => block.operations)
      ) {
        if (
          operation.kind === "store.write" || operation.kind === "store.grow"
        ) {
          assert.equal(operation.update, "owned-reuse");
        }
      }
    }

    await assert.rejects(
      compiler.prepare(
        "examples/rejected/semantics/reuse_persistent_update.blot",
      ),
      /BLOT_LINEAR_ARGUMENT_NOT_OWNED/,
    );
  } finally {
    compiler.destroy();
  }
});

test("destroyed Rust compiler host refuses new work", async () => {
  const compiler = await Compiler.create();
  compiler.destroy();
  await assert.rejects(
    compiler.check("examples/minimal.blot"),
    /Compiler session has been destroyed/,
  );
});

test(
  "resident checker reuses a closed nullary leaf across root edits",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "blot-resident-leaf-"));
    const library = join(directory, "library.blot");
    const root = join(directory, "root.blot");
    const source = (x: number, other: string, value: number): string =>
      `const api = import "./library.blot"\n` +
      `return api.project { .x = ${x}; .${other} = ${value}; }\n`;
    const compiler = await Compiler.create();
    try {
      await writeFile(
        library,
        "const project = fn value => value.x\nreturn { .project = project; }\n",
      );
      await writeFile(root, source(1, "y", 2));
      assert.equal((await compiler.check(root)).type, "1");

      await writeFile(root, source(3, "z", 4));
      assert.equal((await compiler.check(root)).type, "3");

      await writeFile(
        library,
        "const project = fn value => value.z\nreturn { .project = project; }\n",
      );
      assert.equal((await compiler.check(root)).type, "4");
    } finally {
      compiler.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "resident checker never reuses a parameterized leaf check",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "blot-resident-param-"));
    const library = join(directory, "library.blot");
    const root = join(directory, "root.blot");
    const compiler = await Compiler.create();
    try {
      await writeFile(
        library,
        "module with input\nlet hidden = input.base\nreturn { .answer = 42; }\n",
      );
      await writeFile(
        root,
        'const library = import "./library.blot" with { .base = 1; }\n' +
          "return library.answer\n",
      );
      assert.equal((await compiler.check(root)).type, "42");

      await writeFile(
        root,
        'const library = import "./library.blot" with { .name = 1; }\n' +
          "return library.answer\n",
      );
      await assert.rejects(
        compiler.check(root),
        /does not flow into \{ \.base = ⊤ \}/,
      );
    } finally {
      compiler.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
