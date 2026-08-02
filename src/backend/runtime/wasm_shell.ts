import {
  wasmInstruction,
  type WasmModuleBuilder,
  wasmType,
} from "../../../../gpupaper/src/wasm.ts";

export function addBlotAbiModuleShell(
  builder: WasmModuleBuilder,
  manifestBytes: Uint8Array,
  heapStart = 8,
  minimumMemoryPages = 1,
): { readonly realloc: number; readonly heap: number } {
  const memory = builder.addMemory(minimumMemoryPages);
  const heap = builder.addI32Global(wasmType.i32, heapStart, true);
  const major = builder.addI32Global(wasmType.i32, 1, false);
  const minor = builder.addI32Global(wasmType.i32, 0, false);
  const reallocType = builder.addFunctionType(
    [wasmType.i32, wasmType.i32, wasmType.i32, wasmType.i32],
    [wasmType.i32],
  );
  const newPointer = 4;
  const endPointer = 5;
  const requiredPages = 6;
  const copyLength = 7;
  const realloc = builder.addFunction(
    reallocType,
    [wasmType.i32, wasmType.i32, wasmType.i32, wasmType.i32],
    [
      ...wasmInstruction.localGet(2),
      ...wasmInstruction.i32Constant(1),
      ...wasmInstruction.i32GreaterThanOrEqualSigned,
      ...wasmInstruction.localGet(2),
      ...wasmInstruction.i32Constant(8),
      ...wasmInstruction.i32LessThanOrEqualSigned,
      ...wasmInstruction.i32And,
      ...wasmInstruction.localGet(2),
      ...wasmInstruction.localGet(2),
      ...wasmInstruction.i32Constant(1),
      ...wasmInstruction.i32Subtract,
      ...wasmInstruction.i32And,
      ...wasmInstruction.i32EqualZero,
      ...wasmInstruction.i32And,
      ...wasmInstruction.i32EqualZero,
      ...wasmInstruction.ifVoid,
      ...wasmInstruction.unreachable,
      ...wasmInstruction.end,
      ...wasmInstruction.localGet(3),
      ...wasmInstruction.i32EqualZero,
      ...wasmInstruction.ifI32,
      ...wasmInstruction.i32Constant(0),
      ...wasmInstruction.else,
      ...wasmInstruction.globalGet(heap),
      ...wasmInstruction.localGet(2),
      ...wasmInstruction.i32Constant(1),
      ...wasmInstruction.i32Subtract,
      ...wasmInstruction.i32Add,
      ...wasmInstruction.localGet(2),
      ...wasmInstruction.i32Constant(-1),
      ...wasmInstruction.i32Multiply,
      ...wasmInstruction.i32And,
      ...wasmInstruction.localTee(newPointer),
      ...wasmInstruction.localGet(3),
      ...wasmInstruction.i32Add,
      ...wasmInstruction.localTee(endPointer),
      ...wasmInstruction.localGet(newPointer),
      ...wasmInstruction.i32LessThanUnsigned,
      ...wasmInstruction.ifVoid,
      ...wasmInstruction.unreachable,
      ...wasmInstruction.end,
      ...wasmInstruction.localGet(endPointer),
      ...wasmInstruction.memorySize,
      ...wasmInstruction.i32Constant(16),
      ...wasmInstruction.i32ShiftLeft,
      ...wasmInstruction.i32GreaterThanUnsigned,
      ...wasmInstruction.ifVoid,
      ...wasmInstruction.localGet(endPointer),
      ...wasmInstruction.i32Constant(1),
      ...wasmInstruction.i32Subtract,
      ...wasmInstruction.i32Constant(16),
      ...wasmInstruction.i32ShiftRightUnsigned,
      ...wasmInstruction.i32Constant(1),
      ...wasmInstruction.i32Add,
      ...wasmInstruction.localTee(requiredPages),
      ...wasmInstruction.memorySize,
      ...wasmInstruction.i32Subtract,
      ...wasmInstruction.memoryGrow,
      ...wasmInstruction.i32Constant(-1),
      ...wasmInstruction.i32Equal,
      ...wasmInstruction.ifVoid,
      ...wasmInstruction.unreachable,
      ...wasmInstruction.end,
      ...wasmInstruction.end,
      ...wasmInstruction.localGet(0),
      ...wasmInstruction.ifVoid,
      ...wasmInstruction.localGet(1),
      ...wasmInstruction.localGet(3),
      ...wasmInstruction.i32LessThanUnsigned,
      ...wasmInstruction.ifI32,
      ...wasmInstruction.localGet(1),
      ...wasmInstruction.else,
      ...wasmInstruction.localGet(3),
      ...wasmInstruction.end,
      ...wasmInstruction.localSet(copyLength),
      ...wasmInstruction.localGet(newPointer),
      ...wasmInstruction.localGet(0),
      ...wasmInstruction.localGet(copyLength),
      ...wasmInstruction.memoryCopy,
      ...wasmInstruction.end,
      ...wasmInstruction.localGet(endPointer),
      ...wasmInstruction.globalSet(heap),
      ...wasmInstruction.localGet(newPointer),
      ...wasmInstruction.end,
    ],
  );
  builder.exportMemory("memory", memory);
  builder.exportFunction("cabi_realloc", realloc);
  builder.exportGlobal("blot:abi-major", major);
  builder.exportGlobal("blot:abi-minor", minor);
  builder.addCustomSection("blot:abi", manifestBytes);
  return { realloc, heap };
}
