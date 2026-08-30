import Std.Tactic

namespace Blot.QCoreTyping

inductive PureSort where
  | proposition
  | typeUniverse (level : Nat)
  deriving DecidableEq, Repr

inductive GradeUpperBound where
  | finite (value : Nat)
  | unbounded
  deriving DecidableEq, Repr

structure GradeInterval where
  lower : Nat
  upper : GradeUpperBound
  deriving DecidableEq, Repr

def GradeInterval.contains (grade : GradeInterval) (uses : Nat) : Prop :=
  grade.lower ≤ uses ∧
    match grade.upper with
    | .finite upper => uses ≤ upper
    | .unbounded => True

mutual
  inductive PureValue where
    | boundVariable (index : Nat)
    | globalDefinition (definition semantics : String)
    | universe (sort : PureSort)
    | dependentPi
        (domain codomain : PureValue)
        (grade : GradeInterval)
    | dependentSigma (first second : PureValue)
    | lambda (body : PureComputation)
    | pair (first second : PureValue)
    | firstProjection (pair : PureValue)
    | secondProjection (pair : PureValue)
    deriving DecidableEq, Repr

  inductive PureComputation where
    | returnValue (value : PureValue)
    | letValue (value : PureValue) (body : PureComputation)
    | bind (first body : PureComputation)
    | apply (function argument : PureValue)
    deriving DecidableEq, Repr
end

mutual
  def shiftValue
      (amount cutoff : Nat) : PureValue → PureValue
    | .boundVariable index =>
        if cutoff ≤ index then
          .boundVariable (index + amount)
        else
          .boundVariable index
    | .globalDefinition definition semantics =>
        .globalDefinition definition semantics
    | .universe sort => .universe sort
    | .dependentPi domain codomain grade =>
        .dependentPi
          (shiftValue amount cutoff domain)
          (shiftValue amount (cutoff + 1) codomain)
          grade
    | .dependentSigma first second =>
        .dependentSigma
          (shiftValue amount cutoff first)
          (shiftValue amount (cutoff + 1) second)
    | .lambda body =>
        .lambda (shiftComputation amount (cutoff + 1) body)
    | .pair first second =>
        .pair
          (shiftValue amount cutoff first)
          (shiftValue amount cutoff second)
    | .firstProjection pair =>
        .firstProjection (shiftValue amount cutoff pair)
    | .secondProjection pair =>
        .secondProjection (shiftValue amount cutoff pair)

  def shiftComputation
      (amount cutoff : Nat) : PureComputation → PureComputation
    | .returnValue value =>
        .returnValue (shiftValue amount cutoff value)
    | .letValue value body =>
        .letValue
          (shiftValue amount cutoff value)
          (shiftComputation amount (cutoff + 1) body)
    | .bind first body =>
        .bind
          (shiftComputation amount cutoff first)
          (shiftComputation amount (cutoff + 1) body)
    | .apply function argument =>
        .apply
          (shiftValue amount cutoff function)
          (shiftValue amount cutoff argument)
end

mutual
  def substituteValue
      (replacement : PureValue)
      (depth : Nat) : PureValue → PureValue
    | .boundVariable index =>
        if index = depth then
          if depth = 0 then replacement else shiftValue depth 0 replacement
        else if depth < index then
          .boundVariable (index - 1)
        else
          .boundVariable index
    | .globalDefinition definition semantics =>
        .globalDefinition definition semantics
    | .universe sort => .universe sort
    | .dependentPi domain codomain grade =>
        .dependentPi
          (substituteValue replacement depth domain)
          (substituteValue replacement (depth + 1) codomain)
          grade
    | .dependentSigma first second =>
        .dependentSigma
          (substituteValue replacement depth first)
          (substituteValue replacement (depth + 1) second)
    | .lambda body =>
        .lambda (substituteComputation replacement (depth + 1) body)
    | .pair first second =>
        .pair
          (substituteValue replacement depth first)
          (substituteValue replacement depth second)
    | .firstProjection pair =>
        .firstProjection (substituteValue replacement depth pair)
    | .secondProjection pair =>
        .secondProjection (substituteValue replacement depth pair)

  def substituteComputation
      (replacement : PureValue)
      (depth : Nat) : PureComputation → PureComputation
    | .returnValue value =>
        .returnValue (substituteValue replacement depth value)
    | .letValue value body =>
        .letValue
          (substituteValue replacement depth value)
          (substituteComputation replacement (depth + 1) body)
    | .bind first body =>
        .bind
          (substituteComputation replacement depth first)
          (substituteComputation replacement (depth + 1) body)
    | .apply function argument =>
        .apply
          (substituteValue replacement depth function)
          (substituteValue replacement depth argument)
