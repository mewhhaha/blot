import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SealedCheckSession } from "./session.ts";

test("dependency changes still propagate through unchanged intermediaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-sealed-dependency-"));
  const leaf = join(directory, "leaf.blot");
  const middle = join(directory, "middle.blot");
  const root = join(directory, "root.blot");
  await writeFile(leaf, "export { .answer = 42; }\n");
  await writeFile(
    middle,
    `const dependency = import "./leaf.blot"\n` +
      `export { .answer = 7; }\n`,
  );
  await writeFile(
    root,
    `const middle = import "./middle.blot"\nexport middle.answer\n`,
  );

  const session = new SealedCheckSession();
  assert.equal((await session.check(root)).type, "7");
  await writeFile(leaf, "export { .answer = 43; }\n");
  const changed = await session.check(root);
  assert.equal(changed.type, "7");
  assert.deepEqual(changed.rechecked, [leaf, middle, root]);
});

test("shared dependency diamonds are collected once per module", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-sealed-diamond-"));
  const paths: string[] = [];
  const leaf = join(directory, "leaf.blot");
  await writeFile(leaf, "export { .answer = 42; }\n");
  paths.push(leaf);

  let previous: [string, string] | null = null;
  for (let level = 1; level <= 10; level += 1) {
    const left = join(directory, `left-${level}.blot`);
    const right = join(directory, `right-${level}.blot`);
    if (previous === null) {
      const source =
        `const dependency = import "./leaf.blot"\nexport dependency\n`;
      await writeFile(left, source);
      await writeFile(right, source);
    } else {
      const [previousLeft, previousRight] = previous;
      const leftName = previousLeft.split("/").at(-1)!;
      const rightName = previousRight.split("/").at(-1)!;
      const source = `const left = import "./${leftName}"\n` +
        `const right = import "./${rightName}"\n` +
        `export { .answer = left.answer; .other = right.answer; }\n`;
      await writeFile(left, source);
      await writeFile(right, source);
    }
    paths.push(left, right);
    previous = [left, right];
  }

  const root = join(directory, "root.blot");
  const [left, right] = previous!;
  await writeFile(
    root,
    `const left = import "./${left.split("/").at(-1)!}"\n` +
      `const right = import "./${right.split("/").at(-1)!}"\n` +
      `export { .answer = left.answer; .other = right.answer; }\n`,
  );
  paths.push(root);

  const initial = await new SealedCheckSession().check(root);
  assert.equal(initial.rechecked.length, paths.length);
  assert.equal(new Set(initial.rechecked).size, paths.length);
});
