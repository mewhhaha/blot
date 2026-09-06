import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  expectedFind,
  nestedRecordSource,
  textSearchInstance,
  textSearchSource,
} from "../../experiments/performance-pathologies/workloads.ts";
import { Compiler } from "../compiler.ts";

async function withSource(
  source: string,
  run: (compiler: Compiler, path: string) => Promise<void>,
) {
  const directory = await mkdtemp(
    join(tmpdir(), "blot-performance-pathologies-"),
  );
  const compiler = await Compiler.create();
  try {
    const path = join(directory, "main.blot");
    await writeFile(path, source);
    await run(compiler, path);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}

for (const depth of [0, 8, 16, 32]) {
  test(`nested record ABI layout preserves two dynamic leaves at depth ${depth}`, async () => {
    await withSource(nestedRecordSource(depth), async (compiler, path) => {
      const artifact = await compiler.compile(path);
      const { instance } = await WebAssembly.instantiate(
        Uint8Array.from(artifact.wasm),
      );
      const nested = instance.exports["blot:default"];
      const memory = instance.exports.memory;
      const manifest = JSON.parse(
        new TextDecoder().decode(artifact.manifestBytes),
      );
      const exported = manifest.exports.find((entry: { sourceName: string }) =>
        entry.sourceName === "default"
      );
      const postReturn = instance.exports[exported.postReturn];
      assert.equal(typeof nested, "function");
      assert.equal(typeof postReturn, "function");
      assert.ok(memory instanceof WebAssembly.Memory);
      for (const input of [-7n, 0n, 41n]) {
        const pointer = (nested as CallableFunction)(input) as number;
        try {
          const view: DataView = new DataView(memory.buffer);
          assert.equal(view.getBigInt64(pointer, true), input);
          assert.equal(view.getBigInt64(pointer + 8, true), input + 1n);
        } finally {
          (postReturn as CallableFunction)(pointer);
        }
      }
    });
  });
}

test("runtime search preserves first matches, scalar starts, empty queries, and UTF-8", async () => {
  await withSource(textSearchSource, async (compiler, path) => {
    const artifact = await compiler.compile(path);
    const { instance } = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
    );
    const runtime = textSearchInstance(instance);
    const cases: readonly (readonly [string, string])[] = [
      ["", ""],
      ["", "a"],
      ["abc", ""],
      ["abc", "abcd"],
      ["abababa", "ababa"],
      ["aaaaaa", "aaa"],
      ["mississippi", "issip"],
      ["αβ🐱éαβ🐱é", "β🐱"],
      ["éééé", "éé"],
      ["🐱🐱x🐱", "🐱x"],
      ["\uFEFFx\uFEFF", "\uFEFF"],
      ["a\0a\0b", "\0b"],
      ["x\r\nx\r\n", "\r\n"],
      ["e\u0301é", "é"],
    ];
    for (const [text, query] of cases) {
      const input = runtime.input(text, query);
      assert.equal(input.contains(), BigInt(Number(text.includes(query))));
      for (let start = 0; start <= Array.from(text).length; start += 1) {
        assert.equal(
          input.find(start),
          expectedFind(text, query, start),
          JSON.stringify({ text, query, start }),
        );
      }
    }
  });
});

test("repetitive runtime search handles early and late mismatch without heap writes", async () => {
  await withSource(textSearchSource, async (compiler, path) => {
    const artifact = await compiler.compile(path);
    const { instance } = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
    );
    const runtime = textSearchInstance(instance);
    const size = 65_536;
    const cases: readonly (readonly [string, string])[] = [
      ["a".repeat(size), "a".repeat(8191) + "b"],
      ["a".repeat(size) + "b", "a".repeat(8191) + "b"],
      ["a".repeat(size), "b" + "a".repeat(8191)],
      ["ab".repeat(size / 2), "ab".repeat(4095) + "ac"],
      ["ab".repeat(4096) + "c" + "ab".repeat(4096), "ab".repeat(4096)],
      ["β".repeat(size / 2), "β".repeat(2048) + "γ"],
    ];
    for (const [text, query] of cases) {
      const input = runtime.input(text, query);
      const before = new Uint8Array(runtime.memory.buffer).slice();
      const sizeBefore = runtime.memory.buffer.byteLength;
      for (const start of [0, 1, 7, Array.from(text).length]) {
        assert.equal(input.find(start), expectedFind(text, query, start));
      }
      assert.equal(input.contains(), BigInt(Number(text.includes(query))));
      assert.equal(runtime.memory.buffer.byteLength, sizeBefore);
      assert.deepEqual(new Uint8Array(runtime.memory.buffer), before);
    }
  });
});

test("generated runtime searches agree with a scalar-index reference", async () => {
  await withSource(textSearchSource, async (compiler, path) => {
    const artifact = await compiler.compile(path);
    const { instance } = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
    );
    const runtime = textSearchInstance(instance);
    let seed = 73;
    function next(limit: number) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % limit;
    }
    const alphabet = ["a", "b", "\0", "é", "🐱", "\uFEFF"];
    for (let index = 0; index < 250; index += 1) {
      const scalars = Array.from(
        { length: next(80) },
        () => alphabet[next(alphabet.length)],
      );
      const text = scalars.join("");
      let query = Array.from(
        { length: next(20) },
        () => alphabet[next(alphabet.length)],
      ).join("");
      if (index % 2 === 0) {
        const begin = next(scalars.length + 1);
        query = scalars.slice(begin, begin + next(20)).join("");
      }
      const input = runtime.input(text, query);
      assert.equal(input.contains(), BigInt(Number(text.includes(query))));
      for (const start of [0, next(scalars.length + 1), scalars.length]) {
        assert.equal(input.find(start), expectedFind(text, query, start));
      }
    }
  });
});

test("new pathological catalog examples retain evaluator observations", async () => {
  const compiler = await Compiler.create();
  try {
    assert.equal(
      (await compiler.evaluate(
        resolve("examples/pathological_text_search.blot"),
      )).display,
      "{ .absent = -1; .late = 12; .unicode = 3; .search = <function>; }",
    );
    assert.equal(
      (await compiler.evaluate(
        resolve("examples/pathological_nested_record_layout.blot"),
      )).display,
      "{ .value = 42; .nested = <function>; }",
    );
    await compiler.compile(resolve("examples/pathological_text_search.blot"));
    await compiler.compile(
      resolve("examples/pathological_nested_record_layout.blot"),
    );
  } finally {
    compiler.destroy();
  }
});
