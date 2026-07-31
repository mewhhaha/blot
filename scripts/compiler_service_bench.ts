import { join } from "@std/path";
import {
  buildWithCompilerService,
  startCompilerServer,
} from "../src/compiler_service.ts";

const SAMPLE_COUNT = 7;
const directory = await Deno.makeTempDir({ prefix: "blot-service-bench-" });
const sourcePath = join(directory, "compiled.blot");
const originalSource = await Deno.readTextFile("examples/compiled.blot");
await Deno.writeTextFile(sourcePath, originalSource);

const serviceStart = performance.now();
const server = await startCompilerServer({ port: 0 });
const serviceStartupMilliseconds = performance.now() - serviceStart;
try {
  const firstStart = performance.now();
  const first = await buildWithCompilerService(sourcePath, server.url);
  const firstBuildMilliseconds = performance.now() - firstStart;

  const unchanged = await samples(async () => {
    await buildWithCompilerService(sourcePath, server.url);
  });

  const edited: number[] = [];
  let latest = first;
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const changedSource = originalSource.replace("- 66", `- ${65 - sample}`);
    await Deno.writeTextFile(sourcePath, changedSource);
    const start = performance.now();
    const built = await buildWithCompilerService(sourcePath, server.url);
    edited.push(performance.now() - start);
    if (equalBytes(built.wasm, latest.wasm)) {
      throw new Error(
        `service edit sample ${sample} returned the previous Wasm artifact`,
      );
    }
    latest = built;
  }

  const thinClient = await samples(() => runThinClient(sourcePath, server.url));
  const direct = await samples(() => runDirectBuild(sourcePath), 3);
  const directWasm = await Deno.readFile(
    sourcePath.replace(/\.blot$/, ".wasm"),
  );
  const directManifest = await Deno.readFile(
    sourcePath.replace(/\.blot$/, ".wasm.json"),
  );
  if (!equalBytes(directWasm, latest.wasm)) {
    throw new Error("direct and service modes emitted different Wasm bytes");
  }
  if (!equalBytes(directManifest, latest.manifestBytes)) {
    throw new Error(
      "direct and service modes emitted different manifest bytes",
    );
  }

  console.log(`Blot compiler service (${SAMPLE_COUNT} resident samples)`);
  console.log(
    `  service GPU startup:       ${serviceStartupMilliseconds.toFixed(1)} ms`,
  );
  console.log(
    `  first resident request:    ${firstBuildMilliseconds.toFixed(1)} ms`,
  );
  console.log(
    `  resident unchanged median: ${median(unchanged).toFixed(1)} ms`,
  );
  console.log(`  resident edit median:      ${median(edited).toFixed(1)} ms`);
  console.log(
    `  thin CLI service median:   ${median(thinClient).toFixed(1)} ms`,
  );
  console.log(`  fresh direct CLI median:   ${median(direct).toFixed(1)} ms`);
  console.log(
    `  artifact:                  ${
      (first.wasm.byteLength / 1024).toFixed(1)
    } KiB`,
  );
} finally {
  await server.shutdown();
}

async function samples(
  measure: () => Promise<void>,
  count = SAMPLE_COUNT,
): Promise<readonly number[]> {
  const durations: number[] = [];
  for (let sample = 0; sample < count; sample += 1) {
    const start = performance.now();
    await measure();
    durations.push(performance.now() - start);
  }
  return durations;
}

async function runThinClient(path: string, serviceUrl: string): Promise<void> {
  const result = await new Deno.Command("./scripts/blot-service-client", {
    args: [path, serviceUrl],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (result.success) return;
  throw new Error(
    `Blot thin service client exited ${result.code}: ${
      new TextDecoder().decode(result.stderr)
    }`,
  );
}

async function runDirectBuild(path: string): Promise<void> {
  const arguments_ = [
    "run",
    "--unstable-webgpu",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-net",
    "src/cli.ts",
    "build",
    "--mode=direct",
    path,
  ];
  const result = await new Deno.Command(Deno.execPath(), {
    args: arguments_,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (result.success) return;
  throw new Error(
    `Blot direct build exited ${result.code}: ${
      new TextDecoder().decode(result.stderr)
    }`,
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = ordered[Math.floor(ordered.length / 2)];
  if (middle === undefined) {
    throw new Error("cannot take the median of no samples");
  }
  return middle;
}
