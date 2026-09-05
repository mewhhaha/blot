import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler } from "../../src/compiler.ts";
import { checkCompletion, expressionHoles } from "./completions.ts";

async function withCompiler(
  run: (compiler: Compiler, path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "blot-completions-"));
  const compiler = await Compiler.create();
  try {
    await run(compiler, join(directory, "main.blot"));
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
}

test("holes are discovered from Baba syntax, not comments or text", async () => {
  const source = `// @hole "comment"
let text = "@hole"
return @hole "result"
`;
  const holes = await expressionHoles(source);
  assert.equal(holes.length, 1);
  assert.equal(holes[0].name, "result");
  assert.equal(
    source.slice(holes[0].span.start, holes[0].span.end),
    '@hole "result"',
  );
});

test("duplicate, missing, unknown, and newly introduced holes fail closed", async () => {
  await assert.rejects(
    () => expressionHoles('return (@hole "x", @hole "x")\n'),
    /Duplicate/,
  );
  await withCompiler(async (compiler, path) => {
    const source = 'return (@hole "left", @hole "right")\n';
    await assert.rejects(
      () => checkCompletion(compiler, path, source, new Map([["left", "1"]])),
      /Unresolved/,
    );
    await assert.rejects(
      () => checkCompletion(compiler, path, source, new Map([["other", "1"]])),
      /Unknown/,
    );
    await assert.rejects(
      () =>
        checkCompletion(
          compiler,
          path,
          'return @hole "x"\n',
          new Map([["x", '@hole "new"']]),
        ),
      /introduced another unresolved/,
    );
  });
});

test("candidate validation cannot comment out or escape the surrounding expression", async () => {
  await withCompiler(async (compiler, path) => {
    for (const candidate of ["1) //", "1) + (2", "1\nreturn 2"]) {
      await assert.rejects(
        () =>
          checkCompletion(
            compiler,
            path,
            'return @hole "x" + 2\n',
            new Map([["x", candidate]]),
          ),
        SyntaxError,
      );
    }
  });
});

test("whole-program checking preserves the required result type", async () => {
  await withCompiler(async (compiler, path) => {
    const source =
      'open import "blot:prelude"\nlet value :: Int\nlet value = @hole "value"\nreturn value\n';
    const accepted = await checkCompletion(
      compiler,
      path,
      source,
      new Map([["value", "42"]]),
    );
    assert.equal(accepted.checked.type, "Int");
    await assert.rejects(
      () =>
        checkCompletion(
          compiler,
          path,
          source,
          new Map([["value", '"wrong"']]),
        ),
      /BLOT_TYPE_ERROR/,
    );
  });
});

test("completion cannot discard a required linear resource", async () => {
  await withCompiler(async (compiler, path) => {
    const source =
      'open import "blot:prelude"\nlet use_token = fn !token => @hole "body"\nreturn use_token\n';
    await assert.rejects(
      () => checkCompletion(compiler, path, source, new Map([["body", "0"]])),
      /BLOT_LINEAR/,
    );
    await checkCompletion(
      compiler,
      path,
      source,
      new Map([["body", "token + 1"]]),
    );
  });
});

test("completion cannot introduce an unavailable effect", async () => {
  await withCompiler(async (compiler, path) => {
    const source =
      'open import "blot:prelude"\nconst Clock = @effect { .read = Unit -> Int; }\nlet answer = @hole "answer"\nreturn answer\n';
    await assert.rejects(
      () =>
        checkCompletion(
          compiler,
          path,
          source,
          new Map([["answer", "Clock.read ()"]]),
        ),
      /BLOT_(UNSEQUENCED_EFFECT|UNHANDLED_EFFECT)/,
    );
  });
});

test("completion cannot supply a runtime value as a compile-time requirement", async () => {
  await withCompiler(async (compiler, path) => {
    const source =
      'open import "blot:prelude"\nlet require = fn requirement => fn value => @satisfies value (@hole "requirement")\nreturn require Int 42\n';
    await assert.rejects(
      () =>
        checkCompletion(
          compiler,
          path,
          source,
          new Map([["requirement", "requirement"]]),
        ),
      /BLOT_REQUIREMENT_NOT_COMPTIME/,
    );
  });
});

test("production checking still rejects an unresolved expression marker", async () => {
  await withCompiler(async (compiler, path) => {
    await assert.rejects(
      () => compiler.checkSource(path, 'return @hole "x"\n'),
      /BLOT_UNKNOWN/,
    );
  });
});
