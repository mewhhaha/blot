import { Compiler } from "../src/compiler/session.ts";
import type {
  BlotRuntimeFunction,
  BlotRuntimeModule,
  BlotRuntimeOperation,
} from "../src/runtime/hir.ts";

const sources = [
  "examples/lib/owned_radix_sorts.blot",
  "examples/lib/owned_merge_sort.blot",
  "case-studies/engine/game_loop.blot",
] as const;

const budgets: Record<
  (typeof sources)[number],
  {
    readonly operations: number;
    readonly largestControlFlowGraph: number;
    readonly wasmBytes: number;
    readonly wasmLocalDeclarations: number;
  }
> = {
  "examples/lib/owned_radix_sorts.blot": {
    operations: 1_400,
    largestControlFlowGraph: 16,
    wasmBytes: 32_000,
    wasmLocalDeclarations: 450,
  },
  "examples/lib/owned_merge_sort.blot": {
    operations: 500,
    largestControlFlowGraph: 16,
    wasmBytes: 13_000,
    wasmLocalDeclarations: 120,
  },
  "case-studies/engine/game_loop.blot": {
    operations: 3_600,
    largestControlFlowGraph: 112,
    wasmBytes: 84_000,
    wasmLocalDeclarations: 760,
  },
};

interface LoweringReport {
  readonly source: string;
  readonly functions: number;
  readonly blocks: number;
  readonly operations: number;
  readonly storeLiterals: number;
  readonly staticStores: number;
  readonly staticStoreElements: number;
  readonly dynamicLiteralElements: number;
  readonly ownedStoreGrowth: number;
  readonly persistentStoreGrowth: number;
  readonly largestControlFlowGraph: number;
  readonly wasmBytes: number;
  readonly wasmFunctionTypes: number;
  readonly wasmLocals: number;
  readonly wasmLocalDeclarations: number;
}

interface WasmShape {
  readonly functionTypes: number;
  readonly locals: number;
  readonly localDeclarations: number;
}

const compiler = await Compiler.create();
const reports: LoweringReport[] = [];
const failures: string[] = [];
try {
  for (const source of sources) {
    try {
      const runtime = await compiler.prepare(source);
      const artifact = await compiler.compile(source);
      if (!WebAssembly.validate(artifact.wasm as BufferSource)) {
        failures.push(`${source}: emitted invalid Wasm`);
      }
      inspectInterning(runtime, failures);
      inspectStaticStores(runtime, failures);
      inspectDeadOperations(runtime, failures);
      inspectAdministrativeOperations(runtime, failures);
      inspectLoopGrowth(runtime, failures);
      const report = summarize(source, runtime, artifact.wasm);
      inspectBudget(report, budgets[source], failures);
      reports.push(report);
    } catch (error) {
      throw new Error(`Lowering audit failed for ${source}`, { cause: error });
    }
  }
} finally {
  compiler.destroy();
}

console.log(JSON.stringify({ reports, failures }, null, 2));
if (failures.length > 0) Deno.exit(1);

function summarize(
  source: string,
  runtime: BlotRuntimeModule,
  wasm: Uint8Array,
): LoweringReport {
  const operations = runtime.functions.flatMap((runtimeFunction) =>
    runtimeFunction.blocks.flatMap((block) => block.operations)
  );
  const storeLiterals = operations.filter((operation) =>
    operation.kind === "store.literal"
  );
  const storeGrowth = operations.filter(isStoreGrowth);
  const wasmShape = inspectWasmShape(wasm);
  return {
    source,
    functions: runtime.functions.length,
    blocks: runtime.functions.reduce(
      (count, runtimeFunction) => count + runtimeFunction.blocks.length,
      0,
    ),
    operations: operations.length,
    storeLiterals: storeLiterals.length,
    staticStores: runtime.staticStores.length,
    staticStoreElements: runtime.staticStores.reduce(
      (count, store) => count + store.values.length,
      0,
    ),
    dynamicLiteralElements: storeLiterals.reduce(
      (count, operation) => count + operation.operands.length,
      0,
    ),
    ownedStoreGrowth:
      storeGrowth.filter((operation) => operation.update === "owned-reuse")
        .length,
    persistentStoreGrowth:
      storeGrowth.filter((operation) => operation.update === "persistent")
        .length,
    largestControlFlowGraph: runtime.functions.reduce(
      (largest, runtimeFunction) =>
        Math.max(largest, runtimeFunction.blocks.length),
      0,
    ),
    wasmBytes: wasm.byteLength,
    wasmFunctionTypes: wasmShape.functionTypes,
    wasmLocals: wasmShape.locals,
    wasmLocalDeclarations: wasmShape.localDeclarations,
  };
}

