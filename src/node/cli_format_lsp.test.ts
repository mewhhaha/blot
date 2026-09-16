// Checkout tests for the Node `format` and `lsp` entry points.
//
// `format` must run the same formatSource engine as the Deno CLI (proved
// here against the facade directly and against the Deno `fmt` command on
// the same fixture); `lsp` must answer initialize over stdio and exit
// cleanly. The built-package twins of these tests live in
// scripts/package_contents.test.ts and run against emitted JavaScript.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { formatSource } from "../tooling/formatter.ts";

const execute = promisify(execFile);

function cli(...arguments_: string[]) {
  return execute(
    process.execPath,
    ["--import", "tsx", resolve("src/node/cli.ts"), ...arguments_],
    { timeout: 60_000, killSignal: "SIGKILL" },
  );
}

const FIXTURE = "const  pair  =  (1,   2)\nlet   x=1\nreturn (x,   pair)\n";

test("help advertises the format and lsp commands", async () => {
  const help = await cli("--help");
  assert.match(help.stdout, /blot format \[--check\] <file\.blot>\.\.\./);
  assert.match(help.stdout, /blot lsp/);
});

test("lsp with arguments is a usage error", async () => {
  await assert.rejects(cli("lsp", "extra.blot"), /usage: blot lsp/);
});

test("format writes the engine bytes and check refuses ragged input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-format-"));
  try {
    const formatted = await formatSource(FIXTURE);
    if (!formatted.ok) throw new Error(JSON.stringify(formatted.diagnostics));
    assert.notEqual(formatted.source, FIXTURE);

    const path = join(directory, "program.blot");
    await writeFile(path, FIXTURE);
    await assert.rejects(cli("format", "--check", path), /needs formatting/);
    const written = await cli("format", path);
    assert.match(written.stdout, /program\.blot/);
    assert.equal(await readFile(path, "utf8"), formatted.source);
    await cli("format", "--check", path);

    await assert.rejects(cli("format"), /usage: blot/);
    await assert.rejects(cli("format", "--check"), /requires at least one/);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("Node format matches Deno fmt bytes on the same fixture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-format parity-"));
  try {
    const nodePath = join(directory, "node.blot");
    const denoPath = join(directory, "deno.blot");
    await writeFile(nodePath, FIXTURE);
    await writeFile(denoPath, FIXTURE);
    await cli("format", nodePath);
    await execute(
      "deno",
      [
        "run",
        "--allow-read",
        "--allow-write",
        resolve("src/cli.ts"),
        "fmt",
        denoPath,
      ],
      { timeout: 60_000, killSignal: "SIGKILL" },
    );
    assert.equal(
      await readFile(nodePath, "utf8"),
      await readFile(denoPath, "utf8"),
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("lsp answers initialize over stdio and exits cleanly", async () => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve("src/node/cli.ts"), "lsp"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => {
    chunks.push(chunk);
  });
  const frame = (message: unknown): Buffer => {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    return Buffer.concat([
      Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "utf8"),
      body,
    ]);
  };
  child.stdin.write(
    frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  );
  child.stdin.write(
    frame({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null }),
  );
  child.stdin.write(frame({ jsonrpc: "2.0", method: "exit", params: null }));
  child.stdin.end();
  const [code, stderr] = await new Promise<[number | null, string]>(
    (resolveWait, rejectWait) => {
      let text = "";
      child.stderr.on("data", (chunk) => {
        text += chunk.toString("utf8");
      });
      child.on("error", rejectWait);
      child.on("close", (exitCode) => {
        resolveWait([exitCode, text]);
      });
    },
  );
  assert.equal(code, 0);
  assert.equal(stderr, "");
  const messages = decodeFrames(Buffer.concat(chunks));
  assert.equal(messages.length, 2);
  const initialize = messages[0] as {
    readonly id: number;
    readonly result: {
      readonly capabilities: Record<string, unknown>;
    };
  };
  assert.equal(initialize.id, 1);
  assert.equal(
    initialize.result.capabilities["documentFormattingProvider"],
    true,
  );
  assert.deepEqual(messages[1], { jsonrpc: "2.0", id: 2, result: null });
});

function decodeFrames(bytes: Buffer): unknown[] {
  const messages: unknown[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const rest = bytes.toString("utf8", offset);
    const boundary = rest.indexOf("\r\n\r\n");
    if (boundary < 0) throw new Error("stdout carried non-frame bytes");
    const header = rest.slice(0, boundary);
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
    if (!Number.isInteger(length)) {
      throw new Error(`invalid Content-Length: ${header}`);
    }
    const bodyStart = offset + Buffer.byteLength(rest.slice(0, boundary + 4));
    const bodyEnd = bodyStart + length;
    messages.push(JSON.parse(bytes.toString("utf8", bodyStart, bodyEnd)));
    offset = bodyEnd;
  }
  return messages;
}
