import { Compiler } from "../src/compiler/session.ts";
import type {
  BlotRuntimeEdge,
  BlotRuntimeFunction,
  BlotRuntimeInstruction,
  BlotRuntimeModule,
  BlotRuntimeTransition,
} from "../src/runtime/hir.ts";

const sources = [
  "examples/collect_principal_type.blot",
  "examples/lib/text_processing_eval.blot",
  "examples/polymorphic_collections.blot",
  "examples/runtime_memory_lowerings.blot",
  "experiments/generated-code/programs/star_dijkstra.blot",
  "examples/lib/owned_radix_sorts.blot",
  "examples/lib/owned_merge_sort.blot",
  "case-studies/engine/game_loop.blot",
] as const;

// ABI 4 whole-module budgets include allocation and canonical conversion code.
// The ABI 3/4 comparison and explicit control-flow metric change are recorded
// in docs/continuation-migration.md; operations still include calls.
const budgets: Record<
  (typeof sources)[number],
  {
    readonly operations: number;
    readonly largestControlFlowGraph: number;
    readonly wasmBytes: number;
    readonly wasmLocalDeclarations: number;
  }
> = {
  "examples/collect_principal_type.blot": {
    operations: 8,
    largestControlFlowGraph: 4,
    wasmBytes: 7_800,
    wasmLocalDeclarations: 34,
  },
  "examples/lib/text_processing_eval.blot": {
    operations: 16,
    largestControlFlowGraph: 4,
    wasmBytes: 12_000,
    wasmLocalDeclarations: 90,
  },
  "examples/polymorphic_collections.blot": {
    operations: 32,
    largestControlFlowGraph: 4,
    wasmBytes: 16_800,
    wasmLocalDeclarations: 82,
  },
  "examples/runtime_memory_lowerings.blot": {
    operations: 500,
    largestControlFlowGraph: 24,
    wasmBytes: 45_600,
    wasmLocalDeclarations: 345,
  },
  "experiments/generated-code/programs/star_dijkstra.blot": {
    operations: 550,
    largestControlFlowGraph: 36,
    wasmBytes: 35_200,
    wasmLocalDeclarations: 440,
  },
  "examples/lib/owned_radix_sorts.blot": {
    operations: 900,
    largestControlFlowGraph: 24,
    wasmBytes: 50_700,
    wasmLocalDeclarations: 580,
  },
  "examples/lib/owned_merge_sort.blot": {
    operations: 220,
    largestControlFlowGraph: 24,
    wasmBytes: 19_000,
    wasmLocalDeclarations: 128,
  },
  "case-studies/engine/game_loop.blot": {
    operations: 8_600,
    largestControlFlowGraph: 210,
    wasmBytes: 227_000,
    wasmLocalDeclarations: 550,
  },
};

