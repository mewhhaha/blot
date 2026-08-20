namespace Blot

abbrev Name := String
abbrev Effect := Nat

mutual
  inductive Value where
    | unit
    | integer (value : Int)
    | variable (name : Name)
    | variant (name : String) (payload : Value)
    | function (parameter : Name) (body : Computation)
    | continuation (state : ContinuationState)

  inductive Computation where
    | return (value : Value)
    | define (name : Name) (value : Value) (body : Computation)
    | bind (name : Name) (first : Computation) (rest : Computation)
    | apply (function argument : Value)
    | perform (effect : Effect) (argument : Value)
    | handle (effect : Effect) (body : Computation) (clauses : Handler)

  inductive Handler where
    | clauses
      (operationArgument : Name)
      (resumeName : Name)
      (operation : Computation)
      (returnedValue : Name)
      (returned : Computation)

  inductive Continuation where
    | oneShot (parameter : Name) (resume : Computation)

  inductive ContinuationState where
    | ready (continuation : Continuation)
    | spent
end

mutual
  def substituteValue
      (name : Name)
      (replacement : Value)
      (value : Value) : Value :=
    match value with
    | .unit => .unit
    | .integer value => .integer value
    | .variable candidate =>
        if candidate = name then replacement else .variable candidate
    | .variant constructor payload =>
        .variant constructor (substituteValue name replacement payload)
    | .function parameter body =>
        if parameter = name then
          .function parameter body
        else
          .function parameter (substituteComputation name replacement body)
    | .continuation state =>
        .continuation (substituteContinuationState name replacement state)

  def substituteComputation
      (name : Name)
      (replacement : Value)
      (computation : Computation) : Computation :=
    match computation with
    | .return value => .return (substituteValue name replacement value)
    | .define binder value body =>
        let value := substituteValue name replacement value
        if binder = name then
          .define binder value body
        else
          .define binder value (substituteComputation name replacement body)
    | .bind binder first rest =>
        let first := substituteComputation name replacement first
        if binder = name then
          .bind binder first rest
        else
          .bind binder first (substituteComputation name replacement rest)
    | .apply function argument =>
        .apply
          (substituteValue name replacement function)
          (substituteValue name replacement argument)
    | .perform effect argument =>
        .perform effect (substituteValue name replacement argument)
    | .handle effect body clauses =>
        .handle
          effect
          (substituteComputation name replacement body)
          (substituteHandler name replacement clauses)

  def substituteHandler
      (name : Name)
      (replacement : Value)
      (handler : Handler) : Handler :=
    match handler with
    | .clauses operationArgument resumeName operation returnedValue returned =>
        let operation :=
          if operationArgument = name ∨ resumeName = name then
            operation
          else
            substituteComputation name replacement operation
        let returned :=
          if returnedValue = name then
            returned
          else
            substituteComputation name replacement returned
        .clauses operationArgument resumeName operation returnedValue returned

  def substituteContinuation
      (name : Name)
      (replacement : Value)
      (continuation : Continuation) : Continuation :=
    match continuation with
    | .oneShot parameter body =>
        if parameter = name then
          .oneShot parameter body
        else
          .oneShot parameter (substituteComputation name replacement body)

  def substituteContinuationState
      (name : Name)
      (replacement : Value)
      (state : ContinuationState) : ContinuationState :=
    match state with
    | .ready continuation =>
        .ready (substituteContinuation name replacement continuation)
    | .spent => .spent
end

def resume :
    ContinuationState → Value → Option (Computation × ContinuationState)
  | .ready (.oneShot parameter continuation), argument =>
      some (substituteComputation parameter argument continuation, .spent)
  | .spent, _ => none

def cancel : ContinuationState → Option ContinuationState
  | .ready _ => some .spent
  | .spent => none

def Handler.onOperation
    (handler : Handler)
    (argument resumeValue : Value) : Computation :=
  match handler with
  | .clauses operationArgument resumeName operation _ _ =>
      substituteComputation
        resumeName
        resumeValue
        (substituteComputation operationArgument argument operation)

def Handler.onReturn (handler : Handler) (value : Value) : Computation :=
  match handler with
  | .clauses _ _ _ returnedValue returned =>
      substituteComputation returnedValue value returned

/-- A compiler-local name outside the source identifier space. -/
def responseName : Name := "$blot$response"

def capturedContinuation (effect : Effect) (handler : Handler) : Continuation :=
  .oneShot
    responseName
    (.handle effect (.return (.variable responseName)) handler)

