import { scalarExport } from "../../test_support/guest_abi.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { BlotError } from "../diagnostic.ts";
import { Compiler } from "./session.ts";

const catalog: {
  accepted: { name: string; type: string; value: string }[];
  rejected: { name: string; code: string }[];
} = JSON.parse(await readFile("examples/pathologies/value-cases.json", "utf8"));

for (const item of catalog.accepted) {
  test(`value pathology ${item.name}: type, evaluation, and Wasm agree`, async () => {
    const path = `examples/pathology_values_${item.name}.blot`;
    const compiler = await Compiler.create();
    try {
      assert.deepEqual(await compiler.check(path), {
        type: item.type,
        effects: "",
      });
      assert.equal((await compiler.evaluate(path)).display, item.value);
      assert.equal(
        await readFile(
          `examples/expected/pathology_values_${item.name}.txt`,
          "utf8",
        ),
        `${item.value}\n`,
      );
      const cold = await compiler.compile(path);
      const warm = await compiler.compile(path);
      assert.deepEqual(cold.wasm, warm.wasm);
      const { instance } = await WebAssembly.instantiate(
        Uint8Array.from(cold.wasm),
      );
      const run = scalarExport(instance, "blot:default");
      assert.equal(typeof run, "function");
      assert.equal((run as () => unknown)(), BigInt(item.value));
    } finally {
      compiler.destroy();
    }
  });
}

for (const item of catalog.rejected) {
  test(`value pathology ${item.name}: refuses erased type information`, async () => {
    const path = `examples/pathologies/value-rejected/${item.name}.blot`;
    const compiler = await Compiler.create();
    try {
      await compiler.portableAst(path);
      const source = await readFile(path, "utf8");
      await assert.rejects(compiler.check(path), (error: unknown) => {
        assert.ok(error instanceof BlotError);
        assert.equal(error.diagnostic.code, item.code);
        assert.equal(error.origin?.path, resolve(path));
        assert.equal(error.origin?.source, source);
        assert.ok(error.diagnostic.span.start >= 0);
        assert.ok(error.diagnostic.span.end > error.diagnostic.span.start);
        assert.ok(error.diagnostic.span.end <= source.length);
        return true;
      });
    } finally {
      compiler.destroy();
    }
  });
}
