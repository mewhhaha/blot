// src/lsp_spawn.test.ts
//
// End-to-end proof for the installed Helix command: this spawns the REAL
// `deno run --allow-read src/cli.ts lsp` process over stdio (no in-process
// shortcut) in a clean environment, drives open, a typing burst, format,
// shutdown, and exit, and asserts the session settles every request, emits
// protocol frames only, initializes no GPU device, invokes no native
// toolchain, and exits cleanly.
//
// The command under test comes from scripts/helix_languages.ts, the same
// module the installer renders into `languages.toml`, so this test tracks
// the installer: if the managed block ever points elsewhere, this proves
// the new target instead of a stale copy.

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl } from "@std/path";
import {
  cleanServerEnv,
  createToolchainTrap,
  GpuProbe,
  inspectThreads,
  readTrapMarkers,
  removeToolchainTrap,
  resolveServerCommand,
  type SpawnedLspServer,
  spawnLspServer,
  watchGpu,
} from "../test_support/lsp_stdio.ts";
import { installedLspCommand } from "../scripts/helix_languages.ts";
import type { InboundMessage } from "./lsp/transport.ts";
import { offsetAtPosition } from "./text/document.ts";

const BURST_CHANGES = 12;
const SESSION_TIMEOUT_MS = 180_000;

Deno.test("the installed command serves a burst session and exits cleanly", async () => {
  const repository = dirname(dirname(fromFileUrl(import.meta.url)));
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
  const probe = new GpuProbe(server.pid);
  // The runtime holds a render node from exec, before user code runs;
  // snapshot that baseline before the session sends anything.
  for (let sample = 0; sample < 5; sample += 1) {
    await probe.sample();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  probe.takeBaseline();
  const sessionDone = runSession(server);
  const watching = watchGpu(probe, sessionDone);
  try {
    const outcome = await withTimeout(sessionDone, SESSION_TIMEOUT_MS, server);
    await watching;
    assertEquals(probe.mapHits(), []);
    assertEquals(probe.fdHits(), []);
    if (Deno.build.os === "linux") {
      assert(probe.supported, "the GPU probe found no /proc to inspect");
    }
    assertEquals(await readTrapMarkers(trap), "");
    const stderr = await server.stderrText();
    assertNoToolchainOrGpuTrace(stderr);
    assertEquals(outcome.exitCode, 0);
  } finally {
    server.kill();
    await removeToolchainTrap(trap).catch(() => undefined);
  }
});

Deno.test("the installed command runs lanes on worker threads", async () => {
  // A format that shares the semantic thread freezes behind analysis; the
  // shipped entry must boot one worker per lane so formatting never waits
  // on the compiler. Deno names worker threads worker-N, so two such
  // threads after exercising both lanes proves the deployment. An inline
  // entry would answer identically with zero worker threads.
  const repository = dirname(dirname(fromFileUrl(import.meta.url)));
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
  const seen = new Map<number, InboundMessage>();
  try {
    await server.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    await server.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    const uri = "untitled:worker-lanes.blot";
    await server.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri, version: 1, text: "let   x=1\nreturn x\n" },
      },
    });
    await server.send({
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/hover",
      params: {
        textDocument: { uri },
        position: { line: 1, character: 7 },
      },
    });
    await server.send({
      jsonrpc: "2.0",
      id: 3,
      method: "textDocument/formatting",
      params: { textDocument: { uri }, options: {} },
    });
    await collectResponses(server, seen, [1, 2, 3]);
    assertSettled(seen.get(2), 2);
    assertFormattingResult(seen.get(3), "let   x=1\nreturn x\n");
    // Both lanes answered, so both workers booted; their threads persist.
    const threads = await inspectThreads(server.pid);
    if (Deno.build.os === "linux") {
      assert(threads.supported, "thread inspection found no /proc to read");
    }
    if (threads.supported) {
      const workers = threads.names.filter((name) => /^worker-\d+$/.test(name));
      assert(
        workers.length >= 2,
        `expected syntax and semantic worker threads, saw: ${
          threads.names.join(", ")
        }`,
      );
    }
    await server.send({
      jsonrpc: "2.0",
      id: 4,
      method: "shutdown",
      params: null,
    });
    await collectResponses(server, seen, [4]);
    assertShutdownResult(seen.get(4));
    await server.send({ jsonrpc: "2.0", method: "exit", params: null });
    await server.finishStdin();
    assertEquals(await server.wait(), 0);
  } finally {
    server.kill();
    await removeToolchainTrap(trap).catch(() => undefined);
  }
});

interface SessionOutcome {
  readonly exitCode: number;
}

