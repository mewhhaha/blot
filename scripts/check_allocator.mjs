import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "blot-allocator-"));
try {
  const artifact = join(directory, "allocator.wasm");
  const build = spawnSync("cargo", [
    "test",
    "--manifest-path",
    "compiler/Cargo.toml",
    "backend::allocation::tests::allocator_helpers_validate_as_a_complete_wasm_module",
    "--",
    "--exact",
  ], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, BLOT_ALLOCATION_TEST_ARTIFACT: artifact },
    stdio: "inherit",
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
  if (build.error !== undefined) throw build.error;
  if (build.signal !== null) {
    throw new Error(`allocator fixture build terminated by ${build.signal}`);
  }
  if (build.status !== 0) {
    throw new Error(
      `allocator fixture build failed with status ${build.status}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(await readFile(artifact));
  const allocator = instance.exports;
  const memory = () => new DataView(allocator.memory.buffer);
  const references = (owner) => memory().getUint32(owner - 48 + 8, true);
  const trap = (action) => assert.throws(action, WebAssembly.RuntimeError);
  const allocate = (size) => {
    const owner = allocator.alloc(0, 0, 16, size);
    allocator.claim(owner);
    return owner;
  };

  const first = allocator.enter();
  const retained = allocate(37);
  assert.equal(references(retained), 1);
  allocator.claim(retained);
  assert.equal(references(retained), 2);
  allocator.release(retained);
  memory().setUint32(retained, 0x12345678, true);
  const second = allocator.enter();
  const sibling = allocate(37);
  assert.notEqual(sibling, retained);
  trap(() => allocator.realloc(second, retained, 37, 16, 64));
  assert.equal(memory().getUint32(retained, true), 0x12345678);
  allocator.leave(second);
  assert.equal(allocator.live_scopes(), 1);
  assert.equal(allocator.live_allocations(), 1);
  assert.equal(memory().getUint32(retained, true), 0x12345678);
  trap(() => allocator.select(second));
  allocator.select(first);
  allocator.release(retained);
  assert.equal(allocator.live_allocations(), 0);
  trap(() => allocator.release(retained));
  const third = allocator.enter();
  assert.notEqual(third, second);
  trap(() => allocator.select(second));
  allocator.leave(third);
  allocator.select(first);

  const warmAllocationBytes = allocator.memory.buffer.byteLength;
  for (let iteration = 0; iteration < 100_000; iteration++) {
    allocator.release(allocate(37));
  }
  assert.equal(allocator.memory.buffer.byteLength, warmAllocationBytes);

  const canonical = allocator.realloc(first, 0, 0, 1, 8);
  assert.equal(references(canonical), 1);
  allocator.claim(canonical);
  assert.equal(references(canonical), 2);
  allocator.clear_temporaries(first);
  assert.equal(references(canonical), 1);
  allocator.release(canonical);
  const temporary = allocator.realloc(first, 0, 0, 4, 4);
  memory().setUint32(temporary, 42, true);
  const resized = allocator.realloc(first, temporary, 4, 4, 100);
  assert.equal(memory().getUint32(resized, true), 42);
  allocator.claim(resized);
  allocator.clear_temporaries(first);
  assert.equal(references(resized), 1);
  allocator.release(resized);
  assert.equal(allocator.live_bytes(), 0);

  const shared = allocate(8);
  const container = allocate(16);
  allocator.retain(shared);
  allocator.retain(shared);
  memory().setUint32(container, shared, true);
  memory().setUint32(container + 4, shared, true);
  // Spare Scratch capacity is not initialized and must never be traversed.
  memory().setUint32(container + 8, 0xdeadbeef, true);
  memory().setUint32(container + 12, 0xdeadbeef, true);
  allocator.set_layout(container, 1, 0, 2);
  allocator.release(shared);
  const beforeContainerDrop = allocator.destructor_calls.value;
  allocator.release(container);
  assert.equal(allocator.destructor_calls.value, beforeContainerDrop + 1);
  assert.equal(allocator.live_allocations(), 0);

  const resizedChild = allocate(4);
  let resizedParent = allocate(4);
  memory().setUint32(resizedParent, resizedChild, true);
  allocator.set_layout(resizedParent, 2, 0, 1);
  const beforeResize = allocator.destructor_calls.value;
  resizedParent = allocator.alloc(resizedParent, 4, 16, 128);
  allocator.claim(resizedParent);
  assert.equal(allocator.destructor_calls.value, beforeResize);
  assert.equal(memory().getUint32(resizedParent, true), resizedChild);
  allocator.release(resizedParent);
  assert.equal(allocator.destructor_calls.value, beforeResize + 1);
  assert.equal(allocator.live_allocations(), 0);

  let chain = 0;
  const depth = 100_000;
  for (let link = 0; link < depth; link++) {
    const parent = allocate(4);
    memory().setUint32(parent, chain, true);
    allocator.set_layout(parent, 2, 0, 1);
    chain = parent;
  }
  const beforeChainDrop = allocator.destructor_calls.value;
  allocator.release(chain);
  assert.equal(allocator.destructor_calls.value, beforeChainDrop + depth);
  assert.equal(allocator.live_allocations(), 0);
  assert.equal(allocator.live_bytes(), 0);

  const invalid = allocate(8);
  trap(() => allocator.alloc(invalid, 17, 16, 32));
  trap(() => allocator.realloc(first, 0, 0, 3, 16));
  trap(() => allocator.realloc(first, 0, 0, 16, 0x80000001));
  assert.equal(allocator.live_allocations(), 1);
  allocator.release(invalid);
  const abandonedParent = allocate(4);
  memory().setUint32(abandonedParent, allocate(4), true);
  allocator.set_layout(abandonedParent, 2, 0, 1);
  const beforeScopeDrop = allocator.destructor_calls.value;
  allocator.leave(first);
  assert.equal(allocator.destructor_calls.value, beforeScopeDrop);
  assert.equal(allocator.live_scopes(), 0);
  assert.equal(allocator.live_allocations(), 0);
  trap(() => allocator.leave(first));
  trap(() => allocator.alloc(0, 0, 8, 5));

  const failedScope = allocator.enter();
  const failedParent = allocate(4);
  memory().setUint32(failedParent, 0xdeadbeef, true);
  allocator.set_layout(failedParent, 2, 0, 1);
  trap(() => allocator.release(failedParent));
  allocator.leave(failedScope);
  const recoveredScope = allocator.enter();
  allocator.release(allocate(4));
  assert.equal(allocator.live_allocations(), 0);
  allocator.leave(recoveredScope);

  const warmScopeBytes = allocator.memory.buffer.byteLength;
  for (let iteration = 0; iteration < 100_000; iteration++) {
    const scope = allocator.enter();
    allocator.realloc(scope, 0, 0, 1, 37);
    allocator.leave(scope);
  }
  assert.equal(allocator.live_bytes(), 0);
  assert.equal(allocator.live_allocations(), 0);
  assert.equal(allocator.memory.buffer.byteLength, warmScopeBytes);
  allocator.next_token.value = -2;
  const lastScope = allocator.enter();
  assert.equal(lastScope >>> 0, 0xffffffff);
  trap(() => allocator.enter());
  allocator.select(lastScope);
  allocator.leave(lastScope);
  assert.equal(allocator.live_scopes(), 0);

  console.log(
    "Allocator checks passed: isolated scopes, canonical adoption, nested ownership, " +
      "100,000-level destruction, and bounded allocation/scope reuse.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
