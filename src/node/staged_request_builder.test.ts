import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const path = "examples/staged_request_builder.blot";
const expectedType =
  "{ .default = { .auth_first = { .credential = Text; .endpoint = Text; .payload = Text; .retries = 0..5 }; .body_first = { .credential = Text; .endpoint = Text; .payload = Text; .retries = 0..5 } } }";

test("staged request builder preserves its type and both executions", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const sourcePath of [
        "examples/lib/staged_request.blot",
        path,
      ]
    ) {
      const source = await readFile(sourcePath, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error("accepted example failed to format");
      assert.equal(formatted.source, source);
    }

    assert.deepEqual(await compiler.check(path), {
      type: expectedType,
      effects: "",
    });

    const evaluated = await compiler.evaluate(path);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile("examples/expected/staged_request_builder.txt", "utf8"))
        .trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      (await readFile(
        "examples/expected/staged_request_builder.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

for (
  const [name, body, diagnostic] of [
    [
      "premature submission",
      `let !draft = Request.begin "/users"
let !authorized = Request.authorize (!draft, "Bearer Ada")
return Request.submit (!authorized)`,
      "BLOT_TYPE_ERROR",
    ],
    [
      "duplicate authorization",
      `let !draft = Request.begin "/users"
let !authorized = Request.authorize (!draft, "Bearer Ada")
return Request.authorize (!authorized, "Bearer Grace")`,
      "BLOT_TYPE_ERROR",
    ],
    [
      "out-of-range retries",
      `let !draft = Request.begin "/users"
return Request.with_retries (!draft, 6)`,
      "BLOT_TYPE_ERROR",
    ],
    [
      "reuse of a consumed stage",
      `let !draft = Request.begin "/users"
let first = Request.with_retries (!draft, 1)
return Request.with_retries (!draft, 2)`,
      "BLOT_LINEAR_CONSUMED_TWICE",
    ],
  ] as const
) {
  test(`staged request builder rejects ${name}`, async () => {
    const compiler = await Compiler.create();
    try {
      await assert.rejects(
        () =>
          compiler.checkSource(
            `examples/staged_request_${name.replaceAll(" ", "_")}.blot`,
            `open import "blot:prelude"
const Request = import "./lib/staged_request.blot"
${body}
`,
          ),
        new RegExp(diagnostic),
      );
    } finally {
      compiler.destroy();
    }
  });
}
