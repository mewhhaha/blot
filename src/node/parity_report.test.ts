import assert from "node:assert/strict";
import test from "node:test";
import {
  type CompilerAcceptance,
  type CompilerRejection,
  compareObservations,
} from "./parity_report.ts";

const accepted: CompilerAcceptance = {
  status: "accepted",
  type: "Int",
  effects: "",
  exports: ["main:runtime"],
  manifest: "{\"abi\":1}",
  capabilities: [],
};

test("matching compiler observations have no parity gap", () => {
  assert.equal(
    compareObservations("examples/minimal.blot", accepted, accepted),
    undefined,
  );
});

test("parity gaps identify the differing compiler boundary", () => {
  const rejected: CompilerRejection = {
    status: "rejected",
    stage: "prepare",
    code: "NODE_RUNTIME_HIR",
    message: "not lowered yet",
  };
  assert.deepEqual(
    compareObservations("examples/storage.blot", rejected, accepted),
    {
      path: "examples/storage.blot",
      node: rejected,
      rust: accepted,
      differences: ["acceptance"],
    },
  );
});
