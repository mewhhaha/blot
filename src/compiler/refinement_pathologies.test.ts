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
} = JSON.parse(await readFile("examples/pathologies/cases.json", "utf8"));

for (const item of catalog.accepted) {
  test(`pathology ${item.name}: principal type, evaluator, and Wasm`, async () => {
    const path = `examples/pathology_${item.name}.blot`;
    const compiler = await Compiler.create();
    try {
      const checked = await compiler.check(path);
      assert.equal(checked.type, item.type);
      const evaluated = await compiler.evaluate(path);
      assert.equal(evaluated.display, item.value);
      const golden = await readFile(
        `examples/expected/pathology_${item.name}.txt`,
        "utf8",
      );
      assert.equal(golden, `${item.value}\n`);
      const artifact = await compiler.compile(path);
      const { instance } = await WebAssembly.instantiate(
        Uint8Array.from(artifact.wasm),
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
  test(`pathology ${item.name}: rejects with ${item.code}`, async () => {
    const path = `examples/pathologies/rejected/${item.name}.blot`;
    const compiler = await Compiler.create();
    try {
      // A parser failure must never masquerade as a type-checking rejection.
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
