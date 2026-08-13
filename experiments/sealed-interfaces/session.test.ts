import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { refreshProgram } from "../../src/compiler/frontend.ts";
import { checkProgram } from "../../src/compiler/typecheck.ts";
import { SealedCheckSession, typeOnlyFingerprint } from "./session.ts";

async function chain(
  depth: number,
  leafSource: string,
): Promise<
  { readonly root: string; readonly leaf: string; readonly paths: string[] }
> {
  const directory = await mkdtemp(join(tmpdir(), "blot-sealed-"));
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

test("a dead private edit stops at a sealed module boundary", async () => {
  const fixture = await chain(
    6,
    "const hidden = 1\nreturn { .answer = 42; }\n",
  );
  const session = new SealedCheckSession();
  const initial = await session.check(fixture.root);
  assert.equal(initial.type, "{ .answer = 42; }");
  assert.equal(initial.rechecked.length, fixture.paths.length);

  await writeFile(
    fixture.leaf,
    "const hidden = 100\nreturn { .answer = 42; }\n",
  );
  const changed = await session.check(fixture.root);
  assert.equal(changed.type, "{ .answer = 42; }");
  assert.deepEqual(changed.rechecked, [fixture.leaf]);
  assert.equal(changed.cacheHit, true);
});

test("a live public change propagates through every importer", async () => {
  const fixture = await chain(
    6,
    "const hidden = 1\nreturn { .answer = 42; }\n",
  );
  const session = new SealedCheckSession();
  await session.check(fixture.root);

  await writeFile(
    fixture.leaf,
    "const hidden = 1\nreturn { .answer = 43; }\n",
  );
  const changed = await session.check(fixture.root);
  assert.equal(changed.type, "{ .answer = 43; }");
  assert.equal(changed.rechecked.length, fixture.paths.length);
  assert.equal(changed.cacheHit, false);
});

test("a dead declaration that constrains the module parameter propagates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-parameter-boundary-"));
  const leaf = join(directory, "leaf.blot");
  const root = join(directory, "root.blot");
  await writeFile(
    leaf,
    `module input\n` +
      `let hidden = input.base\n` +
      `return { .answer = 42; }\n`,
  );
  await writeFile(
    root,
    `const leaf = @import "./leaf.blot"\n` +
      `return (leaf { .base = 1; }).answer\n`,
  );

  const session = new SealedCheckSession();
  const initial = await session.check(root);
  assert.equal(initial.type, "42");

  await writeFile(
    leaf,
    `module input\n` +
      `let hidden = input.name\n` +
      `return { .answer = 42; }\n`,
  );
  await assert.rejects(
    session.check(root),
    /no field .*name.*shape with \.base/,
  );
  // A failed incremental request must not partially publish the leaf snapshot.
  // The same still-invalid revision has to fail again rather than hitting the
  // previous successful root summary.
  await assert.rejects(
    session.check(root),
    /no field .*name.*shape with \.base/,
  );
});

test("type-only sealing is unsound for compile-time callable exports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-type-only-seal-"));
  const leaf = join(directory, "leaf.blot");
  const root = join(directory, "root.blot");
  const writeLeaf = async (increment: number): Promise<void> => {
    await writeFile(
      leaf,
      `open @import "blot:prelude" ()\n` +
        `sig bump = Int -> Int\n` +
        `const bump = fn x => @int.add x ${increment}\n` +
        `return { .bump = bump; }\n`,
    );
  };
  await writeLeaf(1);
  await writeFile(
    root,
    `open @import "blot:prelude" ()\n` +
      `const leaf = @import "./leaf.blot" ()\n` +
      `const result = leaf.bump 41\n` +
      `return result\n`,
  );

  await refreshProgram(root);
  const beforeLeaf = await checkProgram(leaf);
  const beforeRoot = await checkProgram(root);
  assert.equal(beforeRoot.type, "42");

  await writeLeaf(2);
  await refreshProgram(root);
  const afterLeaf = await checkProgram(leaf);
  const afterRoot = await checkProgram(root);
  assert.equal(afterRoot.type, "43");
  assert.equal(
    typeOnlyFingerprint(beforeLeaf.type, beforeLeaf.effects),
    typeOnlyFingerprint(afterLeaf.type, afterLeaf.effects),
  );
  assert.notEqual(beforeRoot.type, afterRoot.type);
});

