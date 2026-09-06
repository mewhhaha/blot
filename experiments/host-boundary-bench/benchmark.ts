import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "esbuild";
import {
  decodeCompilerArtifactManifest,
  sha256,
  validateCompilerArtifact,
} from "../../src/compiler/artifact.ts";
import { COMPILER_HOST_ABI_VERSION } from "../../src/compiler/host_abi.ts";
import type { BlotAbiType } from "../../src/compiler/backend/runtime/abi.ts";
import {
  BinaryDecoder,
  BinaryEncoder,
} from "../../src/compiler/binary_frame.ts";
import { CompilerWasm } from "../../src/compiler/wasm.ts";
import { runArtifact } from "../../src/node/run.ts";
import { indirectResultFixture } from "../../test_support/indirect_result_fixture.ts";

const collectGarbage: unknown = Reflect.get(globalThis, "gc");
const candidateRoot = fileURLToPath(new URL("../../", import.meta.url));
const baselineArgument = process.argv[2];
if (baselineArgument === undefined) {
  throw new Error("usage: node --import tsx benchmark.ts BASELINE_WORKTREE");
}
const baselineRoot = resolve(baselineArgument);
const sampleCount = 9;
const warmups = 3;
const temporary = await mkdtemp(join(tmpdir(), "blot-host-boundary-"));

