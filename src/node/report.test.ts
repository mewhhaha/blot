import assert from "node:assert/strict";
import test from "node:test";
import {
  CompilerInvariantFailure,
  CompilerLimitDiagnostic,
  CompilerTargetRefusal,
} from "../compiler/policy.ts";
import { BlotError } from "../diagnostic.ts";
import { LoadError } from "../load.ts";
import { renderFailure } from "./report.ts";

test("source failures preserve the actual originating file and span", () => {
  const diagnostic = {
    code: "BLOT_UNPROVEN_INDEX" as const,
    message: "index is not proved",
    span: { start: 7, end: 8 },
  };
  const origin = { path: "dependency.blot", source: "return x\n" };
  assert.equal(
    renderFailure("main.blot", new BlotError(diagnostic, origin)),
    "dependency.blot:1:8: BLOT_UNPROVEN_INDEX: index is not proved",
  );
  assert.equal(
    renderFailure(
      "main.blot",
      new LoadError(origin.path, origin.source, [diagnostic]),
    ),
    "dependency.blot:1:8: BLOT_UNPROVEN_INDEX: index is not proved",
  );
});

test("target, resource, and invariant failures retain separate classifications", () => {
  const cases = [
    [new CompilerTargetRefusal("open layout"), "target refusal"],
    [
      new CompilerLimitDiagnostic("BLOT_LIMIT", "fuel exhausted"),
      "compiler limit",
    ],
    [
      new CompilerInvariantFailure("lowering", new Error("missing fact")),
      "compiler invariant failure",
    ],
  ] as const;
  for (const [error, classification] of cases) {
    const rendered = renderFailure("main.blot", error);
    assert.ok(rendered.includes(classification));
    assert.ok(rendered.includes(error.code));
    assert.doesNotMatch(rendered, /:0:0:|:1:1:/);
  }
});

test("an unlocated or host error is not assigned a fabricated source location", () => {
  assert.equal(
    renderFailure("main.blot", new Error("missing artifact")),
    "main.blot: missing artifact",
  );
  assert.equal(
    renderFailure("main.blot", "host stopped"),
    "main.blot: host stopped",
  );
  assert.equal(
    renderFailure(
      "main.blot",
      new BlotError({
        code: "BLOT_UNPROVEN_INDEX",
        message: "index is not proved",
        span: { start: 7, end: 8 },
      }),
    ),
    "main.blot: BLOT_UNPROVEN_INDEX: index is not proved",
  );
});
