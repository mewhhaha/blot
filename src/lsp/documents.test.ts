import { assert, assertEquals, assertThrows } from "@std/assert";
import type { ContentChange } from "../text/document.ts";
import { CoordinatorDocuments, sameDocumentRevision } from "./documents.ts";

Deno.test("coordinator documents track lifecycles across open generations", () => {
  const documents = new CoordinatorDocuments();
  const first = documents.open("u", "return 1\n", 1);
  assertEquals(first.uri, "u");
  assertEquals(first.version, 1);
  assertEquals(first.document.source, "return 1\n");
  assertEquals(documents.isOpen("u"), true);
  assertEquals(documents.isOpen("missing"), false);
  const changed = documents.change("u", [{ text: "return 2\n" }], 2);
  assertEquals(changed.version, 2);
  assertEquals(changed.lifecycle, first.lifecycle);
  assertEquals(changed.document.source, "return 2\n");
  assertThrows(
    () => documents.change("missing", [{ text: "x\n" }], 2),
    Error,
    "document missing is not open",
  );
  documents.close("u");
  assertEquals(documents.isOpen("u"), false);
  assertEquals(documents.current("u"), null);
  assertThrows(
    () => documents.change("u", [{ text: "x\n" }], 3),
    Error,
    "document u is not open",
  );
  const reopened = documents.open("u", "return 1\n", 1);
  assertEquals(reopened.version, 1);
  assert(sameDocumentRevision(reopened, reopened));
  assert(!sameDocumentRevision(first, reopened));
});

Deno.test("freshness compares lifecycle and revision of open documents", () => {
  const documents = new CoordinatorDocuments();
  const entry = documents.open("u", "return 1\n", 1);
  assertEquals(documents.isFresh(entry), true);
  documents.change("u", [{ text: "return 2\n" }], 2);
  assertEquals(documents.isFresh(entry), false);
  const second = documents.open("v", "return 7\n", 7);
  documents.close("v");
  assertEquals(documents.isFresh(second), false);
  documents.open("v", "return 7\n", 7);
  assertEquals(documents.isFresh(second), false);
  assertEquals(documents.isFresh(entry), false);
});

Deno.test("changes apply ranges through the shared text layer", () => {
  const documents = new CoordinatorDocuments();
  documents.open("u", "hello world\n", 1);
  const ranged: readonly ContentChange[] = [{
    range: {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 11 },
    },
    text: "mirror",
  }];
  const changed = documents.change("u", ranged, 2);
  assertEquals(changed.document.source, "hello mirror\n");
});

Deno.test("snapshots list every open document for resync", () => {
  const documents = new CoordinatorDocuments();
  assertEquals(documents.snapshots(), []);
  documents.open("a", "return 1\n", 1);
  documents.open("b", "return 2\n", 1);
  documents.close("a");
  const snapshots = documents.snapshots();
  assertEquals(snapshots.length, 1);
  assertEquals(snapshots[0]?.uri, "b");
  assertEquals(snapshots[0]?.document.source, "return 2\n");
});
