import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  applyContentChanges,
  contentId,
  lineAtOffset,
  offsetAtPosition,
  positionAtOffset,
  rangeOf,
  sourceLineStarts,
  TextDocument,
} from "./document.ts";

Deno.test("line index starts at zero and splits on newlines", () => {
  assertEquals(sourceLineStarts(""), [0]);
  assertEquals(sourceLineStarts("return 1\n"), [0, 9]);
  assertEquals(sourceLineStarts("a\nb\nc"), [0, 2, 4]);
  assertEquals(sourceLineStarts("\n"), [0, 1]);
});

Deno.test("line index treats carriage returns as content", () => {
  assertEquals(sourceLineStarts("a\rb"), [0]);
  assertEquals(sourceLineStarts("a\r\nb\r\n"), [0, 3, 6]);
});

Deno.test("line lookup finds containing lines at boundaries", () => {
  const starts = sourceLineStarts("ab\ncde\n");
  assertEquals(starts, [0, 3, 7]);
  assertEquals(lineAtOffset(starts, 0), 0);
  assertEquals(lineAtOffset(starts, 2), 0);
  assertEquals(lineAtOffset(starts, 3), 1);
  assertEquals(lineAtOffset(starts, 6), 1);
  assertEquals(lineAtOffset(starts, 7), 2);
});

Deno.test("position conversion clamps empty and out-of-range offsets", () => {
  assertEquals(positionAtOffset("", 0), { line: 0, character: 0 });
  assertEquals(positionAtOffset("", 9), { line: 0, character: 0 });
  assertEquals(positionAtOffset("", -4), { line: 0, character: 0 });
  assertEquals(positionAtOffset("ab\n", 3), { line: 1, character: 0 });
  assertEquals(positionAtOffset("ab\n", 99), { line: 1, character: 0 });
  assertEquals(positionAtOffset("ab\n", -1), { line: 0, character: 0 });
});

Deno.test("position conversion reaches end of file", () => {
  const source = "let value = 1\nreturn value\n";
  assertEquals(positionAtOffset(source, source.length), {
    line: 2,
    character: 0,
  });
  assertEquals(positionAtOffset(source, 4), { line: 0, character: 4 });
});

Deno.test("offset conversion clamps lines and columns", () => {
  assertEquals(offsetAtPosition("", { line: 0, character: 0 }), 0);
  assertEquals(offsetAtPosition("", { line: 5, character: 10 }), 0);
  assertEquals(offsetAtPosition("ab\ncde\n", { line: 0, character: 1 }), 1);
  assertEquals(offsetAtPosition("ab\ncde\n", { line: 0, character: 99 }), 2);
  assertEquals(offsetAtPosition("ab\ncde\n", { line: 9, character: 99 }), 7);
  assertEquals(offsetAtPosition("ab\ncde\n", { line: -2, character: -3 }), 0);
});

Deno.test("range conversion round-trips through offsets", () => {
  const source = "let value = 1\nreturn value\n";
  const start = source.indexOf("value");
  const span = { start, end: start + 5 };
  const range = rangeOf(source, span);
  assertEquals(range, {
    start: { line: 0, character: 4 },
    end: { line: 0, character: 9 },
  });
  assertEquals(offsetAtPosition(source, range.start), span.start);
  assertEquals(offsetAtPosition(source, range.end), span.end);
});

Deno.test("columns count UTF-16 code units, not code points", () => {
  const source = "a😀b\n";
  assertEquals(source.length, 5);
  assertEquals([...source].length, 4);
  assertEquals(positionAtOffset(source, 3), { line: 0, character: 3 });
  assertEquals(offsetAtPosition(source, { line: 0, character: 3 }), 3);
  assertEquals(source.slice(3, 4), "b");
  assertEquals(offsetAtPosition(source, { line: 0, character: 1 }), 1);
  assertEquals(offsetAtPosition(source, { line: 0, character: 4 }), 4);
});

Deno.test("mid-surrogate columns keep raw arithmetic without snapping", () => {
  const source = "a😀b\n";
  assertEquals(offsetAtPosition(source, { line: 0, character: 2 }), 2);
  assertEquals(positionAtOffset(source, 2), { line: 0, character: 2 });
  assertEquals(positionAtOffset(source, 1), { line: 0, character: 1 });
  assertEquals(
    offsetAtPosition(source, positionAtOffset(source, 2)),
    2,
  );
});

Deno.test("carriage returns count as characters on CRLF boundaries", () => {
  const source = "a\r\nb\r\n";
  assertEquals(positionAtOffset(source, 2), { line: 0, character: 2 });
  assertEquals(positionAtOffset(source, 3), { line: 1, character: 0 });
  assertEquals(offsetAtPosition(source, { line: 0, character: 5 }), 2);
  assertEquals(offsetAtPosition(source, { line: 1, character: 0 }), 3);
  assertEquals(offsetAtPosition(source, { line: 1, character: 1 }), 4);
});