end

def substituteValueTop
    (body replacement : PureValue) : PureValue :=
  substituteValue replacement 0 body

def substituteComputationTop
    (body : PureComputation)
    (replacement : PureValue) : PureComputation :=
  substituteComputation replacement 0 body

mutual
  def countValueUses (target : Nat) : PureValue → Nat
    | .boundVariable index => if index = target then 1 else 0
    | .globalDefinition _ _ | .universe _ => 0
    | .dependentPi domain codomain _
    | .dependentSigma domain codomain =>
        countValueUses target domain +
          countValueUses (target + 1) codomain
    | .lambda body => countComputationUses (target + 1) body
    | .pair first second =>
        countValueUses target first + countValueUses target second
    | .firstProjection pair | .secondProjection pair =>
        countValueUses target pair

  def countComputationUses (target : Nat) : PureComputation → Nat
    | .returnValue value => countValueUses target value
    | .letValue value body =>
        countValueUses target value +
          countComputationUses (target + 1) body
    | .bind first body =>
        countComputationUses target first +
          countComputationUses (target + 1) body
    | .apply function argument =>
        countValueUses target function + countValueUses target argument
end

mutual
  inductive ConvertsValue : PureValue → PureValue → Prop where
    | reflexive (value) : ConvertsValue value value
    | symmetric : ConvertsValue left right → ConvertsValue right left
    | transitive :
        ConvertsValue left middle →
        ConvertsValue middle right →
        ConvertsValue left right
    | dependentPi :
        ConvertsValue leftDomain rightDomain →
        ConvertsValue leftCodomain rightCodomain →
        ConvertsValue
          (.dependentPi leftDomain leftCodomain grade)
          (.dependentPi rightDomain rightCodomain grade)
    | dependentSigma :
        ConvertsValue leftFirst rightFirst →
        ConvertsValue leftSecond rightSecond →
        ConvertsValue
          (.dependentSigma leftFirst leftSecond)
          (.dependentSigma rightFirst rightSecond)
    | lambda :
        ConvertsComputation left right →
        ConvertsValue (.lambda left) (.lambda right)
    | pair :
        ConvertsValue leftFirst rightFirst →
        ConvertsValue leftSecond rightSecond →
        ConvertsValue
          (.pair leftFirst leftSecond)
          (.pair rightFirst rightSecond)
    | firstProjection :
        ConvertsValue left right →
        ConvertsValue (.firstProjection left) (.firstProjection right)
    | secondProjection :
        ConvertsValue left right →
        ConvertsValue (.secondProjection left) (.secondProjection right)
    | firstPair :
        ConvertsValue (.firstProjection (.pair first second)) first
    | secondPair :
        ConvertsValue (.secondProjection (.pair first second)) second

  inductive ConvertsComputation : PureComputation → PureComputation → Prop where
    | reflexive (computation) : ConvertsComputation computation computation
    | symmetric :
        ConvertsComputation left right → ConvertsComputation right left
    | transitive :
        ConvertsComputation left middle →
        ConvertsComputation middle right →
        ConvertsComputation left right
    | returnValue :
        ConvertsValue left right →
        ConvertsComputation (.returnValue left) (.returnValue right)
    | letValue :
        ConvertsValue leftValue rightValue →
        ConvertsComputation leftBody rightBody →
        ConvertsComputation
          (.letValue leftValue leftBody)
          (.letValue rightValue rightBody)
    | bind :
        ConvertsComputation leftFirst rightFirst →
        ConvertsComputation leftBody rightBody →
        ConvertsComputation
          (.bind leftFirst leftBody)
          (.bind rightFirst rightBody)
    | apply :
        ConvertsValue leftFunction rightFunction →
        ConvertsValue leftArgument rightArgument →
        ConvertsComputation
          (.apply leftFunction leftArgument)
          (.apply rightFunction rightArgument)
    | applicationBeta :
        ConvertsComputation
          (.apply (.lambda body) argument)
          (substituteComputationTop body argument)
    | letBeta :
        ConvertsComputation
          (.letValue value body)
          (substituteComputationTop body value)
    | bindReturn :
        ConvertsComputation
          (.bind (.returnValue value) body)
          (substituteComputationTop body value)
end

structure GlobalDeclaration where
  definition : String
  semantics : String
  type : PureValue
  deriving DecidableEq, Repr

def lookupGlobal
    (globals : List GlobalDeclaration)
    (definition semantics : String) : Option PureValue :=
  match globals.find?
      (fun declaration =>
        declaration.definition == definition &&
          declaration.semantics == semantics) with
  | some declaration => some declaration.type
  | none => none

