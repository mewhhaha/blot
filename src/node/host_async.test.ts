import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Compiler } from "../compiler.ts";

const execute = promisify(execFile);

test("refused asynchronous host results do not escape as unhandled rejections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-host-async-"));
  const compiler = await Compiler.create();
  try {
    const source = join(directory, "main.blot");
    await writeFile(
      source,
      `open import "blot:prelude"
const Device = @effect.host { .read = Unit -> Int; .write = Int -> Unit; }
let run = fn () => do:
  use number <- Device.read ()
  use Device.write number
  return number
return run
`,
    );
    const artifact = await compiler.compile(source);
    const wasm = join(directory, "guest.wasm");
    const manifest = join(directory, "guest.json");
    await writeFile(wasm, artifact.wasm);
    await writeFile(manifest, artifact.manifestBytes);
    // Strict child processes prove that no rejection escapes after the
    // synchronous contract failure has already been caught by the caller.
    const script = `
      import assert from "node:assert/strict";
      import { readFile } from "node:fs/promises";
      import { runInNewContext } from "node:vm";
      import { instantiateArtifact } from ${
      JSON.stringify(new URL("../host.ts", import.meta.url).href)
    };
      const artifact = {
        wasm: await readFile(${JSON.stringify(wasm)}),
        manifestBytes: await readFile(${JSON.stringify(manifest)}),
      };
      const factories = [
        () => Promise.reject(new Error("immediate asynchronous failure")),
        () => new Promise((_accept, reject) => {
          setTimeout(() => reject(new Error("delayed asynchronous failure")), 5);
        }),
        () => runInNewContext('Promise.reject(new Error("other realm"))'),
        () => ({ then(_accept, reject) { reject(new Error("thenable failure")); } }),
      ];
      for (const operation of ["read", "write"]) {
        for (const failure of factories) {
          const operations = new Map([
            ["read", () => {
              if (operation === "read") return failure();
              return 42n;
            }],
            ["write", () => {
              if (operation === "write") return failure();
              return null;
            }],
          ]);
          const hosted = await instantiateArtifact(
            artifact, new Map([["Device", operations]]),
          );
          try {
            assert.throws(() => hosted.call("default", [null]), /synchronous/);
            await new Promise((accept) => setTimeout(accept, 20));
          } finally {
            hosted.destroy();
          }
        }
      }
      console.log("asynchronous results refused without leaked rejections");
    `;
    const result = await execute(
      process.execPath,
      [
        "--unhandled-rejections=strict",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        script,
      ],
      { timeout: 30_000, killSignal: "SIGKILL" },
    );
    assert.match(result.stdout, /without leaked rejections/);
    assert.equal(result.stderr, "");
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
