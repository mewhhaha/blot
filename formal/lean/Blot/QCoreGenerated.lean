-- Generated from qcore/schema.json by scripts/generate_qcore.ts. Do not edit.

namespace Blot.QCoreGenerated

def schemaVersion : UInt32 := 3

structure ValueId where
  «value» : UInt32
  deriving BEq, DecidableEq, Repr

structure ComputationId where
  «value» : UInt32
  deriving BEq, DecidableEq, Repr

structure EffectRowId where
  «value» : UInt32
  deriving BEq, DecidableEq, Repr

structure GradeId where
  «value» : UInt32
  deriving BEq, DecidableEq, Repr

structure ProofId where
  «value» : UInt32
  deriving BEq, DecidableEq, Repr

structure SourceOriginId where
  «value» : UInt32
  deriving BEq, DecidableEq, Repr

structure DefinitionKey where
  «value» : String
  deriving BEq, DecidableEq, Repr

structure SemanticKey where
  «value» : String
  deriving BEq, DecidableEq, Repr

inductive UniverseTag where
  | TypeUniverse
  | Prop
  deriving BEq, DecidableEq, Repr

def UniverseTag.code : UniverseTag → UInt8
  | .TypeUniverse => 0
  | .Prop => 1

inductive Universe where
  | TypeUniverse («level» : UInt32)
  | Prop
  deriving BEq, DecidableEq, Repr

def Universe.tag : Universe → UniverseTag
  | .TypeUniverse _ => .TypeUniverse
  | .Prop => .Prop

inductive GradeUpperBoundTag where
  | Finite
  | Unbounded
  deriving BEq, DecidableEq, Repr

def GradeUpperBoundTag.code : GradeUpperBoundTag → UInt8
  | .Finite => 0
  | .Unbounded => 1

inductive GradeUpperBound where
  | Finite («value» : UInt32)
  | Unbounded
  deriving BEq, DecidableEq, Repr

def GradeUpperBound.tag : GradeUpperBound → GradeUpperBoundTag
  | .Finite _ => .Finite
  | .Unbounded => .Unbounded

inductive EffectRowTag where
  | Empty
  | Variable
  | Extend
  deriving BEq, DecidableEq, Repr

def EffectRowTag.code : EffectRowTag → UInt8
  | .Empty => 0
  | .Variable => 1
  | .Extend => 2

inductive EffectRow where
  | Empty
  | Variable («index» : UInt32)
  | Extend («effect» : SemanticKey) («tail» : EffectRowId)
  deriving BEq, DecidableEq, Repr

def EffectRow.tag : EffectRow → EffectRowTag
  | .Empty => .Empty
  | .Variable _ => .Variable
  | .Extend _ _ => .Extend

inductive RangeDomainTag where
  | Integer
  | Text
  | Float64
  | Float32
  deriving BEq, DecidableEq, Repr

def RangeDomainTag.code : RangeDomainTag → UInt8
  | .Integer => 0
  | .Text => 1
  | .Float64 => 2
  | .Float32 => 3

inductive RangeDomain where
  | Integer
  | Text
  | Float64
  | Float32
  deriving BEq, DecidableEq, Repr

def RangeDomain.tag : RangeDomain → RangeDomainTag
  | .Integer => .Integer
  | .Text => .Text
  | .Float64 => .Float64
  | .Float32 => .Float32

inductive ScalarBoundTag where
  | Unbounded
  | Integer
  | Text
  deriving BEq, DecidableEq, Repr

def ScalarBoundTag.code : ScalarBoundTag → UInt8
  | .Unbounded => 0
  | .Integer => 1
  | .Text => 2

inductive ScalarBound where
  | Unbounded
  | Integer («decimal» : String)
  | Text («value» : String)
  deriving BEq, DecidableEq, Repr

def ScalarBound.tag : ScalarBound → ScalarBoundTag
  | .Unbounded => .Unbounded
  | .Integer _ => .Integer
  | .Text _ => .Text

inductive ValueTag where
  | BoundVariable
  | GlobalDefinition
  | Universe
  | DependentPi
  | DependentSigma
  | Lambda
  | Pair
  | FirstProjection
  | SecondProjection
  | Thunk
  | EffectRow
  | IntervalGrade
  | Proof
  | StructuralRigid
  | StructuralForall
  | StructuralRange
  | StructuralUnit
  | StructuralFunction
  | StructuralRecord
  | StructuralRecordUpdate
  | StructuralArray
  | StructuralRegion
  | StructuralScratch
  | StructuralVariant
  | StructuralEffects
  | StructuralOpenEffects
  | StructuralUnion
  | StructuralOpaque
  | StructuralTop
  | StructuralBottom
  deriving BEq, DecidableEq, Repr

