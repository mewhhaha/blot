import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("build never overwrites an extensionless source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-cli-"));
  const path = join(directory, "program");
  const source = "return 42\n";
  try {
    await writeFile(path, source);
    await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("src/node/cli.ts"),
        "build",
        path,
      ],
    );
    assert.equal(await readFile(path, "utf8"), source);
    assert.equal(
      WebAssembly.validate(Uint8Array.from(await readFile(`${path}.wasm`))),
      true,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("lint check refuses a file with findings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-cli-"));
  const path = join(directory, "program.blot");
  try {
    await writeFile(
      path,
      `open import "blot:prelude"
return Int.rem 5 2
`,
    );
    await assert.rejects(
      execute(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("src/node/cli.ts"),
          "lint",
          "--check",
          path,
        ],
      ),
      /BLOT_LINT_OPERATOR_SPELLING/,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("lint fix writes only the compiler-checked result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-cli-"));
  const path = join(directory, "program.blot");
  try {
    await writeFile(
      path,
      `open import "blot:prelude"
return Int.rem 5 2
`,
    );
    await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("src/node/cli.ts"),
        "lint",
        "--fix",
        path,
      ],
    );
    assert.equal(
      await readFile(path, "utf8"),
      `open import "blot:prelude"
return (5 % 2)
`,
    );
    await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("src/node/cli.ts"),
        "lint",
        "--check",
        path,
      ],
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
