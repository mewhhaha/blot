import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { LanguageService } from "./language_service.ts";

Deno.test("language diagnostics check the open editor revision", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "revision.blot");
  await Deno.writeTextFile(path, "return 1;");
  const uri = toFileUrl(path).href;
  const service = new LanguageService();
  try {
    service.open(uri, "return missing;", 1);
    const diagnostics = await service.diagnostics(uri);
    assert(
      diagnostics.some((diagnostic) => diagnostic.code === "BLOT_UNBOUND"),
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("language formatting returns one whole-document edit", async () => {
  const service = new LanguageService();
  const uri = "untitled:format.blot";
  try {
    service.open(uri, "return 1;", 1);
    const edits = await service.formatting(uri);
    assertEquals(edits.length, 1);
    assertEquals(edits[0]?.newText, "return 1;\n");
  } finally {
    await service.destroy();
  }
});
