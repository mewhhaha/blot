// test_support/lsp_stdio.ts
//
// Shared driver for tests that spawn a REAL language-server process over
// stdio and speak framed LSP to it. The e2e suite (src/lsp_spawn.test.ts)
// and the installer suite (scripts/helix_languages.test.ts) both drive the
// installed command through this module, so the installer test reuses the
// exact spawn path the e2e test proves.
//
// The driver also carries the negative-environment probes: a toolchain trap
// directory (cargo/rustc/rustup shims that record any invocation) and a
// GPU probe that watches /proc for device opens and driver mappings while
// the server runs. Ordinary editor startup must trip neither.

import {
  encodeFrame,
  FrameReader,
  type InboundMessage,
} from "../src/lsp/transport.ts";

/**
 * Resolves a bare `deno` command to the running binary. The installed block
 * spells `command = "deno"` for Helix to resolve through the login PATH;
 * tests spawn with a replaced PATH that cannot resolve it, so they execute
 * the same binary with the identical argument list instead.
 */
export function resolveServerCommand(command: string): string {
  if (command === "deno") return Deno.execPath();
  return command;
}

/** A live server process with framed writers and readers attached. */
export interface SpawnedLspServer {
  readonly pid: number;
  send(message: unknown): Promise<void>;
  read(): Promise<InboundMessage | null>;
  finishStdin(): Promise<void>;
  stderrText(): Promise<string>;
  wait(): Promise<number>;
  kill(): void;
}

