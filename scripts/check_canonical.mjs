import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "blot-canonical-"));
try {
  const artifact = join(directory, "canonical.wasm");
  const build = spawnSync("cargo", [
    "test",
    "--manifest-path",
    "compiler/Cargo.toml",
    "backend::canonical::tests",
  ], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, BLOT_CANONICAL_TEST_ARTIFACT: artifact },
    stdio: "inherit",
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
  if (build.error !== undefined) throw build.error;
  if (build.signal !== null) {
    throw new Error(`canonical fixture build terminated by ${build.signal}`);
  }
  if (build.status !== 0) {
    throw new Error(
      `canonical fixture build failed with status ${build.status}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(await readFile(artifact));
  const adapters = instance.exports;
  const encode = new TextEncoder();
  const decode = new TextDecoder("utf-8", { fatal: true });
  const memory = () => new DataView(adapters.memory.buffer);
  const scope = adapters.enter();
  const allocate = (length, alignment = 4) =>
    adapters.realloc(scope, 0, 0, alignment, length);
  const text = (value, destination = allocate(8)) => {
    const encoded = encode.encode(value);
    const pointer = allocate(encoded.length, 1);
    new Uint8Array(adapters.memory.buffer, pointer, encoded.length).set(
      encoded,
    );
    memory().setUint32(destination, pointer, true);
    memory().setUint32(destination + 4, encoded.length, true);
    return destination;
  };
  const readText = (pointer) => {
    const address = memory().getUint32(pointer, true);
    const length = memory().getUint32(pointer + 4, true);
    return decode.decode(
      new Uint8Array(adapters.memory.buffer, address, length),
    );
  };
  const textArray = (values, destination = allocate(8)) => {
    const pointer = allocate(values.length * 8);
    values.forEach((value, index) => text(value, pointer + index * 8));
    memory().setUint32(destination, pointer, true);
    memory().setUint32(destination + 4, values.length, true);
    return destination;
  };
  const nested = (values) => {
    const destination = allocate(8);
    const pointer = allocate(values.length * 8);
    values.forEach((value, index) => textArray(value, pointer + index * 8));
    memory().setUint32(destination, pointer, true);
    memory().setUint32(destination + 4, values.length, true);
    return destination;
  };
  const readTextArray = (pointer) => {
    const address = memory().getUint32(pointer, true);
    const length = memory().getUint32(pointer + 4, true);
    return Array.from({ length }, (_, index) => readText(address + index * 8));
  };
  const readNested = (pointer) => {
    const address = memory().getUint32(pointer, true);
    const length = memory().getUint32(pointer + 4, true);
    return Array.from(
      { length },
      (_, index) => readTextArray(address + index * 8),
    );
  };
  const finish = () => {
    adapters.clear_temporaries(scope);
    assert.equal(adapters.live_allocations(), 0);
    assert.equal(adapters.live_bytes(), 0);
  };

  const values = [["prefix λ🙂 tail", "", "a\u0000b"], ["e\u0301", "漢字"], []];
  const owned = adapters.lower_4(nested(values));
  adapters.clear_temporaries(scope);
  assert.equal(adapters.live_allocations(), 7);
  // The first inner array uses a 12-byte private descriptor stride.
  const inner = memory().getUint32(owned[0], true);
  const firstText = memory().getUint32(inner, true);
  memory().setUint32(inner, firstText + 7, true);
  memory().setUint32(inner + 4, 6, true);
  const sibling = adapters.enter();
  adapters.realloc(sibling, 0, 0, 1, 10_000);
  adapters.leave(sibling);
  adapters.select(scope);
  const output = allocate(8);
  adapters.upper_4(output, ...owned);
  adapters.release_4(...owned);
  assert.deepEqual(readNested(output), [
    ["λ🙂", "", "a\u0000b"],
    values[1],
    [],
  ]);
  finish();

  const record = (label, integer, destination = allocate(16, 8)) => {
    memory().setBigInt64(destination, integer, true);
    text(label, destination + 8);
    return destination;
  };
  const readRecord = (pointer) => ({
    a: memory().getBigInt64(pointer, true),
    z: readText(pointer + 8),
  });
  for (const type of [5, 7, 8]) {
    const captured = adapters[`lower_${type}`](record("captured 🙂", 42n));
    assert.equal(captured[3], 42n);
    adapters.clear_temporaries(scope);
    const destination = allocate(16, 8);
    adapters[`upper_${type}`](destination, ...captured);
    adapters[`release_${type}`](...captured);
    assert.deepEqual(readRecord(destination), { a: 42n, z: "captured 🙂" });
    finish();
  }
  const recordArray = allocate(8);
  const records = allocate(32, 8);
  record("left", -9n, records);
  record("right", 9007199254740993n, records + 16);
  memory().setUint32(recordArray, records, true);
  memory().setUint32(recordArray + 4, 2, true);
  const ownedRecords = adapters.lower_9(recordArray);
  adapters.clear_temporaries(scope);
  assert.equal(memory().getBigInt64(ownedRecords[0] + 16, true), -9n);
  assert.equal(
    memory().getBigInt64(ownedRecords[0] + 24 + 16, true),
    9007199254740993n,
  );
  const outputRecords = allocate(8);
  adapters.upper_9(outputRecords, ...ownedRecords);
  adapters.release_9(...ownedRecords);
  const canonicalRecords = memory().getUint32(outputRecords, true);
  assert.deepEqual(readRecord(canonicalRecords), { a: -9n, z: "left" });
  assert.deepEqual(readRecord(canonicalRecords + 16), {
    a: 9007199254740993n,
    z: "right",
  });
  finish();

  for (const publicTag of [0, 1]) {
    const source = allocate(12);
    memory().setUint8(source, publicTag);
    if (publicTag === 1) text("variant λ", source + 4);
    const tagged = adapters.lower_6(source);
    assert.equal(tagged[0], 1 - publicTag);
    adapters.clear_temporaries(scope);
    const destination = allocate(12);
    adapters.upper_6(destination, ...tagged);
    adapters.release_6(...tagged);
    assert.equal(memory().getUint8(destination), publicTag);
    if (publicTag === 1) assert.equal(readText(destination + 4), "variant λ");
    finish();
  }

  const variantArray = allocate(8);
  const variants = allocate(24);
  memory().setUint8(variants, 0);
  memory().setUint8(variants + 12, 1);
  text("nested variant", variants + 16);
  memory().setUint32(variantArray, variants, true);
  memory().setUint32(variantArray + 4, 2, true);
  const ownedVariants = adapters.lower_10(variantArray);
  adapters.clear_temporaries(scope);
  const outputVariants = allocate(8);
  adapters.upper_10(outputVariants, ...ownedVariants);
  adapters.release_10(...ownedVariants);
  const canonicalVariants = memory().getUint32(outputVariants, true);
  assert.equal(memory().getUint8(canonicalVariants), 0);
  assert.equal(memory().getUint8(canonicalVariants + 12), 1);
  assert.equal(readText(canonicalVariants + 16), "nested variant");
  finish();

  const resource = allocate(8, 8);
  const token = -81985529216486896n;
  memory().setBigInt64(resource, token, true);
  assert.equal(adapters.lower_11(resource), token);
  adapters.upper_11(resource, token);
  adapters.release_11(token);
  assert.equal(memory().getBigInt64(resource, true), token);
  finish();

  const units = allocate(8);
  memory().setUint32(units, 0, true);
  memory().setUint32(units + 4, 1_000_000, true);
  const ownedUnits = adapters.lower_12(units);
  assert.deepEqual(ownedUnits, [0, 1_000_000, 0]);
  adapters.clear_temporaries(scope);
  assert.equal(adapters.live_allocations(), 0);
  const outputUnits = allocate(8);
  adapters.upper_12(outputUnits, ...ownedUnits);
  adapters.release_12(...ownedUnits);
  assert.equal(memory().getUint32(outputUnits + 4, true), 1_000_000);
  finish();

  const warmBytes = adapters.memory.buffer.byteLength;
  for (let iteration = 0; iteration < 10_000; iteration++) {
    const value = adapters.lower_4(nested(values));
    adapters.clear_temporaries(scope);
    const destination = allocate(8);
    adapters.upper_4(destination, ...value);
    adapters.release_4(...value);
    assert.deepEqual(readNested(destination), values);
    finish();
  }
  assert.equal(adapters.memory.buffer.byteLength, warmBytes);
  adapters.leave(scope);
  console.log(
    "Canonical adapter checks passed: nested/sliced Text, records, variants, " +
      "sealed callback captures, opaque resources, and 10,000 round trips without growth.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
