/** Target choices visible at the Blot compiler boundary. */
export interface CompilerTargetPolicy {
  /** Public Blot ABI major emitted at the caller boundary. */
  readonly abiMajor: number;
  /** Concrete WebAssembly target requested from the compiler. */
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

export function resolveTargetPolicy(
  policy: CompilerTargetPolicy | undefined,
): ResolvedCompilerTargetPolicy {
  let requested = policy;
  if (requested === undefined) requested = defaultCompilerTargetPolicy;
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