/** Spawns a server with a fully replaced environment over piped stdio. */
export function spawnLspServer(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Record<string, string> },
): SpawnedLspServer {
  const child = new Deno.Command(command, {
    args: [...args],
    cwd: options.cwd,
    clearEnv: true,
    env: options.env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  const reader = new FrameReader(child.stdout.getReader());
  const stderrChunks: Uint8Array[] = [];
  const stderrDone = drainStream(child.stderr, stderrChunks);
  let stdinFinished = false;
  return {
    pid: child.pid,
    async send(message: unknown): Promise<void> {
      await writer.write(encodeFrame(message));
    },
    read(): Promise<InboundMessage | null> {
      return reader.read();
    },
    async finishStdin(): Promise<void> {
      if (stdinFinished) return;
      stdinFinished = true;
      await writer.close().catch(() => undefined);
    },
    async stderrText(): Promise<string> {
      await stderrDone;
      return new TextDecoder().decode(concatBytes(stderrChunks));
    },
    async wait(): Promise<number> {
      const status = await child.status;
      return status.code;
    },
    kill(): void {
      try {
        child.kill();
      } catch {
        // The process already exited; the test asserts the outcome.
      }
    },
  };
}

async function drainStream(
  stream: ReadableStream<Uint8Array>,
  chunks: Uint8Array[],
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * A PATH trap: executable `cargo`, `rustc`, and `rustup` shims that record
 * any invocation and fail. Prepend `directory` to the server PATH; an empty
 * marker file afterwards proves no native toolchain ran during the session.
 */
export interface ToolchainTrap {
  readonly directory: string;
  readonly markerPath: string;
}

/** Creates a toolchain trap directory with failing recorder shims. */
export async function createToolchainTrap(): Promise<ToolchainTrap> {
  const directory = await Deno.makeTempDir({ prefix: "blot-toolchain-trap-" });
  const markerPath = `${directory}/invocations`;
  for (const name of ["cargo", "rustc", "rustup"]) {
    const shim = `${directory}/${name}`;
    await Deno.writeTextFile(
      shim,
      `#!/bin/sh\necho "${name} invoked" >> "${markerPath}"\nexit 1\n`,
    );
    await Deno.chmod(shim, 0o755);
  }
  return { directory, markerPath };
}

/** Reads the trap markers: empty means the toolchain never ran. */
export async function readTrapMarkers(trap: ToolchainTrap): Promise<string> {
  try {
    return await Deno.readTextFile(trap.markerPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "";
    throw error;
  }
}

/** Removes a toolchain trap directory. */
export async function removeToolchainTrap(
  trap: ToolchainTrap,
): Promise<void> {
  await Deno.remove(trap.directory, { recursive: true });
}

/**
 * Builds the clean server environment: an explicit allowlist with the trap
 * first on PATH. The server inherits nothing else: no cargo/rustup
 * configuration, no GPU loader overrides, and no developer shell state.
 */
export function cleanServerEnv(trap: ToolchainTrap): Record<string, string> {
  const home = Deno.env.get("HOME");
  if (home === undefined) throw new Error("HOME is not set");
  return {
    PATH: `${trap.directory}:/usr/bin:/bin`,
    HOME: home,
    DENO_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    CLICOLOR: "0",
  };
}

/** One observed GPU touch: where it was seen and what matched. */
export interface GpuTouch {
  readonly source: "fd" | "maps";
  readonly detail: string;
}

/**
 * Mapping-name fragments that never appear in a stock Deno runtime but do
 * appear once an adapter plus device is created (positive control:
 * requestAdapter/requestDevice maps libvulkan_radeon and libnvidia paths).
 */
const GPU_MAP_TOKENS: readonly string[] = [
  "vulkan",
  "libnvidia",
  "nvidia",
  "dawn",
  "wgpu",
  "radeon",
  "amdgpu",
  "nouveau",
  "mesa",
  "/dev/dri",
  "/dev/nvidia",
];

/**
 * Watches a live process for GPU device initialization through two signals:
 * memory mappings naming a GPU loader or driver, and file descriptors under
 * /dev/dri or /dev/nvidia.
 *
 * The descriptor signal is baseline-relative: the Deno runtime itself holds
 * a render node (and dmabuf handles) from exec, before any user code runs,
 * so the test snapshots that baseline right after spawn and only new
 * targets count as hits. The mapping signal is absolute: a stock runtime
 * maps no GPU loader or driver, while adapter plus device creation dlopens
 * several (verified against a requestAdapter/requestDevice positive
 * control). Outside Linux /proc the probe reports unsupported rather than
 * a vacuous clean bill.
 */
export class GpuProbe {
  readonly #pid: number;
  readonly #observedFdTargets = new Set<string>();
  #baselineFdTargets: Set<string> | undefined = undefined;
  readonly #mapHits = new Map<string, GpuTouch>();
  #supported: boolean | undefined = undefined;

  constructor(pid: number) {
    this.#pid = pid;
  }

  /**
   * Polls once; safe to call on any platform. Never throws: a process
   * that exits mid-poll simply yields no further observations.
   */
  async sample(): Promise<void> {
    try {
      await this.#sampleFds();
    } catch {
      // The process exited mid-poll or the platform hides /proc.
    }
    try {
      await this.#sampleMaps();
    } catch {
      // The process exited mid-poll or the platform hides /proc.
    }
  }

  /**
   * Snapshots the runtime descriptor baseline. Call after spawn, before
   * the session under test sends anything.
   */
  takeBaseline(): void {
    this.#baselineFdTargets = new Set(this.#observedFdTargets);
  }

  /** Whether the platform exposed process inspection to the probe. */
  get supported(): boolean {
    return this.#supported === true;
  }

  /** GPU descriptor targets observed beyond the spawn baseline. */
  fdHits(): readonly string[] {
    const baseline = this.#baselineFdTargets;
    const hits: string[] = [];
    for (const target of this.#observedFdTargets) {
      if (baseline === undefined || !baseline.has(target)) hits.push(target);
    }
    return hits.sort();
  }

  /** Every distinct GPU loader or driver mapping observed. */
  mapHits(): readonly GpuTouch[] {
    return [...this.#mapHits.values()];
  }

  async #sampleFds(): Promise<void> {
    try {
      for await (const entry of Deno.readDir(`/proc/${this.#pid}/fd`)) {
        this.#supported = true;
        let target = "";
        try {
          target = await Deno.readLink(`/proc/${this.#pid}/fd/${entry.name}`);
        } catch {
          continue;
        }
        if (
          target.startsWith("/dev/dri/") || target.startsWith("/dev/nvidia")
        ) {
          this.#observedFdTargets.add(target);
        }
      }
    } catch {
      // Missing /proc or an exited process: nothing more to observe.
    }
  }

  async #sampleMaps(): Promise<void> {
    let maps = "";
    try {
      maps = await Deno.readTextFile(`/proc/${this.#pid}/maps`);
    } catch {
      return;
    }
    this.#supported = true;
    const lowered = maps.toLowerCase();
    for (const token of GPU_MAP_TOKENS) {
      if (lowered.includes(token)) {
        this.#mapHits.set(token, { source: "maps", detail: token });
      }
    }
  }
}

/**
 * Samples a probe until `done` resolves, then returns the probe. The
 * interval keeps running while the server works so transient device opens
 * are caught, not just steady-state mappings.
 */
export async function watchGpu(
  probe: GpuProbe,
  done: Promise<unknown>,
  intervalMs = 25,
): Promise<GpuProbe> {
  let finished = false;
  void done.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  while (!finished) {
    await probe.sample();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  await probe.sample();
  return probe;
}
