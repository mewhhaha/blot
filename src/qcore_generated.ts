// Generated from qcore/schema.json by scripts/generate_qcore.ts. Do not edit.

export const qcoreSchemaVersion = 4;

export interface ValueId {
  readonly value_id: number;
}

export interface ComputationId {
  readonly computation_id: number;
}

export interface EffectRowId {
  readonly effect_row_id: number;
}

export interface GradeId {
  readonly grade_id: number;
}

export interface ProofId {
  readonly proof_id: number;
}

export interface SourceOriginId {
  readonly source_origin_id: number;
}

export interface DefinitionKey {
  readonly definition_key: string;
}

export interface SemanticKey {
  readonly semantic_key: string;
}

export enum UniverseTag {
  TypeUniverse = 0,
  Prop = 1,
}

export type Universe =
  | {
    readonly tag: UniverseTag.TypeUniverse;
    readonly level: number;
  }
  | {
    readonly tag: UniverseTag.Prop;
  };

export enum GradeUpperBoundTag {
  Finite = 0,
  Unbounded = 1,
}

export type GradeUpperBound =
  | {
    readonly tag: GradeUpperBoundTag.Finite;
    readonly value: number;
  }
  | {
    readonly tag: GradeUpperBoundTag.Unbounded;
  };

export enum EffectRowTag {
  Empty = 0,
  Variable = 1,
  Extend = 2,
}

export type EffectRow =
  | {
    readonly tag: EffectRowTag.Empty;
  }
  | {
    readonly tag: EffectRowTag.Variable;
    readonly index: number;
  }
  | {
    readonly tag: EffectRowTag.Extend;
    readonly effect: SemanticKey;
    readonly tail: EffectRowId;
  };

export enum RangeDomainTag {
  Integer = 0,
  Text = 1,
  Float64 = 2,
  Float32 = 3,
}

export type RangeDomain =
  | {
    readonly tag: RangeDomainTag.Integer;
  }
  | {
    readonly tag: RangeDomainTag.Text;
  }
  | {
    readonly tag: RangeDomainTag.Float64;
  }
  | {
    readonly tag: RangeDomainTag.Float32;
  };

export enum ScalarBoundTag {
  Unbounded = 0,
  Integer = 1,
  Text = 2,
}

export type ScalarBound =
  | {
    readonly tag: ScalarBoundTag.Unbounded;
  }
  | {
    readonly tag: ScalarBoundTag.Integer;
    readonly decimal: string;
  }
  | {
    readonly tag: ScalarBoundTag.Text;
    readonly value: string;
  };

export enum ValueTag {
  BoundVariable = 0,
  GlobalDefinition = 1,
  Universe = 2,
  DependentPi = 3,
  DependentSigma = 4,
  Lambda = 5,
  Pair = 6,
  FirstProjection = 7,
  SecondProjection = 8,
  Thunk = 9,
  EffectRow = 10,
  IntervalGrade = 11,
  Proof = 12,
  StructuralRigid = 13,
  StructuralForall = 14,
  StructuralRange = 15,
  StructuralUnit = 16,
  StructuralFunction = 17,
  StructuralRecord = 18,
  StructuralRecordUpdate = 19,
  StructuralArray = 20,
  StructuralRegion = 21,
  StructuralScratch = 22,
  StructuralVariant = 23,
  StructuralEffects = 24,
  StructuralOpenEffects = 25,
  StructuralUnion = 26,
  StructuralOpaque = 27,
  StructuralTop = 28,
  StructuralBottom = 29,
  StructuralQualified = 30,
}

