import { resolve } from "@std/path";
import { BlotError } from "../../src/diagnostic.ts";
import { checkFile } from "../../src/check/mod.ts";
import { load, type Loaded, LoadError } from "../../src/load.ts";
import { CompilerWasm } from "../../src/compiler/wasm.ts";

const wasm = await Deno.readFile(
  new URL("../../generated/compiler/compiler.wasm", import.meta.url),
);
const rust = await CompilerWasm.load(wasm);
// Both directions matter. Comparing rejections alone lets the production
// checker drift towards accepting what the oracle refuses, which is the drift
// that reaches an artifact.
let candidates = [
  ...await blotFiles("examples/rejected/semantics"),
  ...await blotFiles("examples"),
];
if (Deno.args.length > 0) candidates = Deno.args;
const loweringRejections: string[] = [];
const failures: {
  readonly root: string;
  readonly typescript: string;
  readonly rust: string;
}[] = [];
let compared = 0;

for (const root of candidates) {
  let loaded: Loaded;
  try {
    loaded = await load(resolve(root));
  } catch (error) {
    if (!(error instanceof LoadError)) throw error;
    loweringRejections.push(root);
    continue;
  }

  // A real host owns one resident session per configured graph. Keeping the
  // entire repository in one session retained every checked value graph and
  // made dropping the artificial mega-session recurse past Wasm's stack.
  const session = rust.createCompilerSession();
  let destroyError: unknown;
  try {
    const modules = new Map<string, Loaded>();
    collect(loaded, modules);
    for (const module of modules.values()) {
      const added = rust.addCompilerSessionModule(
        session,
        module.path,
        module.source,
      );
      if (!added.ok) throw new Error(`${module.path}: ${added.message}`);
    }
    for (const module of modules.values()) {
      rust.configureCompilerSessionModule(session, module.path, {
        imports: Object.fromEntries(
          [...module.dependencies].map(([specifier, dependency]) => [
            specifier,
            dependency.path,
          ]),
        ),
        includes: Object.fromEntries(
          [...module.includedFiles].map(([specifier, included]) => [
            specifier,
            { path: included.path, text: included.source },
          ]),
        ),
      });
    }

    const typescript = await checkResult(loaded.path);
    const checked = rust.checkCompilerSessionModule(session, loaded.path);
    let rustCode = "accepted";
    if (!checked.ok) {
      const diagnosticCode = checked.diagnostic?.code;
      if (diagnosticCode === undefined) rustCode = "failed";
      else rustCode = diagnosticCode;
    }
    if (typescript !== rustCode) {
      failures.push({ root, typescript, rust: rustCode });
    } else {
      compared += 1;
    }
  } finally {
    try {
      rust.destroyCompilerSession(session);
    } catch (error) {
      destroyError = error;
    }
  }
  if (destroyError !== undefined) {
    throw new Error(`${root}: failed to destroy checked Rust session`, {
      cause: destroyError,
    });
  }
}

console.log(
  JSON.stringify({ compared, loweringRejections, failures }, null, 2),
);
if (failures.length > 0) Deno.exitCode = 1;

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

async function blotFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (entry.isFile && entry.name.endsWith(".blot")) {
      paths.push(`${root}/${entry.name}`);
    }
  }
  paths.sort();
  return paths;
}
