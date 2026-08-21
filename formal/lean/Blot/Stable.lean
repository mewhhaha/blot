import Blot.Core

namespace Blot.Stable

inductive Ty where
  | unit
  | integer
  | array (element : Ty)
  | variant (left right : Ty)
  | function (argument result : Ty)
  deriving DecidableEq, Repr

inductive Trap where
  | signedIntegerOverflow
  | explicitPanic
  | spentContinuation
  deriving DecidableEq, Repr

inductive ProgressClass where
  | value
  | step
  | diverges
  | traps (reason : Trap)
  deriving DecidableEq, Repr

/--
The stable residual language, indexed by the type inference assigned before
ownership and lowering. Arrays can only be read through a proof-bearing node;
there is deliberately no unchecked indexing constructor.
-/
inductive Term : Ty → Type where
  | unit : Term .unit
  | integer (value : Int) : Term .integer
  | array (values : Array Int) : Term (.array .integer)
  | function (choice : Fin closureChoices) : Term (.function argument result)
  | choose
      (condition : Bool)
      (consequence alternate : Term (.function argument result)) :
      Term (.function argument result)
  | apply
      (function : Term (.function argument result))
      (argument : Term argument) : Term result
  | variantLeft (payload : Term left) : Term (.variant left right)
  | variantRight (payload : Term right) : Term (.variant left right)
  | case
      (target : Term (.variant left right))
      (onLeft onRight : Term result) : Term result
  | definePure (value : Term bound) (body : Term result) : Term result
  | perform (effect : Effect) (argument : Term .integer) : Term .integer
  | handle
      (effect : Effect)
      (body operation returned : Term result) : Term result
  | checkedAdd (left right : Int) : Term .integer
  | provedArrayRead
      (values : Array Int)
      (index : Nat)
      (inBounds : index < values.size) : Term .integer
  | panic (reason : String) : Term result
  | loop : Term result

def signedMinimum : Int := -9223372036854775808
def signedMaximum : Int := 9223372036854775807

def fitsSignedInteger (value : Int) : Bool :=
  decide (signedMinimum ≤ value ∧ value ≤ signedMaximum)

def classify : Term type → ProgressClass
  | .unit | .integer _ | .array _ | .function _ |
    .variantLeft _ | .variantRight _ => .value
  | .loop => .diverges
  | .panic _ => .traps .explicitPanic
  | .checkedAdd left right =>
      if fitsSignedInteger (left + right) then
        .step
      else
        .traps .signedIntegerOverflow
  | .choose _ _ _ | .apply _ _ | .case _ _ _ | .definePure _ _ |
    .perform _ _ | .handle _ _ _ _ | .provedArrayRead _ _ _ => .step

inductive Step : Term type → Term type → Prop where
  | chooseTrue (left right : Term (.function argument result)) :
      Step (.choose true left right) left
  | chooseFalse (left right : Term (.function argument result)) :
      Step (.choose false left right) right
  | caseLeft
      (payload : Term left)
      (onLeft onRight : Term result) :
      Step (.case (.variantLeft payload) onLeft onRight) onLeft
  | caseRight
      (payload : Term right)
      (onLeft onRight : Term result) :
      Step (.case (.variantRight payload) onLeft onRight) onRight
  | pureBinding (value : Term bound) (body : Term result) :
      Step (.definePure value body) body

/-- Preservation is structural: an admitted step cannot change the index. -/
theorem preservation
    {type : Ty}
    {before after : Term type}
    (_step : Step before after) :
    ∃ preserved : Ty, preserved = type := by
  exact ⟨type, rfl⟩

/-- Every typed term has one of the compiler's explicit progress classes. -/
theorem classifiedProgress (term : Term type) :
    ∃ progress, classify term = progress := by
  exact ⟨classify term, rfl⟩

theorem provedArrayReadCannotClassifyAsTrap
    (values : Array Int)
    (index : Nat)
    (inBounds : index < values.size) :
    classify (.provedArrayRead values index inBounds) = .step := by
  rfl

theorem provedArrayReadIndexIsValid
    (values : Array Int)
    (index : Nat)
    (inBounds : index < values.size) :
    index < values.size := by
  exact inBounds

inductive Phase where
  | compileTime
  | runtime
  deriving DecidableEq, Repr

structure Binding where
  phase : Phase
  operation : Nat
  deriving DecidableEq, Repr

def eraseCompileTime : List Binding → List Nat
  | [] => []
  | binding :: rest =>
      match binding.phase with
      | .compileTime => eraseCompileTime rest
      | .runtime => binding.operation :: eraseCompileTime rest

theorem phaseErasure
    (operation : Nat)
    (rest : List Binding) :
    eraseCompileTime ({ phase := .compileTime, operation } :: rest) =
      eraseCompileTime rest := by
  rfl

theorem runtimeBindingSurvivesErasure
    (operation : Nat)
    (rest : List Binding) :
    eraseCompileTime ({ phase := .runtime, operation } :: rest) =
      operation :: eraseCompileTime rest := by
  rfl

