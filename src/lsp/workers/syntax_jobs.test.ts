import { assert, assertEquals } from "@std/assert";
import { executeSyntaxJob, parseFacts, runCpuProbe } from "./syntax_jobs.ts";

Deno.test("the cpu probe is deterministic per seed and iterations", () => {
  const first = runCpuProbe(1000, 7);
  const second = runCpuProbe(1000, 7);
  assertEquals(first, second);
  assertEquals(first.digest.length, 8);
  assertEquals(first.iterations, 1000);
  assertEquals(first.seed, 7);
  const reseeded = runCpuProbe(1000, 8);
  assert(reseeded.digest !== first.digest);
  const relengthed = runCpuProbe(999, 7);
  assert(relengthed.digest !== first.digest);
  const empty = runCpuProbe(0, 0);
  assertEquals(empty.digest.length, 8);
});

Deno.test("parse facts report a good parse", async () => {
  const facts = await parseFacts("u", "return 1\n");
  assertEquals(facts.uri, "u");
  assertEquals(facts.ok, true);
  assertEquals(facts.errors, []);
  assertEquals(facts.sourceLength, 9);
  assert(facts.declarationCount >= 0);
});

Deno.test("parse facts report a broken parse with spans", async () => {
  const facts = await parseFacts("u", "}}}");
  assertEquals(facts.ok, false);
  assert(facts.errors.length > 0);
  for (const error of facts.errors) {
    assert(error.code.length > 0);
    assert(error.message.length > 0);
    assert(error.start >= 0);
    assert(error.end >= error.start);
  }
  assertEquals(facts.declarationCount, 0);
});

Deno.test("syntax jobs reject kinds they do not offer", async () => {
  let failure: unknown = null;
  try {
    await executeSyntaxJob({
      protocol: 1,
      job: 1,
      kind: "service/request",
      method: "textDocument/hover",
      uri: "u",
      params: {},
    });
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof Error);
});
