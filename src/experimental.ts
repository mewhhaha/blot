/**
 * The opt-in single-WebAssembly Blot compiler.
 *
 * This API is experimental: its source-to-Wasm behavior follows Blot, but its
 * TypeScript interface may change between package releases while the Rust
 * implementation is evaluated against the default compiler.
 */
export {
  type RustCheckedModule as ExperimentalCheckedModule,
  type RustCompilerArtifact as ExperimentalCompilerArtifact,
  RustMiddleCompiler as ExperimentalCompiler,
} from "./backend/rust_middle.ts";
