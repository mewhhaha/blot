import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { instantiateArtifact } from "../host.ts";
import { runArtifact } from "./run.ts";

const prelude = 'open import "blot:prelude"\n';

test("imported stream builders execute dynamic inputs and survive provider revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-handler-values-"));
  const compiler = await Compiler.create();
  try {
    for (
      const name of [
        "effect_stream_support.blot",
        "effect_stream_combinators.blot",
      ]
    ) {
      await writeFile(
        join(directory, name),
        await readFile(
          new URL(`../../experiments/next-feature/${name}`, import.meta.url),
          "utf8",
        ),
      );
    }
    const path = join(directory, "effect_stream_combinators.blot");
    const evaluation = join(directory, "observe.blot");
    for (const bias of [0, 10]) {
      const support = join(directory, "effect_stream_support.blot");
      if (bias !== 0) {
        const source = await readFile(support, "utf8");
        await writeFile(
          support,
          prelude +
            source.replace(
              "combine (value, rest)",
              "combine (value + 10, rest)",
            ),
        );
      }
      const guest = await instantiateArtifact(await compiler.compile(path));
      try {
        for (const seed of [0, 3, 17]) {
          const expected = BigInt(6 * seed + 12 + 3 * bias);
          assert.equal(await guest.callAsync("run", [BigInt(seed)]), expected);
          await writeFile(
            evaluation,
            `const stream = import "./effect_stream_combinators.blot"\nreturn stream.run ${seed}\n`,
          );
          assert.equal(
            (await compiler.evaluate(evaluation)).display,
            String(expected),
          );
          assert.equal(
            await runArtifact(await compiler.compile(evaluation)),
            String(expected),
          );
        }
        const repeated = await compiler.compile(path);
        assert.equal(repeated.artifactSource, "revision-cache");
      } finally {
        await guest.close();
      }
    }
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

test("imported linear clauses resume or cancel and affine clauses cannot abandon linear work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-handler-linear-"));
  const compiler = await Compiler.create();
  try {
    await writeFile(
      join(directory, "builders.blot"),
      prelude +
        `const resuming = fn () => { .ask = fn (_, !resume) => resume (); }
const cancelling = fn result => { .ask = fn (_, !resume) => do:
  use Continuation.cancel resume
  return result
; }
const aborting = fn result => { .ask = fn (_, ?resume) => result; }
return { .resuming = resuming; .cancelling = cancelling; .aborting = aborting; }
`,
    );
    await writeFile(
      join(directory, "alias.blot"),
      'return import "./builders.blot"\n',
    );
    const path = join(directory, "main.blot");
    for (
      const [handler, expected] of [["Builders.resuming ()", "42"], [
        "Builders.cancelling 7",
        "7",
      ], ["Builders.aborting 0", "BLOT_LINEAR_HANDLER_MAY_ABORT"]]
    ) {
      const source = prelude + `const Builders = import "./alias.blot"
const Ask = @effect { .ask = Unit -> Unit; }
let consume = fn !value => value + 1
let !token = 41
let work = fn () => do:
  use Ask.ask ()
  return consume (!token)
return @handle (Ask, work, ${handler})
`;
      await writeFile(path, source);
      if (expected.startsWith("BLOT_")) {
        await assert.rejects(() => compiler.check(path), new RegExp(expected));
      } else {
        assert.equal((await compiler.evaluate(path)).display, expected);
        assert.equal(await runArtifact(await compiler.compile(path)), expected);
      }
    }
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

test("imported clauses retain operation ownership checks and continuation use restrictions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-handler-invalid-"));
  const compiler = await Compiler.create();
  try {
    const path = join(directory, "main.blot");
    const provider = join(directory, "handler.blot");
    await writeFile(
      provider,
      prelude + `const consume = fn !value => value + 1
return { .release = fn (resource, ?resume) => resume (consume resource); }
`,
    );
    await writeFile(
      path,
      prelude +
        `const Resource = @effect { .release = Effect.consumes (Int -> Int); }
const handler = import "./handler.blot"
let work = fn () => do:
  let !resource = 41
  use result <- Resource.release (!resource)
  return result
return @handle (Resource, work, handler)
`,
    );
    await assert.rejects(
      () => compiler.check(path),
      /BLOT_EFFECT_HANDLER_OWNERSHIP/,
    );
    await writeFile(
      provider,
      prelude + `const consume = fn !value => value + 1
return { .release = fn (!resource, ?resume) => do:
  let number = consume (!resource)
  use first <- resume number
  use second <- resume number
  return first + second
; }
`,
    );
    await assert.rejects(
      () => compiler.check(path),
      /BLOT_LINEAR_CONSUMED_TWICE/,
    );
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});
