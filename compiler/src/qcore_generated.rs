// Generated from qcore/schema.json by scripts/generate_qcore.ts. Do not edit.

pub const QCORE_SCHEMA_VERSION: u32 = 3;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ValueId(pub u32);

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ComputationId(pub u32);

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct EffectRowId(pub u32);

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct GradeId(pub u32);

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ProofId(pub u32);

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct SourceOriginId(pub u32);

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct DefinitionKey(pub String);

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct SemanticKey(pub String);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum UniverseTag {
    TypeUniverse = 0,
    Prop = 1,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum Universe {
    TypeUniverse { level: u32 },
    Prop,
}

impl Universe {
    pub const fn tag(&self) -> UniverseTag {
        match self {
            Self::TypeUniverse { .. } => UniverseTag::TypeUniverse,
            Self::Prop => UniverseTag::Prop,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum GradeUpperBoundTag {
    Finite = 0,
    Unbounded = 1,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum GradeUpperBound {
    Finite { value: u32 },
    Unbounded,
}

impl GradeUpperBound {
    pub const fn tag(&self) -> GradeUpperBoundTag {
        match self {
            Self::Finite { .. } => GradeUpperBoundTag::Finite,
            Self::Unbounded => GradeUpperBoundTag::Unbounded,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum EffectRowTag {
    Empty = 0,
    Variable = 1,
    Extend = 2,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum EffectRow {
    Empty,
    Variable {
        index: u32,
    },
    Extend {
        effect: SemanticKey,
        tail: EffectRowId,
    },
}

impl EffectRow {
    pub const fn tag(&self) -> EffectRowTag {
        match self {
            Self::Empty => EffectRowTag::Empty,
            Self::Variable { .. } => EffectRowTag::Variable,
            Self::Extend { .. } => EffectRowTag::Extend,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum RangeDomainTag {
    Integer = 0,
    Text = 1,
    Float64 = 2,
    Float32 = 3,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum RangeDomain {
    Integer,
    Text,
    Float64,
    Float32,
}

impl RangeDomain {
    pub const fn tag(&self) -> RangeDomainTag {
        match self {
            Self::Integer => RangeDomainTag::Integer,
            Self::Text => RangeDomainTag::Text,
            Self::Float64 => RangeDomainTag::Float64,
            Self::Float32 => RangeDomainTag::Float32,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum ScalarBoundTag {
    Unbounded = 0,
    Integer = 1,
    Text = 2,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum ScalarBound {
    Unbounded,
    Integer { decimal: String },
    Text { value: String },
}

impl ScalarBound {
    pub const fn tag(&self) -> ScalarBoundTag {
        match self {
            Self::Unbounded => ScalarBoundTag::Unbounded,
            Self::Integer { .. } => ScalarBoundTag::Integer,
            Self::Text { .. } => ScalarBoundTag::Text,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum ValueTag {
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
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum Value {
    BoundVariable {
        index: u32,
    },
    GlobalDefinition {
        definition: DefinitionKey,
        semantics: SemanticKey,
    },
    Universe {
        universe: Universe,
    },
    DependentPi {
        domain: ValueId,
        codomain: ValueId,
        effects: EffectRowId,
        grade: GradeId,
    },
    DependentSigma {
        first: ValueId,
        second: ValueId,
    },
    Lambda {
        body: ComputationId,
    },
    Pair {
        first: ValueId,
        second: ValueId,
    },
    FirstProjection {
        pair: ValueId,
    },
    SecondProjection {
        pair: ValueId,
    },
    Thunk {
        computation: ComputationId,
    },
    EffectRow {
        row: EffectRowId,
    },
    IntervalGrade {
        grade: GradeId,
    },
    Proof {
        proof: ProofId,
        proposition: ValueId,
    },
    StructuralRigid {
        variable: u32,
    },
    StructuralForall {
        variables: Vec<u32>,
        body: ValueId,
    },
    StructuralRange {
        domain: RangeDomain,
        low: ScalarBound,
        high: ScalarBound,
    },
    StructuralUnit,
    StructuralFunction {
        deferred: bool,
        parameter: ValueId,
        effects: ValueId,
        result: ValueId,
    },
    StructuralRecord {
        labels: Vec<String>,
        field_types: Vec<ValueId>,
    },
    StructuralRecordUpdate {
        base: ValueId,
        labels: Vec<String>,
        field_types: Vec<ValueId>,
    },
    StructuralArray {
        element: ValueId,
    },
    StructuralRegion {
        element: ValueId,
    },
    StructuralScratch {
        element: ValueId,
    },
    StructuralVariant {
        labels: Vec<String>,
        payload_types: Vec<ValueId>,
        open: bool,
    },
    StructuralEffects {
        labels: Vec<String>,
    },
    StructuralOpenEffects {
        labels: Vec<String>,
        tail: ValueId,
    },
    StructuralUnion {
        members: Vec<ValueId>,
    },
    StructuralOpaque {
        name: String,
    },
    StructuralTop,
    StructuralBottom,
}

impl Value {
    pub const fn tag(&self) -> ValueTag {
        match self {
            Self::BoundVariable { .. } => ValueTag::BoundVariable,
            Self::GlobalDefinition { .. } => ValueTag::GlobalDefinition,
            Self::Universe { .. } => ValueTag::Universe,
            Self::DependentPi { .. } => ValueTag::DependentPi,
            Self::DependentSigma { .. } => ValueTag::DependentSigma,
            Self::Lambda { .. } => ValueTag::Lambda,
            Self::Pair { .. } => ValueTag::Pair,
            Self::FirstProjection { .. } => ValueTag::FirstProjection,
            Self::SecondProjection { .. } => ValueTag::SecondProjection,
            Self::Thunk { .. } => ValueTag::Thunk,
            Self::EffectRow { .. } => ValueTag::EffectRow,
            Self::IntervalGrade { .. } => ValueTag::IntervalGrade,
            Self::Proof { .. } => ValueTag::Proof,
            Self::StructuralRigid { .. } => ValueTag::StructuralRigid,
            Self::StructuralForall { .. } => ValueTag::StructuralForall,
            Self::StructuralRange { .. } => ValueTag::StructuralRange,
            Self::StructuralUnit => ValueTag::StructuralUnit,
            Self::StructuralFunction { .. } => ValueTag::StructuralFunction,
            Self::StructuralRecord { .. } => ValueTag::StructuralRecord,
            Self::StructuralRecordUpdate { .. } => ValueTag::StructuralRecordUpdate,
            Self::StructuralArray { .. } => ValueTag::StructuralArray,
            Self::StructuralRegion { .. } => ValueTag::StructuralRegion,
            Self::StructuralScratch { .. } => ValueTag::StructuralScratch,
            Self::StructuralVariant { .. } => ValueTag::StructuralVariant,
            Self::StructuralEffects { .. } => ValueTag::StructuralEffects,
            Self::StructuralOpenEffects { .. } => ValueTag::StructuralOpenEffects,
            Self::StructuralUnion { .. } => ValueTag::StructuralUnion,
            Self::StructuralOpaque { .. } => ValueTag::StructuralOpaque,
            Self::StructuralTop => ValueTag::StructuralTop,
            Self::StructuralBottom => ValueTag::StructuralBottom,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum ComputationTag {
    ReturnValue = 0,
    LetValue = 1,
    Bind = 2,
    Apply = 3,
    Force = 4,
    Perform = 5,
    Handle = 6,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum Computation {
    ReturnValue {
        value: ValueId,
    },
    LetValue {
        value: ValueId,
        body: ComputationId,
    },
    Bind {
        first: ComputationId,
        body: ComputationId,
    },
    Apply {
        function: ValueId,
        argument: ValueId,
    },
    Force {
        thunk: ValueId,
    },
    Perform {
        effect: SemanticKey,
        operation: SemanticKey,
        argument: ValueId,
    },
    Handle {
        effect: SemanticKey,
        body: ComputationId,
        handler: ValueId,
    },
}

impl Computation {
    pub const fn tag(&self) -> ComputationTag {
        match self {
            Self::ReturnValue { .. } => ComputationTag::ReturnValue,
            Self::LetValue { .. } => ComputationTag::LetValue,
            Self::Bind { .. } => ComputationTag::Bind,
            Self::Apply { .. } => ComputationTag::Apply,
            Self::Force { .. } => ComputationTag::Force,
            Self::Perform { .. } => ComputationTag::Perform,
            Self::Handle { .. } => ComputationTag::Handle,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum DefinitionBodyTag {
    Value = 0,
    Computation = 1,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum DefinitionBody {
    Value {
        value: ValueId,
        expected_type: ValueId,
    },
    Computation {
        computation: ComputationId,
        result_type: ValueId,
        effects: EffectRowId,
    },
}

impl DefinitionBody {
    pub const fn tag(&self) -> DefinitionBodyTag {
        match self {
            Self::Value { .. } => DefinitionBodyTag::Value,
            Self::Computation { .. } => DefinitionBodyTag::Computation,
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct SourceOrigin {
    pub source: SemanticKey,
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct DefinitionReference {
    pub definition: DefinitionKey,
    pub semantics: SemanticKey,
    pub origin: SourceOriginId,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct GradeInterval {
    pub lower: u32,
    pub upper: GradeUpperBound,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProofReference {
    pub proof: ProofId,
    pub proposition: ValueId,
    pub origin: SourceOriginId,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ValueNode {
    pub origin: SourceOriginId,
    pub term: Value,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ComputationNode {
    pub origin: SourceOriginId,
    pub term: Computation,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EffectRowNode {
    pub origin: SourceOriginId,
    pub row: EffectRow,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct GradeNode {
    pub origin: SourceOriginId,
    pub interval: GradeInterval,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct Definition {
    pub reference: DefinitionReference,
    pub body: DefinitionBody,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct QArena {
    pub origins: Vec<SourceOrigin>,
    pub values: Vec<ValueNode>,
    pub computations: Vec<ComputationNode>,
    pub effect_rows: Vec<EffectRowNode>,
    pub grades: Vec<GradeNode>,
    pub proofs: Vec<ProofReference>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct QModule {
    pub schema_version: u32,
    pub module: SemanticKey,
    pub effect_parameter_count: u32,
    pub imports: Vec<DefinitionReference>,
    pub definitions: Vec<Definition>,
    pub arena: QArena,
}
