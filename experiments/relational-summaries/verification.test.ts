import assert from "node:assert/strict";
import test from "node:test";
import {
  parameter,
  RelationalState,
  type RelationalSummary,
  result,
  type SummaryCall,
} from "./summary.ts";
import {
  RelationalCheckSession,
  type RelationalDefinition,
  verifyRelationalSummary,
} from "./verification.ts";

const STEP: RelationalSummary = {
  tag: "relational-summary",
  schema: 1,
  parameters: 1,
  results: [{ tag: "fresh" }],
  requires: [],
  ensures: [{
    tag: "equal-offset",
    left: result(0),
    right: parameter(0),
    offset: 1n,
  }],
};

test("a wrapper summary is verified from its symbolic body", () => {
  const verification = verifyRelationalSummary(definition("v1", 4));
  if (verification.tag === "rejected") {
    throw new Error(verification.reason);
  }
  assert.equal(verification.tag, "verified");
  assert.equal(verification.artifact.bodyRevision, "v1");

  const state = new RelationalState();
  const input = state.bindFresh("input", { description: "caller input" });
  const call = accepted(state.call(
    verification.artifact.summary,
    [input],
    { description: "verified wrapper call" },
  ));
  assert.equal(
    state.entails({
      tag: "equal-offset",
      left: call.results[0],
      right: input,
      offset: 4n,
    }),
    true,
  );
});

test("verification rejects a postcondition the body does not establish", () => {
  const invalid = definition("v1", 3, 4);
  assert.deepEqual(verifyRelationalSummary(invalid), {
    tag: "rejected",
    reason: "advance does not establish equal-offset",
  });
});

test("verification rejects a false result identity policy", () => {
  const summary: RelationalSummary = {
    tag: "relational-summary",
    schema: 1,
    parameters: 1,
    results: [{ tag: "alias", parameter: 0 }],
    requires: [],
    ensures: [],
  };
  const invalid: RelationalDefinition = {
    name: "falseIdentity",
    revision: "v1",
    summary,
    body(state, parameters) {
      return accepted(state.call(
        STEP,
        parameters,
        { description: "step" },
      )).results;
    },
  };
  assert.deepEqual(verifyRelationalSummary(invalid), {
    tag: "rejected",
    reason:
      "falseIdentity result 0 does not preserve its declared parameter identity",
  });
});

test("a private body revision reverifies once without rechecking callers", () => {
  const session = new RelationalCheckSession();
  let callerChecks = 0;
  const callers = ["decode", "parse", "serve"].map((name) => ({
    name,
    revision: "v1",
    check(summary: RelationalSummary) {
      callerChecks += 1;
      const state = new RelationalState();
      const input = state.bindFresh("input", { description: name });
      accepted(state.call(summary, [input], { description: `${name} call` }));
    },
  }));

  const cold = session.check(definition("body-v1", 3), callers);
  assert.equal(cold.bodyVerified, true);
  assert.equal(cold.interfaceChanged, true);
  assert.deepEqual(cold.recheckedCallers, ["decode", "parse", "serve"]);
  assert.equal(callerChecks, 3);

  const unchanged = session.check(definition("body-v1", 3), callers);
  assert.equal(unchanged.bodyVerified, false);
  assert.equal(unchanged.interfaceChanged, false);
  assert.deepEqual(unchanged.recheckedCallers, []);
  assert.equal(callerChecks, 3);

  const privateEdit = session.check(definition("body-v2", 3), callers);
  assert.equal(privateEdit.bodyVerified, true);
  assert.equal(privateEdit.interfaceChanged, false);
  assert.deepEqual(privateEdit.recheckedCallers, []);
  assert.equal(callerChecks, 3);

  const publicEdit = session.check(definition("body-v3", 4), callers);
  assert.equal(publicEdit.bodyVerified, true);
  assert.equal(publicEdit.interfaceChanged, true);
  assert.deepEqual(publicEdit.recheckedCallers, ["decode", "parse", "serve"]);
  assert.equal(callerChecks, 6);
});

test("a failed caller check publishes no partial incremental state", () => {
  const session = new RelationalCheckSession();
  const checked: string[] = [];
  const failing = ["first", "second"].map((name) => ({
    name,
    revision: "v1",
    check() {
      checked.push(name);
      if (name === "second") throw new Error("caller failed");
    },
  }));
  assert.throws(
    () => session.check(definition("body-v1", 2), failing),
    /caller failed/,
  );
  assert.deepEqual(checked, ["first", "second"]);

  const retry = ["first", "second"].map((name) => ({
    name,
    revision: "v1",
    check() {
      checked.push(name);
    },
  }));
  const result = session.check(definition("body-v1", 2), retry);
  assert.equal(result.bodyVerified, true);
  assert.deepEqual(result.recheckedCallers, ["first", "second"]);
  assert.deepEqual(checked, ["first", "second", "first", "second"]);
});

function definition(
  revision: string,
  bodyDepth: number,
  declaredOffset = bodyDepth,
): RelationalDefinition {
  return {
    name: "advance",
    revision,
    summary: {
      tag: "relational-summary",
      schema: 1,
      parameters: 1,
      results: [{ tag: "fresh" }],
      requires: [],
      ensures: [{
        tag: "equal-offset",
        left: result(0),
        right: parameter(0),
        offset: BigInt(declaredOffset),
      }],
    },
    body(state, parameters) {
      const input = parameters[0];
      if (input === undefined) throw new Error("advance input is missing");
      let current = input;
      for (let index = 0; index < bodyDepth; index += 1) {
        current = accepted(state.call(
          STEP,
          [current],
          { description: `advance step ${index}` },
        )).results[0]!;
      }
      return [current];
    },
  };
}

function accepted(
  call: SummaryCall,
): Extract<SummaryCall, { tag: "accepted" }> {
  if (call.tag === "refused") {
    throw new Error(`unexpected refusal: ${call.missing.required.tag}`);
  }
  return call;
}