function inspectInterning(
  runtime: BlotRuntimeModule,
  failures: string[],
): void {
  for (
    const [description, values] of [
      ["runtime type", runtime.types],
      ["runtime signature", runtime.signatures],
    ] as const
  ) {
    const firstIds = new Map<string, number>();
    values.forEach((value, id) => {
      const key = JSON.stringify(value);
      const firstId = firstIds.get(key);
      if (firstId === undefined) {
        firstIds.set(key, id);
        return;
      }
      failures.push(
        `${runtime.source}: ${description}s ${firstId} and ${id} are identical`,
      );
    });
  }
  const firstFunctions = new Map<string, number>();
  runtime.functions.forEach((runtimeFunction) => {
    const key = JSON.stringify(
      {
        ...runtimeFunction,
        id: 0,
        name: "",
      },
      (name, value) => {
        if (name === "span") return undefined;
        if (typeof value === "bigint") return `\u0000bigint:${value}`;
        return value;
      },
    );
    const firstId = firstFunctions.get(key);
    if (firstId === undefined) {
      firstFunctions.set(key, runtimeFunction.id);
      return;
    }
    failures.push(
      `${runtime.source}: runtime functions ${firstId} and ${runtimeFunction.id} have identical normalized bodies`,
    );
  });
}

function inspectBudget(
  report: LoweringReport,
  budget: (typeof budgets)[keyof typeof budgets],
  failures: string[],
): void {
  for (
    const metric of [
      "operations",
      "largestControlFlowGraph",
      "wasmBytes",
      "wasmLocalDeclarations",
    ] as const
  ) {
    if (report[metric] <= budget[metric]) continue;
    failures.push(
      `${report.source}: ${metric} ${report[metric]} exceeds budget ${
        budget[metric]
      }`,
    );
  }
}

function inspectStaticStores(
  runtime: BlotRuntimeModule,
  failures: string[],
): void {
  for (const runtimeFunction of runtime.functions) {
    for (const operation of functionOperations(runtimeFunction)) {
      if (operation.kind !== "store.literal") continue;
      if (operation.staticStore === undefined) continue;
      if (operation.operands.length === 0) continue;
      failures.push(
        `${operation.span.file}:${operation.span.start}: pooled Store literal retains ${operation.operands.length} runtime producers`,
      );
    }
  }
}

function inspectDeadOperations(
  runtime: BlotRuntimeModule,
  failures: string[],
): void {
  for (const runtimeFunction of runtime.functions) {
    const used = new Set<number>();
    for (const block of runtimeFunction.blocks) {
      for (const operation of block.operations) {
        operation.operands.forEach((operand) => used.add(operand));
      }
      const terminator = block.terminator;
      if (terminator.kind === "return") used.add(terminator.value);
      if (terminator.kind === "branch") {
        terminator.arguments.forEach((argument) => used.add(argument));
      }
      if (terminator.kind === "conditional") {
        used.add(terminator.condition);
        terminator.consequentArguments.forEach((argument) =>
          used.add(argument)
        );
        terminator.alternateArguments.forEach((argument) => used.add(argument));
      }
      if (terminator.kind === "switch") used.add(terminator.selector);
    }
    for (const operation of functionOperations(runtimeFunction)) {
      if (used.has(operation.result)) continue;
      if (!isDiscardableOperation(operation)) continue;
      failures.push(
        `${operation.span.file}:${operation.span.start}: unused total ${operation.kind} remains in ${runtimeFunction.name}`,
      );
    }
  }
}

