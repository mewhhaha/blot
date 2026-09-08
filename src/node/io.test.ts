import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { instantiateArtifact } from "../host.ts";
import { IoRuntime } from "../io.ts";
import { HostScope } from "../resources.ts";

test("explicit HTTP capabilities return canonical responses and enforce their origin", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(201);
    response.end("hello from HTTP");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address !== null && typeof address === "object");
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile("examples/lib/io.blot");
    const io = new IoRuntime(root);
    const http = io.http(root, {
      baseURL: new URL(`http://127.0.0.1:${address.port}/`),
    });
    const hosted = await instantiateArtifact(
      artifact,
      io.capabilitiesFor(artifact),
      { scope: root },
    );
    try {
      assert.deepEqual(await hosted.callAsync("get", [http, "/example"]), {
        kind: "variant",
        name: "Ok",
        payload: {
          kind: "record",
          fields: new Map<string, string | bigint>([
            ["body", "hello from HTTP"],
            ["status", 201n],
          ]),
        },
      });
      assert.deepEqual(
        await hosted.callAsync("get", [http, "https://example.invalid/"]),
        {
          kind: "variant",
          name: "Error",
          payload: "HTTP URL is outside the granted origin",
        },
      );
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      })
    );
  }
});

test("clock sleep uses the selected service and cancellation clears a pending timer", async () => {
  const compiler = await Compiler.create();
  const root = new HostScope();
  try {
    const artifact = await compiler.compile("examples/lib/io.blot");
    const io = new IoRuntime(root);
    const durations: number[] = [];
    const fake = io.clock(root, {
      now: () => 123n,
      sleep: async (duration) => {
        durations.push(duration);
      },
    });
    const clock = io.clock(root);
    const hosted = await instantiateArtifact(
      artifact,
      io.capabilitiesFor(artifact),
      { scope: root },
    );
    try {
      assert.equal(await hosted.callAsync("sleep", [fake, 17n]), 123n);
      assert.deepEqual(durations, [17]);
      const controller = new AbortController();
      const reason = new Error("stop sleeping");
      const pending = hosted.callAsync("sleep", [clock, 60000n], {
        signal: controller.signal,
      });
      const rejected = assert.rejects(pending, (error) => error === reason);
      setTimeout(() => controller.abort(reason), 10);
      await rejected;
      await assert.rejects(
        hosted.callAsync("sleep", [clock, -1n]),
        /sleep must be/,
      );
    } finally {
      await hosted.close();
    }
  } finally {
    await root.close();
    compiler.destroy();
  }
});
