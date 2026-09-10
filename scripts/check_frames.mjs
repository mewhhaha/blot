import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
const directory = await mkdtemp(join(tmpdir(), "blot-frames-"));
try {
  const build = spawnSync("cargo", [
    "test",
    "--manifest-path",
    "compiler/Cargo.toml",
    "backend::suspension::tests",
  ], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, BLOT_FRAME_TEST_DIRECTORY: directory },
    stdio: "inherit",
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
  if (build.error !== undefined) throw build.error;
  if (build.signal !== null) {
    throw new Error(`frame fixture build terminated by ${build.signal}`);
  }
  if (build.status !== 0) {
    throw new Error(`frame fixture build failed with status ${build.status}`);
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const instantiateFrameFixture = async (name) => {
    const module = await WebAssembly.compile(
      await readFile(`${directory}/${name}.wasm`),
    );
    const imports = {};
    for (const imported of WebAssembly.Module.imports(module)) {
      if (imports[imported.module] === undefined) imports[imported.module] = {};
      imports[imported.module][imported.name] = () => {
        throw new Error("suspending operation invoked synchronously");
      };
    }
    const { exports: wasm } = await WebAssembly.instantiate(module, imports);
    const view = () => new DataView(wasm.memory.buffer);
    const word = (pointer, offset = 0) =>
      view().getUint32(pointer + offset, true);
    const lowerText = (scope, value) => {
      const bytes = encoder.encode(value);
      const pointer = wasm.cabi_realloc(scope, 0, 0, 1, bytes.length);
      new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
      return [pointer, bytes.length];
    };
    const readText = (pointer) =>
      decoder.decode(
        new Uint8Array(wasm.memory.buffer, word(pointer), word(pointer, 4)),
      );
    const respond = (scope, context, value) => {
      const destination = word(context, 16);
      if (typeof value === "bigint") {
        view().setBigInt64(destination, value, true);
      } else {
        const [pointer, length] = lowerText(scope, value);
        view().setUint32(destination, pointer, true);
        view().setUint32(destination + 4, length, true);
      }
      wasm["blot:resume"](scope, context);
    };
    const poll = (scope, context) => {
      for (;;) {
        const status = wasm["blot:poll"](scope, context, 64);
        if (status !== 4) return status;
      }
    };
    const finish = (scope, context) => {
      wasm["blot:release"](scope, context);
      wasm.cabi_leave(scope);
    };
    return { wasm, view, word, lowerText, readText, respond, poll, finish };
  };
  {
    const { wasm, view, word, respond, poll, finish } =
      await instantiateFrameFixture("scalar");
    const scope = wasm.cabi_enter();
    const context = wasm.run(scope, 7n);
    assert.equal(poll(scope, context), 1);
    assert.equal(view().getBigInt64(word(context, 12), true), 7n);
    respond(scope, context, 35n);
    assert.equal(poll(scope, context), 2);
    assert.equal(view().getBigInt64(word(context, 20), true), 77n);
    assert.equal(wasm["blot:live-allocations"](), 2);
    finish(scope, context);
    assert.equal(wasm["blot:live-allocations"](), 0);
  }
  {
    const { wasm, word, lowerText, readText, respond, poll, finish } =
      await instantiateFrameFixture("text");
    const first = wasm.cabi_enter();
    const firstContext = wasm.run(first, ...lowerText(first, "first λ"));
    assert.equal(poll(first, firstContext), 1);
    const second = wasm.cabi_enter();
    const secondContext = wasm.run(second, ...lowerText(second, "second 🙂"));
    assert.equal(poll(second, secondContext), 1);
    respond(first, firstContext, "first reply");
    assert.equal(poll(first, firstContext), 2);
    assert.equal(readText(word(firstContext, 20)), "first reply");
    finish(first, firstContext);
    assert.equal(readText(word(secondContext, 12)), "second 🙂");
    assert.equal(wasm["blot:live-allocations"](), 4);
    wasm["blot:cancel"](second, secondContext);
    finish(second, secondContext);
    assert.equal(wasm["blot:live-allocations"](), 0);
    assert.equal(wasm["blot:live-scopes"](), 0);
  }
  {
    const { wasm, view, word, lowerText, readText, respond, poll, finish } =
      await instantiateFrameFixture("tail");
    const scope = wasm.cabi_enter();
    const context = wasm.run(scope, ...lowerText(scope, "tail-kept λ"));
    const initialFrame = word(context);
    assert.equal(poll(scope, context), 1);
    assert.equal(word(context), initialFrame);
    assert.equal(view().getBigInt64(word(context, 12), true), 7n);
    assert.equal(wasm["blot:live-allocations"](), 4);
    respond(scope, context, 35n);
    assert.equal(poll(scope, context), 2);
    assert.equal(readText(word(context, 20)), "tail-kept λ");
    finish(scope, context);
    assert.equal(wasm["blot:live-allocations"](), 0);
  }
  {
    const { wasm, word, lowerText, readText, respond, poll, finish } =
      await instantiateFrameFixture("children");
    const scope = wasm.cabi_enter();
    const rounds = 100000;
    const context = wasm.run(
      scope,
      BigInt(rounds),
      ...lowerText(scope, "owned λ"),
    );
    let requests = 0;
    let warmBytes;
    let reusableFrame;
    for (;;) {
      const status = poll(scope, context);
      if (status === 2) break;
      assert.equal(status, 1);
      assert.equal(readText(word(context, 12)), "owned λ");
      assert.equal(wasm["blot:live-allocations"](), 5);
      if (requests === 32) {
        warmBytes = wasm.memory.buffer.byteLength;
        reusableFrame = word(context);
      }
      if (requests > 32) {
        assert.equal(wasm.memory.buffer.byteLength, warmBytes);
        assert.equal(word(context), reusableFrame);
      }
      respond(scope, context, "owned λ");
      requests++;
    }
    assert.equal(requests, rounds);
    assert.equal(readText(word(context, 20)), "owned λ");
    assert.equal(wasm["blot:live-allocations"](), 3);
    finish(scope, context);
    assert.equal(wasm["blot:live-allocations"](), 0);
    assert.equal(wasm["blot:live-bytes"](), 0);
  }
  console.log(
    "Frame Wasm proofs passed: scalar/text suspension, independent scope cancellation, managed tail-frame transfer, 100000 reused child frames with bounded memory.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
