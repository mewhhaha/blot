import {
  type CompilerArtifactManifest,
  describeCompilerArtifact,
} from "./compiler_artifact.ts";

const repository = new URL("../", import.meta.url);
const compiler = new URL(
  "../generated/compiler/compiler.wasm",
  import.meta.url,
);
const manifestPath = new URL(
  "../generated/compiler/compiler-artifact.json",
  import.meta.url,
);

const bytes = await Deno.readFile(compiler);
const manifest: CompilerArtifactManifest = await describeCompilerArtifact(
  bytes,
  await commandText("git", "rev-parse", "HEAD"),
  await commandText("git", "rev-parse", "HEAD^{tree}"),
  await commandText("rustc", "--version"),
);
await Deno.writeTextFile(
  manifestPath,
  `${JSON.stringify(manifest, undefined, 2)}\n`,
);
console.log(
  `packaged compiler artifact ${manifest.sha256} (${manifest.bytes} bytes)`,
);

async function commandText(
  command: string,
  ...args: string[]
): Promise<string> {
  const output = await new Deno.Command(command, {
    args,
    cwd: repository,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!output.success) throw new Error(`${command} ${args.join(" ")} failed`);
  return new TextDecoder().decode(output.stdout).trim();
}
