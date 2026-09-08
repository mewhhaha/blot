import { assertEquals } from "@std/assert";
import { CompilerWasm } from "./wasm.ts";
import { COMPILER_HOST_ABI_VERSION } from "./host_abi.ts";

Deno.test("compiler transport reads and writes memory32 addresses above 2 GiB", async () => {
  const response = new TextEncoder().encode(
    '{"ok":true,"module":{"high":true}}',
  );
  const text = (value: string) => {
    const bytes = [...new TextEncoder().encode(value)];
    return [...unsigned(bytes.length), ...bytes];
  };
  const section = (
    id: number,
    bytes: number[],
  ) => [id, ...unsigned(bytes.length), ...bytes];
  const functionBody = (instructions: number[]) => {
    const bytes = [0, ...instructions, 0x0b];
    return [...unsigned(bytes.length), ...bytes];
  };
  const names = [
    "compiler_host_abi_version",
    "allocate_words",
    "deallocate_words",
    "lower_source",
    "lower_result_pointer",
  ];
  const bytes = new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, [
      4,
      0x60,
      0,
      1,
      0x7f,
      0x60,
      1,
      0x7f,
      1,
      0x7f,
      0x60,
      2,
      0x7f,
      0x7f,
      0,
      0x60,
      2,
      0x7f,
      0x7f,
      1,
      0x7f,
    ]),
    ...section(3, [5, 0, 1, 2, 3, 0]),
    ...section(5, [1, 0, ...unsigned(32769)]),
    ...section(7, [
      6,
      ...text("memory"),
      2,
      0,
      ...names.flatMap((name, index) => [...text(name), 0, index]),
    ]),
    ...section(10, [
      5,
      ...functionBody([0x41, ...signed(COMPILER_HOST_ABI_VERSION)]),
      ...functionBody([0x41, ...signed(-2147479552)]),
      ...functionBody([]),
      ...functionBody([0x41, ...signed(response.length)]),
      ...functionBody([0x41, ...signed(-2147483648)]),
    ]),
    ...section(11, [
      1,
      0,
      0x41,
      ...signed(-2147483648),
      0x0b,
      ...unsigned(response.length),
      ...response,
    ]),
  ]);
  const compiler = await CompilerWasm.load(bytes);
  assertEquals(compiler.lower("return 1"), {
    ok: true,
    module: { high: true },
  });
});

function unsigned(value: number): number[] {
  const bytes = [];
  do {
    let byte = value & 127;
    value >>>= 7;
    if (value !== 0) byte |= 128;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function signed(value: number): number[] {
  const bytes = [];
  for (;;) {
    const byte = value & 127;
    value >>= 7;
    if (
      (value === 0 && (byte & 64) === 0) || (value === -1 && (byte & 64) !== 0)
    ) {
      bytes.push(byte);
      return bytes;
    }
    bytes.push(byte | 128);
  }
}
