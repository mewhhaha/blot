import { assertEquals } from "@std/assert";
import { CpuFrontend } from "@mewhhaha/baba/runtime/webgpu";
import { ingestCpuSource, parse } from "../../src/syntax/parse.ts";
import { moduleImports, moduleIncludes } from "../../src/load.ts";
import { canonicalModule, materializeFlatModule } from "./flat_ast.ts";
import { layoutSource } from "./layout_source.ts";
import { CompilerWasm } from "../../src/compiler/wasm.ts";

const wasm = await Deno.readFile(
  new URL("../../generated/compiler/compiler.wasm", import.meta.url),
);
const plan = await Deno.readFile("generated/wasm/parser.plan");
const frontend = CpuFrontend.create(plan);
const rust = await CompilerWasm.load(wasm);
const session = rust.createCompilerSession();
const paths = await blotPaths(".");
let compared = 0;
let mutuallyRejected = 0;
const rejectedPaths: string[] = [];

for (const path of paths) {
  const source = await Deno.readTextFile(path);
  const elaborated = await layoutSource(path, source);
  const parsed = ingestCpuSource(frontend, elaborated.source);
  const typescript = await parse(source);
  if (!parsed.ok) {
    if (typescript.ok) {
      throw new Error(
        `${path}: direct CPU ingestion failed while TypeScript parsing succeeded`,
      );
    }
    mutuallyRejected += 1;
    rejectedPaths.push(path);
    continue;
  }
  const lowered = rust.lower(source);
  if (!typescript.ok) {
    if (!lowered.ok) {
      let rustCode = lowered.diagnostics?.[0]?.code;
      if (rustCode === undefined && lowered.message !== undefined) {
        rustCode = lowered.message.match(/BLOT_[A-Z_]+/)?.[0];
      }
      const typescriptCode = typescript.diagnostics[0]?.code;
      if (rustCode !== typescriptCode) {
        throw new Error(
          `${path}: rejection differs: Rust ${rustCode}, TypeScript ${typescriptCode}`,
        );
      }
      mutuallyRejected += 1;
      rejectedPaths.push(path);
      continue;
    }
    throw new Error(
      `${path}: Rust accepted a module TypeScript rejected: ${
        formatDiagnostics(typescript.diagnostics)
      }`,
    );
  }
  if (!lowered.ok) {
    throw new Error(
      `${path}: Rust rejected a module TypeScript accepted: ${lowered.message}`,
    );
  }
  try {
    assertEquals(
      canonicalModule(materializeFlatModule(lowered.module)),
      canonicalModule(typescript.module),
    );
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        `${path}: Rust AST differs from TypeScript\n${error.message}`,
      );
    }
    throw error;
  }
  const added = rust.addCompilerSessionModule(
    session,
    path,
    source,
  );
  if (!added.ok) {
    throw new Error(
      `${path}: resident Rust session rejected the module: ${added.message}`,
    );
  }
  assertEquals(added.module.imports, moduleImports(typescript.module));
  assertEquals(added.module.includes, moduleIncludes(typescript.module));
  compared += 1;
}

rust.destroyCompilerSession(session);

console.log(
  JSON.stringify(
    { compared, mutually_rejected: mutuallyRejected, rejected: rejectedPaths },
    null,
    2,
  ),
);

async function blotPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    let path = `${root}/${entry.name}`;
    if (root === ".") path = entry.name;
    if (entry.isDirectory) {
      if (entry.name === ".git" || entry.name === "target") continue;
      paths.push(...await blotPaths(path));
      continue;
    }
    if (entry.isFile && entry.name.endsWith(".blot")) paths.push(path);
  }
  paths.sort();
  return paths;
}

function formatDiagnostics(
  diagnostics: readonly { readonly code: string; readonly message: string }[],
): string {
  return diagnostics.map((diagnostic) =>
    `${diagnostic.code}: ${diagnostic.message}`
  ).join("; ");
}
