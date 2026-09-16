// Characterization counters for the Baba-facing frontend path in
// src/syntax/parse.ts. Each counter records how many times parseConcrete (or
// one of its stages) ran in this process. The stages mirror parseConcrete's
// pipeline order: layout elaboration, generated lexing, Baba CPU parse, CST
// materialization, lowering, then surface elaboration. A stage counts when it
// is attempted, so a failure stops later stages from counting.
//
// The counters are process-global plain increments with negligible overhead.
// They never write to stdout. Tests use resetFrontendMetrics and
// snapshotFrontendMetrics; the record functions below are internal wiring for
// parse.ts and are not part of the test API.

export interface FrontendMetricsSnapshot {
  readonly parseConcrete: number;
  readonly layoutElaboration: number;
  readonly generatedLexing: number;
  readonly babaCpuParse: number;
  readonly cstMaterialization: number;
  readonly lowering: number;
  readonly surfaceElaboration: number;
}

const counters = {
  parseConcrete: 0,
  layoutElaboration: 0,
  generatedLexing: 0,
  babaCpuParse: 0,
  cstMaterialization: 0,
  lowering: 0,
  surfaceElaboration: 0,
};

export function resetFrontendMetrics(): void {
  counters.parseConcrete = 0;
  counters.layoutElaboration = 0;
  counters.generatedLexing = 0;
  counters.babaCpuParse = 0;
  counters.cstMaterialization = 0;
  counters.lowering = 0;
  counters.surfaceElaboration = 0;
}

export function snapshotFrontendMetrics(): FrontendMetricsSnapshot {
  return { ...counters };
}

export function recordParseConcreteInvocation(): void {
  counters.parseConcrete += 1;
}

export function recordLayoutElaboration(): void {
  counters.layoutElaboration += 1;
}

export function recordGeneratedLexing(): void {
  counters.generatedLexing += 1;
}

export function recordBabaCpuParse(): void {
  counters.babaCpuParse += 1;
}

export function recordCstMaterialization(): void {
  counters.cstMaterialization += 1;
}

export function recordLowering(): void {
  counters.lowering += 1;
}

export function recordSurfaceElaboration(): void {
  counters.surfaceElaboration += 1;
}
