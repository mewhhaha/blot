import { assertEquals } from "@std/assert";
import {
  type BlotRuntimeModule,
  runtimeLayoutWitness,
  validateBlotRuntimeModule,
} from "./hir.ts";
import { runtimeHirSchema } from "../compiler/protocol.ts";

const span = { file: "test.blot", start: 0, end: 1 } as const;

function acceptedModule(): BlotRuntimeModule {
  return {
    format: "blot-runtime-hir",
    schemaVersion: runtimeHirSchema,
    source: "test.blot",
    types: [
      { kind: "unit" },
      { kind: "signed-integer-64" },
      { kind: "boolean" },
      { kind: "store", elementType: 1 },
    ],
    signatures: [
      { parameters: [], result: 1, effects: [] },
      { parameters: [1], result: 1, effects: ["Console"] },
    ],
    functions: [
      {
        id: 0,
        name: "main",
        signature: 0,
        entryBlock: 0,
        blocks: [
          {
            id: 0,
            parameters: [],
            operations: [
              {
                kind: "constant",
                result: 0,
                type: 2,
                operands: [],
                ownership: "plain",
                value: true,
                span,
              },
              {
                kind: "constant",
                result: 1,
                type: 1,
                operands: [],
                ownership: "plain",
                value: 42n,
                span,
              },
            ],
            terminator: {
              kind: "conditional",
              condition: 0,
              consequent: 1,
              consequentArguments: [1],
              alternate: 2,
              alternateArguments: [1],
              likely: "consequent",
              span,
            },
          },
          {
            id: 1,
            parameters: [{
              value: 2,
              type: 1,
              ownership: "plain",
              span,
            }],
            operations: [],
            terminator: { kind: "return", value: 2, span },
          },
          {
            id: 2,
            parameters: [{
              value: 3,
              type: 1,
              ownership: "plain",
              span,
            }],
            operations: [],
            terminator: { kind: "return", value: 3, span },
          },
        ],
        span,
      },
      {
        id: 1,
        name: "write",
        signature: 1,
        entryBlock: 0,
        blocks: [{
          id: 0,
          parameters: [{
            value: 0,
            type: 1,
            ownership: "plain",
            span,
          }],
          operations: [{
            kind: "host.call",
            result: 1,
            type: 1,
            operands: [0],
            ownership: "plain",
            capability: "Console",
            operation: "write",
            span,
          }],
          terminator: { kind: "return", value: 1, span },
        }],
        span,
      },
    ],
    capabilities: [{
      name: "Console",
      operations: [{ name: "write", signature: 1 }],
    }],
    exports: [{
      sourceName: "default",
      phase: "runtime",
      wasmName: "blot:default",
      function: 0,
      signature: 0,
      ownership: "owned",
    }],
  };
}

Deno.test("Blot Runtime HIR accepts typed control flow and declared effects", () => {
  validateBlotRuntimeModule(acceptedModule());
});

Deno.test("Runtime HIR derives a closed Store layout witness", () => {
  const layout = runtimeLayoutWitness(acceptedModule(), 3);
  assertEquals(layout.size, 8);
  assertEquals(layout.alignment, 4);
  assertEquals(layout.fingerprint, "store(signed-integer-64;stride=8)");
});

Deno.test("Runtime HIR derives the opaque Scratch header layout", () => {
  const module: BlotRuntimeModule = {
    ...acceptedModule(),
    types: [
      ...acceptedModule().types,
      { kind: "scratch", elementType: 1 },
    ],
  };
  const layout = runtimeLayoutWitness(module, 4);
  assertEquals(layout.size, 12);
  assertEquals(layout.alignment, 4);
  assertEquals(layout.fingerprint, "scratch(signed-integer-64;stride=8)");
});

Deno.test("Runtime HIR accepts a typed Scratch lifecycle", () => {
  validateBlotRuntimeModule(scratchModule());
});

Deno.test("Runtime HIR rejects a Scratch push with the wrong element type", () => {
  const module = scratchModule();
  const main = module.functions[0];
  const entry = main.blocks[0];
  const operations = entry.operations.map((operation) => {
    if (operation.result !== 2) return operation;
    return { ...operation, type: 2, value: true };
  });
  const invalid: BlotRuntimeModule = {
    ...module,
    functions: [{
      ...main,
      blocks: [{ ...entry, operations }, ...main.blocks.slice(1)],
    }, ...module.functions.slice(1)],
  };
  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /requires \(Scratch T, T\) -> Scratch T/,
  );
});

