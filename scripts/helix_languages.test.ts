// scripts/helix_languages.test.ts
//
// Pins the Helix installer's managed block: it must keep pointing at the
// Deno `lsp` command, keep `auto-format = true`, and add no client timeout
// override. The merge tests prove replace-or-append behavior; the boot
// test spawns the installed command over stdio through the shared e2e
// driver and proves it answers initialize and exits cleanly.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  cleanServerEnv,
  createToolchainTrap,
  readTrapMarkers,
  removeToolchainTrap,
  resolveServerCommand,
  type SpawnedLspServer,
  spawnLspServer,
} from "../test_support/lsp_stdio.ts";
import {
  helixBeginMarker,
  helixEndMarker,
  helixManagedBlock,
  installedLspCommand,
  installHelixManagedBlock,
  repositoryCliPath,
} from "./helix_languages.ts";

const BOOT_TIMEOUT_MS = 120_000;

function repositoryRoot(): string {
  return dirname(dirname(fromFileUrl(import.meta.url)));
}

Deno.test("the managed block points at the Deno lsp command", () => {
  const repository = repositoryRoot();
  const block = helixManagedBlock(repository);
  assert(block.startsWith(`${helixBeginMarker(repository)}\n`));
  assert(block.endsWith(`${helixEndMarker(repository)}\n`));
  assert(block.includes('command = "deno"'));
  const cliPath = repositoryCliPath(repository);
  assert(
    block.includes(
      `args = ["run", "--allow-read", "${cliPath}", "lsp"]`,
    ),
    "the managed block must install the Deno lsp command",
  );
  const installed = installedLspCommand(repository);
  assertEquals(installed.command, "deno");
  assertEquals(installed.args, ["run", "--allow-read", cliPath, "lsp"]);
});

Deno.test("the managed block keeps auto-format on with no timeout", () => {
  const block = helixManagedBlock(repositoryRoot());
  assert(block.includes("auto-format = true"));
  assert(!block.includes("auto-format = false"));
  assert(
    !block.toLowerCase().includes("timeout"),
    "the installer must not override the client timeout",
  );
});

Deno.test("installing merges the managed block idempotently", () => {
  const repository = repositoryRoot();
  const languagesPath = join(repository, "languages.toml");
  const merged = installHelixManagedBlock("", repository, languagesPath);
  assert(merged.includes(helixManagedBlock(repository)));
  const again = installHelixManagedBlock(merged, repository, languagesPath);
  assertEquals(again, merged);
  const prefixed = installHelixManagedBlock(
    "# user settings\n",
    repository,
    languagesPath,
  );
  assert(prefixed.startsWith("# user settings\n\n# >>> blot"));
});

Deno.test("installing refuses an unclosed managed block", () => {
  const repository = repositoryRoot();
  assertThrows(
    () =>
      installHelixManagedBlock(
        `${helixBeginMarker(repository)}\n[language]\n`,
        repository,
        "/tmp/languages.toml",
      ),
    Error,
    "no closing marker",
  );
});

Deno.test("the installed command boots and answers initialize", async () => {
  const repository = repositoryRoot();
  const trap = await createToolchainTrap();
  const installed = installedLspCommand(repository);
  const server = spawnLspServer(
    resolveServerCommand(installed.command),
    installed.args,
    {
      cwd: repository,
      env: cleanServerEnv(trap),
    },
  );
  try {
    const booted = await withTimeout(
      bootSession(server),
      BOOT_TIMEOUT_MS,
      server,
    );
    assertEquals(booted.exitCode, 0);
    assertEquals(await readTrapMarkers(trap), "");
    const stderr = await server.stderrText();
    const lowered = stderr.toLowerCase();
    for (const token of ["cargo", "rustc", "rustup", "notcapable"]) {
      assert(!lowered.includes(token), `server stderr mentions ${token}`);
    }
  } finally {
    server.kill();
    await removeToolchainTrap(trap).catch(() => undefined);
  }
});

interface BootOutcome {
  readonly exitCode: number;
}

async function bootSession(server: SpawnedLspServer): Promise<BootOutcome> {
  await server.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  const initialize = await nextResponse(server, 1);
  if (initialize.error !== undefined) {
    throw new Error(
      `installed command failed initialize: ${
        JSON.stringify(initialize.error)
      }`,
    );
  }
  const result = initialize.result as
    | { capabilities?: Record<string, unknown> }
    | null;
  if (result === null || typeof result !== "object") {
    throw new Error("installed command answered no initialize result");
  }
  const capabilities = result.capabilities;
  if (capabilities === undefined) {
    throw new Error("installed command omits its capabilities");
  }
  assertEquals(capabilities["documentFormattingProvider"], true);
  assertEquals(capabilities["codeActionProvider"], {
    resolveProvider: true,
    codeActionKinds: ["quickfix", "refactor.rewrite", "source.fixAll.blot"],
  });
  await server.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  await server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "shutdown",
    params: null,
  });
  const shutdown = await nextResponse(server, 2);
  assertEquals(shutdown.result, null);
  await server.send({ jsonrpc: "2.0", method: "exit", params: null });
  await server.finishStdin();
  while (true) {
    const trailing = await server.read();
    if (trailing === null) break;
    if (trailing.id !== undefined) {
      throw new Error("installed command settled a response after exit");
    }
  }
  return { exitCode: await server.wait() };
}

async function nextResponse(
  server: SpawnedLspServer,
  id: number,
): Promise<{ result?: unknown; error?: unknown }> {
  while (true) {
    const message = await server.read();
    if (message === null) throw new Error(`stdout closed before ${id} settled`);
    if (message.id === id) return message;
  }
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  server: SpawnedLspServer,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        server.kill();
        reject(
          new Error(`installed command timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      work.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
