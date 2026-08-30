import {
  assertEquals,
  assertGreaterOrEqual,
  assertNotEquals,
} from "@std/assert";
import { join } from "@std/path";
import { writeDevelopmentBenchmarkWorkload } from "./workload.ts";

Deno.test("development workload uses Blot declarations for its measured source volume", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const workload = await writeDevelopmentBenchmarkWorkload({
      directory,
      targetSourceBytes: 64 * 1024,
      unitCount: 4,
    });
    assertGreaterOrEqual(workload.sourceBytes, 64 * 1024);
    assertEquals(workload.editedProviderBytes < 1024, true);
    assertEquals(workload.unitCount, 4);
    assertGreaterOrEqual(workload.voxelDeclarations, 1);

    let declarations = 0;
    for await (const entry of Deno.readDir(directory)) {
      if (!entry.isFile || !entry.name.endsWith(".blot")) continue;
      const source = await Deno.readTextFile(join(directory, entry.name));
      declarations += [...source.matchAll(/\.name = "shrubbery_/g)].length;
      assertEquals(source.includes(`// ${"x".repeat(128)}`), false);
    }
    assertEquals(declarations, workload.voxelDeclarations);
    assertEquals(
      (await Deno.readTextFile(workload.editedProviderPath)).includes(
        '.name = "shrubbery_',
      ),
      false,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("development workload edits one provider without changing its interface", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const workload = await writeDevelopmentBenchmarkWorkload({
      directory,
      targetSourceBytes: 16 * 1024,
      unitCount: 3,
    });
    const first = workload.editedProviderSource(101);
    const second = workload.editedProviderSource(102);
    assertNotEquals(first, second);
    assertEquals(
      first.replace("value + 101", "value + 102"),
      second,
    );
    assertEquals(workload.expectedObservation(102), 224n);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
