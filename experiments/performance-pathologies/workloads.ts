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
  const realloc = instance.exports.cabi_realloc;
  const find = instance.exports["blot:find"];
  const contains = instance.exports["blot:contains"];
  if (
    !(memory instanceof WebAssembly.Memory) || typeof realloc !== "function" ||
    typeof find !== "function" || typeof contains !== "function"
  ) {
    throw new Error("search artifact omitted its canonical exports");
  }
  const wasmMemory: WebAssembly.Memory = memory;
  const findFunction = find as (
    textPointer: number,
    textLength: number,
    queryPointer: number,
    queryLength: number,
    start: bigint,
  ) => bigint;
  const containsFunction = contains as (
    textPointer: number,
    textLength: number,
    queryPointer: number,
    queryLength: number,
  ) => bigint;
  const capacity = 262_144;
  const textPointer = Number(realloc(0, 0, 1, capacity));
  const queryPointer = Number(realloc(0, 0, 1, capacity));
  const encoder = new TextEncoder();
  function input(text: string, query: string) {
    const textBytes = encoder.encode(text);
    const queryBytes = encoder.encode(query);
    if (textBytes.length > capacity || queryBytes.length > capacity) {
      throw new Error("search fixture exceeds its input buffer");
    }
    const bytes = new Uint8Array(wasmMemory.buffer);
    bytes.set(textBytes, textPointer);
    bytes.set(queryBytes, queryPointer);
    return {
      find(start: number): bigint {
        return findFunction(
          textPointer,
          textBytes.length,
          queryPointer,
          queryBytes.length,
          BigInt(start),
        ) as bigint;
      },
      contains(): bigint {
        return containsFunction(
          textPointer,
          textBytes.length,
          queryPointer,
          queryBytes.length,
        ) as bigint;
      },
    };
  }
  return { memory: wasmMemory, input };
}
