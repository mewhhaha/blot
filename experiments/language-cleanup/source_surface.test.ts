import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { evaluateFile } from "../../src/run.ts";

const elementFree = fromFileUrl(
  new URL("./element-free.blot", import.meta.url),
);

Deno.test("element-free component spelling preserves the element example", async () => {
  const result = await evaluateFile(elementFree, { write() {} });
  assertEquals(result, {
    tag: "text",
    value:
      "<div>Count: <button>Save</button><button disabled data-order=2>Delete</button><icon></icon></div>",
  });
});