try {
  // Compile only the original transport helpers, not a substitute Blot compiler.
  const source = await readFile(
    join(baselineRoot, "src/compiler/wasm.ts"),
    "utf8",
  );
  const classes = ["BinaryEncoder", "BinaryDecoder"].map((name) => {
    const match = source.match(
      new RegExp(`^class ${name} \\{[\\s\\S]*?^\\}`, "m"),
    );
    if (match === null) throw new Error(`baseline omitted ${name}`);
    return `export ${match[0]}`;
  });
  const original = await transform(classes.join("\n"), {
    loader: "ts",
    format: "esm",
    target: "node22",
  });
  const baselineFrames = join(temporary, "binary-frame.mjs");
  await writeFile(baselineFrames, original.code);
  const frameModule = await import(pathToFileURL(baselineFrames).href);
  const BeforeEncoder = frameModule.BinaryEncoder as typeof BinaryEncoder;
  const BeforeDecoder = frameModule.BinaryDecoder as typeof BinaryDecoder;
  const beforeRun = (await import(
    pathToFileURL(
      join(baselineRoot, "src/node/run.ts"),
    ).href
  )).runArtifact as typeof runArtifact;
  const BeforeCompiler = (await import(
    pathToFileURL(
      join(baselineRoot, "src/compiler/wasm.ts"),
    ).href
  )).CompilerWasm as typeof CompilerWasm;
  const provenanceBefore = await provenance();
  const measurements = [];
  const payload = new Uint8Array(1_048_576).fill(0x61);
  const encode = (Encoder: typeof BinaryEncoder) => {
    const encoder = new Encoder();
    encoder.u32(3);
    encoder.string("/benchmark.blot");
    encoder.bytes(payload);
    return encoder.finish();
  };
  assert.deepEqual(encode(BeforeEncoder), encode(BinaryEncoder));
  measurements.push(
    await measure(
      "encode-1MiB-transport-frame",
      3,
      () => encode(BeforeEncoder).byteLength,
      () => encode(BinaryEncoder).byteLength,
    ),
  );

  const smallPayload = new Uint8Array(64).fill(0x61);
  const encodeSmall = (Encoder: typeof BinaryEncoder) => {
    const encoder = new Encoder();
    encoder.u32(3);
    encoder.string("/benchmark.blot");
    encoder.bytes(smallPayload);
    return encoder.finish();
  };
  assert.deepEqual(encodeSmall(BeforeEncoder), encodeSmall(BinaryEncoder));
  measurements.push(
    await measure(
      "encode-64-byte-transport-frame",
      1000,
      () => encodeSmall(BeforeEncoder).byteLength,
      () => encodeSmall(BinaryEncoder).byteLength,
    ),
  );

  const words = new BinaryEncoder();
  const wordCount = 32_768;
  for (let word = 0; word < wordCount; word += 1) words.u32(word);
  const wordFrame = words.finish();
  const decode = (Decoder: typeof BinaryDecoder) => {
    const decoder = new Decoder(wordFrame);
    let sum = 0;
    for (let word = 0; word < wordCount; word += 1) sum += decoder.u32("word");
    decoder.finish();
    return sum;
  };
  assert.equal(decode(BeforeDecoder), decode(BinaryDecoder));
  measurements.push(
    await measure(
      "decode-32768-u32-transport-fields",
      3,
      () => decode(BeforeDecoder),
      () => decode(BinaryDecoder),
    ),
  );

  for (const [depth, count] of [[0, 1], [12, 1], [4, 1000]]) {
    const { artifact, expected } = recordFixture(depth, count);
    assert.equal(await beforeRun(artifact), expected);
    assert.equal(await runArtifact(artifact), expected);
    measurements.push(
      await measure(
        `runArtifact-depth-${depth}-count-${count}`,
        3,
        async () => (await beforeRun(artifact)).length,
        async () => (await runArtifact(artifact)).length,
      ),
    );
  }

  const wasm = await readFile(
    join(candidateRoot, "generated/compiler/compiler.wasm"),
  );
  const artifactManifest = decodeCompilerArtifactManifest(
    await readFile(
      join(candidateRoot, "generated/compiler/compiler-artifact.json"),
      "utf8",
    ),
  );
  const prelude = await readFile(
    join(candidateRoot, "generated/compiler/prelude.snapshot"),
  );
  await validateCompilerArtifact(wasm, artifactManifest, {
    hostAbi: COMPILER_HOST_ABI_VERSION,
    preludeSha256: await sha256(prelude),
  });
  const beforeCompiler = await BeforeCompiler.load(wasm);
  const afterCompiler = await CompilerWasm.load(wasm);
  let compileSource = `return "${"x".repeat(131_072)}"\n`;
  const compile = (compiler: CompilerWasm) => {
    const handle = compiler.createCompilerSession();
    try {
      const added = compiler.addCompilerSessionModule(
        handle,
        "/benchmark.blot",
        compileSource,
      );
      if (!added.ok) throw new Error(JSON.stringify(added));
      compiler.configureCompilerSessionModule(
        handle,
        "/benchmark.blot",
        { imports: {}, includes: {} },
      );
      const result = compiler.compileCompilerSessionModule(
        handle,
        "/benchmark.blot",
      );
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result;
    } finally {
      compiler.destroyCompilerSession(handle);
    }
  };
  const beforeArtifact = compile(beforeCompiler);
  const afterArtifact = compile(afterCompiler);
  assert.deepEqual(beforeArtifact.wasm, afterArtifact.wasm);
  assert.deepEqual(beforeArtifact.manifestBytes, afterArtifact.manifestBytes);
  measurements.push(
    await measure(
      "resident-compiler-new-session-128KiB-text-compile-and-extract",
      1,
      () => compile(beforeCompiler).wasm.byteLength,
      () => compile(afterCompiler).wasm.byteLength,
    ),
  );
  compileSource = "return ()\n";
  const beforeMinimal = compile(beforeCompiler);
  const afterMinimal = compile(afterCompiler);
  assert.deepEqual(beforeMinimal.wasm, afterMinimal.wasm);
  assert.deepEqual(beforeMinimal.manifestBytes, afterMinimal.manifestBytes);
  measurements.push(
    await measure(
      "resident-compiler-new-session-minimal-compile-and-extract",
      3,
      () => compile(beforeCompiler).wasm.byteLength,
      () => compile(afterCompiler).wasm.byteLength,
    ),
  );
  const provenanceAfter = await provenance();
  assert.deepEqual(
    provenanceAfter,
    provenanceBefore,
    "benchmark inputs changed",
  );
  console.log(JSON.stringify(
    {
      schema: "blot-host-boundary-benchmark-v1",
      sampleCount,
      warmups,
      aggregation:
        "median of per-invocation milliseconds; alternating baseline/candidate order",
      gcBeforeEachSample: typeof collectGarbage === "function",
      setup:
        "module loading, fixture creation, Wasm compiler instantiation, and parity checks are outside timing",
      runtimeBoundary:
        "runArtifact includes Wasm instantiation, decoding, post-return, and formatting; not warm guest execution",
      compilerBoundary:
        "same compiled Rust artifact for both hosts; new semantic session, source transfer, compile, extraction, and teardown inside timing",
      provenance: provenanceBefore,
      provenanceAfter,
      observations: {
        compilerWasmSha256: hash(beforeArtifact.wasm),
        compilerManifestSha256: hash(beforeArtifact.manifestBytes),
        encoderFrameSha256: hash(encode(BinaryEncoder)),
      },
      measurements,
    },
    null,
    2,
  ));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function measure(
  name: string,
  invocations: number,
  before: () => number | Promise<number>,
  after: () => number | Promise<number>,
) {
  for (let index = 0; index < warmups; index += 1) {
    assert.equal(await before(), await after());
  }
  const samples: { baseline: number[]; candidate: number[] } = {
    baseline: [],
    candidate: [],
  };
  let baselineSink = 0;
  let candidateSink = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const order = ["baseline", "candidate"] as (keyof typeof samples)[];
    if (sample % 2 === 1) order.reverse();
    for (const side of order) {
      let operation = before;
      if (side === "candidate") operation = after;
      if (typeof collectGarbage === "function") collectGarbage.call(globalThis);
      let sink = 0;
      const start = performance.now();
      for (let invocation = 0; invocation < invocations; invocation += 1) {
        const observation = operation();
        if (typeof observation === "number") sink += observation;
        else sink += await observation;
      }
      samples[side].push((performance.now() - start) / invocations);
      if (side === "baseline") baselineSink += sink;
      else candidateSink += sink;
    }
  }
  assert.equal(baselineSink, candidateSink, `${name} changed its observation`);
  const baselineMedian = median(samples.baseline);
  const candidateMedian = median(samples.candidate);
  return {
    name,
    invocationsPerSample: invocations,
    baselineMilliseconds: distribution(samples.baseline),
    candidateMilliseconds: distribution(samples.candidate),
    medianSpeedup: baselineMedian / candidateMedian,
    samplesMilliseconds: samples,
  };
}

