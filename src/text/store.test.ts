import { assert, assertEquals } from "@std/assert";
import { DocumentStore, sameDocumentRevision } from "./store.ts";

Deno.test("store opens immutable snapshots with version and revision", () => {
  const store = new DocumentStore();
  const snapshot = store.open("untitled:open.blot", "return 1\n", 1);
  assertEquals(snapshot.uri, "untitled:open.blot");
  assertEquals(snapshot.version, 1);
  assertEquals(snapshot.document.source, "return 1\n");
  assert(Object.isFrozen(snapshot));
  assertEquals(store.version("untitled:open.blot"), 1);
  assertEquals(store.snapshot("untitled:open.blot"), snapshot);
});

Deno.test("store changes replace content and enforce version order", () => {
  const store = new DocumentStore();
  const first = store.open("untitled:change.blot", "return 1\n", 1);
  const second = store.change("untitled:change.blot", "return 2\n", 2);
  assertEquals(second.document.source, "return 2\n");
  assertEquals(second.lifecycle, first.lifecycle);
  assert(second.revision > first.revision);
  assertEquals(first.document.source, "return 1\n");
  for (const version of [2, 1]) {
    let thrown = "";
    try {
      store.change("untitled:change.blot", "return 3\n", version);
    } catch (error) {
      if (error instanceof Error) thrown = error.message;
    }
    assertEquals(
      thrown,
      `document untitled:change.blot version ${version} does not follow 2`,
    );
  }
});

Deno.test("store applies ordered range changes progressively", () => {
  const store = new DocumentStore();
  store.open("untitled:ranges.blot", "return 10\n", 1);
  const snapshot = store.changeRanges("untitled:ranges.blot", [{
    range: {
      start: { line: 0, character: 8 },
      end: { line: 0, character: 9 },
    },
    rangeLength: 1,
    text: "2",
  }, {
    range: {
      start: { line: 0, character: 7 },
      end: { line: 0, character: 8 },
    },
    rangeLength: 1,
    text: "4",
  }], 2);
  assertEquals(snapshot.document.source, "return 42\n");
  assertEquals(snapshot.version, 2);
});

Deno.test("store rejects edits to documents that are not open", () => {
  const store = new DocumentStore();
  assertEquals(store.snapshot("untitled:missing.blot"), null);
  assertEquals(store.version("untitled:missing.blot"), null);
  let changeMessage = "";
  try {
    store.change("untitled:missing.blot", "return 1\n", 1);
  } catch (error) {
    if (error instanceof Error) changeMessage = error.message;
  }
  assertEquals(changeMessage, "document untitled:missing.blot is not open");
  let rangesMessage = "";
  try {
    store.changeRanges("untitled:missing.blot", [{ text: "x\n" }], 1);
  } catch (error) {
    if (error instanceof Error) rangesMessage = error.message;
  }
  assertEquals(rangesMessage, "document untitled:missing.blot is not open");
});

Deno.test("close and reopen mints a new lifecycle for reused versions", () => {
  const store = new DocumentStore();
  const before = store.open("untitled:reopen.blot", "return 1\n", 1);
  store.close("untitled:reopen.blot");
  assertEquals(store.snapshot("untitled:reopen.blot"), null);
  const after = store.open("untitled:reopen.blot", "return 2\n", 1);
  assertEquals(after.version, 1);
  assert(after.lifecycle !== before.lifecycle);
  assert(after.revision > before.revision);
  assert(!sameDocumentRevision(before, after));
});

Deno.test("revision increases monotonically across documents", () => {
  const store = new DocumentStore();
  const first = store.open("untitled:first.blot", "return 1\n", 1);
  const second = store.open("untitled:second.blot", "return 1\n", 1);
  const third = store.change("untitled:first.blot", "return 2\n", 2);
  assert(second.revision > first.revision);
  assert(third.revision > second.revision);
  assertEquals(store.snapshots().length, 2);
});

Deno.test("opening twice without close starts a new lifecycle", () => {
  const store = new DocumentStore();
  const first = store.open("untitled:double.blot", "return 1\n", 1);
  const second = store.open("untitled:double.blot", "return 1\n", 1);
  assert(second.lifecycle !== first.lifecycle);
  assert(!sameDocumentRevision(first, second));
});

Deno.test("snapshot identity requires uri, lifecycle, and revision", () => {
  const store = new DocumentStore();
  const first = store.open("untitled:identity.blot", "return 1\n", 1);
  assert(sameDocumentRevision(first, first));
  const current = store.snapshot("untitled:identity.blot");
  assert(current !== null);
  assert(sameDocumentRevision(first, current));
  const edited = store.change("untitled:identity.blot", "return 2\n", 2);
  assert(!sameDocumentRevision(first, edited));
  const other = store.open("untitled:other.blot", "return 2\n", 2);
  assert(!sameDocumentRevision(edited, other));
});

Deno.test("clear drops every open document", () => {
  const store = new DocumentStore();
  store.open("untitled:clear.blot", "return 1\n", 1);
  store.clear();
  assertEquals(store.snapshot("untitled:clear.blot"), null);
  assertEquals(store.snapshots(), []);
});
