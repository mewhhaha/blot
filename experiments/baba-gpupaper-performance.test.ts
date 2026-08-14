import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("Baba to gpupaper performance note records the measured boundaries", async () => {
  const note = await readFile(
    resolve("experiments/baba-gpupaper-performance.md"),
    "utf8",
  );
  assert.match(note, /runtime-neutral semantic edit/);
  assert.match(note, /compile after prepare/);
  assert.match(note, /TypeScript inference/);
});
