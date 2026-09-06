import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler } from "../../src/compiler.ts";
import { BlotError } from "../../src/diagnostic.ts";
import { runArtifact } from "../../src/node/run.ts";

interface ReportPaths {
  readonly root: string;
  readonly config: string;
  readonly label: string;
  readonly heading: string;
  readonly directory: string;
  readonly configSource: string;
}

async function withReport(
  run: (compiler: Compiler, paths: ReportPaths) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "blot-live-report-"));
  try {
    for (const name of [
      "main.blot",
      "config.blot",
      "score.blot",
      "heading.blot",
      "label.txt",
    ]) {
      await writeFile(
        join(directory, name),
        await readFile(new URL(name, import.meta.url)),
      );
    }
    const heading = join(directory, "heading-entry.blot");
    await writeFile(
      heading,
      'const report = import "./main.blot"\nreturn report.heading\n',
    );
    const config = join(directory, "config.blot");
    const compiler = await Compiler.create();
    try {
      await run(compiler, {
        root: join(directory, "main.blot"),
        config,
        label: join(directory, "label.txt"),
        heading,
        directory,
        configSource: await readFile(config, "utf8"),
      });
    } finally {
      compiler.destroy();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runtimeScore(
  compiler: Compiler,
  root: string,
  quantity: bigint,
): Promise<unknown> {
  const artifact = await compiler.compile(root);
  assert.equal(WebAssembly.validate(Uint8Array.from(artifact.wasm)), true);
  const { instance } = await WebAssembly.instantiate(
    Uint8Array.from(artifact.wasm),
  );
  const score = instance.exports["blot:score"];
  assert.equal(typeof score, "function");
  if (typeof score !== "function") throw new Error("score export is missing");
  return score(quantity);
}

test("report views infer field requirements and run quantities", async () => {
  await withReport(async (compiler, paths) => {
    assert.deepEqual(
      await compiler.check(join(paths.directory, "score.blot")),
      { type: "{ .quantity = Int } -> Int", effects: "" },
    );
    assert.deepEqual(
      await compiler.check(join(paths.directory, "heading.blot")),
      { type: "{ .name = Text } -> Text", effects: "" },
    );
    assert.deepEqual(await compiler.check(paths.root), {
      type: "{ .heading = Text; .score = Int -> Int }",
      effects: "",
    });
    for (const quantity of [0n, 1n, 21n, -3n]) {
      assert.equal(
        await runtimeScore(compiler, paths.root, quantity),
        quantity * 2n,
      );
    }
    assert.equal(
      await runArtifact(await compiler.compile(paths.heading)),
      '"Warehouse A: widgets"',
    );
  });
});

test("include refresh keeps the shared unsaved revision", async () => {
  await withReport(async (compiler, paths) => {
    assert.equal(await runtimeScore(compiler, paths.root, 21n), 42n);
    const overlay = paths.configSource.replace(".weight = 2", ".weight = 3");
    await compiler.setOverlay(paths.config, overlay, 1);
    assert.equal(await runtimeScore(compiler, paths.root, 21n), 63n);
    await writeFile(paths.label, "Warehouse B");
    assert.equal(await runtimeScore(compiler, paths.root, 21n), 63n);
    assert.equal(
      await runArtifact(await compiler.compile(paths.heading)),
      '"Warehouse B: widgets"',
    );
    // A fresh session with the same effective sources must agree.
    const fresh = await Compiler.create();
    try {
      await fresh.setOverlay(paths.config, overlay, 1);
      assert.deepEqual(
        await compiler.check(paths.root),
        await fresh.check(paths.root),
      );
      assert.equal(await runtimeScore(fresh, paths.root, 21n), 63n);
    } finally {
      fresh.destroy();
    }
  });
});

test("include refresh cannot silently repair an invalid weight", async () => {
  await withReport(async (compiler, paths) => {
    await compiler.check(paths.root);
    const invalid = paths.configSource.replace(
      ".weight = 2",
      '.weight = "heavy"',
    );
    await compiler.setOverlay(paths.config, invalid, 1);
    const rejectsWeight = async () => {
      await assert.rejects(
        () => compiler.check(paths.root),
        (error: unknown) => {
          assert.ok(error instanceof BlotError);
          assert.equal(error.diagnostic.code, "BLOT_TYPE_ERROR");
          assert.ok(error.diagnostic.span.end > error.diagnostic.span.start);
          return true;
        },
      );
    };
    await rejectsWeight();
    await writeFile(paths.label, "Warehouse B");
    await rejectsWeight();
    await compiler.setOverlay(
      paths.config,
      paths.configSource.replace(".weight = 2", ".weight = 4"),
      2,
    );
    assert.equal(await runtimeScore(compiler, paths.root, 21n), 84n);
    await compiler.clearOverlay(paths.config);
    assert.equal(await runtimeScore(compiler, paths.root, 21n), 42n);
  });
});

test("a new importer sees a released overlay without disk source", async () => {
  await withReport(async (compiler, paths) => {
    await compiler.setOverlay(
      paths.config,
      paths.configSource.replace(".weight = 2", ".weight = 3"),
      1,
    );
    assert.equal(await runtimeScore(compiler, paths.root, 21n), 63n);
    await compiler.releaseRoot(paths.config);
    await compiler.releaseRoot(paths.root);
    await rm(paths.config);
    assert.equal(await runtimeScore(compiler, paths.root, 21n), 63n);
    assert.equal(
      await runArtifact(await compiler.compile(paths.heading)),
      '"Warehouse A: widgets"',
    );
  });
});
