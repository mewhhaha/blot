import assert from "node:assert/strict";
import test from "node:test";
import { locate } from "../diagnostic.ts";
import {
  parseExplainArguments,
  renderExplanation,
  sourceOffset,
} from "./explain.ts";

for (
  const arguments_ of [
    [],
    ["a.blot"],
    ["a.blot", "0:1"],
    ["a.blot", "1:0"],
    ["a.blot", "-1:2"],
    ["a.blot", "1.5:2"],
    ["a.blot", "1e2:3"],
    ["a.blot", "9007199254740992:1"],
    ["a.blot", "1:1", "extra"],
    ["--unknown", "1:1"],
    ["--json", "--json", "1:1"],
  ]
) {
  test(`explain refuses invalid arguments ${JSON.stringify(arguments_)}`, () => {
    assert.equal(parseExplainArguments(arguments_).ok, false);
  });
}

test("explain parses optional machine output and an explicit position", () => {
  assert.deepEqual(parseExplainArguments(["--json", "a.blot", "2:4"]), {
    ok: true,
    path: "a.blot",
    location: { line: 2, column: 4 },
    json: true,
  });
});

test("positions match locate for UTF-16, CRLF, empty lines, and EOF", () => {
  const source = "// 🦉\r\n\r\nreturn 42\n";
  for (
    const location of [
      { line: 1, column: 1 },
      { line: 1, column: 6 },
      { line: 2, column: 1 },
      { line: 3, column: 8 },
      { line: 4, column: 1 },
    ]
  ) {
    assert.deepEqual(locate(source, sourceOffset(source, location)), location);
  }
  assert.equal(sourceOffset("", { line: 1, column: 1 }), 0);
  assert.throws(() => sourceOffset(source, { line: 5, column: 1 }), RangeError);
  assert.throws(() => sourceOffset(source, { line: 2, column: 2 }), RangeError);
  assert.throws(() => sourceOffset(source, { line: 0, column: 1 }), RangeError);
  assert.throws(
    () => sourceOffset(source, { line: 1, column: Infinity }),
    RangeError,
  );
});

test("absence and module-level target facts do not invent source diagnostics", () => {
  const location = { line: 2, column: 3 };
  assert.match(
    renderExplanation("a.blot", location, null),
    /no compiler explanation/,
  );
  const rendered = renderExplanation("a.blot", location, {
    kind: "target",
    span: { start: 0, end: 0 },
    summary: "open public layout",
    reasons: ["provide a closed export signature"],
  });
  assert.equal(
    rendered,
    "a.blot: module target: open public layout\n  provide a closed export signature",
  );
  assert.doesNotMatch(rendered, /:0:0:|:2:3:/);
});
