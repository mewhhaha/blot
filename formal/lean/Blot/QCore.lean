import Blot.QCoreGenerated
import Std.Tactic

namespace Blot.QCore

open QCoreGenerated

def sourceOriginValid (origin : SourceOrigin) : Bool :=
  decide (origin.start.toNat ≤ origin.end.toNat)

def valueInBounds (arena : QArena) (id : ValueId) : Bool :=
  decide (id.value.toNat < arena.values.length)

def computationInBounds (arena : QArena) (id : ComputationId) : Bool :=
  decide (id.value.toNat < arena.computations.length)

def effectRowInBounds (arena : QArena) (id : EffectRowId) : Bool :=
  decide (id.value.toNat < arena.effect_rows.length)

def gradeInBounds (arena : QArena) (id : GradeId) : Bool :=
  decide (id.value.toNat < arena.grades.length)

def rigidBindersValid (rigids variables : List UInt32) : Bool :=
  decide variables.Nodup && variables.all fun rigid =>
    !rigids.contains rigid

mutual
  def scopedValue
      (arena : QArena)
      (fuel depth : Nat)
      (rigids : List UInt32)
      (id : ValueId) : Bool :=
    match fuel with
    | 0 => false
    | Nat.succ remaining =>
        match arena.values[id.value.toNat]? with
        | none => false
        | some node =>
            match node.term with
            | .BoundVariable index => decide (index.toNat < depth)
            | .GlobalDefinition _ _ | .Universe _ => true
            | .DependentPi domain codomain effects grade =>
                scopedValue arena remaining depth rigids domain &&
                scopedValue arena remaining (depth + 1) rigids codomain &&
                effectRowInBounds arena effects &&
                gradeInBounds arena grade
            | .DependentSigma first second =>
                scopedValue arena remaining depth rigids first &&
                scopedValue arena remaining (depth + 1) rigids second
            | .Lambda body =>
                scopedComputation arena remaining (depth + 1) rigids body
            | .Pair first second =>
                scopedValue arena remaining depth rigids first &&
                scopedValue arena remaining depth rigids second
            | .FirstProjection pair | .SecondProjection pair =>
                scopedValue arena remaining depth rigids pair
            | .Thunk computation =>
                scopedComputation arena remaining depth rigids computation
            | .EffectRow row => effectRowInBounds arena row
            | .IntervalGrade grade => gradeInBounds arena grade
            | .Proof proof proposition =>
                match arena.proofs[proof.value.toNat]? with
                | none => false
                | some reference =>
                    decide (reference.proposition = proposition) &&
                    scopedValue arena remaining depth rigids proposition
            | .StructuralRigid rigid => rigids.contains rigid
            | .StructuralForall variables body =>
                rigidBindersValid rigids variables &&
                scopedValue arena remaining depth (variables ++ rigids) body
            | .StructuralQualified body names subjects members =>
                decide (names.length = subjects.length) &&
                decide (names.length = members.length) &&
                scopedValue arena remaining depth rigids body &&
                subjects.all (scopedValue arena remaining depth rigids) &&
                members.all (scopedValue arena remaining depth rigids)
            | .StructuralRange _ _ _ | .StructuralUnit => true
            | .StructuralFunction _ parameter effects result =>
                scopedValue arena remaining depth rigids parameter &&
                scopedValue arena remaining depth rigids effects &&
                scopedValue arena remaining depth rigids result
            | .StructuralRecord labels fieldTypes =>
                decide (labels.length = fieldTypes.length) &&
                fieldTypes.all (scopedValue arena remaining depth rigids)
            | .StructuralRecordUpdate base labels fieldTypes =>
                scopedValue arena remaining depth rigids base &&
                decide (labels.length = fieldTypes.length) &&
                fieldTypes.all (scopedValue arena remaining depth rigids)
            | .StructuralArray element
            | .StructuralRegion element
            | .StructuralScratch element =>
                scopedValue arena remaining depth rigids element
            | .StructuralVariant labels payloadTypes _ =>
                decide (labels.length = payloadTypes.length) &&
                payloadTypes.all (scopedValue arena remaining depth rigids)
            | .StructuralEffects _ => true
            | .StructuralOpenEffects _ tail =>
                scopedValue arena remaining depth rigids tail
            | .StructuralUnion members =>
                members.all (scopedValue arena remaining depth rigids)
            | .StructuralOpaque _ | .StructuralTop | .StructuralBottom => true

  def scopedComputation
      (arena : QArena)
      (fuel depth : Nat)
      (rigids : List UInt32)
      (id : ComputationId) : Bool :=
    match fuel with
    | 0 => false
    | Nat.succ remaining =>
        match arena.computations[id.value.toNat]? with
        | none => false
        | some node =>
            match node.term with
            | .ReturnValue value | .Force value =>
                scopedValue arena remaining depth rigids value
            | .LetValue value body =>
                scopedValue arena remaining depth rigids value &&
                scopedComputation arena remaining (depth + 1) rigids body
            | .Bind first body =>
                scopedComputation arena remaining depth rigids first &&
                scopedComputation arena remaining (depth + 1) rigids body
            | .Apply function argument =>
                scopedValue arena remaining depth rigids function &&
                scopedValue arena remaining depth rigids argument
            | .Perform _ _ argument =>
                scopedValue arena remaining depth rigids argument
            | .Handle _ body handler =>
                scopedComputation arena remaining depth rigids body &&
                scopedValue arena remaining depth rigids handler
