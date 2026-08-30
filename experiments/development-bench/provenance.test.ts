import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import type { DevelopmentBenchmarkProvenance } from "./schema.ts";
import {
  decodeNullTerminatedArguments,
  developmentBenchmarkCompilerPaths,
  developmentBenchmarkDenoInvocationIdentity,
  type DevelopmentBenchmarkIdentityInput,
  developmentBenchmarkInputIdentity,
  developmentBenchmarkModulePaths,
  requireStableDevelopmentBenchmarkProvenance,
} from "./provenance.ts";

const commit = "a".repeat(40);
const executableSha256 = "b".repeat(64);

Deno.test("compiler distribution selection keeps production and profile inputs separate", () => {
  assertEquals(developmentBenchmarkCompilerPaths("production"), {
    artifact: "generated/compiler/compiler.wasm",
    manifest: "generated/compiler/compiler-artifact.json",
    prelude: "generated/compiler/prelude.snapshot",
  });
  assertEquals(developmentBenchmarkCompilerPaths("development-profile"), {
    artifact: "compiler/target/development-profile/compiler.wasm",
    manifest: "compiler/target/development-profile/compiler-artifact.json",
    prelude: "compiler/target/development-profile/prelude.snapshot",
  });
});

Deno.test("input identity covers commit, paths, states, modes, and bytes", () => {
  const initial = developmentBenchmarkInputIdentity(commit, [{
    path: "src/main.ts",
    kind: "file",
    executable: false,
    bytes: new TextEncoder().encode("initial"),
  }, {
    path: "src/removed.ts",
    kind: "missing",
  }]);

  assertNotEquals(
    developmentBenchmarkInputIdentity("c".repeat(40), [{
      path: "src/main.ts",
      kind: "file",
      executable: false,
      bytes: new TextEncoder().encode("initial"),
    }, {
      path: "src/removed.ts",
      kind: "missing",
    }]),
    initial,
  );
  assertNotEquals(
    developmentBenchmarkInputIdentity(commit, [{
      path: "src/main.ts",
      kind: "file",
      executable: false,
      bytes: new TextEncoder().encode("changed"),
    }, {
      path: "src/removed.ts",
      kind: "missing",
    }]),
    initial,
  );
  assertNotEquals(
    developmentBenchmarkInputIdentity(commit, [{
      path: "src/main.ts",
      kind: "file",
      executable: true,
      bytes: new TextEncoder().encode("initial"),
    }, {
      path: "src/removed.ts",
      kind: "missing",
    }]),
    initial,
  );
  assertNotEquals(
    developmentBenchmarkInputIdentity(commit, [{
      path: "src/main.ts",
      kind: "file",
      executable: false,
      bytes: new TextEncoder().encode("initial"),
    }, {
      path: "src/removed.ts",
      kind: "file",
      executable: false,
      bytes: new Uint8Array(),
    }]),
    initial,
  );
});

Deno.test("input identity is independent of Git enumeration order", () => {
  const left: DevelopmentBenchmarkIdentityInput = {
    path: "a.ts",
    kind: "file",
    executable: false,
    bytes: new Uint8Array([1]),
  };
  const right: DevelopmentBenchmarkIdentityInput = {
    path: "b.ts",
    kind: "symlink",
    target: "a.ts",
  };

  assertEquals(
    developmentBenchmarkInputIdentity(commit, [left, right]),
    developmentBenchmarkInputIdentity(commit, [right, left]),
  );
});

Deno.test("input identity rejects duplicate paths", () => {
  const input: DevelopmentBenchmarkIdentityInput = {
    path: "src/main.ts",
    kind: "missing",
  };

  assertThrows(
    () => developmentBenchmarkInputIdentity(commit, [input, input]),
    Error,
    'input path "src/main.ts" repeats',
  );
});

Deno.test("Deno invocation identity covers flags and relocates the repository", () => {
  const initial = developmentBenchmarkDenoInvocationIdentity({
    arguments: [
      "/usr/bin/deno",
      "run",
      "--allow-read",
      "/first/blot/experiments/development-bench/benchmark.ts",
    ],
    executableSha256,
    mainModule: "file:///first/blot/experiments/development-bench/benchmark.ts",
    repositoryPath: "/first/blot",
  });
  const relocated = developmentBenchmarkDenoInvocationIdentity({
    arguments: [
      "/usr/bin/deno",
      "run",
      "--allow-read",
      "/second/blot/experiments/development-bench/benchmark.ts",
    ],
    executableSha256,
    mainModule:
      "file:///second/blot/experiments/development-bench/benchmark.ts",
    repositoryPath: "/second/blot",
  });
  const changedFlags = developmentBenchmarkDenoInvocationIdentity({
    arguments: [
      "/usr/bin/deno",
      "run",
      "--allow-all",
      "/first/blot/experiments/development-bench/benchmark.ts",
    ],
    executableSha256,
    mainModule: "file:///first/blot/experiments/development-bench/benchmark.ts",
    repositoryPath: "/first/blot",
  });

  assertEquals(relocated, initial);
  assertNotEquals(changedFlags, initial);
});

Deno.test("null-terminated argument decoding preserves empty arguments", () => {
  assertEquals(
    decodeNullTerminatedArguments(
      new Uint8Array([0x64, 0x65, 0x6e, 0x6f, 0, 0, 0x78, 0]),
    ),
    ["deno", "", "x"],
  );
  assertThrows(
    () =>
      decodeNullTerminatedArguments(new Uint8Array([0x64, 0x65, 0x6e, 0x6f])),
    Error,
    "not null-terminated",
  );
});

Deno.test("Deno module paths include resolved ignored dependencies", () => {
  assertEquals(
    developmentBenchmarkModulePaths({
      modules: [{ specifier: "node:crypto" }, {
        specifier: "file:///repo/src/development.ts",
      }, {
        specifier: "file:///repo/node_modules/.pnpm/package/src/runtime.js",
      }],
    }, "/repo"),
    [
      "node_modules/.pnpm/package/src/runtime.js",
      "src/development.ts",
    ],
  );
});

Deno.test("Deno module paths reject dependencies outside the repository", () => {
  assertThrows(
    () =>
      developmentBenchmarkModulePaths({
        modules: [{ specifier: "file:///cache/runtime.js" }],
      }, "/repo"),
    Error,
    "outside repository",
  );
});

Deno.test("provenance rejects drift during measured samples", () => {
  const initial = provenance();
  requireStableDevelopmentBenchmarkProvenance(initial, provenance());

  assertThrows(
    () =>
      requireStableDevelopmentBenchmarkProvenance(initial, {
        ...provenance(),
        compilerArtifactSha256: "c".repeat(64),
      }),
    Error,
    "compilerArtifactSha256",
  );
});

function provenance(): DevelopmentBenchmarkProvenance {
  return {
    commit,
    hostInputsSha256: "1".repeat(64),
    benchmarkInputsSha256: "2".repeat(64),
    compilerArtifactSha256: "3".repeat(64),
    compilerManifestSha256: "4".repeat(64),
    compilerInputsSha256: "5".repeat(64),
    compilerPreludeSha256: "6".repeat(64),
    compilerSourceCommit: "7".repeat(40),
    compilerSourceTree: "8".repeat(40),
    compilerRustc: "rustc 1.0.0",
    compilerProfile: "production",
    environment: {
      os: "linux",
      architecture: "x86_64",
      cpuModels: ["Test CPU"],
      logicalCpuCount: 1,
      deno: "2.9.5",
      v8: "15.0",
      denoExecutableSha256: "9".repeat(64),
      denoInvocationSha256: "a".repeat(64),
    },
  };
}