function isDiscardableOperation(operation: BlotRuntimeOperation): boolean {
  if (operation.kind === "scalar") {
    return operation.operator !== "divide" &&
      operation.operator !== "remainder";
  }
  if (operation.kind === "convert") {
    return operation.conversion !== "float-64-to-signed-integer-64";
  }
  return [
    "constant",
    "scalar.unary",
    "vector",
    "product.make",
    "product.project",
    "sum.make",
    "sum.tag",
    "sum.payload",
    "indirect.load",
    "store.length",
    "seal.wrap",
    "seal.unwrap",
    "resource.move",
    "resource.borrow",
    "resource.freeze",
  ].includes(operation.kind);
}

function inspectAdministrativeOperations(
  runtime: BlotRuntimeModule,
  failures: string[],
): void {
  for (const runtimeFunction of runtime.functions) {
    const blocks = new Map(
      runtimeFunction.blocks.map((block) => [block.id, block] as const),
    );
    const liveValues = new Set<number>();
    const edges: Array<{
      readonly target: number;
      readonly arguments: readonly number[];
    }> = [];
    const definitions = new Map<number, BlotRuntimeOperation>();
    for (const block of runtimeFunction.blocks) {
      for (const operation of block.operations) {
        definitions.set(operation.result, operation);
        operation.operands.forEach((operand) => liveValues.add(operand));
      }
      const terminator = block.terminator;
      if (terminator.kind === "branch") {
        edges.push({
          target: terminator.target,
          arguments: terminator.arguments,
        });
      }
      if (terminator.kind === "conditional") {
        liveValues.add(terminator.condition);
        edges.push({
          target: terminator.consequent,
          arguments: terminator.consequentArguments,
        });
        edges.push({
          target: terminator.alternate,
          arguments: terminator.alternateArguments,
        });
      }
      if (terminator.kind === "switch") liveValues.add(terminator.selector);
      if (terminator.kind === "return") liveValues.add(terminator.value);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges) {
        const target = blocks.get(edge.target);
        if (target === undefined) {
          failures.push(
            `${runtime.source}: ${runtimeFunction.name} targets absent block ${edge.target}`,
          );
          continue;
        }
        if (target.parameters.length !== edge.arguments.length) continue;
        target.parameters.forEach((parameter, index) => {
          const argument = edge.arguments[index];
          if (argument === undefined || !liveValues.has(parameter.value)) {
            return;
          }
          if (liveValues.has(argument)) return;
          liveValues.add(argument);
          changed = true;
        });
      }
    }
    for (const block of runtimeFunction.blocks) {
      if (block.id === runtimeFunction.entryBlock) continue;
      for (const parameter of block.parameters) {
        if (liveValues.has(parameter.value)) continue;
        failures.push(
          `${parameter.span.file}:${parameter.span.start}: unused block parameter ${parameter.value} remains in ${runtimeFunction.name}`,
        );
      }
    }
    for (const operation of definitions.values()) {
      const operand = operation.operands[0];
      if (operand === undefined) continue;
      const source = definitions.get(operand);
      if (
        source !== undefined &&
        ((operation.kind === "indirect.load" &&
          source.kind === "indirect.make") ||
          (operation.kind === "indirect.make" &&
            source.kind === "indirect.load"))
      ) {
        failures.push(
          `${operation.span.file}:${operation.span.start}: inverse ${source.kind}/${operation.kind} roundtrip remains in ${runtimeFunction.name}`,
        );
      }
      if (
        operation.kind === "product.project" &&
        source?.kind === "product.make"
      ) {
        failures.push(
          `${operation.span.file}:${operation.span.start}: product projection of a fresh product remains in ${runtimeFunction.name}`,
        );
      }
    }
  }
}