end

def scopedDefinitionBody
    (arena : QArena)
    (fuel : Nat) : DefinitionBody → Bool
  | .Value value expectedType =>
      scopedValue arena fuel 0 [] value &&
      scopedValue arena fuel 0 [] expectedType
  | .Computation computation resultType effects =>
      scopedComputation arena fuel 0 [] computation &&
      scopedValue arena fuel 0 [] resultType &&
      effectRowInBounds arena effects

def effectPrecedesTail (effect : SemanticKey) : EffectRow → Bool
  | .Extend nextEffect _ => compare effect.value nextEffect.value == .lt
  | .Empty | .Variable _ => true

def canonicalEffectRow
    (arena : QArena)
    (parameterCount fuel : Nat)
    (id : EffectRowId) : Bool :=
  match fuel with
  | 0 => false
  | Nat.succ remaining =>
      match arena.effect_rows[id.value.toNat]? with
      | none => false
      | some node =>
          match node.row with
          | .Empty => true
          | .Variable index => decide (index.toNat < parameterCount)
          | .Extend effect tail =>
              match arena.effect_rows[tail.value.toNat]? with
              | none => false
              | some tailNode =>
                  effectPrecedesTail effect tailNode.row &&
                  canonicalEffectRow arena parameterCount remaining tail

theorem emptyEffectRowIsCanonical
    (arena : QArena)
    (parameterCount fuel : Nat)
    (id : EffectRowId)
    (origin : SourceOriginId)
    (lookup :
      arena.effect_rows[id.value.toNat]? =
        some { origin := origin, row := .Empty }) :
    canonicalEffectRow arena parameterCount (fuel + 1) id = true := by
  simp [canonicalEffectRow, lookup]

inductive ExtendedNatural where
  | finite (value : Nat)
  | infinity
  deriving DecidableEq, Repr

namespace ExtendedNatural

def lessOrEqual : ExtendedNatural → ExtendedNatural → Prop
  | .finite left, .finite right => left ≤ right
  | .finite _, .infinity => True
  | .infinity, .finite _ => False
  | .infinity, .infinity => True

def add : ExtendedNatural → ExtendedNatural → ExtendedNatural
  | .finite left, .finite right => .finite (left + right)
  | _, _ => .infinity

