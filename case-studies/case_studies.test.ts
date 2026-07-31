import { assertEquals } from "@std/assert";
import { validateLowering } from "../src/backend/compile.ts";
import { checkFile } from "../src/check/mod.ts";
import { evaluateFile } from "../src/run.ts";
import { show } from "../src/comptime/value.ts";

for (
  const source of [
    "case-studies/grep/main.blot",
    "case-studies/terminal/main.blot",
    "case-studies/agent/main.blot",
    "case-studies/engine/main.blot",
  ]
) {
  Deno.test(`${source} type checks and lowers`, async () => {
    await checkFile(source);
    await validateLowering(source);
  });
}

Deno.test("Text.contains searches Unicode text", async () => {
  const directory = await Deno.makeTempDir();
  const source = `${directory}/contains.blot`;
  await Deno.writeTextFile(
    source,
    [
      'open {} = (@import "blot:prelude") ();',
      'return Text.contains "GPU 😀 frontend" "😀 front";',
    ].join("\n"),
  );
  const value = await evaluateFile(source, { write: () => {} });
  assertEquals(show(value), "#True");
});
