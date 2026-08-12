// The gpufuck oracle keeps this compatibility import while Runtime-HIR lowering
// is compiler-owned. Production and development compiler code import
// `src/compiler/lower/runtime_hir.ts` directly.
export { exportResidualRuntimeHir } from "../../compiler/lower/runtime_hir.ts";