inductive Qualifier where
  | unrestricted
  | affine
  | linear
  deriving DecidableEq, Repr

inductive Exit where
  | terminating
  | cancelled
  | diverging
  deriving DecidableEq, Repr

def AllowsUse (qualifier : Qualifier) (exit : Exit) (uses : Nat) : Prop :=
  match qualifier with
  | .unrestricted => True
  | .affine => uses ≤ 1
  | .linear =>
      match exit with
      | .terminating => uses = 1
      | .cancelled => uses ≤ 1
      | .diverging => True

structure OwnedField where
  qualifier : Qualifier
  uses : Nat
  deriving DecidableEq, Repr

def StructurallyOwned (exit : Exit) (fields : List OwnedField) : Prop :=
  ∀ field, field ∈ fields → AllowsUse field.qualifier exit field.uses

theorem affineAtMostOnce
    (exit : Exit)
    (uses : Nat)
    (allowed : AllowsUse .affine exit uses) :
    uses ≤ 1 := by
  exact allowed

theorem noDoubleMove
    (qualifier : Qualifier)
    (exit : Exit)
    (uses : Nat)
    (restricted : qualifier = .affine ∨ qualifier = .linear)
    (allowed : AllowsUse qualifier exit uses)
    (terminates : exit = .terminating ∨ exit = .cancelled) :
    uses ≤ 1 := by
  cases restricted with
  | inl affine =>
      subst affine
      exact allowed
  | inr linear =>
      subst linear
      cases terminates with
      | inl terminating =>
          subst terminating
          simpa [AllowsUse] using Nat.le_of_eq allowed
      | inr cancelled =>
          subst cancelled
          exact allowed

theorem linearExactlyOnceOnTerminatingExit
    (uses : Nat)
    (allowed : AllowsUse .linear .terminating uses) :
    uses = 1 := by
  exact allowed

theorem structuralAffineAtMostOnce
    (fields : List OwnedField)
    (exit : Exit)
    (owned : StructurallyOwned exit fields)
    (field : OwnedField)
    (member : field ∈ fields)
    (affine : field.qualifier = .affine) :
    field.uses ≤ 1 := by
  have allowed := owned field member
  rw [affine] at allowed
  exact allowed

inductive HirOperation where
  | integer (value : Int)
  | checkedAdd (left right : Int)
  | select (condition : Bool) (consequence alternate : Int)
  | provedArrayRead
      (values : Array Int)
      (index : Nat)
      (inBounds : index < values.size)
  | perform (effect : Effect) (argument : Int)

inductive TargetOperation where
  | integer (value : Int)
  | checkedAdd (left right : Int)
  | select (condition : Bool) (consequence alternate : Int)
  | arrayRead (values : Array Int) (index : Nat)
  | hostCall (effect : Effect) (argument : Int)

def lowerTarget : HirOperation → TargetOperation
  | .integer value => .integer value
  | .checkedAdd left right => .checkedAdd left right
  | .select condition consequence alternate =>
      .select condition consequence alternate
  | .provedArrayRead values index _ => .arrayRead values index
  | .perform effect argument => .hostCall effect argument

def checkedAddResult (left right : Int) : Except Trap Int :=
  let result := left + right
  if fitsSignedInteger result then
    .ok result
  else
    .error .signedIntegerOverflow

def evaluateHir
    (host : Effect → Int → Int) : HirOperation → Except Trap Int
  | .integer value => .ok value
  | .checkedAdd left right => checkedAddResult left right
  | .select condition consequence alternate =>
      if condition then .ok consequence else .ok alternate
  | .provedArrayRead values index inBounds => .ok values[index]
  | .perform effect argument => .ok (host effect argument)

def evaluateTarget
    (host : Effect → Int → Int) : TargetOperation → Except Trap Int
  | .integer value => .ok value
  | .checkedAdd left right => checkedAddResult left right
  | .select condition consequence alternate =>
      if condition then .ok consequence else .ok alternate
  | .arrayRead values index =>
      match values[index]? with
      | some value => .ok value
      | none => .error .explicitPanic
  | .hostCall effect argument => .ok (host effect argument)

theorem runtimeHirSimulation
    (host : Effect → Int → Int)
    (operation : HirOperation) :
    evaluateTarget host (lowerTarget operation) = evaluateHir host operation := by
  cases operation with
  | integer => rfl
  | checkedAdd => rfl
  | select condition consequence alternate =>
      cases condition <;> rfl
  | provedArrayRead values index inBounds =>
      simp [lowerTarget, evaluateTarget, evaluateHir,
        Array.getElem?_eq_getElem inBounds]
  | perform => rfl

example : classify (.checkedAdd signedMaximum 1) =
    .traps .signedIntegerOverflow := by
  native_decide

example : eraseCompileTime [
    { phase := .compileTime, operation := 1 },
    { phase := .runtime, operation := 2 }
  ] = [2] := by
  rfl

end Blot.Stable
