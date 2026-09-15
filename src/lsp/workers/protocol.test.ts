import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  isWorkerReady,
  LSP_WORKER_PROTOCOL_VERSION,
  lspWorkerJob,
  lspWorkerResult,
  WORKER_READY_MESSAGE,
  workerFailureResult,
  workerSuccess,
} from "./protocol.ts";

Deno.test("the protocol validates every job kind", () => {
  assertEquals(LSP_WORKER_PROTOCOL_VERSION, 1);
  const probe = lspWorkerJob({
    protocol: 1,
    job: 1,
    kind: "cpu/probe",
    iterations: 10,
    seed: 3,
  });
  assertEquals(probe.kind, "cpu/probe");
  const facts = lspWorkerJob({
    protocol: 1,
    job: 2,
    kind: "syntax/parse-facts",
    uri: "u",
    source: "return 1\n",
  });
  assertEquals(facts.kind, "syntax/parse-facts");
  const open = lspWorkerJob({
    protocol: 1,
    job: 3,
    kind: "doc/open",
    uri: "u",
    source: "x",
    version: 1,
  });
  assertEquals(open.kind, "doc/open");
  const change = lspWorkerJob({
    protocol: 1,
    job: 4,
    kind: "doc/change",
    uri: "u",
    changes: [{
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      rangeLength: 1,
      text: "y",
    }],
    version: 2,
  });
  assertEquals(change.kind, "doc/change");
  const close = lspWorkerJob({
    protocol: 1,
    job: 5,
    kind: "doc/close",
    uri: "u",
  });
  assertEquals(close.kind, "doc/close");
  const request = lspWorkerJob({
    protocol: 1,
    job: 6,
    kind: "service/request",
    method: "textDocument/hover",
    uri: "u",
    params: {},
  });
  assertEquals(request.kind, "service/request");
  const format = lspWorkerJob({
    protocol: 1,
    job: 7,
    kind: "syntax/format",
    uri: "u",
    source: "return 1\n",
    params: {},
  });
  assertEquals(format.kind, "syntax/format");
});

Deno.test("the protocol rejects malformed jobs", () => {
  const bad: unknown[] = [
    null,
    42,
    { protocol: 2, job: 1, kind: "cpu/probe", iterations: 1, seed: 1 },
    { protocol: 1, job: 0, kind: "cpu/probe", iterations: 1, seed: 1 },
    { protocol: 1, job: 1.5, kind: "cpu/probe", iterations: 1, seed: 1 },
    { protocol: 1, job: 1, kind: "nope" },
    { protocol: 1, job: 1, kind: "cpu/probe", iterations: -1, seed: 1 },
    { protocol: 1, job: 1, kind: "cpu/probe", iterations: 1, seed: 1.5 },
    { protocol: 1, job: 1, kind: "doc/open", uri: "u", source: "x" },
    {
      protocol: 1,
      job: 1,
      kind: "doc/change",
      uri: "u",
      changes: [],
      version: 1.5,
    },
    {
      protocol: 1,
      job: 1,
      kind: "doc/change",
      uri: "u",
      changes: [{ text: 5 }],
      version: 1,
    },
    {
      protocol: 1,
      job: 1,
      kind: "doc/change",
      uri: "u",
      changes: [{
        range: {
          start: { line: -1, character: 0 },
          end: { line: 0, character: 0 },
        },
        text: "x",
      }],
      version: 1,
    },
    {
      protocol: 1,
      job: 1,
      kind: "service/request",
      method: "",
      uri: null,
      params: {},
    },
    {
      protocol: 1,
      job: 1,
      kind: "service/request",
      method: "m",
      uri: 7,
      params: {},
    },
    { protocol: 1, job: 1, kind: "service/request", method: "m", uri: null },
    { protocol: 1, job: 1, kind: "syntax/format", uri: "u", source: "x" },
    {
      protocol: 1,
      job: 1,
      kind: "syntax/format",
      uri: 7,
      source: "x",
      params: {},
    },
    {
      protocol: 1,
      job: 1,
      kind: "syntax/format",
      uri: "u",
      source: 7,
      params: {},
    },
  ];
  for (const value of bad) {
    assertThrows(() => lspWorkerJob(value), TypeError);
  }
});

Deno.test("the protocol validates results and preserves failure codes", () => {
  const ok = lspWorkerResult({
    protocol: 1,
    job: 4,
    ok: true,
    kind: "cpu/probe",
    value: { digest: "ab" },
  });
  assert(ok.ok);
  assertEquals(ok.job, 4);
  const failed = lspWorkerResult({
    protocol: 1,
    job: 4,
    ok: false,
    kind: "service/request",
    name: "JsonRpcError",
    message: "bad params",
    code: -32602,
  });
  assert(!failed.ok);
  assertEquals(failed.code, -32602);
  const codeless = lspWorkerResult({
    protocol: 1,
    job: 0,
    ok: false,
    kind: undefined,
    name: "TypeError",
    message: "nope",
    code: undefined,
  });
  assert(!codeless.ok);
  const bad: unknown[] = [
    null,
    { protocol: 1, job: 1, ok: true, kind: "cpu/probe" },
    { protocol: 1, job: -1, ok: true, kind: "cpu/probe", value: 1 },
    { protocol: 2, job: 1, ok: true, kind: "cpu/probe", value: 1 },
    { protocol: 1, job: 1, ok: "yes", kind: "cpu/probe", value: 1 },
    { protocol: 1, job: 1, ok: false, name: "E", message: "m", code: 1.5 },
    { protocol: 1, job: 1, ok: false, name: 7, message: "m" },
  ];
  for (const value of bad) {
    assertThrows(() => lspWorkerResult(value), TypeError);
  }
});

Deno.test("result builders echo the job and carry thrown codes", () => {
  const job = lspWorkerJob({
    protocol: 1,
    job: 9,
    kind: "service/request",
    method: "m",
    uri: null,
    params: {},
  });
  const success = workerSuccess(job, [1]);
  assert(success.ok);
  assertEquals(success.job, 9);
  assertEquals(success.value, [1]);
  const plain = workerFailureResult(job, new Error("boom"));
  assert(!plain.ok);
  assertEquals(plain.name, "Error");
  assertEquals(plain.code, undefined);
  const coded = workerFailureResult(
    job,
    Object.assign(new Error("bad"), { code: -32602 }),
  );
  assert(!coded.ok);
  assertEquals(coded.code, -32602);
  const strange = workerFailureResult(job, "string throw");
  assert(!strange.ok);
  assertEquals(strange.message, "string throw");
});

Deno.test("the ready sentinel is recognized and is not a result", () => {
  assertEquals(isWorkerReady(WORKER_READY_MESSAGE), true);
  assertEquals(isWorkerReady({ protocol: 1, ready: false }), false);
  assertEquals(isWorkerReady(null), false);
  assertThrows(() => lspWorkerResult(WORKER_READY_MESSAGE), TypeError);
});
