namespace Blot

abbrev Effect := Nat

mutual
  inductive Value where
    | unit
    | integer (value : Int)
    | variable (index : Nat)
    | variant (name : String) (payload : Value)
    | function (body : Computation)

  inductive Computation where
    | return (value : Value)
    | define (value : Value) (body : Computation)
    | bind (first : Computation) (rest : Computation)
    | apply (function argument : Value)
    | perform (effect : Effect) (argument : Value)
    | handle (effect : Effect) (body : Computation) (clauses : Handler)

  inductive Handler where
    | clauses
      (operation : Computation)
      (returned : Computation)

  inductive Continuation where
    | oneShot (resume : Computation)
end

inductive ContinuationState where
  | ready (continuation : Continuation)
  | spent

def resume : ContinuationState → Value → Option (Computation × ContinuationState)
  | .ready (.oneShot continuation), _ =>
      some (continuation, .spent)
  | .spent, _ => none

theorem resumedContinuationIsSpent
    (state : ContinuationState)
    (argument : Value)
    (computation : Computation)
    (next : ContinuationState)
    (resumed : resume state argument = some (computation, next)) :
    next = .spent := by
  cases state with
  | spent => simp [resume] at resumed
  | ready continuation =>
      cases continuation
      simp [resume] at resumed
      exact resumed.2.symm

theorem spentContinuationCannotResume (argument : Value) :
    resume .spent argument = none := by
  rfl

inductive Executes (host : Effect → Value → Value) :
    Computation → List Effect → Value → Prop where
  | returned (value : Value) :
      Executes host (.return value) [] value
  | defined
      (value : Value)
      (body : Computation)
      (trace : List Effect)
      (result : Value)
      (executesBody : Executes host body trace result) :
      Executes host (.define value body) trace result
  | bound
      (first : Computation)
      (rest : Computation)
      (firstTrace restTrace : List Effect)
      (intermediate result : Value)
      (executesFirst : Executes host first firstTrace intermediate)
      (executesRest : Executes host rest restTrace result) :
      Executes host (.bind first rest) (firstTrace ++ restTrace) result
  | performed (effect : Effect) (argument : Value) :
      Executes host (.perform effect argument) [effect] (host effect argument)

theorem definePreservesObservation
    (host : Effect → Value → Value)
    (value : Value)
    (body : Computation)
    (trace : List Effect)
    (result : Value) :
    Executes host (.define value body) trace result ↔
      Executes host body trace result := by
  constructor
  · intro execution
    cases execution with
    | defined _ _ _ _ executesBody => exact executesBody
  · intro execution
    exact .defined value body trace result execution

theorem bindOrdersTraces
    (host : Effect → Value → Value)
    (first : Computation)
    (rest : Computation)
    (firstTrace restTrace : List Effect)
    (intermediate result : Value)
    (executesFirst : Executes host first firstTrace intermediate)
    (executesRest : Executes host rest restTrace result) :
    Executes host (.bind first rest) (firstTrace ++ restTrace) result := by
  exact .bound first rest firstTrace restTrace intermediate result
    executesFirst executesRest

end Blot
