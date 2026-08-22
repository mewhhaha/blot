import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { BlotError } from "./diagnostic.ts";
import { testFile } from "./test.ts";

const scratch = await Deno.makeTempDir();
const PRELUDE = `open import "blot:prelude"
`;

async function sourceFile(source: string): Promise<string> {
  const path = `${scratch}/${crypto.randomUUID()}.blot`;
  await Deno.writeTextFile(path, PRELUDE + source);
  return path;
}

Deno.test("test discovery uses resolved descriptor names through aliases", async () => {
  const path = await sourceFile(
    `const alias = tag ("test", "fast", identity)
@[alias] let discovered = fn () => ()
return ()
`,
  );
  assertEquals((await testFile(path)).map((test) => test.status), ["passed"]);
});

Deno.test("a failed test does not stop the tests after it", async () => {
  const path = await sourceFile(
    `@[test] let before = fn () => ()
@[test] let failure = fn () => @fail "expected failure"
@[test] let after = fn () => ()
return ()
`,
  );
  const outcomes = await testFile(path);
  assertEquals(outcomes.map((test) => test.status), [
    "passed",
    "failed",
    "passed",
  ]);
});

Deno.test("each test resolves the binding occurrence carrying its tag", async () => {
  const path = await sourceFile(
    `@[test] let same = fn () => ()
@[tag ("plain", (), identity)] let same = fn () => @fail "wrong shadow"
return ()
`,
  );
  const outcomes = await testFile(path);
  assertEquals(outcomes.map((test) => test.status), ["passed"]);
});

Deno.test("a test must be a pure nullary unit function", async () => {
  const path = await sourceFile(
    `@[test] let wrong = fn () => 1
return ()
`,
  );
  const error = await assertRejects(() => testFile(path), BlotError);
  assertStringIncludes(error.message, "must have type `() -> ()`");
});

Deno.test("a nested test is rejected instead of silently undiscovered", async () => {
  const path = await sourceFile(
    `let outer = fn () => do:
  @[test] let hidden = fn () => ()
return outer
`,
  );
  const error = await assertRejects(() => testFile(path), BlotError);
  assertStringIncludes(error.message, "top-level named binding");
});

Deno.test("a test file cannot require a module argument", async () => {
  const path = `${scratch}/${crypto.randomUUID()}.blot`;
  await Deno.writeTextFile(
    path,
    "module with init\n" + PRELUDE +
      `@[test] let needs_host = fn () => ()
return ()
`,
  );
  const error = await assertRejects(() => testFile(path), BlotError);
  assertStringIncludes(error.message, "cannot declare a module input");
});

Deno.test("a test file cannot perform ambient initialization effects", async () => {
  const path = await sourceFile(
    `const Console = @effect.host { .write = Str -> Unit; }
@[test] let isolated = fn () => ()
_ <- Console.write "initializing"
return ()
`,
  );
  const error = await assertRejects(() => testFile(path), BlotError);
  assertStringIncludes(error.message, "must initialize without effects");
});

Deno.test("a file without test descriptors returns an empty suite", async () => {
  const path = await sourceFile(`let value = 1
return value
`);
  assertEquals(await testFile(path), []);
});
