import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
    `let score :: Int -> Int
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

test("host refuses indirect parameter blocks instead of passing scalar lanes incorrectly", async () => {
  const parameters = Array.from({ length: 17 }, (_, index) => `value${index}`);
  const signature = [...parameters.map(() => "Int"), "Int"].join(" -> ");
  const body = parameters.map((name) => `fn ${name} => `).join("") +
    "@int.add value0 value16";
  await withArtifact(
    `let run :: ${signature}\nlet run = ${body}\nreturn run`,
    async (artifact) => {
      await assert.rejects(
        () => instantiateArtifact(artifact),
        /indirect parameter blocks/,
      );
    },
  );
});
