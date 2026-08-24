import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runtimeHirSchema } from "./protocol.ts";
import { CompilerTargetRefusal } from "./policy.ts";
import { Compiler } from "./session.ts";

test("Rust compiler host exposes check, prepare, compile", async () => {
  const compiler = await Compiler.create();
  try {
    const checked = await compiler.check("examples/minimal.blot");
    assert.equal(checked.type, "42");

    const runtime = await compiler.prepare("examples/minimal.blot");
    assert.equal(runtime.schemaVersion, runtimeHirSchema);

    const artifact = await compiler.compile("examples/minimal.blot");
    const wasm = Uint8Array.from(artifact.wasm).buffer;
    assert.equal(WebAssembly.validate(wasm), true);
    assert.equal(artifact.artifactSource, "compiled");
  } finally {
    compiler.destroy();
  }
});

test("unsupported lowering remains a target refusal after checking", async () => {
  const compiler = await Compiler.create();
  try {
    await compiler.check("examples/lib/region_vault.blot");
    await assert.rejects(
      compiler.compile("examples/lib/region_vault.blot"),
      (error: unknown) => {
        assert(error instanceof CompilerTargetRefusal);
        assert.equal(error.code, "BLOT_UNSUPPORTED_LOWERING");
        return true;
      },
    );
  } finally {
    compiler.destroy();
  }
});

test("Array builders and Map update helpers evaluate through the prelude", async () => {
  const compiler = await Compiler.create();
  try {
    const evaluated = await compiler.evaluate(
      "examples/lib/array_builder_and_map_updates.blot",
    );
    assert.equal(evaluated.display, "(3, #Some 11, #Some 20)");
  } finally {
    compiler.destroy();
  }
});

test("Shape.update preserves fields outside the updater's visible row", async () => {
  const compiler = await Compiler.create();
  try {
    const evaluated = await compiler.evaluate(
      "examples/lib/shape_update.blot",
    );
    assert.equal(evaluated.display, "3");
  } finally {
    compiler.destroy();
  }
});

test("Unicode-scalar Text operations agree in evaluation and emitted Wasm", async () => {
  const compiler = await Compiler.create();
  try {
    const evaluated = await compiler.evaluate(
      "examples/lib/text_processing_eval.blot",
    );
    assert.equal(
      evaluated.display,
      '("α,beta,γ", 3, #Some "α", #Some 2, "α,B,γ", #True, #True)',
    );

    const runtime = await compiler.prepare(
      "examples/lib/text_processing.blot",
    );
    const operations = runtime.functions.flatMap((function_) =>
      function_.blocks.flatMap((block) => block.operations)
    );
    assert.ok(
      operations.some((operation) => operation.kind === "text.length"),
    );
    assert.ok(
      operations.some((operation) => operation.kind === "text.find-from"),
    );
    assert.ok(operations.some((operation) => operation.kind === "text.slice"));

    const artifact = await compiler.compile(
      "examples/lib/text_processing.blot",
    );
    assert.equal(
      WebAssembly.validate(Uint8Array.from(artifact.wasm).buffer),
      true,
    );

    const scalarArtifact = await compiler.compile(
      "examples/lib/text_scalar_runtime.blot",
    );
    const instance = await WebAssembly.instantiate(
      Uint8Array.from(scalarArtifact.wasm) as BufferSource,
    );
    const memory = instance.instance.exports.memory as WebAssembly.Memory;
    const realloc = instance.instance.exports.cabi_realloc as (
      oldPointer: number,
      oldSize: number,
      alignment: number,
      newSize: number,
    ) => number;
    const run = instance.instance.exports["blot:default"] as (
      pointer: number,
      length: number,
    ) => bigint;
    const input = new TextEncoder().encode("🙂αβ");
    const pointer = realloc(0, 0, 1, input.byteLength);
    new Uint8Array(memory.buffer, pointer, input.byteLength).set(input);
    assert.equal(run(pointer, input.byteLength), 5n);
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
    const writingFunctions = quicksort.functions.filter((function_) =>
      function_.blocks.some((block) =>
        block.operations.some((operation) => operation.kind === "store.write")
      )
    );
    assert.ok(writingFunctions.length >= 1);
    for (const function_ of writingFunctions) {
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
    const operations = quicksort.functions.flatMap((function_) =>
      function_.blocks.flatMap((block) => block.operations)
    );
    assert.ok(
      operations.some((operation) => operation.kind === "call.direct"),
      "runtime quicksort lost its direct recursive call",
    );
    assert.ok(
      quicksort.functions.some((function_) =>
        function_.blocks.some((block) =>
          block.terminator.kind === "branch" &&
          block.terminator.target === function_.entryBlock
        )
      ),
      "runtime quicksort lost its tail-recursive back-edge",
    );
    for (const operation of operations) {
      if (operation.kind === "store.write" || operation.kind === "store.grow") {
        assert.equal(operation.update, "owned-reuse");
      }
    }

    const artifact = await compiler.compile(
      "examples/lib/reuse_quicksort.blot",
    );
    const module = await WebAssembly.compile(
      Uint8Array.from(artifact.wasm) as BufferSource,
    );
    const importedFunctions = WebAssembly.Module.imports(module).map((entry) =>
      `${entry.module}.${entry.name}`
    );
    assert.deepEqual(importedFunctions, ["blot:host/Source.value"]);

    const instantiate = async (direction: bigint): Promise<() => bigint> => {
      const instance = await WebAssembly.instantiate(module, {
        "blot:host/Source": {
          value(input: bigint) {
            if (input === 0n) return 4n;
            return direction;
          },
        },
      });
      const run = instance.exports["blot:default"];
      assert.equal(typeof run, "function");
      return run as () => bigint;
    };
    assert.equal((await instantiate(1n))(), 204n);
    assert.equal((await instantiate(-1n))(), 120n);

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

test("canonical syntax snapshots expose parser bypass and node reuse", async () => {
  const compiler = await Compiler.create();
  const path = join(tmpdir(), "blot-canonical-syntax-snapshot.blot");
  const source = "const first = 1\nconst second = 2\nreturn first\n";
  try {
    const initial = await compiler.syntaxSnapshot(path, source);
    assert.equal(initial.parserExecuted, true);
    assert.equal(initial.cst.name, "program");

    const unchanged = await compiler.syntaxSnapshot(path, source);
    assert.equal(unchanged.parserExecuted, false);
    assert.equal(unchanged.portableAstDigest, initial.portableAstDigest);
    assert.ok(unchanged.reuse.length > 0);

    const edited = await compiler.syntaxSnapshot(
      path,
      source.replace("second = 2", "second = 3 + 4"),
    );
    assert.equal(edited.parserExecuted, true);
    assert.ok(edited.reuse.length > 0);
  } finally {
    compiler.destroy();
  }
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
