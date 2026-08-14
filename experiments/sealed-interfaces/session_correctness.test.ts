import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SealedCheckSession } from "./session.ts";

async function chain(depth: number, leafSource: string) {
  const directory = await mkdtemp(join(tmpdir(), "blot-sealed-review-"));
  const paths: string[] = [];
  const leaf = join(directory, "module-0.blot");
  await writeFile(leaf, leafSource);
  paths.push(leaf);
  for (let index = 1; index < depth; index += 1) {
    const path = join(directory, `module-${index}.blot`);
    await writeFile(
      path,
      `const dependency = @import "./module-${index - 1}.blot" ()\n` +
        `return { .answer = dependency.answer; }\n`,
    );
    paths.push(path);
  }
  return { root: paths.at(-1)!, leaf, paths };
}

test("failed incremental checks do not publish partial snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-sealed-transaction-"));
  const leaf = join(directory, "leaf.blot");
  const root = join(directory, "root.blot");
  await writeFile(
    leaf,
    `module input\nlet hidden = input.base\nreturn { .answer = 42; }\n`,
  );
  await writeFile(
    root,
    `const leaf = @import "./leaf.blot"\n` +
      `return (leaf { .base = 1; }).answer\n`,
  );

  const session = new SealedCheckSession();
  assert.equal((await session.check(root)).type, "42");
  await writeFile(
    leaf,
    `module input\nlet hidden = input.name\nreturn { .answer = 42; }\n`,
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      session.check(root),
      /no field .*name.*shape with \.base/,
    );
  }
});

test("referenced dead literals stay in the checked boundary", async () => {
  const fixture = await chain(
    5,
    "const seed = 1\nlet hidden = seed\nreturn { .answer = 42; }\n",
  );
  const session = new SealedCheckSession();
  await session.check(fixture.root);

  await writeFile(
    fixture.leaf,
    "const seed = 100\nlet hidden = seed\nreturn { .answer = 42; }\n",
  );
  const changed = await session.check(fixture.root);
  assert.equal(changed.rechecked.length, fixture.paths.length);
  assert.equal(changed.cacheHit, false);
});
