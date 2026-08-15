import assert from "node:assert/strict";
import test from "node:test";
import type { RefinementProposition } from "../../src/core/refinement.ts";
import {
  loadRelationalSummary,
  parameter,
  publishRelationalSummary,
  RelationalState,
  type RelationalSummary,
  result,
  type SummaryCall,
} from "./summary.ts";

const READ_EXACT: RelationalSummary = {
  tag: "relational-summary",
  schema: 1,
  parameters: 2,
  results: [{ tag: "fresh" }],
  requires: [{ tag: "at-least", variable: parameter(1), value: 0n }],
  ensures: [{
    tag: "equal-offset",
    left: result(0),
    right: parameter(1),
    offset: 0n,
  }],
};

const TAKE_PREFIX: RelationalSummary = {
  tag: "relational-summary",
  schema: 1,
  parameters: 2,
  results: [{ tag: "fresh" }],
  requires: [
    { tag: "at-least", variable: parameter(1), value: 0n },
    {
      tag: "difference-at-most",
      left: parameter(1),
      right: parameter(0),
      offset: 0n,
    },
  ],
  ensures: [{
    tag: "equal-offset",
    left: result(0),
    right: parameter(1),
    offset: 0n,
  }],
};

const IDENTITY: RelationalSummary = {
  tag: "relational-summary",
  schema: 1,
  parameters: 1,
  results: [{ tag: "alias", parameter: 0 }],
  requires: [],
  ensures: [],
};

const OPAQUE_RESULT: RelationalSummary = {
  tag: "relational-summary",
  schema: 1,
  parameters: 1,
  results: [{ tag: "fresh" }],
  requires: [],
  ensures: [],
};

const declared = { description: "declared test value" };

test("a relational summary substitutes fresh caller identities", () => {
  const state = new RelationalState(10);
  const input = state.bindFresh("input", declared);
  const count = state.bindFresh("count", declared);
  state.assume(atLeast(count, 0n), { description: "count was checked" });

  const first = accepted(state.call(
    READ_EXACT,
    [input, count],
    { description: "first readExact call" },
  ));
  assert.deepEqual(first.results, [12]);
  assert.equal(state.entails(equal(first.results[0], count)), true);

  const otherInput = state.bindFresh("otherInput", declared);
  const otherCount = state.bindFresh("otherCount", declared);
  state.assume(atLeast(otherCount, 0n), {
    description: "other count was checked",
  });
  const second = accepted(state.call(
    READ_EXACT,
    [otherInput, otherCount],
    { description: "second readExact call" },
  ));

  assert.notEqual(first.results[0], second.results[0]);
  assert.equal(state.entails(equal(second.results[0], otherCount)), true);
  assert.equal(state.entails(equal(first.results[0], otherCount)), false);
});

test("a failed precondition changes neither Phi nor identity allocation", () => {
  const state = new RelationalState();
  const bytes = state.bindFresh("bytes", declared);
  const count = state.bindFresh("count", declared);
  state.assume(atLeast(count, 0n), { description: "count is nonnegative" });

  const refused = state.call(
    TAKE_PREFIX,
    [bytes, count],
    { description: "takePrefix call" },
  );
  assert.equal(refused.tag, "refused");
  if (refused.tag !== "refused") throw new Error("expected refusal");
  assert.deepEqual(
    refused.missing.required,
    differenceAtMost(count, bytes, 0n),
  );

  const sentinel = state.bindFresh("sentinel", declared);
  assert.equal(sentinel, 2);
  assert.equal(state.entails(atLeast(count, 0n)), true);

  state.assume(differenceAtMost(count, bytes, 0n), {
    description: "count is within the input",
  });
  const call = accepted(state.call(
    TAKE_PREFIX,
    [bytes, count],
    { description: "proved takePrefix call" },
  ));
  assert.deepEqual(call.results, [3]);
});

test("only an explicit result alias preserves facts", () => {
  const state = new RelationalState();
  const value = state.bindFresh("value", declared);
  state.assume(atLeast(value, 0n), { description: "value is nonnegative" });

  const identity = accepted(state.call(
    IDENTITY,
    [value],
    { description: "identity call" },
  ));
  assert.equal(identity.results[0], value);
  assert.equal(state.entails(atLeast(identity.results[0], 0n)), true);

  const opaque = accepted(state.call(
    OPAQUE_RESULT,
    [value],
    { description: "opaque call" },
  ));
  assert.notEqual(opaque.results[0], value);
  assert.equal(state.entails(atLeast(opaque.results[0], 0n)), false);
});