def ValueTag.code : ValueTag → UInt8
  | .BoundVariable => 0
  | .GlobalDefinition => 1
  | .Universe => 2
  | .DependentPi => 3
  | .DependentSigma => 4
  | .Lambda => 5
  | .Pair => 6
  | .FirstProjection => 7
  | .SecondProjection => 8
  | .Thunk => 9
  | .EffectRow => 10
  | .IntervalGrade => 11
  | .Proof => 12
  | .StructuralRigid => 13
  | .StructuralForall => 14
  | .StructuralRange => 15
  | .StructuralUnit => 16
  | .StructuralFunction => 17
  | .StructuralRecord => 18
  | .StructuralRecordUpdate => 19
  | .StructuralArray => 20
  | .StructuralRegion => 21
  | .StructuralScratch => 22
  | .StructuralVariant => 23
  | .StructuralEffects => 24
  | .StructuralOpenEffects => 25
  | .StructuralUnion => 26
  | .StructuralOpaque => 27
  | .StructuralTop => 28
  | .StructuralBottom => 29

inductive Value where
  | BoundVariable («index» : UInt32)
  | GlobalDefinition («definition» : DefinitionKey) («semantics» : SemanticKey)
  | Universe («universe» : Universe)
  | DependentPi («domain» : ValueId) («codomain» : ValueId) («effects» : EffectRowId) («grade» : GradeId)
  | DependentSigma («first» : ValueId) («second» : ValueId)
  | Lambda («body» : ComputationId)
  | Pair («first» : ValueId) («second» : ValueId)
  | FirstProjection («pair» : ValueId)
  | SecondProjection («pair» : ValueId)
  | Thunk («computation» : ComputationId)
  | EffectRow («row» : EffectRowId)
  | IntervalGrade («grade» : GradeId)
  | Proof («proof» : ProofId) («proposition» : ValueId)
  | StructuralRigid («variable» : UInt32)
  | StructuralForall («variables» : List UInt32) («body» : ValueId)
  | StructuralRange («domain» : RangeDomain) («low» : ScalarBound) («high» : ScalarBound)
  | StructuralUnit
  | StructuralFunction («deferred» : Bool) («parameter» : ValueId) («effects» : ValueId) («result» : ValueId)
  | StructuralRecord («labels» : List String) («field_types» : List ValueId)
  | StructuralRecordUpdate («base» : ValueId) («labels» : List String) («field_types» : List ValueId)
  | StructuralArray («element» : ValueId)
  | StructuralRegion («element» : ValueId)
  | StructuralScratch («element» : ValueId)
  | StructuralVariant («labels» : List String) («payload_types» : List ValueId) («open» : Bool)
  | StructuralEffects («labels» : List String)
  | StructuralOpenEffects («labels» : List String) («tail» : ValueId)
  | StructuralUnion («members» : List ValueId)
  | StructuralOpaque («name» : String)
  | StructuralTop
  | StructuralBottom
  deriving BEq, DecidableEq, Repr

def Value.tag : Value → ValueTag
  | .BoundVariable _ => .BoundVariable
  | .GlobalDefinition _ _ => .GlobalDefinition
  | .Universe _ => .Universe
  | .DependentPi _ _ _ _ => .DependentPi
  | .DependentSigma _ _ => .DependentSigma
  | .Lambda _ => .Lambda
  | .Pair _ _ => .Pair
  | .FirstProjection _ => .FirstProjection
  | .SecondProjection _ => .SecondProjection
  | .Thunk _ => .Thunk
  | .EffectRow _ => .EffectRow
  | .IntervalGrade _ => .IntervalGrade
  | .Proof _ _ => .Proof
  | .StructuralRigid _ => .StructuralRigid
  | .StructuralForall _ _ => .StructuralForall
  | .StructuralRange _ _ _ => .StructuralRange
  | .StructuralUnit => .StructuralUnit
  | .StructuralFunction _ _ _ _ => .StructuralFunction
  | .StructuralRecord _ _ => .StructuralRecord
  | .StructuralRecordUpdate _ _ _ => .StructuralRecordUpdate
  | .StructuralArray _ => .StructuralArray
  | .StructuralRegion _ => .StructuralRegion
  | .StructuralScratch _ => .StructuralScratch
  | .StructuralVariant _ _ _ => .StructuralVariant
  | .StructuralEffects _ => .StructuralEffects
  | .StructuralOpenEffects _ _ => .StructuralOpenEffects
  | .StructuralUnion _ => .StructuralUnion
  | .StructuralOpaque _ => .StructuralOpaque
  | .StructuralTop => .StructuralTop
  | .StructuralBottom => .StructuralBottom

