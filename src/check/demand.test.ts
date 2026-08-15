import { assertEquals } from "@std/assert";
import { checkUncheckedSource } from "./mod.ts";

Deno.test("opened polymorphic fields instantiate independently on demand", async () => {
  const directory = await Deno.makeTempDir();
  const checked = await checkUncheckedSource(
    `${directory}/open-demand.blot`,
    `open { .id = fn x => x; .unused = fn x => x; }
return (id 1, id ())
`,
  );
  assertEquals(checked.type, "(1, ())");
});