test("a caller cannot forge an identity outside its scope", () => {
  const state = new RelationalState();
  const value = state.bindFresh("value", declared);

  assert.throws(
    () => state.bind("forged", 99, declared),
    /unallocated relational identity 99/,
  );
  assert.throws(
    () =>
      state.call(
        OPAQUE_RESULT,
        [99],
        { description: "forged call" },
      ),
    /unallocated relational identity 99/,
  );
  assert.throws(
    () => state.assume(atLeast(99, 0n), declared),
    /unallocated relational identity 99/,
  );
  assert.equal(state.entails(atLeast(99, 0n)), false);

  const result = accepted(state.call(
    OPAQUE_RESULT,
    [value],
    { description: "allocated call" },
  ));
  assert.deepEqual(result.results, [1]);
});

test("the published boundary carries slots but no caller facts", () => {
  const published = publishRelationalSummary(READ_EXACT);
  const encoded = JSON.stringify(published);
  assert.equal(encoded.includes("caller-local"), false);
  assert.equal(encoded.includes('"parameter"'), true);
  assert.equal(encoded.includes('"result"'), true);

  const loaded = loadRelationalSummary(JSON.parse(encoded));
  assert.notEqual(loaded, null);
  if (loaded === null) throw new Error("summary did not round trip");

  const state = new RelationalState(100);
  const input = state.bindFresh("input", { description: "caller-local input" });
  const count = state.bindFresh("count", { description: "caller-local count" });
  state.assume(atLeast(count, 0n), {
    description: "caller-local precondition",
  });
  const call = accepted(state.call(
    loaded,
    [input, count],
    { description: "loaded summary call" },
  ));
  assert.deepEqual(call.results, [102]);
  assert.equal(state.entails(equal(call.results[0], count)), true);

  assert.equal(JSON.stringify(publishRelationalSummary(READ_EXACT)), encoded);
});

test("publication canonicalizes conjunction order", () => {
  const reversed: RelationalSummary = {
    ...TAKE_PREFIX,
    requires: [...TAKE_PREFIX.requires].reverse(),
  };
  assert.deepEqual(
    publishRelationalSummary(reversed),
    publishRelationalSummary(TAKE_PREFIX),
  );
});

test("loading rejects facts that escape their summary slots", () => {
  const published = publishRelationalSummary(READ_EXACT);
  const resultPrecondition: unknown = {
    ...published,
    requires: [{
      tag: "at-least",
      variable: { tag: "result", index: 0 },
      value: "0",
    }],
  };
  assert.equal(loadRelationalSummary(resultPrecondition), null);

  const badAlias: unknown = {
    ...published,
    results: [{ tag: "alias", parameter: 9 }],
  };
  assert.equal(loadRelationalSummary(badAlias), null);

  const nonCanonicalInteger: unknown = {
    ...published,
    requires: [{
      tag: "at-least",
      variable: { tag: "parameter", index: 1 },
      value: "-0",
    }],
  };
  assert.equal(loadRelationalSummary(nonCanonicalInteger), null);
});

test("a rebinding explains where its missing fact was invalidated", () => {
  const state = new RelationalState();
  const input = state.bindFresh("input", declared);
  const count = state.bindFresh("count", declared);
  state.assume(atLeast(count, 0n), { description: "count was checked" });
  const read = accepted(state.call(
    READ_EXACT,
    [input, count],
    { description: "readExact at decode.rel:8" },
  ));
  state.bind("bytes", read.results[0], { description: "bytes declaration" });

  const changed = state.rebindFresh("bytes", {
    description: "bytes truncated at mutation.rel:3",
  });
  const required = equal(changed, count);
  assert.equal(state.entails(required), false);

  const explanation = state.explain(required);
  assert.deepEqual(explanation.knownAt, [{
    description: "readExact at decode.rel:8",
  }]);
  assert.deepEqual(explanation.invalidatedAt, {
    description: "bytes truncated at mutation.rel:3",
  });
  assert.equal(state.entails(atLeast(count, 0n)), true);

  state.assume(required, { description: "length repaired" });
  assert.equal(state.entails(required), true);
});

test("an alias keeps old facts live after another name is rebound", () => {
  const state = new RelationalState();
  const count = state.bindFresh("count", declared);
  const bytes = state.bindFresh("bytes", declared);
  state.assume(equal(bytes, count), { description: "decoded packet" });
  const kept = state.alias("kept", "bytes", { description: "kept alias" });

  const changed = state.rebindFresh("bytes", {
    description: "bytes rebound",
  });
  assert.equal(state.entails(equal(kept, count)), true);
  assert.equal(state.entails(equal(changed, count)), false);
});

function accepted(
  call: SummaryCall,
): Extract<SummaryCall, { tag: "accepted" }> {
  if (call.tag === "refused") {
    throw new Error(
      `unexpected relational refusal: ${call.missing.required.tag}`,
    );
  }
  return call;
}

function atLeast(variable: number, value: bigint): RefinementProposition {
  return { tag: "at-least", variable, value };
}

function equal(left: number, right: number): RefinementProposition {
  return { tag: "equal-offset", left, right, offset: 0n };
}

function differenceAtMost(
  left: number,
  right: number,
  offset: bigint,
): RefinementProposition {
  return { tag: "difference-at-most", left, right, offset };
}
