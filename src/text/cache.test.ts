import { assertEquals } from "@std/assert";
import {
  analysisCacheKey,
  ContentCache,
  SYNTAX_FRONTEND_ID,
  syntaxCacheKey,
} from "./cache.ts";

Deno.test("cache misses until a matching source is stored", () => {
  const cache = new ContentCache<string>(4);
  assertEquals(cache.size, 0);
  assertEquals(
    cache.get(analysisCacheKey("return 1\n"), "return 1\n"),
    undefined,
  );
  cache.set(analysisCacheKey("return 1\n"), "return 1\n", 1, "one");
  assertEquals(cache.size, 1);
  assertEquals(
    cache.get(analysisCacheKey("return 1\n"), "return 1\n"),
    "one",
  );
  assertEquals(
    cache.get(analysisCacheKey("return 2\n"), "return 2\n"),
    undefined,
  );
});

Deno.test("syntax keys separate frontends sharing one content", () => {
  const cache = new ContentCache<string>(4);
  const source = "return 1\n";
  cache.set(syntaxCacheKey(source, SYNTAX_FRONTEND_ID), source, 1, "parsed");
  assertEquals(
    cache.get(syntaxCacheKey(source, SYNTAX_FRONTEND_ID), source),
    "parsed",
  );
  assertEquals(
    cache.get(syntaxCacheKey(source, "other-frontend/9"), source),
    undefined,
  );
});

Deno.test("stale revisions never overwrite newer cache slots", () => {
  const cache = new ContentCache<string>(4);
  const source = "return 1\n";
  const key = analysisCacheKey(source);
  cache.set(key, source, 5, "newer");
  cache.set(key, source, 3, "stale");
  assertEquals(cache.get(key, source), "newer");
  cache.set(key, source, 5, "same");
  assertEquals(cache.get(key, source), "same");
  cache.set(key, source, 7, "newest");
  assertEquals(cache.get(key, source), "newest");
});

Deno.test("out-of-order dispatches keep the newest pending result", async () => {
  const cache = new ContentCache<Promise<string>>(4);
  const source = "return 1\n";
  const key = analysisCacheKey(source);
  const arm: { release: ((value: string) => void) | null } = {
    release: null,
  };
  const old = new Promise<string>((resolve) => {
    arm.release = resolve;
  });
  cache.set(key, source, 5, old);
  cache.set(key, source, 6, Promise.resolve("new"));
  if (arm.release === null) throw new Error("old dispatch never armed");
  arm.release("old");
  assertEquals(await old, "old");
  const cached = cache.get(key, source);
  if (cached === undefined) throw new Error("cache lost the newest slot");
  assertEquals(await cached, "new");
});

Deno.test("cache evicts the least recently used entry past capacity", () => {
  const cache = new ContentCache<string>(2);
  cache.set(analysisCacheKey("a\n"), "a\n", 1, "a");
  cache.set(analysisCacheKey("b\n"), "b\n", 2, "b");
  assertEquals(cache.get(analysisCacheKey("a\n"), "a\n"), "a");
  cache.set(analysisCacheKey("c\n"), "c\n", 3, "c");
  assertEquals(cache.size, 2);
  assertEquals(cache.get(analysisCacheKey("a\n"), "a\n"), "a");
  assertEquals(cache.get(analysisCacheKey("b\n"), "b\n"), undefined);
  assertEquals(cache.get(analysisCacheKey("c\n"), "c\n"), "c");
});

Deno.test("cache clear empties every slot", () => {
  const cache = new ContentCache<string>(2);
  cache.set(analysisCacheKey("a\n"), "a\n", 1, "a");
  cache.clear();
  assertEquals(cache.size, 0);
  assertEquals(cache.get(analysisCacheKey("a\n"), "a\n"), undefined);
});

Deno.test("cache rejects non-positive capacities", () => {
  for (const capacity of [0, -2]) {
    let message = "";
    try {
      new ContentCache<string>(capacity);
    } catch (error) {
      if (error instanceof Error) message = error.message;
    }
    assertEquals(
      message,
      `content cache capacity must be a positive integer, got ${capacity}`,
    );
  }
});