function inspectLoopGrowth(
  runtime: BlotRuntimeModule,
  failures: string[],
): void {
  const functions = new Map(
    runtime.functions.map((runtimeFunction) =>
      [
        runtimeFunction.id,
        runtimeFunction,
      ] as const
    ),
  );
  const reachable = new Set(
    runtime.functions
      .filter((runtimeFunction) => runtimeFunction.name.endsWith("$go$"))
      .map((runtimeFunction) => runtimeFunction.id),
  );
  const pending = [...reachable];
  while (pending.length > 0) {
    const functionId = pending.pop();
    if (functionId === undefined) break;
    const runtimeFunction = functions.get(functionId);
    if (runtimeFunction === undefined) {
      failures.push(
        `${runtime.source}: loop call graph references absent function ${functionId}`,
      );
      continue;
    }
    for (const operation of functionOperations(runtimeFunction)) {
      if (operation.kind !== "call.direct") continue;
      if (reachable.has(operation.function)) continue;
      reachable.add(operation.function);
      pending.push(operation.function);
    }
  }
  for (const functionId of reachable) {
    const runtimeFunction = functions.get(functionId);
    if (runtimeFunction === undefined) continue;
    for (const operation of functionOperations(runtimeFunction)) {
      if (isStoreGrowth(operation) && operation.update === "persistent") {
        failures.push(
          `${operation.span.file}:${operation.span.start}: loop-reachable ${runtimeFunction.name} uses persistent Store growth`,
        );
      }
    }
  }
}

function functionOperations(
  runtimeFunction: BlotRuntimeFunction,
): readonly BlotRuntimeOperation[] {
  return runtimeFunction.blocks.flatMap((block) => block.operations);
}

function isStoreGrowth(
  operation: BlotRuntimeOperation,
): operation is BlotRuntimeOperation & {
  readonly kind: "store.grow";
  readonly update: "persistent" | "owned-reuse";
} {
  return operation.kind === "store.grow";
}

function inspectWasmShape(wasm: Uint8Array): WasmShape {
  let cursor = 8;
  let functionTypes = 0;
  let locals = 0;
  let localDeclarations = 0;
  while (cursor < wasm.length) {
    const sectionId = wasm[cursor];
    if (sectionId === undefined) throw new TypeError("Wasm section has no id");
    cursor += 1;
    const sectionSize = readUnsignedLeb128(wasm, cursor);
    cursor = sectionSize.next;
    const sectionEnd = cursor + sectionSize.value;
    if (sectionEnd > wasm.length) {
      throw new TypeError(`Wasm section ${sectionId} exceeds the artifact`);
    }
    if (sectionId === 1) {
      functionTypes = readUnsignedLeb128(wasm, cursor).value;
    }
    if (sectionId === 10) {
      const functionCount = readUnsignedLeb128(wasm, cursor);
      let bodyCursor = functionCount.next;
      for (let index = 0; index < functionCount.value; index += 1) {
        const bodySize = readUnsignedLeb128(wasm, bodyCursor);
        bodyCursor = bodySize.next;
        const bodyEnd = bodyCursor + bodySize.value;
        if (bodyEnd > sectionEnd) {
          throw new TypeError(
            `Wasm function ${index} exceeds the code section`,
          );
        }
        const declarationCount = readUnsignedLeb128(wasm, bodyCursor);
        bodyCursor = declarationCount.next;
        localDeclarations += declarationCount.value;
        for (
          let declaration = 0;
          declaration < declarationCount.value;
          declaration += 1
        ) {
          const count = readUnsignedLeb128(wasm, bodyCursor);
          locals += count.value;
          bodyCursor = count.next + 1;
          if (bodyCursor > bodyEnd) {
            throw new TypeError(
              `Wasm function ${index} has an incomplete local declaration`,
            );
          }
        }
        bodyCursor = bodyEnd;
      }
    }
    cursor = sectionEnd;
  }
  return { functionTypes, locals, localDeclarations };
}

function readUnsignedLeb128(
  bytes: Uint8Array,
  start: number,
): { readonly value: number; readonly next: number } {
  let value = 0;
  let shift = 0;
  let cursor = start;
  while (true) {
    const byte = bytes[cursor];
    if (byte === undefined) throw new TypeError("Wasm integer is truncated");
    cursor += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
    if (shift > 35) throw new TypeError("Wasm u32 is too wide");
  }
}