Deno.test("Runtime HIR rejects Scratch at a public ABI boundary", () => {
  const module = scratchModule();
  const main = module.functions[0];
  const entry = main.blocks[0];
  const invalid: BlotRuntimeModule = {
    ...module,
    signatures: [{
      ...module.signatures[0],
      result: 4,
    }, ...module.signatures.slice(1)],
    functions: [{
      ...main,
      blocks: [{
        ...entry,
        terminator: { kind: "return", value: 3, span },
      }, ...main.blocks.slice(1)],
    }, ...module.functions.slice(1)],
  };
  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /exposes compiler-private Scratch storage/,
  );
});

Deno.test("Runtime HIR rejects Scratch nested in initialized storage", () => {
  const module = scratchModule();
  const invalid: BlotRuntimeModule = {
    ...module,
    types: [...module.types, { kind: "store", elementType: 4 }],
  };
  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /nests compiler-private Scratch storage/,
  );
});

Deno.test("Blot Runtime HIR rejects values that do not dominate their use", () => {
  const module = acceptedModule();
  const main = module.functions[0];
  const invalid: BlotRuntimeModule = {
    ...module,
    functions: [{
      ...main,
      blocks: [
        main.blocks[0],
        main.blocks[1],
        {
          ...main.blocks[2],
          terminator: { kind: "return", value: 2, span },
        },
      ],
    }, ...module.functions.slice(1)],
  };

  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /value 2 does not dominate its use in main:2/,
  );
});

Deno.test("Blot Runtime HIR rejects undeclared host effects", () => {
  const module = acceptedModule();
  const writer = module.functions[1];
  const invalid: BlotRuntimeModule = {
    ...module,
    signatures: [module.signatures[0], {
      ...module.signatures[1],
      effects: [],
    }],
    functions: [module.functions[0], writer],
  };

  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /calls Console.write outside capability Console in its effect row/,
  );
});

Deno.test("Blot Runtime HIR rejects effect rows without reachable operations", () => {
  const module = acceptedModule();
  const main = module.functions[0];
  const invalid: BlotRuntimeModule = {
    ...module,
    signatures: [{
      ...module.signatures[0],
      effects: ["Console"],
    }, module.signatures[1]],
    functions: [{ ...main }, module.functions[1]],
  };

  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /function main effect row \[Console\] differs from reachable effects \[\]/,
  );
});

Deno.test("Blot Runtime HIR closes effects through direct calls", () => {
  const module = acceptedModule();
  const main = module.functions[0];
  const entry = main.blocks[0];
  const transitive: BlotRuntimeModule = {
    ...module,
    signatures: [{
      ...module.signatures[0],
      effects: ["Console"],
    }, module.signatures[1]],
    functions: [{
      ...main,
      blocks: [{
        ...entry,
        operations: [...entry.operations, {
          kind: "call.direct",
          result: 4,
          type: 1,
          operands: [1],
          ownership: "plain",
          function: 1,
          span,
        }],
      }, ...main.blocks.slice(1)],
    }, module.functions[1]],
  };

  validateBlotRuntimeModule(transitive);
});

Deno.test("Blot Runtime HIR rejects owned Store reuse without ownership evidence", () => {
  const module = acceptedModule();
  const main = module.functions[0];
  const entry = main.blocks[0];
  const invalid: BlotRuntimeModule = {
    ...module,
    functions: [{
      ...main,
      blocks: [{
        ...entry,
        operations: [...entry.operations, {
          kind: "store.write",
          result: 4,
          type: 3,
          operands: [1, 1, 1],
          ownership: "plain",
          update: "owned-reuse",
          span,
        }],
      }, ...main.blocks.slice(1)],
    }, ...module.functions.slice(1)],
  };

  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /claims owned reuse with plain ownership/,
  );
});

