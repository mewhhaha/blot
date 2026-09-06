// Synthetic Wasm fixtures for host-adapter tests, not a Blot compiler/emitter.
export type FixtureValueType = "i32" | "i64" | "f32" | "f64";

interface FixtureFunction {
  readonly parameters: readonly FixtureValueType[];
  readonly results: readonly FixtureValueType[];
}

export function wasmFixture(options: {
  readonly types: readonly FixtureFunction[];
  readonly imports?: readonly {
    readonly module: string;
    readonly name: string;
    readonly type: number;
  }[];
  readonly functions?: readonly {
    readonly type: number;
    readonly instructions: readonly number[];
  }[];
  readonly exports: Readonly<Record<string, number>>;
  readonly manifest: Uint8Array;
  readonly data?: Uint8Array;
}): Uint8Array {
  const types = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };
  const bytes = [0, 97, 115, 109, 1, 0, 0, 0];
  bytes.push(...section(
    1,
    vector(options.types.map((type) => [
      0x60,
      ...vector(type.parameters.map((parameter) => [types[parameter]])),
      ...vector(type.results.map((result) => [types[result]])),
    ])),
  ));
  if (options.imports !== undefined && options.imports.length > 0) {
    bytes.push(...section(
      2,
      vector(options.imports.map((imported) => [
        ...name(imported.module),
        ...name(imported.name),
        0,
        ...u32(imported.type),
      ])),
    ));
  }
  if (options.functions !== undefined && options.functions.length > 0) {
    bytes.push(
      ...section(
        3,
        vector(options.functions.map((function_) => u32(function_.type))),
      ),
    );
  }
  bytes.push(...section(5, [1, 0, 1])); // One growable memory, initially one page.
  bytes.push(...section(
    7,
    vector([
      [...name("memory"), 2, 0],
      ...Object.entries(options.exports).map(([exported, index]) => [
        ...name(exported),
        0,
        ...u32(index),
      ]),
    ]),
  ));
  if (options.functions !== undefined && options.functions.length > 0) {
    bytes.push(...section(
      10,
      vector(options.functions.map((function_) => {
        const body = [0, ...function_.instructions, 0x0b];
        return [...u32(body.length), ...body];
      })),
    ));
  }
  if (options.data !== undefined) {
    bytes.push(...section(11, [
      1,
      0,
      0x41,
      0,
      0x0b,
      ...u32(options.data.length),
      ...options.data,
    ]));
  }
  bytes.push(...section(0, [...name("blot:abi"), ...options.manifest]));
  const wasm = Uint8Array.from(bytes);
  if (!WebAssembly.validate(wasm)) throw new Error("invalid test Wasm fixture");
  return wasm;
}

function u32(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function name(value: string): number[] {
  const bytes = new TextEncoder().encode(value);
  return [...u32(bytes.length), ...bytes];
}

function vector(values: readonly (readonly number[])[]): number[] {
  return [...u32(values.length), ...values.flat()];
}

function section(id: number, bytes: readonly number[]): number[] {
  return [id, ...u32(bytes.length), ...bytes];
}
