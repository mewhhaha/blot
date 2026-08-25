import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  decodeCompilerArtifactManifest,
  sha256,
  validateCompilerArtifact,
} from "../../src/compiler/artifact.ts";
import { COMPILER_HOST_ABI_VERSION } from "../../src/compiler/host_abi.ts";
import { CompilerWasm } from "../../src/compiler/wasm.ts";
import { decodePortableModule } from "../../src/syntax/portable.ts";
import type {
  CompilerStartupChildSample,
  CompilerStartupPhase,
} from "./schema.ts";
import { compilerStartupChildExecArgv } from "./invocation.ts";

const sourcePath = process.argv[2];
if (sourcePath === undefined) {
  throw new Error("compiler startup sample requires a source path");
}
if (
  JSON.stringify(process.execArgv) !==
    JSON.stringify(compilerStartupChildExecArgv)
) {
  throw new Error(
    `compiler startup child has Node flags ${
      JSON.stringify(process.execArgv)
    }, expected ${JSON.stringify(compilerStartupChildExecArgv)}`,
  );
}

const phases: Partial<Record<CompilerStartupPhase, number>> = {};

async function measured<T>(
  phase: CompilerStartupPhase,
  operation: () => Promise<T> | T,
): Promise<T> {
  const before = performance.now();
  const result = await operation();
  phases[phase] = performance.now() - before;
  return result;
}

const internalStart = performance.now();
const bundle = await measured("bundle-read", async () => {
  const [wasm, manifestSource, preludeSnapshot] = await Promise.all([
    readFile(resolve("generated/compiler/compiler.wasm")),
    readFile(resolve("generated/compiler/compiler-artifact.json"), "utf8"),
    readFile(resolve("generated/compiler/prelude.snapshot")),
  ]);
  return { wasm, manifestSource, preludeSnapshot };
});
await measured("artifact-validation", async () => {
  const manifest = decodeCompilerArtifactManifest(bundle.manifestSource);
  await validateCompilerArtifact(bundle.wasm, manifest, {
    hostAbi: COMPILER_HOST_ABI_VERSION,
    preludeSha256: await sha256(bundle.preludeSnapshot),
  });
});
const module = await measured(
  "wasm-compile",
  () => CompilerWasm.compile(bundle.wasm),
);
const compiler = await measured(
  "wasm-instantiate",
  () => CompilerWasm.instantiate(module),
);
const session = await measured(
  "session-create",
  () => compiler.createCompilerSession(),
);
const preludePath = "snapshot:prelude";
try {
  await measured(
    "snapshot-install",
    () =>
      compiler.installCompilerSessionTrustedModuleSnapshot(
        session,
        preludePath,
        bundle.preludeSnapshot,
      ),
  );
  const source = await measured(
    "root-read",
    () => readFile(resolve(sourcePath), "utf8"),
  );
  const rootPath = resolve(sourcePath);
  const added = await measured(
    "root-lower",
    () => compiler.addCompilerSessionModule(session, rootPath, source),
  );
  if (!added.ok) throw new Error("compiler startup root was rejected");
  if (
    added.module.imports.length !== 1 ||
    added.module.imports[0] !== "blot:prelude" ||
    added.module.includes.length !== 0
  ) {
    throw new Error(
      "compiler startup decomposition requires a root that imports only blot:prelude",
    );
  }
  await measured(
    "root-configure",
    () =>
      compiler.configureCompilerSessionModule(session, rootPath, {
        imports: { "blot:prelude": preludePath },
        includes: {},
      }),
  );
  const checked = await measured(
    "root-check",
    () => compiler.checkCompilerSessionModule(session, rootPath),
  );
  if (!checked.ok) throw new Error("compiler startup root failed to check");
  const internalMilliseconds = performance.now() - internalStart;
  const exportedPrelude = await measured(
    "prelude-ast-export",
    () => compiler.exportCompilerSessionModuleAst(session, preludePath),
  );
  if (!exportedPrelude.ok) {
    throw new Error("installed prelude snapshot omitted its portable AST");
  }
  await measured("prelude-ast-decode", () =>
    decodePortableModule(
      JSON.parse(exportedPrelude.ast),
      "distributed prelude snapshot",
    ));
  const sample: CompilerStartupChildSample = {
    internalMilliseconds,
    syntaxConsumerInternalMilliseconds: performance.now() - internalStart,
    phases,
    observation: JSON.stringify({
      type: checked.type,
      effects: checked.effects,
    }),
  };
  process.stdout.write(JSON.stringify(sample));
} finally {
  compiler.destroyCompilerSession(session);
}