inductive ComputationTag where
  | ReturnValue
  | LetValue
  | Bind
  | Apply
  | Force
  | Perform
  | Handle
  deriving BEq, DecidableEq, Repr

def ComputationTag.code : ComputationTag → UInt8
  | .ReturnValue => 0
  | .LetValue => 1
  | .Bind => 2
  | .Apply => 3
  | .Force => 4
  | .Perform => 5
  | .Handle => 6

inductive Computation where
  | ReturnValue («value» : ValueId)
  | LetValue («value» : ValueId) («body» : ComputationId)
  | Bind («first» : ComputationId) («body» : ComputationId)
  | Apply («function» : ValueId) («argument» : ValueId)
  | Force («thunk» : ValueId)
  | Perform («effect» : SemanticKey) («operation» : SemanticKey) («argument» : ValueId)
  | Handle («effect» : SemanticKey) («body» : ComputationId) («handler» : ValueId)
  deriving BEq, DecidableEq, Repr

def Computation.tag : Computation → ComputationTag
  | .ReturnValue _ => .ReturnValue
  | .LetValue _ _ => .LetValue
  | .Bind _ _ => .Bind
  | .Apply _ _ => .Apply
  | .Force _ => .Force
  | .Perform _ _ _ => .Perform
  | .Handle _ _ _ => .Handle

inductive DefinitionBodyTag where
  | Value
  | Computation
  deriving BEq, DecidableEq, Repr

def DefinitionBodyTag.code : DefinitionBodyTag → UInt8
  | .Value => 0
  | .Computation => 1

inductive DefinitionBody where
  | Value («value» : ValueId) («expected_type» : ValueId)
  | Computation («computation» : ComputationId) («result_type» : ValueId) («effects» : EffectRowId)
  deriving BEq, DecidableEq, Repr

def DefinitionBody.tag : DefinitionBody → DefinitionBodyTag
  | .Value _ _ => .Value
  | .Computation _ _ _ => .Computation

structure SourceOrigin where
  «source» : SemanticKey
  «start» : UInt32
  «end» : UInt32
  deriving BEq, DecidableEq, Repr

structure DefinitionReference where
  «definition» : DefinitionKey
  «semantics» : SemanticKey
  «origin» : SourceOriginId
  deriving BEq, DecidableEq, Repr

structure GradeInterval where
  «lower» : UInt32
  «upper» : GradeUpperBound
  deriving BEq, DecidableEq, Repr

structure ProofReference where
  «proof» : ProofId
  «proposition» : ValueId
  «origin» : SourceOriginId
  deriving BEq, DecidableEq, Repr

structure ValueNode where
  «origin» : SourceOriginId
  «term» : Value
  deriving BEq, DecidableEq, Repr

structure ComputationNode where
  «origin» : SourceOriginId
  «term» : Computation
  deriving BEq, DecidableEq, Repr

structure EffectRowNode where
  «origin» : SourceOriginId
  «row» : EffectRow
  deriving BEq, DecidableEq, Repr

structure GradeNode where
  «origin» : SourceOriginId
  «interval» : GradeInterval
  deriving BEq, DecidableEq, Repr

structure Definition where
  «reference» : DefinitionReference
  «body» : DefinitionBody
  deriving BEq, DecidableEq, Repr

structure QArena where
  «origins» : List SourceOrigin
  «values» : List ValueNode
  «computations» : List ComputationNode
  «effect_rows» : List EffectRowNode
  «grades» : List GradeNode
  «proofs» : List ProofReference
  deriving BEq, DecidableEq, Repr

structure QModule where
  «schema_version» : UInt32
  «module» : SemanticKey
  «effect_parameter_count» : UInt32
  «imports» : List DefinitionReference
  «definitions» : List Definition
  «arena» : QArena
  deriving BEq, DecidableEq, Repr

end Blot.QCoreGenerated
