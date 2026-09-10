import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompilerInvariantFailure } from "./policy.ts";
import { Compiler } from "./session.ts";
import { CompilerWasm } from "./wasm.ts";
import { runArtifact } from "../node/run.ts";

test("prepared HIR snapshots cannot mutate the resident validated module", async () => {
  const compiler = await Compiler.create();
  const fresh = await Compiler.create();
  const prepare = CompilerWasm.prototype.prepareCompilerSessionRuntimeHir;
  let preparations = 0;
  CompilerWasm.prototype.prepareCompilerSessionRuntimeHir = function (
    handle,
    path,
  ) {
    preparations += 1;
    return prepare.call(this, handle, path);
  };
  try {
    const path = "examples/minimal.blot";
    const first = await compiler.prepare(path);
    const expected = await fresh.prepare(path);
    assert.deepEqual(first, expected);
    const instruction = first.functions[0].continuations[0].instructions[0];
    assert.equal(instruction.operation.kind, "constant");
    if (instruction.operation.kind !== "constant") {
      throw new Error("expected a constant");
    }
    assert.equal(instruction.operation.value, 42n);

    // JavaScript consumers are not constrained by TypeScript's readonly types.
    Reflect.set(first, "schemaVersion", -1);
    Reflect.set(instruction.operation, "value", 9007199254740993n);
    Reflect.set(instruction.definition.span, "file", "forged.blot");
    Reflect.set(first.signatures[0].parameters, 0, 999);
    Reflect.set(first.exports[0], "sourceName", "forged");
    const second = await compiler.prepare(path);
    assert.deepEqual(second, expected);
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first.functions, second.functions);

    // A cache hit must also detach its result; copying only the miss is unsafe.
    Reflect.set(second.types[0], "kind", "text");
    Reflect.set(second.functions[0].continuations[0].instructions, "length", 0);
    assert.deepEqual(await compiler.prepare(path), expected);
    assert.equal(await runArtifact(await compiler.compile(path)), "42");
    assert.equal(
      preparations,
      2,
      "only the two fresh sessions prepare in Rust",
    );
  } finally {
    CompilerWasm.prototype.prepareCompilerSessionRuntimeHir = prepare;
    compiler.destroy();
    fresh.destroy();
  }
});

test("prepared HIR remains isolated across roots and edited revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-hir-snapshots-"));
  const firstPath = join(directory, "first.blot");
  const secondPath = join(directory, "second.blot");
  const compiler = await Compiler.create();
  const fresh = await Compiler.create();
  try {
    await writeFile(firstPath, "return 1\n");
    await writeFile(secondPath, "return 2\n");
    const first = await compiler.prepare(firstPath);
    const second = await compiler.prepare(secondPath);
    Reflect.set(first.functions, "length", 0);
    assert.deepEqual(await compiler.prepare(secondPath), second);
    await writeFile(firstPath, "return 3\n");
    const edited = await compiler.prepare(firstPath);
    assert.deepEqual(edited, await fresh.prepare(firstPath));
    Reflect.set(edited.exports, "length", 0);
    assert.deepEqual(
      await compiler.prepare(firstPath),
      await fresh.prepare(firstPath),
    );
    assert.equal(await runArtifact(await compiler.compile(firstPath)), "3");
  } finally {
    compiler.destroy();
    fresh.destroy();
    await rm(directory, { recursive: true });
  }
});

for (const kind of ["imports", "includes"] as const) {
  for (const collision of ["empty", "delimiter", "equivalent"] as const) {
    test(`semantic installation checks ${kind} ${collision} reports`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "blot-parity-collision-"));
      const path = join(directory, "main.blot");
      const specifiers = ["./a.blot", "./b.blot"];
      let source = "return 42\n";
      if (collision !== "empty") {
        await writeFile(join(directory, "a.blot"), "return 1\n");
        await writeFile(join(directory, "b.blot"), "return 2\n");
        if (kind === "imports") {
          source = 'const a = import "./a.blot"\n' +
            'const b = import "./b.blot"\nreturn (a, b)\n';
        } else {
          source = 'const a = @include "./a.blot"\n' +
            'const b = @include "./b.blot"\nreturn (a, b)\n';
        }
      }
      await writeFile(path, source);
      const share = CompilerWasm.prototype.shareCompilerSessionModule;
      let injected = false;
      CompilerWasm.prototype.shareCompilerSessionModule = function (
        sourceHandle,
        targetHandle,
        modulePath,
      ) {
        const result = share.call(this, sourceHandle, targetHandle, modulePath);
        if (modulePath !== path || !result.ok) return result;
        injected = true;
        let reported = [""];
        if (collision === "delimiter") reported = [specifiers.join("\0")];
        if (collision === "equivalent") {
          reported = [specifiers[1], specifiers[0], specifiers[1]];
        }
        // Fault injection changes only the semantic-installation report, after
        // genuine Rust parsing/inspection and host filesystem resolution.
        return { ...result, module: { ...result.module, [kind]: reported } };
      };
      let compiler: Compiler | undefined;
      try {
        compiler = await Compiler.create();
        if (collision === "equivalent") {
          const checked = await compiler.check(path);
          assert.equal(typeof checked.type, "string");
        } else {
          await assert.rejects(compiler.check(path), (error: unknown) => {
            assert(error instanceof CompilerInvariantFailure);
            assert.match(error.message, /source-graph agreement/);
            assert.match(error.message, new RegExp(`${kind} differ`));
            return true;
          });
        }
        assert.equal(injected, true);
        CompilerWasm.prototype.shareCompilerSessionModule = share;
        // A failed parity check must not publish a reusable installed payload.
        const repaired = await compiler.check(path);
        assert.equal(typeof repaired.type, "string");
      } finally {
        CompilerWasm.prototype.shareCompilerSessionModule = share;
        compiler?.destroy();
        await rm(directory, { recursive: true });
      }
    });
  }
}
