import {
  decodeCompilerArtifactManifest,
  sha256,
  validateCompilerArtifact,
} from "./compiler_artifact.ts";
import { COMPILER_HOST_ABI_VERSION } from "../src/compiler/host_abi.ts";
import { compilerInputIdentity } from "./compiler_inputs.ts";

interface WorkflowRun {
  readonly databaseId: number;
  readonly headSha: string;
}

const repository = new URL("../", import.meta.url);
const destination = new URL("../generated/compiler/", import.meta.url);
const requestedRun = parseRun(Deno.args);
const commit = await runText("git", ["rev-parse", "HEAD"]);
let runId = requestedRun;
if (runId === undefined) runId = await findRun(commit);

const temporary = await Deno.makeTempDir({ prefix: "blot-compiler-" });
try {
  await run("gh", [
    "run",
    "download",
    String(runId),
    "--name",
    "blot-rust-compiler",
    "--dir",
    temporary,
  ]);
  const compilerPath = await findArtifactFile(temporary, "compiler.wasm");
  const manifestPath = await findArtifactFile(
    temporary,
    "compiler-artifact.json",
  );
  const bytes = await Deno.readFile(compilerPath);
  const manifest = decodeCompilerArtifactManifest(
    await Deno.readTextFile(manifestPath),
  );
  const prelude = await Deno.readFile(
    new URL("../generated/compiler/prelude.snapshot", import.meta.url),
  );
  await validateCompilerArtifact(bytes, manifest, {
    hostAbi: COMPILER_HOST_ABI_VERSION,
    preludeSha256: await sha256(prelude),
    compilerInputsSha256: await compilerInputIdentity(),
  });
  await Deno.mkdir(destination, { recursive: true });
  await Deno.writeFile(new URL("compiler.wasm", destination), bytes);
  await Deno.writeTextFile(
    new URL("compiler-artifact.json", destination),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
  );
  console.log(
    `installed compiler artifact from run ${runId}: ${manifest.sha256} (${manifest.bytes} bytes)`,
  );
} finally {
  await Deno.remove(temporary, { recursive: true });
}

function parseRun(args: readonly string[]): number | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--run") {
    throw new Error("usage: download_compiler.ts [--run <workflow-run-id>]");
  }
  const runId = Number(args[1]);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error("workflow run id must be a positive integer");
  }
  return runId;
}

async function findRun(commit: string): Promise<number> {
  const json = await runText("gh", [
    "run",
    "list",
    "--workflow",
    "ci.yml",
    "--commit",
    commit,
    "--status",
    "success",
    "--limit",
    "20",
    "--json",
    "databaseId,headSha",
  ]);
  const runs = JSON.parse(json) as WorkflowRun[];
  const exact = runs.find((candidate) => candidate.headSha === commit);
  if (exact === undefined) {
    throw new Error(
      `no successful Rust/Wasm compiler CI run found for commit ${commit}; build locally or pass --run`,
    );
  }
  return exact.databaseId;
}

async function findArtifactFile(
  directory: string,
  name: string,
): Promise<string> {
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isFile && entry.name === name) return path;
    if (entry.isDirectory) {
      try {
        return await findArtifactFile(path, name);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  }
  throw new Deno.errors.NotFound(`downloaded artifact omitted ${name}`);
}

async function runText(command: string, args: string[]): Promise<string> {
  const output = await run(command, args, "piped");
  return new TextDecoder().decode(output.stdout).trim();
}

async function run(
  command: string,
  args: string[],
  stdout: "inherit" | "piped" = "inherit",
): Promise<Deno.CommandOutput> {
  const output = await new Deno.Command(command, {
    args,
    cwd: repository,
    stdout,
    stderr: "inherit",
  }).output();
  if (!output.success) throw new Error(`${command} ${args.join(" ")} failed`);
  return output;
}