Deno.test("Blot Runtime HIR rejects a persistent update in a reuse-checked function", () => {
  const module = acceptedModule();
  const main = module.functions[0];
  const entry = main.blocks[0];
  const invalid: BlotRuntimeModule = {
    ...module,
    functions: [{
      ...main,
      reuse: "checked",
      blocks: [{
        ...entry,
        operations: [...entry.operations, {
          kind: "store.empty",
          result: 4,
          type: 3,
          operands: [],
          ownership: "owned",
          span,
        }, {
          kind: "store.write",
          result: 5,
          type: 3,
          operands: [4, 1, 1],
          ownership: "owned",
          update: "persistent",
          span,
        }],
      }, ...main.blocks.slice(1)],
    }, ...module.functions.slice(1)],
  };

  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /reuse-checked function main contains persistent store.write/,
  );
});

Deno.test("Blot Runtime HIR rejects an unknown reuse certificate", () => {
  const module = acceptedModule();
  const invalid = {
    ...module,
    functions: [{ ...module.functions[0], reuse: "claimed" }],
  } as unknown as BlotRuntimeModule;

  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /function main has unknown reuse certificate claimed/,
  );
});

Deno.test("Blot Runtime HIR rejects owned reuse across layouts", () => {
  const module = acceptedModule();
  const main = module.functions[0];
  const entry = main.blocks[0];
  const invalid: BlotRuntimeModule = {
    ...module,
    types: [
      ...module.types,
      { kind: "float-32" },
      { kind: "store", elementType: 4 },
    ],
    functions: [{
      ...main,
      blocks: [{
        ...entry,
        operations: [...entry.operations, {
          kind: "store.empty",
          result: 4,
          type: 3,
          operands: [],
          ownership: "owned",
          span,
        }, {
          kind: "store.write",
          result: 5,
          type: 5,
          operands: [4, 1, 1],
          ownership: "owned",
          update: "owned-reuse",
          span,
        }],
      }, ...main.blocks.slice(1)],
    }, ...module.functions.slice(1)],
  };

  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /claims owned reuse across incompatible layouts/,
  );
});

Deno.test("Blot Runtime HIR rejects owned reuse on non-Store types", () => {
  const module = acceptedModule();
  const main = module.functions[0];
  const entry = main.blocks[0];
  const invalid: BlotRuntimeModule = {
    ...module,
    functions: [{
      ...main,
      blocks: [{
        ...entry,
        operations: [...entry.operations, {
          kind: "store.write",
          result: 4,
          type: 1,
          operands: [1, 1, 1],
          ownership: "owned",
          update: "owned-reuse",
          span,
        }],
      }, ...main.blocks.slice(1)],
    }, ...module.functions.slice(1)],
  };

  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /claims owned reuse without Store source and result types/,
  );
});

Deno.test("Blot Runtime HIR rejects duplicate exported names", () => {
  const module = acceptedModule();
  const invalid: BlotRuntimeModule = {
    ...module,
    exports: [...module.exports, { ...module.exports[0] }],
  };

  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /source exports repeats "default"/,
  );
});

function scratchModule(): BlotRuntimeModule {
  const module = acceptedModule();
  const main = module.functions[0];
  return {
    ...module,
    types: [...module.types, { kind: "scratch", elementType: 1 }],
    signatures: [{
      ...module.signatures[0],
      result: 3,
    }, ...module.signatures.slice(1)],
    functions: [{
      ...main,
      blocks: [{
        id: 0,
        parameters: [],
        operations: [{
          kind: "constant",
          result: 0,
          type: 1,
          operands: [],
          ownership: "plain",
          value: 4n,
          span,
        }, {
          kind: "scratch.with-capacity",
          result: 1,
          type: 4,
          operands: [0],
          ownership: "owned",
          span,
        }, {
          kind: "constant",
          result: 2,
          type: 1,
          operands: [],
          ownership: "plain",
          value: 42n,
          span,
        }, {
          kind: "scratch.push",
          result: 3,
          type: 4,
          operands: [1, 2],
          ownership: "owned",
          span,
        }, {
          kind: "scratch.finish",
          result: 4,
          type: 3,
          operands: [3],
          ownership: "owned",
          span,
        }],
        terminator: { kind: "return", value: 4, span },
      }],
    }, ...module.functions.slice(1)],
  };
}

function assertThrows(action: () => unknown, expected: RegExp): void {
  try {
    action();
  } catch (error) {
    let message = String(error);
    if (error instanceof Error) message = error.message;
    if (expected.test(message)) return;
    throw new Error(
      `expected error matching ${expected}; received ${
        JSON.stringify(message)
      }`,
    );
  }
  throw new Error(`expected error matching ${expected}`);
}