function distribution(values: readonly number[]) {
  const center = median(values);
  return {
    median: center,
    medianAbsoluteDeviation: median(
      values.map((value) => Math.abs(value - center)),
    ),
    minimum: Math.min(...values),
    maximum: Math.max(...values),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function recordFixture(depth: number, count: number) {
  let type: BlotAbiType = { kind: "text" };
  let expected = '"blot"';
  for (let index = 0; index < depth; index += 1) {
    type = { kind: "record", fields: [{ name: "value", type }] };
    expected = `{ .value = ${expected} }`;
  }
  const data = new Uint8Array(32 + count * 8 + 4);
  const view = new DataView(data.buffer);
  const textPointer = data.length - 4;
  data.set(new TextEncoder().encode("blot"), textPointer);
  if (count === 1) {
    view.setUint32(0, textPointer, true);
    view.setUint32(4, 4, true);
  } else {
    type = { kind: "array", element: type };
    expected = `[${Array.from({ length: count }, () => expected).join(", ")}]`;
    view.setUint32(0, 16, true);
    view.setUint32(4, count, true);
    for (let index = 0; index < count; index += 1) {
      view.setUint32(16 + index * 8, textPointer, true);
      view.setUint32(20 + index * 8, 4, true);
    }
  }
  return { artifact: indirectResultFixture(type, data), expected };
}

async function provenance() {
  const wasm = await readFile(
    join(candidateRoot, "generated/compiler/compiler.wasm"),
  );
  const manifest = await readFile(
    join(candidateRoot, "generated/compiler/compiler-artifact.json"),
  );
  return {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    architecture: process.arch,
    cpuModels: [...new Set(cpus().map((cpu) => cpu.model))],
    logicalCpuCount: cpus().length,
    invocation: process.execArgv,
    baseline: await inputs(baselineRoot),
    candidate: await inputs(candidateRoot),
    compilerWasmSha256: hash(wasm),
    compilerManifestSha256: hash(manifest),
    compilerArtifactManifest: JSON.parse(manifest.toString()),
  };
}

async function inputs(root: string) {
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const paths = execFileSync("git", [
    "-C",
    root,
    "ls-files",
    "-co",
    "--exclude-standard",
    "-z",
    "--",
    "src",
    "test_support",
    "experiments/host-boundary-bench",
    "generated/wasm",
    "generated/compiler/prelude.snapshot",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "deno.json",
  ], { encoding: "utf8" }).split("\0").filter(Boolean);
  paths.push(".pnp.cjs");
  const digest = createHash("sha256");
  for (const path of [...new Set(paths)].sort()) {
    const bytes = await readFile(join(root, path));
    digest.update(`${path.length}:${path}:${bytes.length}:`);
    digest.update(bytes);
  }
  return { head, hostInputsSha256: digest.digest("hex") };
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
