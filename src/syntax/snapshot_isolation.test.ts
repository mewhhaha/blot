// Dependency audit: the source-only snapshot facade plus the formatter must
// never reach the semantic compiler or the workspace graph, so formatting
// keeps working while the compiler artifact is absent.
//
// Run with: deno test --allow-read --allow-run src/syntax/snapshot_isolation.test.ts

import { assert } from "@std/assert";
import { dirname, fromFileUrl } from "@std/path";

interface InfoModule {
  readonly specifier: string;
}

interface InfoGraph {
  readonly modules: readonly InfoModule[];
}

Deno.test("snapshot facade and formatter avoid compiler and graph code", async () => {
  const root = dirname(dirname(dirname(fromFileUrl(import.meta.url))));
  const specifiers: string[] = [];
  for (
    const entry of ["src/syntax/snapshot.ts", "src/tooling/formatter.ts"]
  ) {
    const command = new Deno.Command(Deno.execPath(), {
      args: ["info", "--json", entry],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    const decoder = new TextDecoder();
    assert(
      output.success,
      `deno info failed: ${decoder.decode(output.stderr)}`,
    );
    const graph = JSON.parse(decoder.decode(output.stdout)) as InfoGraph;
    for (const module of graph.modules) specifiers.push(module.specifier);
  }
  assert(
    specifiers.some((specifier) =>
      specifier.endsWith("/src/syntax/snapshot.ts")
    ),
    "deno info omitted the snapshot facade",
  );
  assert(
    specifiers.some((specifier) =>
      specifier.endsWith("/src/tooling/formatter.ts")
    ),
    "deno info omitted the formatter",
  );
  const violations = specifiers.filter((specifier) =>
    specifier.includes("/src/compiler/") ||
    specifier.includes("workspace_graph")
  );
  assert(
    violations.length === 0,
    `source-only frontend reaches forbidden modules: ${violations.join(", ")}`,
  );
});