interface LoweringReport {
  readonly source: string;
  readonly functions: number;
  readonly continuations: number;
  readonly operations: number;
  readonly instructions: number;
  readonly calls: number;
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
// A nullary function that tail-calls itself distinguishes an invalid artifact
// from a valid Wasm 3.0 artifact that this audit's V8 cannot validate.
const tailCallProbe = Uint8Array.of(
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x04,
  0x01,
  0x60,
  0x00,
  0x00,
  0x03,
  0x02,
  0x01,
  0x00,
  0x0a,
  0x06,
  0x01,
  0x04,
  0x00,
  0x12,
  0x00,
  0x0b,
);
const hostSupportsTailCalls = WebAssembly.validate(tailCallProbe);
try {
  for (const source of sources) {
    try {
      const runtime = await compiler.prepare(source);
      const artifact = await compiler.compile(source);
      const manifest = JSON.parse(
        new TextDecoder().decode(artifact.manifestBytes),
      ) as { readonly abi: { readonly requiredFeatures: readonly string[] } };
      const unsupportedTailCalls = !hostSupportsTailCalls &&
        manifest.abi.requiredFeatures.includes("tail-call");
      if (
        !unsupportedTailCalls &&
        !WebAssembly.validate(artifact.wasm as BufferSource)
      ) {
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
    runtimeFunction.continuations.flatMap((continuation) =>
      continuation.instructions
    )
  );
  const calls = runtime.functions.reduce(
    (count, function_) =>
      count + function_.continuations.filter(
        (continuation) => continuation.transition.kind === "call",
      ).length,
    0,
  );
  const storeLiterals = operations.filter((instruction) =>
    instruction.operation.kind === "store.literal"
  );
  const storeGrowth = operations.filter(isStoreGrowth);
  const wasmShape = inspectWasmShape(wasm);
  return {
    source,
    functions: runtime.functions.length,
    continuations: runtime.functions.reduce(
      (count, runtimeFunction) => count + runtimeFunction.continuations.length,
      0,
    ),
    operations: operations.length + calls,
    instructions: operations.length,
    calls,
    storeLiterals: storeLiterals.length,
    staticStores: runtime.staticStores.length,
    staticStoreElements: runtime.staticStores.reduce(
      (count, store) => count + store.values.length,
      0,
    ),
    dynamicLiteralElements: storeLiterals.reduce(
      (count, instruction) => count + instruction.operands.length,
      0,
    ),
    ownedStoreGrowth:
      storeGrowth.filter((instruction) =>
        instruction.operation.update === "owned-reuse"
      )
        .length,
    persistentStoreGrowth:
      storeGrowth.filter((instruction) =>
        instruction.operation.update === "persistent"
      )
        .length,
    largestControlFlowGraph: runtime.functions.reduce(
      (largest, runtimeFunction) =>
        Math.max(largest, runtimeFunction.continuations.length),
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
    for (const instruction of functionOperations(runtimeFunction)) {
      if (instruction.operation.kind !== "store.literal") continue;
      if (instruction.operation.staticStore === undefined) continue;
      if (instruction.operands.length === 0) continue;
      failures.push(
        `${instruction.definition.span.file}:${instruction.definition.span.start}: pooled Store literal retains ${instruction.operands.length} runtime producers`,
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
    for (const continuation of runtimeFunction.continuations) {
      for (const instruction of continuation.instructions) {
        instruction.operands.forEach((operand) => used.add(operand));
      }
      continuation.captures.forEach((capture) => used.add(capture.value));
      const transition = continuation.transition;
      if (transition.kind === "return") used.add(transition.value);
      if (transition.kind === "branch") used.add(transition.condition);
      if (transition.kind === "switch") used.add(transition.selector);
      if (transition.kind === "call") {
        transition.arguments.forEach((argument) => used.add(argument));
      }
      for (const edge of successorEdges(transition)) {
        for (const argument of edge.arguments) {
          if (argument.kind === "value") used.add(argument.value);
        }
      }
    }
    for (const instruction of functionOperations(runtimeFunction)) {
      if (used.has(instruction.definition.value)) continue;
      if (!isDiscardableOperation(instruction)) continue;
      failures.push(
        `${instruction.definition.span.file}:${instruction.definition.span.start}: unused total ${instruction.operation.kind} remains in ${runtimeFunction.name}`,
      );
    }
  }
}

function isDiscardableOperation(instruction: BlotRuntimeInstruction): boolean {
  if (instruction.operation.kind === "scalar") {
    return instruction.operation.operator !== "divide" &&
      instruction.operation.operator !== "remainder";
  }
  if (instruction.operation.kind === "convert") {
    return instruction.operation.conversion !== "float-64-to-signed-integer-64";
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
  ].includes(instruction.operation.kind);
}

function inspectAdministrativeOperations(
  runtime: BlotRuntimeModule,
  failures: string[],
): void {
  for (const runtimeFunction of runtime.functions) {
    const continuations = new Map(
      runtimeFunction.continuations.map((continuation) =>
        [continuation.id, continuation] as const
      ),
    );
    const liveValues = new Set<number>();
    const edges: BlotRuntimeEdge[] = [];
    const definitions = new Map<number, BlotRuntimeInstruction>();
    for (const continuation of runtimeFunction.continuations) {
      for (const instruction of continuation.instructions) {
        definitions.set(instruction.definition.value, instruction);
        instruction.operands.forEach((operand) => liveValues.add(operand));
      }
      continuation.captures.forEach((capture) => liveValues.add(capture.value));
      const transition = continuation.transition;
      edges.push(...successorEdges(transition));
      if (transition.kind === "branch") liveValues.add(transition.condition);
      if (transition.kind === "switch") liveValues.add(transition.selector);
      if (transition.kind === "return") liveValues.add(transition.value);
      if (transition.kind === "call") {
        transition.arguments.forEach((argument) => liveValues.add(argument));
        const successor = continuations.get(transition.next.target);
        if (successor === undefined) {
          throw new Error("call has no successor continuation");
        }
        transition.next.arguments.forEach((argument, index) => {
          if (argument.kind === "result") {
            liveValues.add(successor.parameters[index].value);
          }
        });
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges) {
        const target = continuations.get(edge.target);
        if (target === undefined) {
          failures.push(
            `${runtime.source}: ${runtimeFunction.name} targets absent continuation ${edge.target}`,
          );
          continue;
        }
        if (target.parameters.length !== edge.arguments.length) continue;
        target.parameters.forEach((parameter, index) => {
          const argument = edge.arguments[index];
          if (
            argument === undefined || argument.kind !== "value" ||
            !liveValues.has(parameter.value)
          ) {
            return;
          }
          if (liveValues.has(argument.value)) return;
          liveValues.add(argument.value);
          changed = true;
        });
      }
    }
    for (const continuation of runtimeFunction.continuations) {
      if (continuation.id === runtimeFunction.entry) continue;
      for (const parameter of continuation.parameters) {
        if (liveValues.has(parameter.value)) continue;
        failures.push(
          `${parameter.span.file}:${parameter.span.start}: unused continuation parameter ${parameter.value} remains in ${runtimeFunction.name}`,
        );
      }
    }
    for (const instruction of definitions.values()) {
      const operand = instruction.operands[0];
      if (operand === undefined) continue;
      const source = definitions.get(operand);
      if (
        source !== undefined &&
        ((instruction.operation.kind === "indirect.load" &&
          source.operation.kind === "indirect.make") ||
          (instruction.operation.kind === "indirect.make" &&
            source.operation.kind === "indirect.load"))
      ) {
        failures.push(
          `${instruction.definition.span.file}:${instruction.definition.span.start}: inverse ${source.operation.kind}/${instruction.operation.kind} roundtrip remains in ${runtimeFunction.name}`,
        );
      }
      if (
        instruction.operation.kind === "product.project" &&
        source?.operation.kind === "product.make"
      ) {
        failures.push(
          `${instruction.definition.span.file}:${instruction.definition.span.start}: product projection of a fresh product remains in ${runtimeFunction.name}`,
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
  const recursiveFunctions = new Set(
    runtime.functions
      .filter((runtimeFunction) =>
        reachesFunction(runtimeFunction.id, runtimeFunction.id)
      )
      .map((runtimeFunction) => runtimeFunction.id),
  );
  for (const runtimeFunction of runtime.functions) {
    const cyclicContinuations = continuationsInCycles(runtimeFunction);
    for (const continuation of runtimeFunction.continuations) {
      for (const instruction of continuation.instructions) {
        const persistentStoreGrowth = isStoreGrowth(instruction) &&
          instruction.operation.update === "persistent";
        const repeatedTextAppend = instruction.operation.kind === "text.append";
        if (!persistentStoreGrowth && !repeatedTextAppend) {
          continue;
        }
        if (
          !recursiveFunctions.has(runtimeFunction.id) &&
          !cyclicContinuations.has(continuation.id)
        ) {
          continue;
        }
        if (repeatedTextAppend) {
          failures.push(
            `${instruction.definition.span.file}:${instruction.definition.span.start}: cyclic ${runtimeFunction.name} repeatedly copies a Text prefix`,
          );
          continue;
        }
        failures.push(
          `${instruction.definition.span.file}:${instruction.definition.span.start}: cyclic ${runtimeFunction.name} continuation ${continuation.id} uses persistent ${instruction.operation.kind} (recursive function: ${
            recursiveFunctions.has(runtimeFunction.id)
          }, cyclic continuation: ${cyclicContinuations.has(continuation.id)})`,
        );
      }
    }
  }

  function reachesFunction(start: number, target: number): boolean {
    const pending = [start];
    const visited = new Set<number>([start]);
    while (pending.length > 0) {
      const functionId = pending.pop();
      if (functionId === undefined) break;
      const runtimeFunction = functions.get(functionId);
      if (runtimeFunction === undefined) continue;
      for (const continuation of runtimeFunction.continuations) {
        const transition = continuation.transition;
        if (
          transition.kind !== "call" || transition.target.kind !== "function"
        ) continue;
        const callee = transition.target.function;
        if (callee === target) return true;
        if (!functions.has(callee)) {
          failures.push(
            `${runtime.source}: ${runtimeFunction.name} calls absent function ${callee}`,
          );
          continue;
        }
        if (visited.has(callee)) continue;
        visited.add(callee);
        pending.push(callee);
      }
    }
    return false;
  }
}

function successorEdges(
  transition: BlotRuntimeTransition,
): readonly BlotRuntimeEdge[] {
  switch (transition.kind) {
    case "jump":
      return [transition.edge];
    case "branch":
      return [transition.consequent, transition.alternate];
    case "switch":
      return [...transition.cases.map(([, edge]) => edge), transition.fallback];
    case "call":
      return [transition.next];
    case "return":
    case "trap":
      return [];
  }
}

function continuationsInCycles(
  runtimeFunction: BlotRuntimeFunction,
): Set<number> {
  const successors = new Map<number, readonly number[]>();
  for (const continuation of runtimeFunction.continuations) {
    successors.set(
      continuation.id,
      successorEdges(continuation.transition).map((edge) => edge.target),
    );
  }
  const cyclic = new Set<number>();
  for (const continuation of runtimeFunction.continuations) {
    const initial = successors.get(continuation.id);
    if (initial === undefined) {
      throw new Error(
        `${runtimeFunction.name}: continuation ${continuation.id} has no successor facts`,
      );
    }
    const pending = [...initial];
    const visited = new Set<number>();
    while (pending.length > 0) {
      const candidate = pending.pop();
      if (candidate === undefined) break;
      if (candidate === continuation.id) {
        cyclic.add(continuation.id);
        break;
      }
      if (visited.has(candidate)) continue;
      visited.add(candidate);
      const next = successors.get(candidate);
      if (next === undefined) {
        throw new Error(
          `${runtimeFunction.name}: continuation ${candidate} has no successor facts`,
        );
      }
      pending.push(...next);
    }
  }
  return cyclic;
}

function functionOperations(
  runtimeFunction: BlotRuntimeFunction,
): readonly BlotRuntimeInstruction[] {
  return runtimeFunction.continuations.flatMap((continuation) =>
    continuation.instructions
  );
}

function isStoreGrowth(
  instruction: BlotRuntimeInstruction,
): instruction is BlotRuntimeInstruction & {
  readonly operation: {
    readonly kind: "store.grow";
    readonly update: "persistent" | "owned-reuse";
  };
} {
  return instruction.operation.kind === "store.grow";
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