Deno.test("content changes apply ordered ranges to the updated source", () => {
  const updated = applyContentChanges("return 10\n", [
    {
      range: {
        start: { line: 0, character: 8 },
        end: { line: 0, character: 9 },
      },
      rangeLength: 1,
      text: "2",
    },
    {
      range: {
        start: { line: 0, character: 7 },
        end: { line: 0, character: 8 },
      },
      rangeLength: 1,
      text: "4",
    },
  ], "untitled:ordered.blot");
  assertEquals(updated, "return 42\n");
});

Deno.test("later ranges observe earlier insertions", () => {
  const updated = applyContentChanges("ac\n", [{
    range: {
      start: { line: 0, character: 1 },
      end: { line: 0, character: 1 },
    },
    text: "b",
  }, {
    range: {
      start: { line: 0, character: 3 },
      end: { line: 0, character: 3 },
    },
    text: "d",
  }], "untitled:observe.blot");
  assertEquals(updated, "abcd\n");
});

Deno.test("content changes support full replacement and empty edits", () => {
  assertEquals(
    applyContentChanges("old\n", [{ text: "new\n" }], "untitled:full.blot"),
    "new\n",
  );
  assertEquals(
    applyContentChanges("same\n", [], "untitled:empty.blot"),
    "same\n",
  );
  assertEquals(
    applyContentChanges("", [{
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      text: "first\n",
    }], "untitled:insert.blot"),
    "first\n",
  );
});

Deno.test("full replacement resets later ranges in the same batch", () => {
  const updated = applyContentChanges("old\n", [
    { text: "ab\n" },
    {
      range: {
        start: { line: 0, character: 1 },
        end: { line: 0, character: 2 },
      },
      text: "c",
    },
  ], "untitled:reset.blot");
  assertEquals(updated, "ac\n");
});

Deno.test("content changes reject reversed ranges and bad lengths", () => {
  let reversed = false;
  try {
    applyContentChanges("ab\n", [{
      range: {
        start: { line: 0, character: 2 },
        end: { line: 0, character: 1 },
      },
      text: "x",
    }], "untitled:reversed.blot");
  } catch (error) {
    reversed = error instanceof Error &&
      error.message ===
        "document untitled:reversed.blot change range ends before it starts";
  }
  assert(reversed);
  let lengthMismatch = false;
  try {
    applyContentChanges("ab\n", [{
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      rangeLength: 9,
      text: "x",
    }], "untitled:length.blot");
  } catch (error) {
    lengthMismatch = error instanceof Error &&
      error.message ===
        "document untitled:length.blot change range length 9 does not match 1";
  }
  assert(lengthMismatch);
});

Deno.test("content changes span CRLF and surrogate boundaries", () => {
  const crlf = applyContentChanges("a\r\nb\r\n", [{
    range: {
      start: { line: 0, character: 0 },
      end: { line: 1, character: 1 },
    },
    rangeLength: 4,
    text: "c",
  }], "untitled:crlf.blot");
  assertEquals(crlf, "c\r\n");
  const emoji = applyContentChanges("a😀b\n", [{
    range: {
      start: { line: 0, character: 1 },
      end: { line: 0, character: 3 },
    },
    rangeLength: 2,
    text: "zz",
  }], "untitled:emoji.blot");
  assertEquals(emoji, "azzb\n");
});

Deno.test("content identity is stable and length-prefixed", () => {
  assertEquals(contentId("return 1\n"), contentId("return 1\n"));
  assertNotEquals(contentId("return 1\n"), contentId("return 2\n"));
  assert(contentId("ab").startsWith("2:"));
  assert(contentId("").startsWith("0:"));
});

Deno.test("text documents are immutable and share helpers", () => {
  const document = new TextDocument("a😀b\n");
  assert(Object.isFrozen(document));
  assertEquals(document.positionAt(3), positionAtOffset("a😀b\n", 3));
  assertEquals(
    document.offsetAt({ line: 0, character: 3 }),
    offsetAtPosition("a😀b\n", { line: 0, character: 3 }),
  );
  assertEquals(
    document.rangeOf({ start: 0, end: 1 }),
    rangeOf("a😀b\n", { start: 0, end: 1 }),
  );
  const next = document.applyChanges(
    [{ text: "changed\n" }],
    "untitled:frozen.blot",
  );
  assertEquals(document.source, "a😀b\n");
  assertEquals(next.source, "changed\n");
  assert(Object.isFrozen(next));
});
