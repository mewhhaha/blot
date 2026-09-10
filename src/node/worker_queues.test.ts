import assert from "node:assert/strict";
import test from "node:test";
import type { CompiledCallback } from "../callbacks.ts";
import { HostScope } from "../resources.ts";
import { WorkerExecutor } from "../worker_executor.ts";
import { workerRequest } from "../worker_protocol.ts";

const module = new WebAssembly.Module(
  new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
);
function callback(): CompiledCallback {
  return {
    module,
    manifestBytes: new Uint8Array(),
    entry: "work",
    environmentType: { kind: "record", fields: [] },
    captures: [],
  };
}

function pool(root: HostScope, size: number) {
  const runs: { job: number; value: unknown; finish: () => void }[] = [];
  const workers = new WorkerExecutor(root, {
    size,
    createWorker() {
      let receive: ((message: unknown) => void) | undefined;
      return {
        postMessage(message) {
          const request = workerRequest(message);
          assert(receive !== undefined);
          const deliver = receive;
          if (request.kind === "run") {
            deliver({ kind: "started", job: request.job });
            runs.push({
              job: request.job,
              value: request.arguments[0],
              finish: () =>
                deliver({
                  kind: "returned",
                  job: request.job,
                  value: request.arguments[0],
                }),
            });
          } else if (request.kind === "cancel") {
            deliver({ kind: "cancelled", job: request.job });
          }
        },
        onMessage(listener) {
          receive = listener;
          return () => {
            receive = undefined;
          };
        },
        onError() {
          return () => {};
        },
        terminate() {
          return Promise.resolve();
        },
      };
    },
  });
  return { workers, runs };
}

test("promotion joins the required FIFO and queued cancellation removes work before admission", async () => {
  const root = new HostScope();
  const { workers, runs } = pool(root, 1);
  const promoted = callback();
  const controller = new AbortController();
  const reason = new Error("cancel queued work");
  try {
    const first = workers.execute(callback(), 0n, root.signal, {
      priority: "required",
    });
    const speculative = workers.execute(promoted, 1n, root.signal, {
      priority: "speculative",
    });
    const second = workers.execute(callback(), 2n, root.signal, {
      priority: "required",
    });
    workers.promote(promoted);
    const cancelled = workers.execute(callback(), 3n, controller.signal, {
      priority: "required",
    });
    const rejected = assert.rejects(cancelled, (cause) => cause === reason);
    controller.abort(reason);
    runs[0].finish();
    assert.deepEqual(runs.map((run) => run.value), [0n, 2n]);
    runs[1].finish();
    assert.deepEqual(runs.map((run) => run.value), [0n, 2n, 1n]);
    runs[2].finish();
    assert.deepEqual(await Promise.all([first, second, speculative]), [
      0n,
      2n,
      1n,
    ]);
    await rejected;
    assert.equal(workers.statistics.jobsSubmitted, 4);
    assert.equal(workers.statistics.jobsStarted, 3);
    assert.equal(workers.statistics.jobsCompleted, 4);
  } finally {
    await root.close();
  }
});

test("active promotion admits one more speculative job while reserving a required worker", async () => {
  const root = new HostScope();
  const { workers, runs } = pool(root, 2);
  const promoted = callback();
  try {
    const first = workers.execute(promoted, 1n, root.signal, {
      priority: "speculative",
    });
    const second = workers.execute(callback(), 2n, root.signal, {
      priority: "speculative",
    });
    assert.deepEqual(runs.map((run) => run.value), [1n]);
    workers.promote(promoted);
    assert.deepEqual(runs.map((run) => run.value), [1n, 2n]);
    workers.promote(promoted);
    const third = workers.execute(callback(), 3n, root.signal, {
      priority: "speculative",
    });
    runs[0].finish();
    assert.deepEqual(runs.map((run) => run.value), [1n, 2n]);
    const required = workers.execute(callback(), 4n, root.signal, {
      priority: "required",
    });
    assert.deepEqual(runs.map((run) => run.value), [1n, 2n, 4n]);
    runs[1].finish();
    assert.deepEqual(runs.map((run) => run.value), [1n, 2n, 4n, 3n]);
    runs[2].finish();
    runs[3].finish();
    assert.deepEqual(await Promise.all([first, second, third, required]), [
      1n,
      2n,
      3n,
      4n,
    ]);
    assert.equal(new Set(runs.map((run) => run.job)).size, 4);
  } finally {
    await root.close();
  }
});

test("large cancellation batches leave no queued work to run after the worker becomes idle", async () => {
  const root = new HostScope();
  const { workers, runs } = pool(root, 1);
  try {
    const first = workers.execute(callback(), 0n, root.signal, {
      priority: "required",
    });
    const controller = new AbortController();
    const reason = new Error("cancel batch");
    const pending = Array.from(
      { length: 4096 },
      (_, index) =>
        workers.execute(callback(), BigInt(index + 1), controller.signal, {
          priority: "required",
        }),
    );
    const drained = Promise.allSettled(pending);
    controller.abort(reason);
    runs[0].finish();
    assert.equal(await first, 0n);
    for (const result of await drained) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") {
        assert.strictEqual(result.reason, reason);
      }
    }
    assert.equal(runs.length, 1);
    assert.equal(workers.statistics.jobsCompleted, 4097);
    const next = workers.execute(callback(), 42n, root.signal, {
      priority: "required",
    });
    runs[1].finish();
    assert.equal(await next, 42n);
  } finally {
    await root.close();
  }
});
