import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directory = await mkdtemp(join(tmpdir(), "blot-managed-"));
try {
  const build = spawnSync("cargo", [
    "test",
    "--manifest-path",
    "compiler/Cargo.toml",
    "backend::managed::tests",
  ], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, BLOT_MANAGED_TEST_DIRECTORY: directory },
    stdio: "inherit",
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
  if (build.error !== undefined) throw build.error;
  if (build.signal !== null) {
    throw new Error(`managed fixture build terminated by ${build.signal}`);
  }
  if (build.status !== 0) {
    throw new Error(`managed fixture build failed with status ${build.status}`);
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const instantiateManagedFixture = async (name) => {
    const { instance } = await WebAssembly.instantiate(
      await readFile(join(directory, `${name}.wasm`)),
    );
    const wasm = instance.exports;
    const view = () => new DataView(wasm.memory.buffer);
    const word = (pointer, offset = 0) =>
      view().getUint32(pointer + offset, true);
    const text = (scope, value) => {
      const bytes = encoder.encode(value);
      const pointer = wasm.cabi_realloc(scope, 0, 0, 1, bytes.length);
      new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
      return [pointer, bytes.length];
    };
    const textArray = (scope, values) => {
      const pointer = wasm.cabi_realloc(scope, 0, 0, 4, values.length * 8);
      values.forEach((value, index) => {
        const [address, length] = text(scope, value);
        view().setUint32(pointer + index * 8, address, true);
        view().setUint32(pointer + index * 8 + 4, length, true);
      });
      return [pointer, values.length];
    };
    const nestedArray = (scope, values) => {
      const pointer = wasm.cabi_realloc(scope, 0, 0, 4, values.length * 8);
      values.forEach((value, index) => {
        const [address, length] = textArray(scope, value);
        view().setUint32(pointer + index * 8, address, true);
        view().setUint32(pointer + index * 8 + 4, length, true);
      });
      return [pointer, values.length];
    };
    const readText = (pointer) =>
      decoder.decode(
        new Uint8Array(wasm.memory.buffer, word(pointer), word(pointer, 4)),
      );
    const readArray = (pointer) =>
      Array.from(
        { length: word(pointer, 4) },
        (_, index) => readText(word(pointer) + index * 8),
      );
    const finish = (scope, result) => {
      if (result !== undefined) wasm.cabi_post_run(scope, result);
      assert.equal(
        wasm["blot:live-allocations"](),
        0,
        `${name} retained an allocation after return`,
      );
      assert.equal(
        wasm["blot:live-bytes"](),
        0,
        `${name} retained payload bytes after return`,
      );
      wasm.cabi_leave(scope);
    };
    return { wasm, text, textArray, nestedArray, readText, readArray, finish };
  };
  {
    const { wasm, nestedArray, readText, finish } =
      await instantiateManagedFixture("nested_slice");
    const scope = wasm.cabi_enter();
    const result = wasm.run(scope, ...nestedArray(scope, [["aλ🙂b"]]));
    assert.equal(readText(result), "λ🙂");
    finish(scope, result);
  }
  for (const kind of ["persistent_write", "persistent_grow"]) {
    const { wasm, textArray, text, readArray, finish } =
      await instantiateManagedFixture(kind);
    const scope = wasm.cabi_enter();
    const result = wasm.run(
      scope,
      ...textArray(scope, ["old λ", "kept 🙂"]),
      ...text(scope, "new"),
    );
    assert.deepEqual(readArray(result), ["old λ", "kept 🙂"]);
    let expected = ["new", "kept 🙂"];
    if (kind === "persistent_grow") expected = ["old λ", "kept 🙂", "new"];
    assert.deepEqual(readArray(result + 8), expected);
    finish(scope, result);
  }
  {
    const { wasm, textArray, text, readArray, finish } =
      await instantiateManagedFixture(
        "owned_grow",
      );
    for (
      const values of [
        [],
        ["retained λ"],
        Array.from({ length: 8 }, () => "shared"),
      ]
    ) {
      const scope = wasm.cabi_enter();
      const result = wasm.run(
        scope,
        ...textArray(scope, values),
        ...text(scope, "appended 🙂"),
      );
      assert.deepEqual(readArray(result), [...values, "appended 🙂"]);
      finish(scope, result);
    }
  }
  for (const kind of ["scratch_recycle", "empty_scratch_recycle"]) {
    const { wasm, text, readArray, finish } = await instantiateManagedFixture(
      kind,
    );
    const scope = wasm.cabi_enter();
    const result = wasm.run(scope, ...text(scope, "recycled λ"));
    assert.deepEqual(readArray(result), ["recycled λ"]);
    finish(scope, result);
  }
  {
    const { wasm, text, readText, finish } = await instantiateManagedFixture(
      "duplicated_call",
    );
    const scope = wasm.cabi_enter();
    const result = wasm.run(scope, ...text(scope, "twice λ"));
    assert.equal(readText(result), "twice λtwice λ");
    finish(scope, result);
  }
  {
    const { wasm, text, readText, finish } = await instantiateManagedFixture(
      "branch_transfer",
    );
    for (const choice of [0, 1]) {
      const scope = wasm.cabi_enter();
      const result = wasm.run(
        scope,
        choice,
        ...text(scope, "left λ"),
        ...text(scope, "right 🙂"),
      );
      assert.equal(readText(result), "left λ");
      let second = "right 🙂";
      if (choice === 1) second = "left λ";
      assert.equal(readText(result + 8), second);
      finish(scope, result);
    }
  }
  {
    const { wasm, text, readArray, finish } = await instantiateManagedFixture(
      "repeated_initial",
    );
    const scope = wasm.cabi_enter();
    const result = wasm.run(scope, 100n, ...text(scope, "shared 🙂"));
    assert.deepEqual(
      readArray(result),
      Array.from({ length: 100 }, () => "shared 🙂"),
    );
    finish(scope, result);
  }
  {
    const { wasm, text, finish } = await instantiateManagedFixture(
      "allocating_loop",
    );
    const warm = wasm.cabi_enter();
    assert.equal(wasm.run(warm, 2n, ...text(warm, "λ🙂"), 0n), 8n);
    finish(warm);
    const scope = wasm.cabi_enter();
    const input = text(scope, "λ🙂");
    const warmBytes = wasm.memory.buffer.byteLength;
    assert.equal(wasm.run(scope, 100_000n, ...input, 0n), 400_000n);
    assert.equal(wasm.memory.buffer.byteLength, warmBytes);
    finish(scope);
  }
  {
    const { instance } = await WebAssembly.instantiate(
      await readFile(join(directory, "reference_free.wasm")),
    );
    for (const kind of ["unit", "integer", "product", "resource"]) {
      instance.exports[`retain_${kind}`](0xffffffff, 0xffffffff);
      instance.exports[`release_${kind}`](0xffffffff, 0xffffffff);
    }
  }
  console.log(
    "Managed Wasm checks passed: nested slices, persistent/owned updates, Scratch reuse, duplicate transfers, 100,000 bounded allocating iterations, and constant-work reference-free ranges.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
