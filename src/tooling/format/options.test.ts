import { assertEquals, assertThrows } from "@std/assert";
import {
  HOUSE_INDENT_WIDTH,
  HOUSE_WIDTH,
  resolveFormattingOptions,
  resolveStyle,
} from "./options.ts";

Deno.test("formatting options accept the LSP shape editors send", () => {
  assertEquals(
    resolveFormattingOptions({ tabSize: 4, insertSpaces: false }),
    { tabSize: 4, insertSpaces: false },
  );
  assertEquals(
    resolveFormattingOptions({
      tabSize: 2,
      insertSpaces: true,
      trimTrailingWhitespace: true,
      insertFinalNewline: true,
      trimFinalNewlines: false,
    }),
    {
      tabSize: 2,
      insertSpaces: true,
      trimTrailingWhitespace: true,
      insertFinalNewline: true,
      trimFinalNewlines: false,
    },
  );
});

Deno.test("formatting options accept LSP custom keys with scalar values", () => {
  assertEquals(
    resolveFormattingOptions({ "blot.columnGuide": 100, "blot.strict": true }),
    { "blot.columnGuide": 100, "blot.strict": true },
  );
  assertThrows(
    () => resolveFormattingOptions({ "blot.nested": { width: 80 } }),
    TypeError,
    "must be a boolean, integer, or string",
  );
  assertThrows(
    () => resolveFormattingOptions({ "blot.list": [80] }),
    TypeError,
    "must be a boolean, integer, or string",
  );
});

Deno.test("formatting options accept the internal shape", () => {
  assertEquals(
    resolveFormattingOptions({ indentWidth: 2, useTabs: false }),
    { indentWidth: 2, useTabs: false },
  );
  assertEquals(resolveFormattingOptions({ endOfLine: "crlf" }), {
    endOfLine: "crlf",
  });
});

Deno.test("formatting options reject mistyped values loudly", () => {
  assertThrows(
    () => resolveFormattingOptions({ tabSize: "two" }),
    TypeError,
    "tabSize",
  );
  assertThrows(
    () => resolveFormattingOptions({ tabSize: -1 }),
    TypeError,
    "tabSize",
  );
  assertThrows(
    () => resolveFormattingOptions({ insertSpaces: "yes" }),
    TypeError,
    "insertSpaces",
  );
  assertThrows(
    () => resolveFormattingOptions({ indentWidth: 2.5 }),
    TypeError,
    "indentWidth",
  );
  assertThrows(
    () => resolveFormattingOptions({ endOfLine: "cr" }),
    TypeError,
    "endOfLine",
  );
  assertThrows(
    () => resolveFormattingOptions([2]),
    TypeError,
    "must be an object",
  );
  assertThrows(
    () => resolveFormattingOptions(4),
    TypeError,
    "must be an object",
  );
});

Deno.test("formatting options default empty and resolve fixed style", () => {
  assertEquals(resolveFormattingOptions(undefined), {});
  assertEquals(resolveFormattingOptions(null), {});
  assertEquals(
    resolveStyle({ tabSize: 8, insertSpaces: false }),
    { width: HOUSE_WIDTH, indentWidth: HOUSE_INDENT_WIDTH },
  );
  assertEquals(HOUSE_WIDTH, 80);
  assertEquals(HOUSE_INDENT_WIDTH, 2);
});