export type Value =
  | {
    readonly tag: ValueTag.BoundVariable;
    readonly index: number;
  }
  | {
    readonly tag: ValueTag.GlobalDefinition;
    readonly definition: DefinitionKey;
    readonly semantics: SemanticKey;
  }
  | {
    readonly tag: ValueTag.Universe;
    readonly universe: Universe;
  }
  | {
    readonly tag: ValueTag.DependentPi;
    readonly domain: ValueId;
    readonly codomain: ValueId;
    readonly effects: EffectRowId;
    readonly grade: GradeId;
  }
  | {
    readonly tag: ValueTag.DependentSigma;
    readonly first: ValueId;
    readonly second: ValueId;
  }
  | {
    readonly tag: ValueTag.Lambda;
    readonly body: ComputationId;
  }
  | {
    readonly tag: ValueTag.Pair;
    readonly first: ValueId;
    readonly second: ValueId;
  }
  | {
    readonly tag: ValueTag.FirstProjection;
    readonly pair: ValueId;
  }
  | {
    readonly tag: ValueTag.SecondProjection;
    readonly pair: ValueId;
  }
  | {
    readonly tag: ValueTag.Thunk;
    readonly computation: ComputationId;
  }
  | {
    readonly tag: ValueTag.EffectRow;
    readonly row: EffectRowId;
  }
  | {
    readonly tag: ValueTag.IntervalGrade;
    readonly grade: GradeId;
  }
  | {
    readonly tag: ValueTag.Proof;
    readonly proof: ProofId;
    readonly proposition: ValueId;
  }
  | {
    readonly tag: ValueTag.StructuralRigid;
    readonly variable: number;
  }
  | {
    readonly tag: ValueTag.StructuralForall;
    readonly variables: readonly number[];
    readonly body: ValueId;
  }
  | {
    readonly tag: ValueTag.StructuralRange;
    readonly domain: RangeDomain;
    readonly low: ScalarBound;
    readonly high: ScalarBound;
  }
  | {
    readonly tag: ValueTag.StructuralUnit;
  }
  | {
    readonly tag: ValueTag.StructuralFunction;
    readonly deferred: boolean;
    readonly parameter: ValueId;
    readonly effects: ValueId;
    readonly result: ValueId;
  }
  | {
    readonly tag: ValueTag.StructuralRecord;
    readonly labels: readonly string[];
    readonly field_types: readonly ValueId[];
  }
  | {
    readonly tag: ValueTag.StructuralRecordUpdate;
    readonly base: ValueId;
    readonly labels: readonly string[];
    readonly field_types: readonly ValueId[];
  }
  | {
    readonly tag: ValueTag.StructuralArray;
    readonly element: ValueId;
  }
  | {
    readonly tag: ValueTag.StructuralRegion;
    readonly element: ValueId;
  }
  | {
    readonly tag: ValueTag.StructuralScratch;
    readonly element: ValueId;
  }
  | {
    readonly tag: ValueTag.StructuralVariant;
    readonly labels: readonly string[];
    readonly payload_types: readonly ValueId[];
    readonly open: boolean;
  }
  | {
    readonly tag: ValueTag.StructuralEffects;
    readonly labels: readonly string[];
  }
  | {
    readonly tag: ValueTag.StructuralOpenEffects;
    readonly labels: readonly string[];
    readonly tail: ValueId;
  }
  | {
    readonly tag: ValueTag.StructuralUnion;
    readonly members: readonly ValueId[];
  }
  | {
    readonly tag: ValueTag.StructuralOpaque;
    readonly name: string;
  }
  | {
    readonly tag: ValueTag.StructuralTop;
  }
  | {
    readonly tag: ValueTag.StructuralBottom;
  }
  | {
    readonly tag: ValueTag.StructuralQualified;
    readonly body: ValueId;
    readonly names: readonly string[];
    readonly subjects: readonly ValueId[];
    readonly members: readonly ValueId[];
  };

export enum ComputationTag {
  ReturnValue = 0,
  LetValue = 1,
  Bind = 2,
  Apply = 3,
  Force = 4,
  Perform = 5,
  Handle = 6,
}

export type Computation =
  | {
    readonly tag: ComputationTag.ReturnValue;
    readonly value: ValueId;
  }
  | {
    readonly tag: ComputationTag.LetValue;
    readonly value: ValueId;
    readonly body: ComputationId;
  }
  | {
    readonly tag: ComputationTag.Bind;
    readonly first: ComputationId;
    readonly body: ComputationId;
  }
  | {
    readonly tag: ComputationTag.Apply;
    readonly function: ValueId;
    readonly argument: ValueId;
  }
  | {
    readonly tag: ComputationTag.Force;
    readonly thunk: ValueId;
  }
  | {
    readonly tag: ComputationTag.Perform;
    readonly effect: SemanticKey;
    readonly operation: SemanticKey;
    readonly argument: ValueId;
  }
  | {
    readonly tag: ComputationTag.Handle;
    readonly effect: SemanticKey;
    readonly body: ComputationId;
    readonly handler: ValueId;
  };

export enum DefinitionBodyTag {
  Value = 0,
  Computation = 1,
}

export type DefinitionBody =
  | {
    readonly tag: DefinitionBodyTag.Value;
    readonly value: ValueId;
    readonly expected_type: ValueId;
  }
  | {
    readonly tag: DefinitionBodyTag.Computation;
    readonly computation: ComputationId;
    readonly result_type: ValueId;
    readonly effects: EffectRowId;
  };

export interface SourceOrigin {
  readonly source: SemanticKey;
  readonly start: number;
  readonly end: number;
}

export interface DefinitionReference {
  readonly definition: DefinitionKey;
  readonly semantics: SemanticKey;
  readonly origin: SourceOriginId;
}

export interface GradeInterval {
  readonly lower: number;
  readonly upper: GradeUpperBound;
}

export interface ProofReference {
  readonly proof: ProofId;
  readonly proposition: ValueId;
  readonly origin: SourceOriginId;
}

export interface ValueNode {
  readonly origin: SourceOriginId;
  readonly term: Value;
}

export interface ComputationNode {
  readonly origin: SourceOriginId;
  readonly term: Computation;
}

export interface EffectRowNode {
  readonly origin: SourceOriginId;
  readonly row: EffectRow;
}

export interface GradeNode {
  readonly origin: SourceOriginId;
  readonly interval: GradeInterval;
}

export interface Definition {
  readonly reference: DefinitionReference;
  readonly body: DefinitionBody;
}

export interface QArena {
  readonly origins: readonly SourceOrigin[];
  readonly values: readonly ValueNode[];
  readonly computations: readonly ComputationNode[];
  readonly effect_rows: readonly EffectRowNode[];
  readonly grades: readonly GradeNode[];
  readonly proofs: readonly ProofReference[];
}

export interface QModule {
  readonly schema_version: number;
  readonly module: SemanticKey;
  readonly effect_parameter_count: number;
  readonly imports: readonly DefinitionReference[];
  readonly definitions: readonly Definition[];
  readonly arena: QArena;
}