inductive Reduces : Computation → Computation → Prop where
  | resumed
      (state : ContinuationState)
      (argument : Value)
      (body : Computation)
      (next : ContinuationState)
      (didResume : resume state argument = some (body, next)) :
      Reduces (.apply (.continuation state) argument) body
  | handledReturn
      (effect : Effect)
      (value : Value)
      (handler : Handler) :
      Reduces
        (.handle effect (.return value) handler)
        (handler.onReturn value)
  | handledOperation
      (effect : Effect)
      (argument : Value)
      (handler : Handler) :
      Reduces
        (.handle effect (.perform effect argument) handler)
        (handler.onOperation
          argument
          (.continuation (.ready (capturedContinuation effect handler))))

inductive Executes (host : Effect → Value → Value) :
    Computation → List Effect → Value → Prop where
  | returned (value : Value) :
      Executes host (.return value) [] value
  | defined
      (name : Name)
      (value : Value)
      (body : Computation)
      (trace : List Effect)
      (result : Value)
      (executesBody :
        Executes host (substituteComputation name value body) trace result) :
      Executes host (.define name value body) trace result
  | bound
      (name : Name)
      (first rest : Computation)
      (firstTrace restTrace : List Effect)
      (intermediate result : Value)
      (executesFirst : Executes host first firstTrace intermediate)
      (executesRest :
        Executes host
          (substituteComputation name intermediate rest)
          restTrace
          result) :
      Executes host
        (.bind name first rest)
        (firstTrace ++ restTrace)
        result
  | applied
      (parameter : Name)
      (body : Computation)
      (argument : Value)
      (trace : List Effect)
      (result : Value)
      (executesBody :
        Executes host
          (substituteComputation parameter argument body)
          trace
          result) :
      Executes host (.apply (.function parameter body) argument) trace result
  | performed (effect : Effect) (argument : Value) :
      Executes host (.perform effect argument) [effect] (host effect argument)
  | stepped
      (before after : Computation)
      (trace : List Effect)
      (result : Value)
      (step : Reduces before after)
      (executesAfter : Executes host after trace result) :
      Executes host before trace result

theorem readyResumeSubstitutesArgument
    (parameter : Name)
    (continuation : Computation)
    (argument : Value) :
    resume (.ready (.oneShot parameter continuation)) argument =
      some (
        substituteComputation parameter argument continuation,
        .spent
      ) := by
  rfl

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

theorem cancellingReadyContinuationSpendsIt (continuation : Continuation) :
    cancel (.ready continuation) = some .spent := by
  rfl

theorem defineSubstitutesBinding
    (host : Effect → Value → Value)
    (name : Name)
    (value : Value)
    (body : Computation)
    (trace : List Effect)
    (result : Value)
    (executesBody :
      Executes host (substituteComputation name value body) trace result) :
    Executes host (.define name value body) trace result := by
  exact .defined name value body trace result executesBody

theorem bindSubstitutesResultAndOrdersTraces
    (host : Effect → Value → Value)
    (name : Name)
    (first rest : Computation)
    (firstTrace restTrace : List Effect)
    (intermediate result : Value)
    (executesFirst : Executes host first firstTrace intermediate)
    (executesRest :
      Executes host
        (substituteComputation name intermediate rest)
        restTrace
        result) :
    Executes host
      (.bind name first rest)
      (firstTrace ++ restTrace)
      result := by
  exact .bound
    name
    first
    rest
    firstTrace
    restTrace
    intermediate
    result
    executesFirst
    executesRest

theorem applicationSubstitutesArgument
    (host : Effect → Value → Value)
    (parameter : Name)
    (body : Computation)
    (argument : Value)
    (trace : List Effect)
    (result : Value)
    (executesBody :
      Executes host
        (substituteComputation parameter argument body)
        trace
        result) :
    Executes host (.apply (.function parameter body) argument) trace result := by
  exact .applied parameter body argument trace result executesBody

theorem handlerReturnRunsReturnClause
    (effect : Effect)
    (value : Value)
    (handler : Handler) :
    Reduces
      (.handle effect (.return value) handler)
      (handler.onReturn value) := by
  exact .handledReturn effect value handler

theorem handlerOperationCapturesOneShotContinuation
    (effect : Effect)
    (argument : Value)
    (handler : Handler) :
    Reduces
      (.handle effect (.perform effect argument) handler)
      (handler.onOperation
        argument
        (.continuation (.ready (capturedContinuation effect handler)))) := by
  exact .handledOperation effect argument handler

end Blot
