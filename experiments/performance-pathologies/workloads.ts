import { requiredFunction } from "../../src/abi_values.ts";
/** Both Text operands remain dynamic, including long repetitive queries. */
export const textSearchSource = `open import "blot:prelude"
let contains :: (Text, Text) -> Int
let contains = fn (text, query) => case Text.contains text query of
  #True => 1
  #False => 0
let find :: (Text, Text, Int) -> Int
let find = fn (text, query, start) => @text.find_from text query start
return { .contains = contains; .find = find; }
`;

/** Two leaves force a canonical result buffer instead of the scalar fast path. */
export function nestedRecordSource(depth: number): string {
  if (!Number.isSafeInteger(depth) || depth < 0) {
    throw new Error("record depth must be a nonnegative safe integer");
  }
  let type = "{ .a = Int; .b = Int; }";
  let value = "{ .a = input; .b = input + 1; }";
  for (let index = 0; index < depth; index += 1) {
    type = `{ .child = ${type}; }`;
    value = `{ .child = ${value}; }`;
  }
  return `open import "blot:prelude"
let nested :: Int -> ${type}
let nested = fn input => ${value}
return nested
`;
}

export function expectedFind(
  text: string,
  query: string,
  start: number,
): bigint {
  const suffix = Array.from(text).slice(start).join("");
  const position = suffix.indexOf(query);
  if (position < 0) return -1n;
  return BigInt(start + Array.from(suffix.slice(0, position)).length);
}

export function textSearchInstance(instance: WebAssembly.Instance) {
  const memory = instance.exports.memory;
  const realloc = requiredFunction(instance, "cabi_realloc");
  const find = requiredFunction(instance, "blot:find");
  const contains = requiredFunction(instance, "blot:contains");
  if (
    !(memory instanceof WebAssembly.Memory)
  ) {
    throw new Error("search artifact omitted its canonical exports");
  }
  const wasmMemory: WebAssembly.Memory = memory;
  const enter = requiredFunction(instance, "cabi_enter");
  const leave = requiredFunction(instance, "cabi_leave");
  const capacity = 262_144;
  const encoder = new TextEncoder();
  function input(text: string, query: string) {
    const textBytes = encoder.encode(text);
    const queryBytes = encoder.encode(query);
    if (textBytes.length > capacity || queryBytes.length > capacity) {
      throw new Error("search fixture exceeds its input buffer");
    }
    const invoke = (
      call: CallableFunction,
      trailing: readonly bigint[],
    ): bigint => {
      const scope = Number(enter());
      try {
        const textPointer = Number(realloc(scope, 0, 0, 1, textBytes.length));
        const queryPointer = Number(realloc(scope, 0, 0, 1, queryBytes.length));
        const bytes = new Uint8Array(wasmMemory.buffer);
        bytes.set(textBytes, textPointer);
        bytes.set(queryBytes, queryPointer);
        return call(
          scope,
          textPointer,
          textBytes.length,
          queryPointer,
          queryBytes.length,
          ...trailing,
        ) as bigint;
      } finally {
        leave(scope);
      }
    };
    return {
      find(start: number): bigint {
        return invoke(find, [BigInt(start)]);
      },
      contains(): bigint {
        return invoke(contains, []);
      },
    };
  }
  return { memory: wasmMemory, input };
}
