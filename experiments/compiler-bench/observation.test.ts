import assert from "node:assert/strict";
import test from "node:test";
import { compilerObservation } from "./observation.ts";

test("effect observations preserve alpha-equivalent identities", () => {
  const first = compilerObservation({
    type: "{ .model = Effect:20:Model; .terminal = Effect:10:Terminal; }",
    effects: " ~ { host:10:Terminal, host:20:Model }",
  });
  const second = compilerObservation({
    type: "{ .model = Effect:4:Model; .terminal = Effect:9:Terminal; }",
    effects: " ~ { host:4:Model, host:9:Terminal }",
  });

  assert.equal(second, first);
});

test("effect observations distinguish shared and distinct identities", () => {
  const shared = compilerObservation({
    type: "(Effect:7:Console, Effect:7:Console)",
    effects: " ~ { host:7:Console }",
  });
  const distinct = compilerObservation({
    type: "(Effect:7:Console, Effect:8:Console)",
    effects: " ~ { host:7:Console, host:8:Console }",
  });

  assert.notEqual(distinct, shared);
});

test("open effect rows retain their tail while labels are canonicalized", () => {
  const first = compilerObservation({
    type: "Int",
    effects: " ~ { host:20:Terminal, host:10:Model, ..'effects }",
  });
  const second = compilerObservation({
    type: "Int",
    effects: " ~ { host:4:Model, host:8:Terminal, ..'effects }",
  });

  assert.equal(second, first);
  assert.match(first, /\.\.'effects/);
});

test("effect rows are ordered after identities shared with their context", () => {
  const first = compilerObservation({
    type: "(Effect:20:Console, { effect:10:Console, effect:20:Console })",
    effects: "",
  });
  const second = compilerObservation({
    type: "(Effect:4:Console, { effect:4:Console, effect:9:Console })",
    effects: "",
  });

  assert.equal(second, first);
});
