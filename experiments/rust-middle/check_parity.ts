import { resolve } from "@std/path";
import { BlotError } from "../../src/diagnostic.ts";
import { checkFile } from "../../src/check/mod.ts";
import { load, type Loaded, LoadError } from "../../src/load.ts";
import { RustMiddle } from "../../src/backend/rust_middle_wasm.ts";

const wasm = await Deno.readFile(
  new URL("../../generated/rust-middle/compiler.wasm", import.meta.url),
);
const rust = await RustMiddle.load(wasm);
const candidates = await semanticRejections("examples/rejected/semantics");
const loadedModules = new Map<string, Loaded>();
const roots: string[] = [];
const loweringRejections: string[] = [];
for (const root of candidates) {
  try {
    collect(await load(resolve(root)), loadedModules);
    roots.push(root);
  } catch (error) {
    if (!(error instanceof LoadError)) throw error;
    loweringRejections.push(root);
  }
}

const session = rust.createCompilerSession();
try {
  for (const loaded of loadedModules.values()) {
    const added = rust.addCompilerSessionModule(
      session,
      loaded.path,
      loaded.source,
    );
    if (!added.ok) throw new Error(`${loaded.path}: ${added.message}`);
  }
  for (const loaded of loadedModules.values()) {
    rust.configureCompilerSessionModule(session, loaded.path, {
      imports: Object.fromEntries(
        [...loaded.dependencies].map(([specifier, dependency]) => [
          specifier,
          dependency.path,
        ]),
      ),
      includes: Object.fromEntries(
        [...loaded.includedFiles].map(([specifier, included]) => [
          specifier,
          { path: included.path, text: included.source },
        ]),
      ),
    });
  }

  const failures: {
    readonly root: string;
    readonly typescript: string;
    readonly rust: string;
  }[] = [];
  let compared = 0;
  for (const root of roots) {
    const typescript = await checkResult(resolve(root));
    const checked = rust.checkCompilerSessionModule(session, resolve(root));
    let rustCode = "accepted";
    if (!checked.ok) {
      const diagnosticCode = checked.diagnostic?.code;
      if (diagnosticCode === undefined) rustCode = "failed";
      else rustCode = diagnosticCode;
    }
    if (typescript !== rustCode) {
      failures.push({ root, typescript, rust: rustCode });
      continue;
    }
    compared += 1;
  }
  console.log(
    JSON.stringify({ compared, loweringRejections, failures }, null, 2),
  );
  if (failures.length > 0) Deno.exitCode = 1;
} finally {
  rust.destroyCompilerSession(session);
}

async function checkResult(path: string): Promise<string> {
  try {
    await checkFile(path);
    return "accepted";
  } catch (error) {
    if (error instanceof BlotError) return error.diagnostic.code;
    throw error;
  }
}

function collect(loaded: Loaded, modules: Map<string, Loaded>): void {
  if (modules.has(loaded.path)) return;
  modules.set(loaded.path, loaded);
  for (const dependency of loaded.dependencies.values()) {
    collect(dependency, modules);
  }
}

async function semanticRejections(root: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (entry.isFile && entry.name.endsWith(".blot")) {
      paths.push(`${root}/${entry.name}`);
    }
  }
  paths.sort();
  return paths;
}
