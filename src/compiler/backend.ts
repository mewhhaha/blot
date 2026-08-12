import {
  type BlotRuntimeModule,
  validateBlotRuntimeModule,
  type ValidatedBlotRuntimeModule,
} from "../runtime/hir.ts";
import {
  compileBlotRuntimeModulesOnRustWasm,
  warmBlotRuntimeEmitter,
} from "./backend/runtime/target.ts";

/** Target choices visible at the Blot compiler boundary. */
export interface CompilerTargetPolicy {
  /** Public Blot ABI major emitted at the caller boundary. */
  readonly abiMajor: number;
  /** Concrete WebAssembly target requested from the production emitter. */
  readonly wasmTarget: string;
}

export interface ResolvedCompilerTargetPolicy {
  readonly abiMajor: 1;
  readonly wasmTarget: "wasm-simd128";
}

export const defaultCompilerTargetPolicy: CompilerTargetPolicy = Object.freeze({
  abiMajor: 1,
  wasmTarget: "wasm-simd128",
});

/** A requested compiler target is not supported by this compiler build. */
export class CompilerTargetRefusal extends Error {
  readonly code = "BLOT_TARGET_REFUSAL";

  constructor(message: string) {
    super(message);
    this.name = "CompilerTargetRefusal";
  }
}

/** A proved compiler fact failed after source checking had succeeded. */
export class CompilerInvariantFailure extends Error {
  readonly code = "BLOT_COMPILER_INVARIANT";

  constructor(phase: string, cause: unknown) {
    let detail = String(cause);
    if (cause instanceof Error) detail = cause.message;
    super(`${phase}: ${detail}`, { cause });
    this.name = "CompilerInvariantFailure";
  }
}

export interface BackendArtifact {
  readonly wasm: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly capabilities: readonly string[];
}

/**
 * The closed Node development representation immediately before emission.
 *
 * Rust has the same conceptual split: `hir::elaborate` produces Runtime HIR,
 * `backend::close` validates the public representation, and the closed program
 * compiles to Wasm. Keeping that shape here makes features straightforward to
 * port from TypeScript into the production compiler.
 */
export class ClosedProgram {
  readonly runtime: ValidatedBlotRuntimeModule;
  readonly policy: ResolvedCompilerTargetPolicy;

  constructor(
    runtime: ValidatedBlotRuntimeModule,
    policy: ResolvedCompilerTargetPolicy,
  ) {
    this.runtime = runtime;
    this.policy = policy;
  }

  async compile(): Promise<BackendArtifact> {
    let batch;
    try {
      batch = await compileBlotRuntimeModulesOnRustWasm(
        [this.runtime],
        { target: this.policy.wasmTarget },
      );
    } catch (error) {
      throw new CompilerInvariantFailure("backend emission", error);
    }
    const emitted = batch.artifacts[0];
    if (emitted === undefined || batch.artifacts.length !== 1) {
      throw new CompilerInvariantFailure(
        "backend emission",
        new Error(
          `gpupaper emitted ${batch.artifacts.length} artifacts for one module`,
        ),
      );
    }
    return {
      wasm: emitted.wasm.slice(),
      manifestBytes: emitted.manifestBytes.slice(),
      capabilities: Object.freeze([
        ...new Set(
          emitted.manifest.imports.map((imported) => imported.capability),
        ),
      ].sort()),
    };
  }
}

export function resolveTargetPolicy(
  policy: CompilerTargetPolicy | undefined,
): ResolvedCompilerTargetPolicy {
  const requested = policy === undefined ? defaultCompilerTargetPolicy : policy;
  if (requested.abiMajor !== 1) {
    throw new CompilerTargetRefusal(
      `Blot ABI major ${
        String(requested.abiMajor)
      } is not supported; expected 1`,
    );
  }
  if (requested.wasmTarget !== "wasm-simd128") {
    throw new CompilerTargetRefusal(
      `WebAssembly target ${requested.wasmTarget} is not supported; expected wasm-simd128`,
    );
  }
  return Object.freeze({ abiMajor: 1, wasmTarget: "wasm-simd128" });
}

export function warmBackend(): void {
  warmBlotRuntimeEmitter();
}

export function close(
  runtime: BlotRuntimeModule,
  policy: ResolvedCompilerTargetPolicy,
): ClosedProgram {
  let validated: ValidatedBlotRuntimeModule;
  try {
    validated = validateBlotRuntimeModule(runtime);
  } catch (error) {
    throw new CompilerInvariantFailure("Runtime HIR validation", error);
  }
  return new ClosedProgram(validated, policy);
}
