export type CompilerStage =
  | "frontend"
  | "load"
  | "check"
  | "prepare"
  | "compile";

export interface CompilerRejection {
  readonly status: "rejected";
  readonly stage: CompilerStage;
  readonly code: string;
  readonly message: string;
}

export interface CompilerAcceptance {
  readonly status: "accepted";
  readonly exports: readonly string[];
  readonly manifest: string;
  readonly capabilities: readonly string[];
}

export type CompilerObservation = CompilerRejection | CompilerAcceptance;

export interface ParityGap {
  readonly path: string;
  readonly node: CompilerObservation;
  readonly rust: CompilerObservation;
  readonly differences: readonly string[];
}

export function compareObservations(
  path: string,
  node: CompilerObservation,
  rust: CompilerObservation,
): ParityGap | undefined {
  const differences: string[] = [];
  if (node.status !== rust.status) {
    differences.push("acceptance");
  } else if (node.status === "rejected" && rust.status === "rejected") {
    if (node.stage !== rust.stage) differences.push("rejection stage");
    if (node.code !== rust.code) differences.push("diagnostic code");
  } else if (node.status === "accepted" && rust.status === "accepted") {
    if (node.exports.join("\0") !== rust.exports.join("\0")) {
      differences.push("Runtime HIR exports");
    }
    if (node.manifest !== rust.manifest) differences.push("ABI manifest");
    if (node.capabilities.join("\0") !== rust.capabilities.join("\0")) {
      differences.push("capabilities");
    }
  }
  if (differences.length === 0) return undefined;
  return { path, node, rust, differences };
}

export interface ParityGapSignature {
  readonly path: string;
  readonly node: string;
  readonly rust: string;
  readonly differences: readonly string[];
}

export function parityGapSignature(gap: ParityGap): ParityGapSignature {
  return {
    path: gap.path,
    node: observationSignature(gap.node),
    rust: observationSignature(gap.rust),
    differences: gap.differences,
  };
}

export function sameParityGapBaseline(
  actual: readonly ParityGapSignature[],
  expected: readonly ParityGapSignature[],
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function observationSignature(observation: CompilerObservation): string {
  if (observation.status === "accepted") return "accepted";
  return `${observation.stage}:${observation.code}`;
}