def sortLevel : PureSort → Nat
  | .proposition => 0
  | .typeUniverse level => level

def piSort (domain codomain : PureSort) : PureSort :=
  match codomain with
  | .proposition => .proposition
  | .typeUniverse level => .typeUniverse (max (sortLevel domain) level)

def sigmaSort (first second : PureSort) : PureSort :=
  .typeUniverse (max (sortLevel first) (sortLevel second))

mutual
  inductive HasValueType
      (globals : List GlobalDeclaration) :
      List PureValue → PureValue → PureValue → Prop where
    | boundVariable :
        context[index]? = some declared →
        HasValueType globals context
          (.boundVariable index)
          (shiftValue (index + 1) 0 declared)
    | globalDefinition :
        lookupGlobal globals definition semantics = some declared →
        HasValueType globals context
          (.globalDefinition definition semantics)
          declared
    | proposition :
        HasValueType globals context
          (.universe .proposition)
          (.universe (.typeUniverse 0))
    | typeUniverse :
        HasValueType globals context
          (.universe (.typeUniverse level))
          (.universe (.typeUniverse (level + 1)))
    | dependentPi :
        HasValueType globals context domain (.universe domainSort) →
        HasValueType globals (domain :: context)
          codomain (.universe codomainSort) →
        HasValueType globals context
          (.dependentPi domain codomain grade)
          (.universe (piSort domainSort codomainSort))
    | dependentSigma :
        HasValueType globals context first (.universe firstSort) →
        HasValueType globals (first :: context)
          second (.universe secondSort) →
        HasValueType globals context
          (.dependentSigma first second)
          (.universe (sigmaSort firstSort secondSort))
    | lambda :
        grade.contains (countComputationUses 0 body) →
        HasComputationType globals (domain :: context) body codomain →
        HasValueType globals context
          (.lambda body)
          (.dependentPi domain codomain grade)
    | pair :
        HasValueType globals context first firstType →
        HasValueType globals context second
          (substituteValueTop secondType first) →
        HasValueType globals context
          (.pair first second)
          (.dependentSigma firstType secondType)
    | firstProjection :
        HasValueType globals context pair
          (.dependentSigma firstType secondType) →
        HasValueType globals context
          (.firstProjection pair)
          firstType
    | secondProjection :
        HasValueType globals context pair
          (.dependentSigma firstType secondType) →
        HasValueType globals context
          (.secondProjection pair)
          (substituteValueTop secondType (.firstProjection pair))
    | conversion :
        HasValueType globals context value inferred →
        ConvertsValue inferred expected →
        HasValueType globals context value expected

  inductive HasComputationType
      (globals : List GlobalDeclaration) :
      List PureValue → PureComputation → PureValue → Prop where
    | returnValue :
        HasValueType globals context value resultType →
        HasComputationType globals context
          (.returnValue value) resultType
    | letValue :
        HasValueType globals context value valueType →
        HasComputationType globals (valueType :: context) body bodyType →
        HasComputationType globals context
          (.letValue value body)
          (substituteValueTop bodyType value)
    | bind :
        HasComputationType globals context first firstType →
        HasComputationType globals (firstType :: context) body
          (shiftValue 1 0 resultType) →
        HasComputationType globals context (.bind first body) resultType
    | apply :
        HasValueType globals context function
          (.dependentPi domain codomain grade) →
        HasValueType globals context argument domain →
        HasComputationType globals context
          (.apply function argument)
          (substituteValueTop codomain argument)
    | conversion :
        HasComputationType globals context computation inferred →
        ConvertsValue inferred expected →
        HasComputationType globals context computation expected
end

@[simp] theorem substituteTopBoundVariable
    (replacement : PureValue) :
    substituteValueTop (.boundVariable 0) replacement = replacement := by
  simp [substituteValueTop, substituteValue]

theorem applicationBetaConverts
    (body : PureComputation)
    (argument : PureValue) :
    ConvertsComputation
      (.apply (.lambda body) argument)
      (substituteComputationTop body argument) := by
  exact .applicationBeta

theorem firstProjectionConverts
    (first second : PureValue) :
    ConvertsValue (.firstProjection (.pair first second)) first := by
  exact .firstPair

theorem secondProjectionConverts
    (first second : PureValue) :
    ConvertsValue (.secondProjection (.pair first second)) second := by
  exact .secondPair

theorem exactGradeContainsItsCount (uses : Nat) :
    (GradeInterval.mk uses (.finite uses)).contains uses := by
  simp [GradeInterval.contains]

end Blot.QCoreTyping
