import {
  type CompilerArtifactManifest,
  describeCompilerArtifact,
  sha256,
} from "./compiler_artifact.ts";
import { compilerInputIdentity } from "./compiler_inputs.ts";

const repository = new URL("../", import.meta.url);
let distributionRoot = new URL("../generated/compiler/", import.meta.url);
if (Deno.args.includes("--development-profile")) {
  distributionRoot = new URL(
    "../compiler/target/development-profile/",
    import.meta.url,
  );
}
const compiler = new URL("compiler.wasm", distributionRoot);
const manifestPath = new URL("compiler-artifact.json", distributionRoot);

const bytes = await Deno.readFile(compiler);
const prelude = await Deno.readFile(
  new URL("prelude.snapshot", distributionRoot),
);
let profile: CompilerArtifactManifest["profile"] = "production";
if (Deno.args.includes("--development-profile")) {
  profile = "development-profile";
}
const manifest: CompilerArtifactManifest = await describeCompilerArtifact(
  bytes,
  await commandText("git", "rev-parse", "HEAD"),
  await commandText("git", "rev-parse", "HEAD^{tree}"),
  await commandText("rustc", "--version"),
  await sha256(prelude),
  await compilerInputIdentity(),
  profile,
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
