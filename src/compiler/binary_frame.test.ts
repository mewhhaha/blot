import assert from "node:assert/strict";
import test from "node:test";
import { BinaryDecoder, BinaryEncoder } from "./binary_frame.ts";

test("binary frames preserve little-endian u32 boundaries", () => {
  const encoder = new BinaryEncoder();
  for (const value of [0, 1, 255, 256, 0x8000_0000, 0xffff_ffff]) {
    encoder.u32(value);
  }
  assert.deepEqual([...encoder.finish()], [
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    255,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    128,
    255,
    255,
    255,
    255,
  ]);
  const decoder = new BinaryDecoder(encoder.finish());
  for (const value of [0, 1, 255, 256, 0x8000_0000, 0xffff_ffff]) {
    assert.equal(decoder.u32("value"), value);
  }
  decoder.finish();
});

test("invalid u32 values leave the frame unchanged", () => {
  const encoder = new BinaryEncoder();
  encoder.u32(42);
  for (const value of [-1, 1.5, 0x1_0000_0000, NaN, Infinity, -Infinity]) {
    assert.throws(() => encoder.u32(value), RangeError);
  }
  assert.deepEqual([...encoder.finish()], [42, 0, 0, 0]);
});

test("UTF-8 frames preserve empty, astral, NUL, and lone-surrogate text", () => {
  const encoder = new BinaryEncoder();
  const strings = [
    "",
    "plain",
    "\0",
    "é漢字",
    "🌳",
    "\ud800",
    "\udfff",
    "a\ud800b",
  ];
  const expected: number[] = [];
  for (const text of strings) {
    const bytes = new TextEncoder().encode(text);
    const length = bytes.length;
    expected.push(length & 255, (length >>> 8) & 255, 0, 0, ...bytes);
    encoder.string(text);
  }
  assert.deepEqual([...encoder.finish()], expected);
  const decoder = new BinaryDecoder(encoder.finish());
  for (const text of strings) {
    assert.equal(
      decoder.string("text"),
      new TextDecoder().decode(new TextEncoder().encode(text)),
    );
  }
  decoder.finish();
});

test("growing frames copy input views and return independent snapshots", () => {
  const input = Uint8Array.from(
    { length: 1_048_593 },
    (_, index) => index & 255,
  );
  const selected = input.subarray(7, input.length - 3);
  const expected = selected.slice();
  const encoder = new BinaryEncoder();
  encoder.bytes(selected);
  input.fill(0);
  const first = encoder.finish();
  encoder.string("after growth");
  const second = encoder.finish();
  first.fill(0);
  const decoder = new BinaryDecoder(second);
  assert.deepEqual(decoder.bytes("payload"), expected);
  assert.equal(decoder.string("suffix"), "after growth");
  decoder.finish();
  assert.deepEqual(encoder.finish(), second);
});

test("decoder honors a nonzero byte offset and its exact view length", () => {
  const encoder = new BinaryEncoder();
  encoder.u32(0xdead_beef);
  encoder.string("hello");
  const encoded = encoder.finish();
  const storage = new Uint8Array(encoded.length + 20).fill(255);
  storage.set(encoded, 7);
  const decoder = new BinaryDecoder(storage.subarray(7, 7 + encoded.length));
  assert.equal(decoder.u32("word"), 0xdead_beef);
  assert.equal(decoder.string("text"), "hello");
  decoder.finish();
  assert.throws(() => decoder.u32("extra"), /omitted extra/);
});

test("malformed and trailing frames remain rejected", () => {
  for (let length = 0; length < 4; length += 1) {
    const decoder = new BinaryDecoder(new Uint8Array(length));
    assert.throws(() => decoder.u32("header"), /omitted header/);
  }
  const oversized = new BinaryDecoder(Uint8Array.of(255, 255, 255, 255));
  assert.throws(() => oversized.bytes("payload"), /truncated payload/);
  const trailing = new BinaryDecoder(Uint8Array.of(0));
  assert.throws(() => trailing.finish(), /1 trailing bytes/);
  const invalid = new BinaryEncoder();
  invalid.bytes(Uint8Array.of(0xc0, 0xaf));
  assert.throws(
    () => new BinaryDecoder(invalid.finish()).string("text"),
    TypeError,
  );
  const valid = new BinaryEncoder();
  valid.string("valid after decoding failure");
  assert.equal(
    new BinaryDecoder(valid.finish()).string("text"),
    "valid after decoding failure",
  );
});

test("seeded mixed frames round-trip across repeated capacity growth", () => {
  let seed = 0x1234_5678;
  const next = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };
  const encoder = new BinaryEncoder();
  const entries = Array.from({ length: 512 }, () => {
    const word = next();
    const bytes = Uint8Array.from(
      { length: next() % 1024 },
      () => next() & 255,
    );
    encoder.u32(word);
    encoder.bytes(bytes);
    return { word, bytes };
  });
  const decoder = new BinaryDecoder(encoder.finish());
  for (const entry of entries) {
    assert.equal(decoder.u32("word"), entry.word);
    assert.deepEqual(decoder.bytes("bytes"), entry.bytes);
  }
  decoder.finish();
});