async function runSession(server: SpawnedLspServer): Promise<SessionOutcome> {
  const uri = "untitled:spawn-burst.blot";
  const base = "let   x=1\nreturn x\n";
  const alternate = "let   x=1\nreturn x \n";
  const seen = new Map<number, InboundMessage>();

  await server.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  await server.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  await server.send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri, version: 1, text: base } },
  });
  for (let change = 0; change < BURST_CHANGES; change += 1) {
    let text = base;
    if (change % 2 === 0) text = alternate;
    await server.send({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version: 2 + change },
        contentChanges: [{ text }],
      },
    });
  }
  let finalText = base;
  if (BURST_CHANGES % 2 !== 0) finalText = alternate;
  // The burst stays in flight while these requests queue behind it: every
  // id must still settle exactly once, which is the responsiveness proof.
  for (const id of [2, 3, 4, 5]) {
    await server.send({
      jsonrpc: "2.0",
      id,
      method: "textDocument/hover",
      params: {
        textDocument: { uri },
        position: { line: 1, character: 7 },
      },
    });
  }
  await server.send({
    jsonrpc: "2.0",
    id: 6,
    method: "textDocument/formatting",
    params: { textDocument: { uri }, options: {} },
  });

  await collectResponses(server, seen, [1, 2, 3, 4, 5, 6]);
  assertInitializeResult(seen.get(1));
  for (const id of [2, 3, 4, 5]) {
    assertSettled(seen.get(id), id);
  }
  assertFormattingResult(seen.get(6), finalText);

  await server.send({
    jsonrpc: "2.0",
    id: 7,
    method: "shutdown",
    params: null,
  });
  await collectResponses(server, seen, [7]);
  assertShutdownResult(seen.get(7));
  await server.send({ jsonrpc: "2.0", method: "exit", params: null });
  await server.finishStdin();
  // Draining to null proves stdout carried protocol frames only: any stray
  // byte outside a frame ends the stream as a truncation error instead.
  while (true) {
    const trailing = await server.read();
    if (trailing === null) break;
    if (trailing.id !== undefined) {
      throw new Error(
        `unexpected settled response after exit: ${
          JSON.stringify(trailing.id)
        }`,
      );
    }
  }
  return { exitCode: await server.wait() };
}

async function collectResponses(
  server: SpawnedLspServer,
  seen: Map<number, InboundMessage>,
  wanted: readonly number[],
): Promise<void> {
  const missing = new Set(wanted);
  while (missing.size > 0) {
    const message = await server.read();
    if (message === null) {
      throw new Error(
        `stdout closed with unsettled requests: ${[...missing].join(", ")}`,
      );
    }
    if (message.id === undefined || typeof message.id !== "number") continue;
    if (seen.has(message.id)) {
      throw new Error(`request ${message.id} settled twice`);
    }
    seen.set(message.id, message);
    missing.delete(message.id);
  }
}

function assertInitializeResult(message: InboundMessage | undefined): void {
  if (message === undefined) throw new Error("initialize never settled");
  if (message.error !== undefined) {
    throw new Error(`initialize failed: ${JSON.stringify(message.error)}`);
  }
  const result = message.result as
    | { capabilities?: Record<string, unknown> }
    | null;
  if (result === null || typeof result !== "object") {
    throw new Error("initialize result is not an object");
  }
  const capabilities = result.capabilities;
  if (capabilities === undefined) throw new Error("initialize omits abilities");
  assertEquals(capabilities["documentFormattingProvider"], true);
}

function assertSettled(message: InboundMessage | undefined, id: number): void {
  if (message === undefined) throw new Error(`request ${id} never settled`);
  const settled = message.result !== undefined || message.error !== undefined;
  assert(settled, `request ${id} settled with neither result nor error`);
}

function assertShutdownResult(message: InboundMessage | undefined): void {
  if (message === undefined) throw new Error("shutdown never settled");
  if (message.error !== undefined) {
    throw new Error(`shutdown failed: ${JSON.stringify(message.error)}`);
  }
  assertEquals(message.result, null);
}

interface FormatEdit {
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly newText: string;
}

function assertFormattingResult(
  message: InboundMessage | undefined,
  finalText: string,
): void {
  if (message === undefined) throw new Error("formatting never settled");
  if (message.error !== undefined) {
    throw new Error(`formatting failed: ${JSON.stringify(message.error)}`);
  }
  const edits = message.result as readonly FormatEdit[];
  assert(Array.isArray(edits), "formatting result is not an edit array");
  assert(edits.length > 0, "formatting returned no edits for ragged input");
  let applied = finalText;
  for (const edit of edits) {
    const start = offsetAtPosition(applied, edit.range.start);
    const end = offsetAtPosition(applied, edit.range.end);
    applied = applied.slice(0, start) + edit.newText + applied.slice(end);
  }
  assert(
    applied !== finalText,
    "formatting edits do not change the document",
  );
  assertEquals(edits, [{
    range: {
      start: { line: 0, character: 4 },
      end: { line: 0, character: 8 },
    },
    newText: "x = ",
  }]);
}

function assertNoToolchainOrGpuTrace(stderr: string): void {
  const lowered = stderr.toLowerCase();
  const forbidden = [
    "webgpu",
    "wgpu",
    "requestadapter",
    "dawn",
    "vulkan",
    "cargo",
    "rustc",
    "rustup",
    "notcapable",
  ];
  for (const token of forbidden) {
    assert(
      !lowered.includes(token),
      `server stderr mentions ${token}: ${stderr.slice(0, 500)}`,
    );
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
          new Error(`spawned session timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      work.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
