import assert from "node:assert/strict";
import test from "node:test";
import {
  compareObservations,
  type CompilerAcceptance,
  type CompilerRejection,
  parityGapSignature,
  sameParityGapBaseline,
} from "./parity_report.ts";

const accepted: CompilerAcceptance = {
  status: "accepted",
  exports: ["main:runtime"],
  manifest: '{"abi":1}',
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

test("parity baselines identify new or resolved gaps", () => {
  const rejected: CompilerRejection = {
    status: "rejected",
    stage: "prepare",
    code: "NODE_PREPARE_ERROR",
    message: "not lowered yet",
  };
  const gap = compareObservations("examples/storage.blot", rejected, accepted);
  assert.notEqual(gap, undefined);
  if (gap === undefined) throw new Error("expected a parity gap");
  const signature = parityGapSignature(gap);
  assert.equal(sameParityGapBaseline([signature], [signature]), true);
  assert.equal(sameParityGapBaseline([], [signature]), false);
});
