import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decodeManifest,
  requiredFunction,
  type RuntimeValue,
} from "../abi_values.ts";
import { Compiler, type CompilerArtifact } from "../compiler.ts";
import {
  type HostedModule,
  type HostOperation,
  instantiateArtifact,
} from "../host.ts";

async function withArtifact(
  source: string,
  run: (artifact: CompilerArtifact) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "blot-host-"));
  const compiler = await Compiler.create();
  try {
    const path = join(directory, "main.blot");
    await writeFile(path, `open import "blot:prelude"\n${source}\n`);
    await run(await compiler.compile(path));
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}

test("host calls typed scalar exports and copies indirect results", async () => {
  await withArtifact(
    `let score: Int -> Int
let score = fn quantity => quantity * 2
return { .score = score; .heading = "\uFEFFWarehouse A"; }`,
    async (artifact) => {
      const hosted = await instantiateArtifact(artifact);
      assert.equal(hosted.call("score", [21n]), 42n);
      assert.equal(hosted.call("score", [-3n]), -6n);
      for (let index = 0; index < 100; index += 1) {
        assert.equal(hosted.call("heading"), "\uFEFFWarehouse A");
      }
      assert.throws(
        () => hosted.call("score", [21]),
        /expected signed-integer-64/,
      );
      assert.throws(
        () => hosted.call("score", [9223372036854775808n]),
        /64-bit range/,
      );
      assert.throws(() => hosted.call("score"), /requires 1 arguments/);
      assert.throws(() => hosted.call("missing"), /unknown runtime export/);
      hosted.destroy();
      hosted.destroy();
      assert.throws(() => hosted.call("score", [1n]), /destroyed/);
    },
  );
});

const effectful =
  `const Device = @effect.host { .read = Unit -> Int; .write = Int -> Unit; }
let run = fn () => do:
  use number <- Device.read ()
  use Device.write number
  return number
return run`;

test("host grants exactly the requested scalar operations and preserves order", async () => {
  await withArtifact(effectful, async (artifact) => {
    const trace: string[] = [];
    const operations = new Map<string, HostOperation>([
      ["read", () => {
        trace.push("read");
        return 42n;
      }],
      ["write", (_context, value) => {
        trace.push(`write ${value}`);
        return null;
      }],
    ]);
    const hosted = await instantiateArtifact(
      artifact,
      new Map([["Device", operations]]),
    );
    try {
      assert.equal(hosted.call("default", [null]), 42n);
      assert.deepEqual(trace, ["read", "write 42"]);
      operations.set("read", () => 7n);
      assert.equal(
        hosted.call("default", [null]),
        42n,
        "capabilities are snapshotted",
      );
    } finally {
      hosted.destroy();
    }
    await assert.rejects(
      () => instantiateArtifact(artifact),
      /missing host operation/,
    );
    operations.set("extra", () => null);
    await assert.rejects(
      () => instantiateArtifact(artifact, new Map([["Device", operations]])),
      /unused host operation/,
    );
  });
});

test("host rejects asynchronous Unit handlers instead of silently discarding them", async () => {
  await withArtifact(effectful, async (artifact) => {
    const asyncWrite = (() =>
      Promise.resolve(null)) as unknown as HostOperation;
    const hosted = await instantiateArtifact(
      artifact,
      new Map([[
        "Device",
        new Map<string, HostOperation>([
          ["read", () => 42n],
          ["write", asyncWrite],
        ]),
      ]]),
    );
    try {
      assert.throws(
        () => hosted.call("default", [null]),
        /synchronous host value/,
      );
    } finally {
      hosted.destroy();
    }
  });
});

test("host refuses reentrancy and destruction during a guest call", async () => {
  await withArtifact(effectful, async (artifact) => {
    const hosted: HostedModule = await instantiateArtifact(
      artifact,
      new Map([[
        "Device",
        new Map<string, HostOperation>([
          ["read", () => {
            assert.throws(() => hosted.call("default", [null]), /reentrant/);
            assert.throws(() => hosted.destroy(), /during a guest call/);
            return 42n;
          }],
          ["write", () => null],
        ]),
      ]]),
    );
    try {
      assert.equal(hosted.call("default", [null]), 42n);
    } finally {
      hosted.destroy();
    }
  });
});

test("host checks ABI identity before exposing exports", async () => {
  await withArtifact("return 42", async (artifact) => {
    const manifest = JSON.parse(
      new TextDecoder().decode(artifact.manifestBytes),
    );
    manifest.source = "forged source";
    await assert.rejects(
      () =>
        instantiateArtifact({
          ...artifact,
          manifestBytes: new TextEncoder().encode(JSON.stringify(manifest)),
        }),
      /manifests disagree/,
    );
    manifest.abi.major = 3;
    await assert.rejects(
      () =>
        instantiateArtifact({
          ...artifact,
          manifestBytes: new TextEncoder().encode(JSON.stringify(manifest)),
        }),
      /ABI 4.0/,
    );
    await assert.rejects(
      () => instantiateArtifact(artifact, new Map([["Ambient", new Map()]])),
      /unused host capability/,
    );
  });
});

