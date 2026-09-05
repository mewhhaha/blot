import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { runArtifact } from "./run.ts";

async function withSource(
  body: string,
  run: (compiler: Compiler, path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "blot-derivation-"));
  const path = join(directory, "main.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(
      path,
      `open import "blot:prelude"\nconst Derive = import "blot:derive"\n${body}\n`,
    );
    await run(compiler, path);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
}

test("derived integer product encoding agrees in evaluator and Wasm", async () => {
  await withSource(
    `const Codec = Derive.integer_record { .count = Int; .code = Int; }
return Codec.encode { .count = 42; .code = -7; }`,
    async (compiler, path) => {
      const expected = '"5:count=42;4:code=-7;"';
      assert.equal((await compiler.evaluate(path)).display, expected);
      assert.equal(await runArtifact(await compiler.compile(path)), expected);
    },
  );
});

test("derived encoding handles runtime parameters and canonical Text results", async () => {
  await withSource(
    `const Codec = Derive.integer_record { .count = Int; .code = Int; }
let encode :: Int -> Text
let encode = fn count => Codec.encode { .count = count; .code = 7; }
return encode`,
    async (compiler, path) => {
      const artifact = await compiler.compile(path);
      const manifest = JSON.parse(
        new TextDecoder().decode(artifact.manifestBytes),
      );
      const exported = manifest.exports.find(
        (entry: { sourceName: string }) => entry.sourceName === "default",
      );
      assert.equal(exported.function.result.kind, "text");
      assert.deepEqual(manifest.imports, []);
      const { instance } = await WebAssembly.instantiate(
        Uint8Array.from(artifact.wasm),
      );
      const encode = instance.exports[exported.name];
      const release = instance.exports[exported.postReturn];
      const memory = instance.exports[manifest.abi.memoryExport];
      if (typeof encode !== "function" || typeof release !== "function") {
        throw new Error("missing canonical Text export or post-return");
      }
      if (!(memory instanceof WebAssembly.Memory)) {
        throw new Error("missing ABI memory");
      }
      for (const value of [0n, -17n, 9223372036854775807n]) {
        const address: unknown = encode(value);
        if (typeof address !== "number") {
          throw new Error("missing indirect result address");
        }
        try {
          const view = new DataView(memory.buffer);
          const pointer = view.getUint32(address, true);
          const length = view.getUint32(address + 4, true);
          const text = new TextDecoder("utf-8", { fatal: true }).decode(
            new Uint8Array(memory.buffer, pointer, length),
          );
          assert.equal(text, `5:count=${value};4:code=7;`);
        } finally {
          release(address);
        }
      }
    },
  );
});

test("field evidence retains scalar types and permits repeated unrestricted reads", async () => {
  await withSource(
    `const Evidence = Derive.fields { .count = Int; .label = Text; }
const matches = expect (
  Reflect.equal (Evidence.fields.count.type, Int),
  "field evidence lost its type"
)
let value = { .count = 21; .label = "ok"; }
return Evidence.fields.count.read value + Evidence.fields.count.read value`,
    async (compiler, path) => {
      assert.equal(await runArtifact(await compiler.compile(path)), "42");
    },
  );
});

test("text field accessors are checked against the enclosing schema", async () => {
  await withSource(
    `const Evidence = Derive.fields { .count = Int; .label = Text; }
return Evidence.fields.label.read { .count = 1; .label = "ok"; }`,
    async (compiler, path) => {
      assert.equal(await runArtifact(await compiler.compile(path)), '"ok"');
    },
  );
});

for (
  const [name, body, code] of [
    [
      "owned array",
      "const E = Derive.fields { .data = [Int]; }\nreturn 1",
      "BLOT_REFUSED",
    ],
    [
      "opaque nominal",
      'const E = Derive.fields { .data = seal ("Token", Int); }\nreturn 1',
      "BLOT_REFUSED",
    ],
    [
      "function field",
      "const E = Derive.fields { .call = Int -> Int; }\nreturn 1",
      "BLOT_REFUSED",
    ],
    [
      "mixed encoder",
      "const E = Derive.integer_record { .label = Text; }\nreturn 1",
      "BLOT_REFUSED",
    ],
    [
      "empty encoder",
      "const E = Derive.integer_record {}\nreturn 1",
      "BLOT_REFUSED",
    ],
    [
      "wrong field type",
      `const E = Derive.fields { .count = Int; }
return E.fields.count.read { .count = "bad"; }`,
      "BLOT_TYPE_ERROR",
    ],
    [
      "missing enclosing field",
      `const E = Derive.fields { .count = Int; .label = Text; }
return E.fields.count.read { .count = 1; }`,
      "BLOT_TYPE_ERROR",
    ],
    [
      "extra owned field under width subtyping",
      `const E = Derive.fields { .count = Int; }
let !token = 41
let consume = fn !value => value + 1
let value = { .count = 1; .secret = fn () => consume (!token); }
return E.fields.count.read value`,
      "BLOT_LINEAR_ARGUMENT_NOT_OWNED",
    ],
  ] as const
) {
  test(`derivation rejects ${name}`, async () => {
    await withSource(body, async (compiler, path) => {
      await assert.rejects(() => compiler.check(path), new RegExp(code));
    });
  });
}