test("observable sealing propagates a compile-time behavior change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-observable-seal-"));
  const leaf = join(directory, "leaf.blot");
  const root = join(directory, "root.blot");
  const writeLeaf = async (increment: number): Promise<void> => {
    await writeFile(
      leaf,
      `open @import "blot:prelude" ()\n` +
        `sig bump = Int -> Int\n` +
        `const bump = fn x => @int.add x ${increment}\n` +
        `return { .bump = bump; }\n`,
    );
  };
  await writeLeaf(1);
  await writeFile(
    root,
    `open @import "blot:prelude" ()\n` +
      `const leaf = @import "./leaf.blot" ()\n` +
      `const result = leaf.bump 41\n` +
      `return result\n`,
  );

  const session = new SealedCheckSession();
  assert.equal((await session.check(root)).type, "42");
  await writeLeaf(2);
  const changed = await session.check(root);
  assert.equal(changed.type, "43");
  assert.equal(changed.cacheHit, false);
  assert.ok(changed.rechecked.includes(root));
});

test("a referenced dead literal is not forgotten from the checked boundary", async () => {
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
  assert.equal(changed.type, "{ .answer = 42; }");
  assert.equal(changed.rechecked.length, fixture.paths.length);
  assert.equal(changed.cacheHit, false);
});

test("dependency changes propagate through an unchanged intermediary for now", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-sealed-dependency-"));
  const leaf = join(directory, "leaf.blot");
  const middle = join(directory, "middle.blot");
  const root = join(directory, "root.blot");
  await writeFile(leaf, "return { .answer = 42; }\n");
  await writeFile(
    middle,
    `const dependency = @import "./leaf.blot" ()\n` +
      `return { .answer = 7; }\n`,
  );
  await writeFile(
    root,
    `const middle = @import "./middle.blot" ()\n` +
      `return middle.answer\n`,
  );

  const session = new SealedCheckSession();
  assert.equal((await session.check(root)).type, "7");

  await writeFile(leaf, "return { .answer = 43; }\n");
  const changed = await session.check(root);
  assert.equal(changed.type, "7");
  assert.deepEqual(changed.rechecked, [leaf, middle, root]);
  assert.equal(changed.cacheHit, false);
});

test("shared dependency diamonds are collected once per module", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-sealed-diamond-"));
  const paths: string[] = [];
  const leaf = join(directory, "leaf.blot");
  await writeFile(leaf, "return { .answer = 42; }\n");
  paths.push(leaf);

  let previous: [string, string] | null = null;
  const depth = 10;
  for (let level = 1; level <= depth; level += 1) {
    const left = join(directory, `left-${level}.blot`);
    const right = join(directory, `right-${level}.blot`);
    if (previous === null) {
      await writeFile(
        left,
        `const dependency = @import "./leaf.blot" ()\n` +
          `return dependency\n`,
      );
      await writeFile(
        right,
        `const dependency = @import "./leaf.blot" ()\n` +
          `return dependency\n`,
      );
    } else {
      const [previousLeft, previousRight] = previous;
      const leftName = previousLeft.split("/").at(-1)!;
      const rightName = previousRight.split("/").at(-1)!;
      const source =
        `const left = @import "./${leftName}" ()\n` +
        `const right = @import "./${rightName}" ()\n` +
        `return { .answer = left.answer; .other = right.answer; }\n`;
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
    `const left = @import "./${left.split("/").at(-1)!}" ()\n` +
      `const right = @import "./${right.split("/").at(-1)!}" ()\n` +
      `return { .answer = left.answer; .other = right.answer; }\n`,
  );
  paths.push(root);

  const session = new SealedCheckSession();
  const initial = await session.check(root);
  assert.equal(initial.rechecked.length, paths.length);
  assert.equal(new Set(initial.rechecked).size, paths.length);
});
