import { scalarExport } from "../test_support/guest_abi.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { Compiler } from "./compiler.ts";
import { buildPackage } from "./package.ts";
import {
  decodeModuleCapsule,
  PACKAGE_FORMAT_VERSION,
} from "./package_format.ts";

test("capsules keep distinct POSIX filenames distinct", {
  skip: sep !== "/",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "blot-capsule-paths-"));
  const compiler = await Compiler.create();
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested/main.blot"), "return 20\n");
    await writeFile(join(root, "nested\\main.blot"), "return 22\n");
    await writeFile(
      join(root, "main.blot"),
      'open import "blot:prelude"\n' +
        'const a = import "./nested/main.blot"\n' +
        'const b = import "./nested\\\\main.blot"\n' +
        "return a + b\n",
    );
    const manifestPath = join(root, "blot.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schema: "blot-package",
        version: PACKAGE_FORMAT_VERSION,
        exports: {
          ".": { source: "./main.blot", built: "./dist/main.blotc" },
        },
      }),
    );
    const before = await compiler.evaluate(join(root, "main.blot"));
    assert.deepEqual(before.value, { tag: "int", value: "42" });

    await buildPackage(manifestPath);
    const capsulePath = join(root, "dist/main.blotc");
    const first = await readFile(capsulePath, "utf8");
    const capsule = await decodeModuleCapsule(first, capsulePath);
    assert.deepEqual(capsule.modules.map((module) => module.name), [
      "./main.blot",
      "./nested/main.blot",
      "./nested\\main.blot",
    ]);
    await buildPackage(manifestPath);
    assert.equal(await readFile(capsulePath, "utf8"), first);

    await rm(join(root, "main.blot"));
    await rm(join(root, "nested"), { recursive: true });
    await rm(join(root, "nested\\main.blot"));
    const consumer = join(root, "consumer.blot");
    await writeFile(consumer, 'return import "./dist/main.blotc"\n');
    const fresh = await Compiler.create();
    try {
      const after = await fresh.evaluate(consumer);
      assert.deepEqual(after, before);
      const artifact = await fresh.compile(consumer);
      const { instance } = await WebAssembly.instantiate(
        Uint8Array.from(artifact.wasm),
      );
      const run = scalarExport(instance, "blot:default");
      assert.equal(typeof run, "function");
      if (typeof run !== "function") throw new Error("missing default export");
      assert.equal(run(), 42n);
    } finally {
      fresh.destroy();
    }
  } finally {
    compiler.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("package graph confinement still rejects escaping relative imports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-package-escape-"));
  try {
    const root = join(directory, "package");
    await mkdir(root);
    await writeFile(join(directory, "outside.blot"), "return 42\n");
    await writeFile(
      join(root, "main.blot"),
      'return import "../outside.blot"\n',
    );
    const manifestPath = join(root, "blot.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schema: "blot-package",
        version: PACKAGE_FORMAT_VERSION,
        exports: { ".": { source: "./main.blot", built: "./main.blotc" } },
      }),
    );
    const target = join(root, "main.blotc");
    await writeFile(target, "previous artifact\n");
    await assert.rejects(() => buildPackage(manifestPath), {
      message: /package-owned module .* is outside/,
    });
    assert.equal(await readFile(target, "utf8"), "previous artifact\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
