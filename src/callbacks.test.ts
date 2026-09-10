import assert from "node:assert/strict";
import test from "node:test";
import {
  type CallbackType,
  createHostCallback,
  takeDevelopmentCallback,
} from "./callbacks.ts";
import { HostScope } from "./resources.ts";

const type: CallbackType = {
  kind: "callback",
  entry: "blot:callback:7",
  function: {
    parameters: [{ kind: "unit" }],
    result: { kind: "signed-integer-64" },
  },
  environment: {
    kind: "record",
    fields: [{ name: "capture00000000", type: { kind: "text" } }],
  },
};
const module = new WebAssembly.Module(
  new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
);

test("development callback transfer consumes the handle and releases its pins once", async () => {
  const owner = new HostScope();
  const destination = new HostScope(owner);
  let disposed = 0;
  const callback = createHostCallback(
    owner,
    (scope) => {
      assert.equal(scope.isWithin(owner), true);
    },
    () => Promise.resolve(41n),
    {
      module,
      manifestBytes: new Uint8Array(),
      entry: type.entry,
      environmentType: type.environment,
      captures: ["retained text"],
    },
    {
      type,
      dispose: () => {
        disposed += 1;
        return Promise.resolve();
      },
    },
  );
  const transferred = takeDevelopmentCallback(callback, {
    ...type,
    entry: "blot:callback:19",
  }, destination);
  assert.deepEqual(transferred.environment, {
    kind: "record",
    fields: new Map([["capture00000000", "retained text"]]),
  });
  await assert.rejects(callback.call(), /consumed/);
  assert.equal(disposed, 0);
  await transferred.release();
  await transferred.release();
  await owner.close();
  assert.equal(disposed, 1);
});

test("a rejected callback layout leaves the original callback available", async () => {
  const owner = new HostScope();
  let disposed = 0;
  const callback = createHostCallback(
    owner,
    () => {},
    () => Promise.resolve(41n),
    {
      module,
      manifestBytes: new Uint8Array(),
      entry: type.entry,
      environmentType: type.environment,
      captures: ["retained text"],
    },
    {
      type,
      dispose: () => {
        disposed += 1;
        return Promise.resolve();
      },
    },
  );
  assert.throws(() =>
    takeDevelopmentCallback(callback, {
      ...type,
      function: { ...type.function, result: { kind: "text" } },
    }, owner), /checked link layout/);
  assert.equal(await callback.call(), 41n);
  assert.equal(disposed, 1);
  await owner.close();
});

test("scope release drains an admitted callback before disposing its snapshot", async () => {
  const owner = new HostScope();
  const started = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<bigint>();
  let disposed = 0;
  const callback = createHostCallback(
    owner,
    () => {},
    () => {
      started.resolve();
      return completed.promise;
    },
    undefined,
    {
      dispose: () => {
        disposed += 1;
        return Promise.resolve();
      },
    },
  );
  const running = callback.call();
  await started.promise;
  const closing = owner.close();
  assert.equal(disposed, 0);
  completed.resolve(42n);
  assert.equal(await running, 42n);
  await closing;
  assert.equal(disposed, 1);
  await assert.rejects(callback.call(), /released/);
});

test("a snapshot disposal failure still consumes and detaches its callback", async () => {
  const owner = new HostScope();
  let disposed = 0;
  const failure = new Error("snapshot disposal failed");
  const callback = createHostCallback(
    owner,
    () => {},
    () => Promise.resolve(null),
    undefined,
    {
      dispose: () => {
        disposed += 1;
        return Promise.reject(failure);
      },
    },
  );
  await assert.rejects(callback.call(), (error) => error === failure);
  await owner.close();
  assert.equal(disposed, 1);
  await assert.rejects(callback.call(), /consumed/);
});