def multiply : ExtendedNatural → ExtendedNatural → ExtendedNatural
  | .finite 0, _ => .finite 0
  | _, .finite 0 => .finite 0
  | .finite left, .finite right => .finite (left * right)
  | _, _ => .infinity

theorem lessOrEqualReflexive (value : ExtendedNatural) :
    lessOrEqual value value := by
  cases value <;> simp [lessOrEqual]

theorem lessOrEqualTransitive
    {left middle right : ExtendedNatural}
    (leftMiddle : lessOrEqual left middle)
    (middleRight : lessOrEqual middle right) :
    lessOrEqual left right := by
  cases left <;> cases middle <;> cases right <;>
    simp_all [lessOrEqual]
  omega

theorem addCommutative (left right : ExtendedNatural) :
    add left right = add right left := by
  cases left <;> cases right <;> simp [add, Nat.add_comm]

theorem multiplyCommutative (left right : ExtendedNatural) :
    multiply left right = multiply right left := by
  cases left with
  | infinity =>
      cases right with
      | infinity => rfl
      | finite right => cases right <;> rfl
  | finite left =>
      cases right with
      | infinity => cases left <;> rfl
      | finite right =>
          cases left <;> cases right <;> simp [multiply, Nat.mul_comm]

end ExtendedNatural

def gradeUpperBoundToExtendedNatural : GradeUpperBound → ExtendedNatural
  | .Finite value => .finite value.toNat
  | .Unbounded => .infinity

def gradeIntervalValid (grade : GradeInterval) : Prop :=
  ExtendedNatural.lessOrEqual
    (.finite grade.lower.toNat)
    (gradeUpperBoundToExtendedNatural grade.upper)

def gradeIntervalLessOrEqual
    (left right : GradeInterval) : Prop :=
  right.lower.toNat ≤ left.lower.toNat ∧
  ExtendedNatural.lessOrEqual
    (gradeUpperBoundToExtendedNatural left.upper)
    (gradeUpperBoundToExtendedNatural right.upper)

def gradeIntervalAddBounds
    (left right : GradeInterval) : Nat × ExtendedNatural :=
  (left.lower.toNat + right.lower.toNat,
    ExtendedNatural.add
      (gradeUpperBoundToExtendedNatural left.upper)
      (gradeUpperBoundToExtendedNatural right.upper))

def gradeIntervalMultiplyBounds
    (left right : GradeInterval) : Nat × ExtendedNatural :=
  (left.lower.toNat * right.lower.toNat,
    ExtendedNatural.multiply
      (gradeUpperBoundToExtendedNatural left.upper)
      (gradeUpperBoundToExtendedNatural right.upper))

theorem gradeLessOrEqualReflexive (grade : GradeInterval) :
    gradeIntervalLessOrEqual grade grade := by
  constructor
  · exact Nat.le_refl _
  · exact ExtendedNatural.lessOrEqualReflexive _

theorem gradeLessOrEqualTransitive
    {left middle right : GradeInterval}
    (leftMiddle : gradeIntervalLessOrEqual left middle)
    (middleRight : gradeIntervalLessOrEqual middle right) :
    gradeIntervalLessOrEqual left right := by
  constructor
  · exact Nat.le_trans middleRight.left leftMiddle.left
  · exact ExtendedNatural.lessOrEqualTransitive
      leftMiddle.right middleRight.right

theorem gradeAdditionCommutative (left right : GradeInterval) :
    gradeIntervalAddBounds left right = gradeIntervalAddBounds right left := by
  simp [gradeIntervalAddBounds, Nat.add_comm,
    ExtendedNatural.addCommutative]

theorem gradeMultiplicationCommutative (left right : GradeInterval) :
    gradeIntervalMultiplyBounds left right =
      gradeIntervalMultiplyBounds right left := by
  simp [gradeIntervalMultiplyBounds, Nat.mul_comm,
    ExtendedNatural.multiplyCommutative]

end Blot.QCore