test("host marshals indirect parameter blocks in source argument order", async () => {
  const parameters = Array.from({ length: 17 }, (_, index) => `value${index}`);
  const signature = [...parameters.map(() => "Int"), "Int"].join(" -> ");
  const body = parameters.map((name) => `fn ${name} => `).join("") +
    "@int.add value0 value16";
  await withArtifact(
    `let run: ${signature}\nlet run = ${body}\nreturn run`,
    async (artifact) => {
      const hosted = await instantiateArtifact(artifact);
      try {
        for (let offset = 0; offset < 8; offset += 1) {
          const values = parameters.map((_, index) => BigInt(offset + index));
          assert.equal(hosted.call("default", values), BigInt(offset * 2 + 16));
        }
        assert.throws(
          () =>
            hosted.call("default", [
              ...parameters.slice(0, 16).map(() => 0n),
              1,
            ]),
          /expected signed-integer-64/,
        );
        assert.equal(hosted.call("default", parameters.map(() => 1n)), 2n);
      } finally {
        hosted.destroy();
      }
    },
  );
});

for (const mode of ["synchronous", "suspending"]) {
  test(`host round trips a wide mixed record through ${mode} effects`, async () => {
    const fields = Array.from({ length: 10 }, (_, index) => `.n${index} = Int;`)
      .join(" ");
    let operation = "Payload -> Payload";
    if (mode === "suspending") operation = `Effect.suspends (${operation})`;
    await withArtifact(
      `const Payload = { ${fields} .a = Bool; .b = Text; .c = [Int]; .d = F32; .e = F64; .f = #Some Int | #None; }
const Echo = @effect.host { .reply = ${operation}; }
let run: Payload -> Payload ~ { Echo }
let run = fn payload => do:
  use result <- Echo.reply payload
  return result
return run`,
      async (artifact) => {
        const payload: RuntimeValue = {
          kind: "record",
          fields: new Map<string, RuntimeValue>([
            ...Array.from(
              { length: 10 },
              (
                _,
                index,
              ): [string, RuntimeValue] => [`n${index}`, BigInt(index - 5)],
            ),
            ["a", true],
            ["b", "matrix — 🐈"],
            ["c", [1n, -7n]],
            ["d", 1.25],
            ["e", -0],
            ["f", { kind: "variant", name: "Some", payload: 31n }],
          ]),
        };
        let calls = 0;
        const reply: HostOperation = (_context, value) => {
          calls += 1;
          assert.deepEqual(value, payload);
          if (mode === "suspending") return Promise.resolve(value);
          return value;
        };
        const hosted = await instantiateArtifact(
          artifact,
          new Map([["Echo", new Map([["reply", reply]])]]),
        );
        try {
          for (let index = 0; index < 5; index += 1) {
            if (mode === "suspending") {
              assert.deepEqual(
                await hosted.callAsync("default", [payload]),
                payload,
              );
            } else {
              assert.deepEqual(hosted.call("default", [payload]), payload);
            }
          }
          assert.equal(calls, 5);
        } finally {
          await hosted.close();
        }
      },
    );
  });
}

test("wide export adapters trap on null, misaligned, truncated, and overflowing parameter blocks", async () => {
  const fields = Array.from({ length: 17 }, (_, index) => `.n${index} = Int;`)
    .join(" ");
  await withArtifact(
    `const Wide = { ${fields} }
let run: Wide -> Int
let run = fn row => row.n16
return run`,
    async (artifact) => {
      const { instance } = await WebAssembly.instantiate(
        Uint8Array.from(artifact.wasm),
      );
      const memory = instance.exports.memory;
      assert.ok(memory instanceof WebAssembly.Memory);
      const run = requiredFunction(instance, "blot:default");
      assert.equal(run.length, 2, "scope plus canonical parameter pointer");
      for (
        const pointer of [0, 1, memory.buffer.byteLength - 128, 0xfffffff8]
      ) {
        const scope = Number(requiredFunction(instance, "cabi_enter")());
        try {
          assert.throws(() => run(scope, pointer), WebAssembly.RuntimeError);
        } finally {
          requiredFunction(instance, "cabi_leave")(scope);
        }
      }
    },
  );
});

test("resumable adapters validate wide parameters before frame allocation grows memory", async () => {
  const fields = Array.from({ length: 17 }, (_, index) => `.n${index} = Int;`)
    .join(" ");
  await withArtifact(
    `const Wide = { ${fields} }
const Gate = @effect.host { .wait = Effect.suspends (Int -> Int); }
let run: Wide -> Int ~ { Gate }
let run = fn row => Gate.wait row.n16
return run`,
    async (artifact) => {
      const manifest = decodeManifest(artifact.manifestBytes);
      const imports: WebAssembly.Imports = {};
      for (const operation of manifest.imports) {
        let namespace = imports[operation.module];
        if (namespace === undefined) {
          namespace = {};
          imports[operation.module] = namespace;
        }
        namespace[operation.name] = () => {
          throw new Error("invalid call reached a host operation");
        };
      }
      const { instance } = await WebAssembly.instantiate(
        Uint8Array.from(artifact.wasm),
        imports,
      );
      const memory = instance.exports.memory;
      assert.ok(memory instanceof WebAssembly.Memory);
      const scope = Number(requiredFunction(instance, "cabi_enter")());
      try {
        const allocate = requiredFunction(instance, "cabi_realloc");
        let available = memory.buffer.byteLength;
        for (let index = 0; index < 4096 && available >= 256; index += 1) {
          const pointer = Number(allocate(scope, 0, 0, 8, 8));
          available = memory.buffer.byteLength - pointer;
        }
        assert.ok(
          available < 256,
          "leave too little memory for the continuation frame",
        );
        const end = memory.buffer.byteLength;
        assert.throws(
          () => requiredFunction(instance, "blot:default")(scope, end),
          WebAssembly.RuntimeError,
        );
        assert.equal(
          memory.buffer.byteLength,
          end,
          "validation precedes memory growth",
        );
      } finally {
        requiredFunction(instance, "cabi_leave")(scope);
      }
    },
  );
});
