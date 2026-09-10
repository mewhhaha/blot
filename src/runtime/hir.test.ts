import { assertEquals } from "@std/assert";
import {
  type BlotRuntimeFunction,
  type BlotRuntimeInstruction,
  type BlotRuntimeModule,
  runtimeLayoutWitness,
  validateBlotRuntimeModule,
} from "./hir.ts";
import { runtimeHirSchema } from "../compiler/protocol.ts";
const span = {
  file: "test.blot",
  start: 0,
  end: 1,
} as const;
function acceptedModule(): BlotRuntimeModule {
  return {
    format: "blot-runtime-hir",
    schemaVersion: runtimeHirSchema,
    source: "test.blot",
    types: [
      {
        kind: "unit",
      },
      {
        kind: "signed-integer-64",
      },
      {
        kind: "boolean",
      },
      {
        kind: "store",
        elementType: 1,
      },
    ],
    signatures: [
      {
        parameters: [],
        result: 1,
        effects: [],
      },
      {
        parameters: [1],
        result: 1,
        effects: ["Console"],
      },
    ],
    staticStores: [],
    functions: [
      {
        id: 0,
        name: "main",
        signature: 0,
        entry: 0,
        continuations: [
          {
            id: 0,
            parameters: [],
            instructions: [
              {
                definition: {
                  value: 0,
                  type: 2,
                  ownership: "plain",
                  span,
                },
                operands: [],
                operation: {
                  kind: "constant",
                  value: true,
                },
              },
              {
                definition: {
                  value: 1,
                  type: 1,
                  ownership: "plain",
                  span,
                },
                operands: [],
                operation: {
                  kind: "constant",
                  value: 42n,
                },
              },
            ],
            transition: {
              kind: "branch",
              condition: 0,
              consequent: {
                target: 1,
                arguments: [
                  {
                    kind: "value",
                    value: 1,
                  },
                ],
              },
              alternate: {
                target: 2,
                arguments: [
                  {
                    kind: "value",
                    value: 1,
                  },
                ],
              },
            },
            captures: [],
            span,
          },
          {
            id: 1,
            parameters: [{
              value: 2,
              type: 1,
              ownership: "plain",
              span,
            }],
            instructions: [],
            transition: {
              kind: "return",
              value: 2,
            },
            captures: [],
            span,
          },
          {
            id: 2,
            parameters: [{
              value: 3,
              type: 1,
              ownership: "plain",
              span,
            }],
            instructions: [],
            transition: {
              kind: "return",
              value: 3,
            },
            captures: [],
            span,
          },
        ],
        span,
        suspends: false,
        framed: false,
        reuse: null,
      },
      {
        id: 1,
        name: "write",
        signature: 1,
        entry: 0,
        continuations: [{
          id: 0,
          parameters: [{
            value: 0,
            type: 1,
            ownership: "plain",
            span,
          }],
          instructions: [],
          transition: {
            kind: "call",
            target: { kind: "host", capability: "Console", operation: "write" },
            signature: 1,
            arguments: [0],
            next: { target: 1, arguments: [{ kind: "result" }] },
            suspends: false,
          },
          captures: [],
          span,
        }, {
          id: 1,
          parameters: [{ value: 1, type: 1, ownership: "plain", span }],
          instructions: [],
          transition: {
            kind: "return",
            value: 1,
          },
          captures: [],
          span,
        }],
        span,
        suspends: false,
        framed: false,
        reuse: null,
      },
    ],
    capabilities: [{
      name: "Console",
      operations: [{
        name: "write",
        sourceName: "write",
        signature: 1,
        contract: {
          input: "unrestricted",
          result: "unrestricted",
          suspends: false,
        },
      }],
    }],
    links: [],
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
Deno.test("Blot Runtime HIR checks the byte cursor operand and Option payload types", () => {
  const module: BlotRuntimeModule = {
    ...acceptedModule(),
    types: [
      {
        kind: "unit",
      },
      {
        kind: "signed-integer-64",
      },
      {
        kind: "text",
      },
      {
        kind: "product",
        name: "ScalarByte",
        fields: [{
          name: "0",
          type: 2,
        }, {
          name: "1",
          type: 1,
        }],
      },
      {
        kind: "sum",
        name: "NextByte",
        cases: [
          {
            name: "None",
            payloadType: 0,
          },
          {
            name: "Some",
            payloadType: 3,
          },
        ],
      },
    ],
    signatures: [{
      parameters: [2, 1],
      result: 4,
      effects: [],
    }],
    functions: [{
      id: 0,
      name: "nextByte",
      signature: 0,
      entry: 0,
      continuations: [{
        id: 0,
        parameters: [
          {
            value: 0,
            type: 2,
            ownership: "owned",
            span,
          },
          {
            value: 1,
            type: 1,
            ownership: "plain",
            span,
          },
        ],
        instructions: [{
          definition: {
            value: 2,
            type: 4,
            ownership: "owned",
            span,
          },
          operands: [0, 1],
          operation: {
            kind: "text.next-byte",
          },
        }],
        transition: {
          kind: "return",
          value: 2,
        },
        captures: [],
        span,
      }],
      span,
      suspends: false,
      framed: false,
      reuse: null,
    }],
    capabilities: [],
  };
  validateBlotRuntimeModule(module);
  for (
    const invalidType of [
      {
        kind: "product" as const,
        name: "ScalarByte",
        fields: [{
          name: "0",
          type: 1,
        }, {
          name: "1",
          type: 2,
        }],
      },
      {
        kind: "sum" as const,
        name: "NextByte",
        cases: [
          {
            name: "Some",
            payloadType: 3,
          },
          {
            name: "None",
            payloadType: 0,
          },
        ],
      },
    ]
  ) {
    const invalidTypes = module.types.map((type) => {
      if (type.kind === invalidType.kind) {
        return invalidType;
      }
      return type;
    });
    assertThrows(() =>
      validateBlotRuntimeModule({
        ...module,
        types: invalidTypes,
      }), /text.next-byte.*requires \(Text, Int\)/);
  }
  const function_ = module.functions[0];
  const block = function_.continuations[0];
  assertThrows(() =>
    validateBlotRuntimeModule({
      ...module,
      functions: [{
        ...function_,
        continuations: [{
          ...block,
          instructions: [{
            ...block.instructions[0],
            operands: [1, 0],
          }],
        }],
      }],
    }), /text.next-byte.*requires \(Text, Int\)/);
});
Deno.test("Blot Runtime HIR accepts structural operation ownership matching its type", () => {
  const module = acceptedModule();
  const structural: BlotRuntimeModule = {
    ...module,
    types: [...module.types, {
      kind: "product",
      name: "Request",
      fields: [
        {
          name: "handle",
          type: 1,
        },
        {
          name: "priority",
          type: 1,
        },
      ],
    }],
    signatures: [...module.signatures, {
      parameters: [4],
      result: 1,
      effects: ["Console"],
    }],
    capabilities: [{
      ...module.capabilities[0],
      operations: [...module.capabilities[0].operations, {
        name: "submit",
        sourceName: "submit",
        signature: 2,
        contract: {
          suspends: false,
          input: {
            kind: "record",
            fields: [
              {
                name: "handle",
                ownership: "linear",
              },
              {
                name: "priority",
                ownership: "unrestricted",
              },
            ],
          },
          result: "unrestricted",
        },
      }],
    }],
  };
  validateBlotRuntimeModule(structural);
});
Deno.test("Blot Runtime HIR rejects structural ownership that disagrees with its type", () => {
  const module = acceptedModule();
  const invalid: BlotRuntimeModule = {
    ...module,
    capabilities: [{
      ...module.capabilities[0],
      operations: [{
        ...module.capabilities[0].operations[0],
        contract: {
          suspends: false,
          input: {
            kind: "record",
            fields: [{
              name: "handle",
              ownership: "linear",
            }],
          },
          result: "unrestricted",
        },
      }],
    }],
  };
  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /describes a record but runtime type 1 is signed-integer-64/,
  );
});
Deno.test("Runtime HIR accepts an integer switch with distinct cases", () => {
  const module: BlotRuntimeModule = {
    ...acceptedModule(),
    functions: [{
      id: 0,
      name: "main",
      signature: 0,
      entry: 0,
      continuations: [
        {
          id: 0,
          parameters: [],
          instructions: [{
            definition: {
              value: 0,
              type: 1,
              ownership: "plain",
              span,
            },
            operands: [],
            operation: {
              kind: "constant",
              value: 2n,
            },
          }],
          transition: {
            kind: "switch",
            selector: 0,
            cases: [
              [
                1n,
                {
                  target: 1,
                  arguments: [],
                },
              ],
              [
                2n,
                {
                  target: 2,
                  arguments: [],
                },
              ],
            ],
            fallback: {
              target: 3,
              arguments: [],
            },
          },
          captures: [],
          span,
        },
        {
          id: 1,
          parameters: [],
          instructions: [{
            definition: {
              value: 1,
              type: 1,
              ownership: "plain",
              span,
            },
            operands: [],
            operation: {
              kind: "constant",
              value: 10n,
            },
          }],
          transition: {
            kind: "return",
            value: 1,
          },
          captures: [],
          span,
        },
        {
          id: 2,
          parameters: [],
          instructions: [{
            definition: {
              value: 2,
              type: 1,
              ownership: "plain",
              span,
            },
            operands: [],
            operation: {
              kind: "constant",
              value: 20n,
            },
          }],
          transition: {
            kind: "return",
            value: 2,
          },
          captures: [],
          span,
        },
        {
          id: 3,
          parameters: [],
          instructions: [{
            definition: {
              value: 3,
              type: 1,
              ownership: "plain",
              span,
            },
            operands: [],
            operation: {
              kind: "constant",
              value: 30n,
            },
          }],
          transition: {
            kind: "return",
            value: 3,
          },
          captures: [],
          span,
        },
      ],
      span,
      suspends: false,
      framed: false,
      reuse: null,
    }],
  };
  validateBlotRuntimeModule(module);
});
Deno.test("Runtime HIR accepts F32x4 shuffle with constant lane selectors", () => {
  validateBlotRuntimeModule(shuffleModule(7));
});
Deno.test("Runtime HIR rejects an F32x4 shuffle selector outside both inputs", () => {
  assertThrows(
    () => validateBlotRuntimeModule(shuffleModule(8)),
    /selector 9 must be a integer-32 constant from 0 through 7/,
  );
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
      {
        kind: "scratch",
        elementType: 1,
      },
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
  const entry = main.continuations[0];
  const operations = entry.instructions.map((instruction) => {
    if (instruction.definition.value !== 2) {
      return instruction;
    }
    return {
      ...instruction,
      definition: { ...instruction.definition, type: 2 },
      operation: { kind: "constant" as const, value: true },
    };
  });
  const invalid: BlotRuntimeModule = {
    ...module,
    functions: [{
      ...main,
      continuations: [{
        ...entry,
        instructions: operations,
      }, ...main.continuations.slice(1)],
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
  const entry = main.continuations[0];
  const invalid: BlotRuntimeModule = {
    ...module,
    signatures: [{
      ...module.signatures[0],
      result: 4,
    }, ...module.signatures.slice(1)],
    functions: [{
      ...main,
      continuations: [{
        ...entry,
        transition: {
          kind: "return",
          value: 3,
        },
      }, ...main.continuations.slice(1)],
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
    types: [...module.types, {
      kind: "store",
      elementType: 4,
    }],
  };
  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /nests compiler-private Scratch storage/,
  );
});
Deno.test("Blot Runtime HIR rejects values absent from continuation inputs", () => {
  const module = acceptedModule();
  const main = module.functions[0];
  const invalid: BlotRuntimeModule = {
    ...module,
    functions: [{
      ...main,
      continuations: [
        main.continuations[0],
        main.continuations[1],
        {
          ...main.continuations[2],
          transition: {
            kind: "return",
            value: 2,
          },
        },
      ],
    }, ...module.functions.slice(1)],
  };
  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /reads unavailable value 2/,
  );
});
Deno.test("Blot Runtime HIR rejects undeclared host call targets", () => {
  const module = acceptedModule();
  assertThrows(
    () => validateBlotRuntimeModule({ ...module, capabilities: [] }),
    /call target is not declared/,
  );
});

Deno.test("Blot Runtime HIR consumes checked effect rows without reconstructing closure", () => {
  const module = acceptedModule();
  validateBlotRuntimeModule({
    ...module,
    signatures: [
      { ...module.signatures[0], effects: ["Console"] },
      module.signatures[1],
    ],
  });
});

Deno.test("Blot Runtime HIR accepts explicit call results and captured inputs", () => {
  validateBlotRuntimeModule(capturedCallModule());
});

Deno.test("Blot Runtime HIR validates explicit captures and successor bindings", () => {
  const module = capturedCallModule();
  const main = module.functions[0];
  const entry = main.continuations[0];
  const successor = main.continuations[1];
  const call = entry.transition;
  if (call.kind !== "call") throw new Error("fixture lost its call");
  const invalid: readonly {
    function: BlotRuntimeFunction;
    expected: RegExp;
  }[] = [
    {
      function: {
        ...main,
        continuations: [entry, { ...successor, captures: [] }],
      },
      expected: /reads unavailable value 1/,
    },
    {
      function: {
        ...main,
        continuations: [entry, {
          ...successor,
          captures: [{ ...successor.captures[0], type: 2 }],
        }],
      },
      expected: /edge capture disagrees with its definition/,
    },
    {
      function: {
        ...main,
        continuations: [entry, {
          ...successor,
          captures: [successor.captures[0], successor.captures[0]],
        }],
      },
      expected: /repeats input 1/,
    },
    {
      function: {
        ...main,
        continuations: [{
          ...entry,
          transition: { kind: "jump", edge: call.next },
        }, successor],
      },
      expected: /references a result outside a call/,
    },
    {
      function: {
        ...main,
        continuations: [{
          ...entry,
          transition: { ...call, next: { target: 1, arguments: [] } },
        }, successor],
      },
      expected: /edge arguments disagree with continuation parameters/,
    },
    {
      function: {
        ...main,
        continuations: [{
          ...entry,
          transition: { ...call, next: { ...call.next, target: 99 } },
        }, successor],
      },
      expected: /edge targets absent continuation 99/,
    },
    {
      function: {
        ...main,
        continuations: [
          { ...entry, transition: { ...call, suspends: true } },
          successor,
        ],
      },
      expected:
        /call disagrees with its target signature or suspension contract/,
    },
    {
      function: {
        ...main,
        continuations: [
          { ...entry, transition: { ...call, arguments: [] } },
          successor,
        ],
      },
      expected: /call arguments disagree with signature/,
    },
  ];
  for (const probe of invalid) {
    assertThrows(
      () =>
        validateBlotRuntimeModule({
          ...module,
          functions: [probe.function, module.functions[1]],
        }),
      probe.expected,
    );
  }
});

Deno.test("Blot Runtime HIR accepts declared link calls with explicit result edges", () => {
  const module = capturedCallModule();
  const main = module.functions[0];
  const entry = main.continuations[0];
  const transition = entry.transition;
  if (transition.kind !== "call") throw new Error("fixture lost its call");
  validateBlotRuntimeModule({
    ...module,
    links: [{
      unit: "dependency",
      name: "write",
      signature: 1,
      suspends: false,
    }],
    functions: [{
      ...main,
      continuations: [{
        ...entry,
        transition: {
          ...transition,
          target: { kind: "link", unit: "dependency", name: "write" },
        },
      }, ...main.continuations.slice(1)],
    }, module.functions[1]],
  });
});

Deno.test("Blot Runtime HIR rejects missing checked function facts and instruction calls", () => {
  for (const field of ["suspends", "framed", "reuse"]) {
    const module = acceptedModule();
    Reflect.deleteProperty(module.functions[0], field);
    assertThrows(
      () => validateBlotRuntimeModule(module),
      /checked suspension\/frame facts|unknown reuse certificate/,
    );
  }
  for (
    const kind of [
      "call.direct",
      "call.indirect",
      "host.call",
      "call.external",
      "unknown.operation",
    ]
  ) {
    const module = acceptedModule();
    Reflect.set(
      module.functions[0].continuations[0].instructions[0].operation,
      "kind",
      kind,
    );
    assertThrows(
      () => validateBlotRuntimeModule(module),
      /unknown instruction operation/,
    );
  }
});

function capturedCallModule(): BlotRuntimeModule {
  const module = acceptedModule();
  const main = module.functions[0];
  return {
    ...module,
    functions: [{
      ...main,
      continuations: [
        {
          ...main.continuations[0],
          transition: {
            kind: "call",
            target: { kind: "function", function: 1 },
            signature: 1,
            arguments: [1],
            next: { target: 1, arguments: [{ kind: "result" }] },
            suspends: false,
          },
        },
        {
          ...main.continuations[1],
          captures: [{ value: 1, type: 1, ownership: "plain", span }],
          instructions: [{
            definition: { value: 4, type: 1, ownership: "plain", span },
            operands: [1, 2],
            operation: { kind: "scalar", operator: "add" },
          }],
          transition: { kind: "return", value: 4 },
        },
      ],
    }, module.functions[1]],
  };
}

Deno.test("Blot Runtime HIR rejects owned Store reuse without ownership evidence", () => {
  const module = acceptedModule();
  const main = module.functions[0];
  const entry = main.continuations[0];
  const invalid: BlotRuntimeModule = {
    ...module,
    functions: [{
      ...main,
      continuations: [{
        ...entry,
        instructions: [...entry.instructions, {
          definition: {
            value: 4,
            type: 3,
            ownership: "plain",
            span,
          },
          operands: [1, 1, 1],
          operation: {
            kind: "store.write",
            update: "owned-reuse",
          },
        }],
      }, ...main.continuations.slice(1)],
    }, ...module.functions.slice(1)],
  };
  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /claims owned reuse with plain ownership/,
  );
});
Deno.test("Blot Runtime HIR accepts a closed Store literal", () => {
  const module = acceptedModule();
  const main = module.functions[0];
  const entry = main.continuations[0];
  const literal: BlotRuntimeModule = {
    ...module,
    functions: [{
      ...main,
      continuations: [{
        ...entry,
        instructions: [...entry.instructions, {
          definition: {
            value: 4,
            type: 3,
            ownership: "owned",
            span,
          },
          operands: [1],
          operation: {
            kind: "store.literal",
          },
        }],
      }, ...main.continuations.slice(1)],
    }, ...module.functions.slice(1)],
  };
  validateBlotRuntimeModule(literal);
});
Deno.test("Blot Runtime HIR accepts a pooled static Store literal", () => {
  const module = acceptedModule();
  const main = module.functions[0];
  const entry = main.continuations[0];
  const literal: BlotRuntimeModule = {
    ...module,
    staticStores: [{
      elementType: 1,
      values: [41n, 42n],
    }],
    functions: [{
      ...main,
      continuations: [{
        ...entry,
        instructions: [...entry.instructions, {
          definition: {
            value: 4,
            type: 3,
            ownership: "owned",
            span,
          },
          operands: [],
          operation: {
            kind: "store.literal",
            staticStore: 0,
          },
        }],
      }, ...main.continuations.slice(1)],
    }, ...module.functions.slice(1)],
  };
  validateBlotRuntimeModule(literal);
});
Deno.test("Blot Runtime HIR rejects runtime operands on a pooled Store literal", () => {
  const module = acceptedModule();
  const main = module.functions[0];
  const entry = main.continuations[0];
  const invalid: BlotRuntimeModule = {
    ...module,
    staticStores: [{
      elementType: 1,
      values: [42n],
    }],
    functions: [{
      ...main,
      continuations: [{
        ...entry,
        instructions: [...entry.instructions, {
          definition: {
            value: 4,
            type: 3,
            ownership: "owned",
            span,
          },
          operands: [1],
          operation: {
            kind: "store.literal",
            staticStore: 0,
          },
        }],
      }, ...main.continuations.slice(1)],
    }, ...module.functions.slice(1)],
  };
  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /retains runtime operands/,
  );
});
Deno.test("Blot Runtime HIR rejects an ill-typed static Store value", () => {
  const module: BlotRuntimeModule = {
    ...acceptedModule(),
    staticStores: [{
      elementType: 1,
      values: [42],
    }],
  };
  assertThrows(
    () => validateBlotRuntimeModule(module),
    /value 0 does not match element type 1/,
  );
});
Deno.test("Blot Runtime HIR rejects a Store literal with the wrong element type", () => {
  const module = acceptedModule();
  const main = module.functions[0];
  const entry = main.continuations[0];
  const invalid: BlotRuntimeModule = {
    ...module,
    functions: [{
      ...main,
      continuations: [{
        ...entry,
        instructions: [...entry.instructions, {
          definition: {
            value: 4,
            type: 3,
            ownership: "owned",
            span,
          },
          operands: [0],
          operation: {
            kind: "store.literal",
          },
        }],
      }, ...main.continuations.slice(1)],
    }, ...module.functions.slice(1)],
  };
  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /operand 0 does not have element type 1/,
  );
});
Deno.test("Blot Runtime HIR rejects a persistent update in a reuse-checked function", () => {
  const module = acceptedModule();
  const main = module.functions[0];
  const entry = main.continuations[0];
  const invalid: BlotRuntimeModule = {
    ...module,
    functions: [{
      ...main,
      reuse: "checked",
      continuations: [{
        ...entry,
        instructions: [...entry.instructions, {
          definition: {
            value: 4,
            type: 3,
            ownership: "owned",
            span,
          },
          operands: [],
          operation: {
            kind: "store.empty",
          },
        }, {
          definition: {
            value: 5,
            type: 3,
            ownership: "owned",
            span,
          },
          operands: [4, 1, 1],
          operation: {
            kind: "store.write",
            update: "persistent",
          },
        }],
      }, ...main.continuations.slice(1)],
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
    functions: [{
      ...module.functions[0],
      reuse: "claimed",
    }],
  } as unknown as BlotRuntimeModule;
  assertThrows(
    () => validateBlotRuntimeModule(invalid),
    /function main has unknown reuse certificate claimed/,
  );
});
Deno.test("Blot Runtime HIR rejects owned reuse across layouts", () => {
  const module = acceptedModule();
  const main = module.functions[0];
  const entry = main.continuations[0];
  const invalid: BlotRuntimeModule = {
    ...module,
    types: [
      ...module.types,
      {
        kind: "float-32",
      },
      {
        kind: "store",
        elementType: 4,
      },
    ],
    functions: [{
      ...main,
      continuations: [{
        ...entry,
        instructions: [...entry.instructions, {
          definition: {
            value: 4,
            type: 3,
            ownership: "owned",
            span,
          },
          operands: [],
          operation: {
            kind: "store.empty",
          },
        }, {
          definition: {
            value: 5,
            type: 5,
            ownership: "owned",
            span,
          },
          operands: [4, 1, 1],
          operation: {
            kind: "store.write",
            update: "owned-reuse",
          },
        }],
      }, ...main.continuations.slice(1)],
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
  const entry = main.continuations[0];
  const invalid: BlotRuntimeModule = {
    ...module,
    functions: [{
      ...main,
      continuations: [{
        ...entry,
        instructions: [...entry.instructions, {
          definition: {
            value: 4,
            type: 1,
            ownership: "owned",
            span,
          },
          operands: [1, 1, 1],
          operation: {
            kind: "store.write",
            update: "owned-reuse",
          },
        }],
      }, ...main.continuations.slice(1)],
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
    exports: [...module.exports, {
      ...module.exports[0],
    }],
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
    types: [...module.types, {
      kind: "scratch",
      elementType: 1,
    }],
    signatures: [{
      ...module.signatures[0],
      result: 3,
    }, ...module.signatures.slice(1)],
    functions: [{
      ...main,
      continuations: [{
        id: 0,
        parameters: [],
        instructions: [{
          definition: {
            value: 0,
            type: 1,
            ownership: "plain",
            span,
          },
          operands: [],
          operation: {
            kind: "constant",
            value: 4n,
          },
        }, {
          definition: {
            value: 1,
            type: 4,
            ownership: "owned",
            span,
          },
          operands: [0],
          operation: {
            kind: "scratch.with-capacity",
          },
        }, {
          definition: {
            value: 2,
            type: 1,
            ownership: "plain",
            span,
          },
          operands: [],
          operation: {
            kind: "constant",
            value: 42n,
          },
        }, {
          definition: {
            value: 3,
            type: 4,
            ownership: "owned",
            span,
          },
          operands: [1, 2],
          operation: {
            kind: "scratch.push",
          },
        }, {
          definition: {
            value: 4,
            type: 3,
            ownership: "owned",
            span,
          },
          operands: [3],
          operation: {
            kind: "scratch.finish",
          },
        }],
        transition: {
          kind: "return",
          value: 4,
        },
        captures: [],
        span,
      }],
    }, ...module.functions.slice(1)],
  };
}
function shuffleModule(lastSelector: number): BlotRuntimeModule {
  const module = acceptedModule();
  const main = module.functions[0];
  const entry = main.continuations[0];
  const shuffleOperations: BlotRuntimeInstruction[] = [
    {
      definition: {
        value: 4,
        type: 4,
        ownership: "plain",
        span,
      },
      operands: [],
      operation: {
        kind: "constant",
        value: 1.0,
      },
    },
    {
      definition: {
        value: 5,
        type: 5,
        ownership: "plain",
        span,
      },
      operands: [4],
      operation: {
        kind: "vector",
        operator: "splat",
      },
    },
    ...[0, 1, 6, lastSelector].map((selector, index) => ({
      definition: {
        value: 6 + index,
        type: 6,
        ownership: "plain" as const,
        span,
      },
      operands: [],
      operation: {
        kind: "constant" as const,
        value: selector,
      },
    })),
    {
      definition: {
        value: 10,
        type: 5,
        ownership: "plain",
        span,
      },
      operands: [5, 5, 6, 7, 8, 9],
      operation: {
        kind: "vector",
        operator: "shuffle",
      },
    },
  ];
  return {
    ...module,
    types: [
      ...module.types,
      {
        kind: "float-32",
      },
      {
        kind: "vector",
        element: "float-32",
        lanes: 4,
      },
      {
        kind: "integer-32",
      },
    ],
    functions: [{
      ...main,
      continuations: [{
        ...entry,
        instructions: [...entry.instructions, ...shuffleOperations],
      }, ...main.continuations.slice(1)],
    }, ...module.functions.slice(1)],
  };
}
function assertThrows(action: () => unknown, expected: RegExp): void {
  try {
    action();
  } catch (error) {
    let message = String(error);
    if (error instanceof Error) {
      message = error.message;
    }
    if (expected.test(message)) {
      return;
    }
    throw new Error(
      `expected error matching ${expected}; received ${
        JSON.stringify(message)
      }`,
    );
  }
  throw new Error(`expected error matching ${expected}`);
}
