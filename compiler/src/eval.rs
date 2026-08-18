use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

use crate::ast::{
    Declaration, DeclarationId, DeclarationKind, Expression, ExpressionId, Module, Pattern,
    PatternId, ShapeMember, Span,
};
use crate::diagnostic::Diagnostic;
use crate::primitives::{constant, primitive_arity, run_primitive};
use crate::value::{
    ClosureAlternative, Domain as ValueDomain, Environment, OpenedValues, OrderedFields, Resume,
    RuntimeMeaning, RuntimeValue, Value, as_tuple, attach_signature, child_env, equal, lookup,
    lookup_signature, show, tuple,
};

#[derive(Clone, Eq, PartialEq)]
pub struct IncludedFile {
    pub path: String,
    pub text: String,
}

#[derive(Clone)]
pub struct LoadedModule {
    pub module: Rc<Module>,
    pub imports: BTreeMap<String, String>,
    pub includes: BTreeMap<String, IncludedFile>,
}

#[derive(Eq, Hash, PartialEq)]
struct EffectIdentity {
    module: String,
    span_start: u32,
    span_end: u32,
    scope: String,
    host: bool,
}

type LiveDeclarations = Rc<Vec<DeclarationId>>;
type LivenessCache = HashMap<(String, Option<ExpressionId>), LiveDeclarations>;
type EvaluatedBindings = HashMap<String, HashMap<(PatternId, ExpressionId, Phase), Value>>;

#[derive(Default)]
pub struct Context {
    pub modules: RefCell<HashMap<String, LoadedModule>>,
    pub module_results: RefCell<HashMap<String, Value>>,
    pub(crate) module_cache: RefCell<Option<(String, Rc<Module>)>>,
    pub(crate) live_declarations: RefCell<LivenessCache>,
    pub(crate) evaluated_bindings: RefCell<EvaluatedBindings>,
    pub(crate) closure_signatures: RefCell<HashMap<(String, ExpressionId), Value>>,
    pub(crate) recursive_closures: RefCell<HashSet<(String, ExpressionId)>>,
    pub(crate) ownership_contracts:
        RefCell<HashMap<(String, ExpressionId), crate::ownership::OwnershipContract>>,
    next_effect: Cell<u32>,
    effect_ids: RefCell<HashMap<EffectIdentity, u32>>,
    named_effects: RefCell<HashMap<(String, String, bool), u32>>,
    next_type_variable: Cell<u32>,
}

impl Context {
    fn fresh_effect_id(&self) -> u32 {
        let id = self.next_effect.get() + 1;
        self.next_effect.set(id);
        id
    }

    fn effect_id(&self, runtime: &Runtime, span: Span, host: bool) -> u32 {
        let key = EffectIdentity {
            module: runtime.module.as_ref().clone(),
            span_start: span.start,
            span_end: span.end,
            scope: runtime
                .effect_scope
                .iter()
                .map(|argument| show(argument))
                .collect::<Vec<_>>()
                .join("\u{1f}"),
            host,
        };
        if let Some(id) = self.effect_ids.borrow().get(&key) {
            return *id;
        }
        let id = self.fresh_effect_id();
        self.effect_ids.borrow_mut().insert(key, id);
        id
    }

    fn named_effect_id(&self, module: &str, name: &str, host: bool) -> u32 {
        let key = (module.to_owned(), name.to_owned(), host);
        if let Some(id) = self.named_effects.borrow().get(&key) {
            return *id;
        }
        let id = self.fresh_effect_id();
        self.named_effects.borrow_mut().insert(key, id);
        id
    }

    fn type_variable(&self) -> u32 {
        let id = self.next_type_variable.get() + 1;
        self.next_type_variable.set(id);
        id
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Phase {
    Comptime,
    Runtime,
}

#[derive(Clone)]
pub struct Runtime {
    pub phase: Phase,
    pub fuel: Rc<Cell<i64>>,
    pub limit: i64,
    pub module: Rc<String>,
    pub residual: Option<Rc<RefCell<crate::hir::ResidualTrace>>>,
    effect_scope: Rc<Vec<Rc<Value>>>,
}

struct ArrayProgress {
    elements: Vec<crate::ast::ArrayElement>,
    index: usize,
    values: Vec<Value>,
    span: Span,
}

struct ShapeProgress {
    members: Vec<ShapeMember>,
    index: usize,
    fields: OrderedFields,
    span: Span,
}

struct BranchProgress {
    branches: Vec<crate::ast::Branch>,
    fallback: Option<ExpressionId>,
    index: usize,
    span: Span,
}

impl Runtime {
    pub fn new(phase: Phase, module: String) -> Self {
        let limit = 1_000_000;
        Self {
            phase,
            fuel: Rc::new(Cell::new(limit)),
            limit,
            module: Rc::new(module),
            residual: None,
            effect_scope: Rc::new(Vec::new()),
        }
    }

    pub(crate) fn residual(
        phase: Phase,
        module: String,
        trace: Rc<RefCell<crate::hir::ResidualTrace>>,
    ) -> Self {
        let mut runtime = Self::new(phase, module);
        runtime.residual = Some(trace);
        runtime
    }

    fn comptime(&self) -> Self {
        Self {
            phase: Phase::Comptime,
            fuel: self.fuel.clone(),
            limit: self.limit,
            module: self.module.clone(),
            residual: self.residual.clone(),
            effect_scope: self.effect_scope.clone(),
        }
    }
}

pub enum Computation {
    Done(Result<Value, Diagnostic>),
    Perform {
        request: Perform,
        resume: Box<dyn FnOnce(Value) -> Computation>,
    },
}

impl Computation {
    pub fn value(value: Value) -> Self {
        Self::Done(Ok(value))
    }

    pub fn error(error: Diagnostic) -> Self {
        Self::Done(Err(error))
    }

    pub fn and_then(self, next: impl FnOnce(Value) -> Computation + 'static) -> Computation {
        match self {
            Computation::Done(Ok(value)) => next(value),
            Computation::Done(Err(error)) => Computation::Done(Err(error)),
            Computation::Perform { request, resume } => Computation::Perform {
                request,
                resume: Box::new(move |value| resume(value).and_then(next)),
            },
        }
    }

    /// Continues with the settled result, error included. A dynamic branch
    /// join uses this to turn an arm's comptime `@panic` into a residual trap
    /// rather than a compile failure.
    fn map_result(
        self,
        next: impl FnOnce(Result<Value, Diagnostic>) -> Computation + 'static,
    ) -> Computation {
        match self {
            Computation::Done(result) => next(result),
            Computation::Perform { request, resume } => Computation::Perform {
                request,
                resume: Box::new(move |value| resume(value).map_result(next)),
            },
        }
    }

    fn at(self, origin: Rc<String>) -> Computation {
        match self {
            Computation::Done(Ok(value)) => Computation::Done(Ok(value)),
            Computation::Done(Err(error)) => Computation::Done(Err(error.at(&origin))),
            Computation::Perform { request, resume } => Computation::Perform {
                request,
                resume: Box::new(move |value| resume(value).at(origin)),
            },
        }
    }
}

#[derive(Clone)]
pub struct Perform {
    pub effect_id: u32,
    pub effect_name: String,
    pub operation: String,
    pub argument: Value,
    pub result_type: Value,
    pub span: Span,
    pub host: bool,
}

pub fn run(computation: Computation) -> Result<Value, Diagnostic> {
    match computation {
        Computation::Done(result) => result,
        Computation::Perform { request, .. } => Err(Diagnostic::new(
            "BLOT_UNHANDLED_EFFECT",
            format!(
                "No handler for `{}.{}`.",
                request.effect_name, request.operation
            ),
            request.span,
        )),
    }
}

pub fn evaluate_module(
    context: Rc<Context>,
    path: String,
    argument: Value,
    mut runtime: Runtime,
) -> Computation {
    let path = Rc::new(path);
    runtime.module = path.clone();
    let loaded = match context.modules.borrow().get(path.as_str()).cloned() {
        Some(loaded) => loaded,
        None => {
            return Computation::error(Diagnostic::new(
                "BLOT_UNRESOLVED_IMPORT",
                format!("Module `{path}` was not loaded."),
                Span { start: 0, end: 0 },
            ));
        }
    };
    let environment = child_env(None);
    let parameter = loaded.module.parameter;
    if let Some(parameter) = parameter
        && !match_pattern(&loaded.module, parameter, &argument, &environment)
    {
        return Computation::error(Diagnostic::new(
            "BLOT_ARGUMENT_MISMATCH",
            format!("{} does not match this module input.", show(&argument)),
            loaded.module.span,
        ));
    }
    let live_declarations = live_declarations_for(
        &context,
        &path,
        &loaded.module,
        None,
        &loaded.module.declarations,
        loaded.module.result,
    );
    evaluate_declarations(
        context,
        path,
        live_declarations,
        0,
        environment,
        runtime,
        loaded.module.result,
    )
}

pub fn module_closure(context: &Rc<Context>, path: &str) -> Result<Value, Diagnostic> {
    context.modules.borrow().get(path).cloned().ok_or_else(|| {
        Diagnostic::new(
            "BLOT_UNRESOLVED_IMPORT",
            format!("Module `{path}` was not loaded."),
            Span { start: 0, end: 0 },
        )
    })?;
    Ok(Value::ModuleClosure {
        module: path.to_owned(),
    })
}

pub fn evaluate_expression(
    context: Rc<Context>,
    module_path: Rc<String>,
    expression_id: ExpressionId,
    environment: Environment,
    runtime: Runtime,
) -> Computation {
    let remaining = runtime.fuel.get() - 1;
    runtime.fuel.set(remaining);
    let loaded_module = match module(&context, &module_path) {
        Ok(module) => module,
        Err(error) => return Computation::error(error.at(&module_path)),
    };
    let expression = match loaded_module
        .arena
        .expressions
        .get(expression_id.0 as usize)
    {
        Some(expression) => expression,
        None => {
            return Computation::error(
                Diagnostic::new(
                    "BLOT_RUST_INVARIANT",
                    format!(
                        "Expression {} is outside module `{module_path}`.",
                        expression_id.0
                    ),
                    loaded_module.span,
                )
                .at(&module_path),
            );
        }
    };
    let span = expression_span(expression);
    if remaining < 0 {
        return Computation::error(
            Diagnostic::new(
                "BLOT_EVALUATION_LIMIT",
                format!(
                    "Evaluation exceeded its deterministic limit of {} steps.",
                    runtime.limit
                ),
                span,
            )
            .at(&module_path),
        );
    }

    let origin = module_path.clone();
    let computation = match expression {
        Expression::Int { value, .. } => {
            if runtime.phase == Phase::Runtime
                && (value < &(-BigIntExt::two_to_63()) || value > &BigIntExt::two_to_63_minus_one())
            {
                return Computation::error(Diagnostic::new(
                    "BLOT_INTEGER_OVERFLOW",
                    format!("The runtime integer {value} is outside signed i64."),
                    span,
                ));
            }
            Computation::value(Value::Int(value.clone()))
        }
        Expression::Float { value, .. } => Computation::value(Value::Float(*value)),
        Expression::Text { value, .. } => Computation::value(Value::Text(value.clone())),
        Expression::Unit { .. } => Computation::value(Value::Unit),
        Expression::Tag { name, .. } => Computation::value(Value::Tag {
            name: name.clone(),
            payload: None,
        }),
        Expression::Var { name, .. } => match lookup(&environment, name) {
            Some(Value::Deferred {
                module: suspended_module,
                expression,
                environment: suspended_environment,
                demanded,
            }) => {
                if demanded.get() {
                    return Computation::error(Diagnostic::new(
                        "BLOT_DEFERRED_DEMANDED_TWICE",
                        format!(
                            "Deferred parameter `{name}` was demanded more than once. Force it once into an ordinary `let` binding before reusing the value."
                        ),
                        span,
                    ));
                }
                demanded.set(true);
                evaluate_expression(
                    context,
                    suspended_module,
                    expression,
                    suspended_environment,
                    runtime,
                )
            }
            Some(mut value) => {
                if let Value::Closure { signature, .. } = &mut value
                    && signature.is_none()
                    && let Some(inferred) = lookup_signature(&environment, name)
                {
                    *signature = Some(Box::new(inferred));
                }
                Computation::value(value)
            }
            None => Computation::error(Diagnostic::new(
                "BLOT_UNBOUND",
                format!("`{name}` is not in scope."),
                span,
            )),
        },
        Expression::Intrinsic { name, .. } => intrinsic(name.clone(), span),
        Expression::Apply {
            function, argument, ..
        } => {
            let function = *function;
            let argument = *argument;
            let argument_context = context.clone();
            let argument_module = module_path.clone();
            let argument_environment = environment.clone();
            let argument_runtime = runtime.clone();
            evaluate_expression(
                context.clone(),
                module_path.clone(),
                function,
                environment,
                runtime,
            )
            .and_then(move |function| {
                // A deferred parameter is handed the argument unevaluated, so
                // the decision not to run it belongs to the body's reads.
                if let Value::Closure {
                    module: closure_module,
                    deferred: true,
                    ..
                } = &function
                {
                    // Deferral is settled while compiling. A residual trace
                    // means this call is being staged into the running
                    // program, which has no representation for a suspension —
                    // source elaboration refuses the same program.
                    if argument_runtime.residual.is_some() {
                        return Computation::error(Diagnostic::new(
                            "BLOT_DEFERRED_AT_RUNTIME",
                            concat!(
                                "A deferred parameter is only supplied while compiling. This call ",
                                "survives into the emitted program, where the argument would run ",
                                "whether or not the parameter is read."
                            ),
                            span,
                        ));
                    }
                    let suspended = Value::Deferred {
                        module: closure_module.clone(),
                        expression: argument,
                        environment: argument_environment,
                        demanded: Rc::new(Cell::new(false)),
                    };
                    return apply(
                        argument_context,
                        function,
                        suspended,
                        span,
                        argument_runtime,
                    );
                }
                evaluate_expression(
                    argument_context.clone(),
                    argument_module,
                    argument,
                    argument_environment,
                    argument_runtime.clone(),
                )
                .and_then(move |argument| {
                    apply(argument_context, function, argument, span, argument_runtime)
                })
            })
        }
        Expression::Field { target, name, .. } => {
            let name = name.clone();
            evaluate_expression(context, module_path, *target, environment, runtime)
                .and_then(move |target| project(target, &name, span))
        }
        Expression::Lambda {
            parameter,
            body,
            deferred,
            ..
        } => {
            let signature = context
                .closure_signatures
                .borrow()
                .get(&(module_path.as_ref().clone(), *body))
                .cloned()
                .map(Box::new);
            Computation::value(Value::Closure {
                module: module_path,
                parameter: *parameter,
                body: *body,
                deferred: *deferred,
                environment,
                self_name: None,
                imports: None,
                signature,
            })
        }
        Expression::Tuple { elements, .. } => evaluate_many(
            context,
            module_path,
            elements.clone(),
            environment,
            runtime,
            Vec::new(),
        )
        .and_then(|elements| match elements {
            Value::Array(elements) => Computation::value(tuple(elements)),
            _ => unreachable!("evaluate_many returns its private array accumulator"),
        }),
        Expression::Array { elements, .. } => evaluate_array(
            context,
            module_path,
            environment,
            runtime,
            ArrayProgress {
                elements: elements.clone(),
                index: 0,
                values: Vec::new(),
                span,
            },
        ),
        Expression::Shape { members, .. } => evaluate_shape(
            context,
            module_path,
            environment,
            runtime,
            ShapeProgress {
                members: members.clone(),
                index: 0,
                fields: OrderedFields::default(),
                span,
            },
        ),
        Expression::If {
            branches, fallback, ..
        } => evaluate_if(
            context,
            module_path,
            environment,
            runtime,
            BranchProgress {
                branches: branches.clone(),
                fallback: *fallback,
                index: 0,
                span,
            },
        ),
        Expression::Case { target, arms, .. } => {
            let target_context = context.clone();
            let target_module = module_path.clone();
            let target_environment = environment.clone();
            let target_runtime = runtime.clone();
            let arms = arms.clone();
            evaluate_expression(context, module_path, *target, environment, runtime).and_then(
                move |target| {
                    if let Value::Runtime(target) = &target {
                        return evaluate_dynamic_case(
                            target_context,
                            target_module,
                            target_environment,
                            target_runtime,
                            target.clone(),
                            arms,
                            span,
                        );
                    }
                    let module = match module(&target_context, &target_module) {
                        Ok(module) => module,
                        Err(error) => return Computation::error(error),
                    };
                    for arm in arms {
                        let scope = child_env(Some(target_environment.clone()));
                        if match_pattern(&module, arm.pattern, &target, &scope) {
                            return evaluate_expression(
                                target_context,
                                target_module,
                                arm.body,
                                scope,
                                target_runtime,
                            );
                        }
                    }
                    Computation::error(Diagnostic::new(
                        "BLOT_NO_MATCH",
                        format!("No arm matched {}.", show(&target)),
                        span,
                    ))
                },
            )
        }
        Expression::Block {
            declarations,
            result,
            ..
        } => {
            let scope = child_env(Some(environment));
            let module = match module(&context, &module_path) {
                Ok(module) => module,
                Err(error) => return Computation::error(error),
            };
            let declarations = live_declarations_for(
                &context,
                &module_path,
                &module,
                Some(expression_id),
                declarations,
                *result,
            );
            evaluate_declarations(
                context,
                module_path,
                declarations,
                0,
                scope,
                runtime,
                *result,
            )
        }
        Expression::Rec { .. } => Computation::error(Diagnostic::new(
            "BLOT_MISPLACED_REC",
            "`rec` marks a `let rec` or `const rec` binding.",
            span,
        )),
        Expression::Comptime { body, .. } => {
            evaluate_expression(context, module_path, *body, environment, runtime.comptime())
        }
    };
    computation.at(origin)
}

fn evaluate_many(
    context: Rc<Context>,
    module_path: Rc<String>,
    expressions: Vec<ExpressionId>,
    environment: Environment,
    runtime: Runtime,
    values: Vec<Value>,
) -> Computation {
    if values.len() == expressions.len() {
        return Computation::value(Value::Array(values));
    }
    let index = values.len();
    let expression = expressions[index];
    let next_context = context.clone();
    let next_module = module_path.clone();
    let next_environment = environment.clone();
    let next_runtime = runtime.clone();
    evaluate_expression(context, module_path, expression, environment, runtime).and_then(
        move |value| {
            let mut values = values;
            values.push(value);
            evaluate_many(
                next_context,
                next_module,
                expressions,
                next_environment,
                next_runtime,
                values,
            )
        },
    )
}

fn evaluate_dynamic_case(
    context: Rc<Context>,
    module_path: Rc<String>,
    environment: Environment,
    runtime: Runtime,
    target: RuntimeValue,
    arms: Vec<crate::ast::Arm>,
    span: Span,
) -> Computation {
    match target.meaning.clone() {
        RuntimeMeaning::Ordering | RuntimeMeaning::ScalarOrdering { .. } => evaluate_ordering_arms(
            context,
            module_path,
            environment,
            runtime,
            target,
            arms,
            0,
            Vec::new(),
            span,
        ),
        RuntimeMeaning::Sum { cases } => evaluate_sum_case(
            context,
            module_path,
            environment,
            runtime,
            target,
            cases,
            arms,
            span,
        ),
        RuntimeMeaning::Plain | RuntimeMeaning::ReusableStore => {
            let boolean = runtime
                .residual
                .as_ref()
                .is_some_and(|trace| trace.borrow().is_boolean(&target));
            if boolean {
                return evaluate_boolean_case(
                    context,
                    module_path,
                    environment,
                    runtime,
                    target,
                    arms,
                    span,
                );
            }
            let sum_cases = runtime
                .residual
                .as_ref()
                .and_then(|trace| trace.borrow().sum_cases(&target));
            if let Some(cases) = sum_cases {
                return evaluate_sum_case(
                    context,
                    module_path,
                    environment,
                    runtime,
                    target,
                    cases,
                    arms,
                    span,
                );
            }
            let integer = runtime
                .residual
                .as_ref()
                .is_some_and(|trace| trace.borrow().is_integer(&target));
            if !integer {
                let type_name = runtime
                    .residual
                    .as_ref()
                    .map(|trace| trace.borrow().type_name(&target))
                    .unwrap_or("unknown");
                return Computation::error(Diagnostic::new(
                    "BLOT_UNSUPPORTED_LOWERING",
                    format!("A dynamic {type_name} case is outside the Rust residual calculus."),
                    span,
                ));
            }
            evaluate_integer_case(
                context,
                module_path,
                environment,
                runtime,
                target,
                arms,
                span,
            )
        }
    }
}

fn evaluate_boolean_case(
    context: Rc<Context>,
    module_path: Rc<String>,
    environment: Environment,
    runtime: Runtime,
    target: RuntimeValue,
    arms: Vec<crate::ast::Arm>,
    span: Span,
) -> Computation {
    let loaded = match module(&context, &module_path) {
        Ok(module) => module,
        Err(error) => return Computation::error(error),
    };
    let select = |name: &str| {
        arms.iter()
            .find(|arm| {
                matches!(
                    &loaded.arena.patterns[arm.pattern.0 as usize],
                    Pattern::Constructor { name: candidate, .. } if candidate == name
                )
            })
            .cloned()
            .or_else(|| {
                arms.iter()
                    .find(|arm| {
                        matches!(
                            loaded.arena.patterns[arm.pattern.0 as usize],
                            Pattern::Wildcard { .. }
                        )
                    })
                    .cloned()
            })
    };
    let (Some(consequent_arm), Some(alternate_arm)) = (select("True"), select("False")) else {
        return Computation::error(Diagnostic::new(
            "BLOT_UNSUPPORTED_LOWERING",
            "A dynamic Boolean case must cover True and False.",
            span,
        ));
    };
    let Some(trace) = runtime.residual.clone() else {
        return Computation::error(Diagnostic::new(
            "BLOT_RUST_INVARIANT",
            "A runtime Boolean exists without a residual trace.",
            span,
        ));
    };
    let branches = match trace.borrow_mut().begin_conditional(&target, span) {
        Ok(branches) => branches,
        Err(error) => return Computation::error(error),
    };
    trace.borrow_mut().select_block(branches.consequent);
    let alternate_context = context.clone();
    let join_context = context.clone();
    let alternate_module = module_path.clone();
    let alternate_environment = environment.clone();
    let alternate_runtime = runtime.clone();
    let alternate_trace = trace.clone();
    evaluate_expression(
        context,
        module_path,
        consequent_arm.body,
        child_env(Some(environment)),
        runtime,
    )
    .and_then(move |consequent| {
        let consequent_end = alternate_trace.borrow().current_block();
        alternate_trace
            .borrow_mut()
            .select_block(branches.alternate);
        let join_trace = alternate_trace.clone();
        evaluate_expression(
            alternate_context,
            alternate_module,
            alternate_arm.body,
            child_env(Some(alternate_environment)),
            alternate_runtime,
        )
        .and_then(move |alternate| {
            let alternate_end = join_trace.borrow().current_block();
            match join_trace.borrow_mut().join_conditional(
                &join_context,
                branches,
                consequent_end,
                consequent,
                alternate_end,
                alternate,
                span,
            ) {
                Ok(value) => Computation::value(value),
                Err(error) => Computation::error(error),
            }
        })
    })
}

#[allow(clippy::too_many_arguments)]
fn evaluate_integer_case(
    context: Rc<Context>,
    module_path: Rc<String>,
    environment: Environment,
    runtime: Runtime,
    target: RuntimeValue,
    arms: Vec<crate::ast::Arm>,
    span: Span,
) -> Computation {
    if arms.len() != 2 {
        return Computation::error(Diagnostic::new(
            "BLOT_UNSUPPORTED_LOWERING",
            "The Rust residual calculus currently lowers a dynamic integer case with one literal and one wildcard.",
            span,
        ));
    }
    let loaded = match module(&context, &module_path) {
        Ok(module) => module,
        Err(error) => return Computation::error(error),
    };
    let expected = match &loaded.arena.patterns[arms[0].pattern.0 as usize] {
        Pattern::Int { value, .. } => Value::Int(value.clone()),
        Pattern::Pin { name, .. } => match lookup(&environment, name) {
            Some(Value::Int(value)) => Value::Int(value),
            _ => {
                return Computation::error(Diagnostic::new(
                    "BLOT_UNSUPPORTED_LOWERING",
                    "A dynamic pinned integer pattern must name a staged integer.",
                    span,
                ));
            }
        },
        _ => {
            return Computation::error(Diagnostic::new(
                "BLOT_UNSUPPORTED_LOWERING",
                "The first dynamic integer arm must be a literal or pinned integer.",
                span,
            ));
        }
    };
    if !matches!(
        loaded.arena.patterns[arms[1].pattern.0 as usize],
        Pattern::Wildcard { .. }
    ) {
        return Computation::error(Diagnostic::new(
            "BLOT_UNSUPPORTED_LOWERING",
            "The final dynamic integer arm must be a wildcard.",
            span,
        ));
    }
    let Some(trace) = runtime.residual.clone() else {
        return Computation::error(Diagnostic::new(
            "BLOT_RUST_INVARIANT",
            "A runtime integer exists without a residual trace.",
            span,
        ));
    };
    let condition = match trace.borrow_mut().integer_equal(&target, &expected, span) {
        Ok(condition) => condition,
        Err(error) => return Computation::error(error),
    };
    let branches = match trace.borrow_mut().begin_conditional(&condition, span) {
        Ok(branches) => branches,
        Err(error) => return Computation::error(error),
    };
    trace.borrow_mut().select_block(branches.consequent);
    let alternate_context = context.clone();
    let join_context = context.clone();
    let alternate_module = module_path.clone();
    let alternate_environment = environment.clone();
    let alternate_runtime = runtime.clone();
    let alternate_body = arms[1].body;
    evaluate_expression(
        context,
        module_path,
        arms[0].body,
        child_env(Some(environment)),
        runtime,
    )
    .and_then(move |consequent| {
        let consequent_end = trace.borrow().current_block();
        trace.borrow_mut().select_block(branches.alternate);
        let join_trace = trace.clone();
        evaluate_expression(
            alternate_context,
            alternate_module,
            alternate_body,
            child_env(Some(alternate_environment)),
            alternate_runtime,
        )
        .and_then(move |alternate| {
            let alternate_end = join_trace.borrow().current_block();
            match join_trace.borrow_mut().join_conditional(
                &join_context,
                branches,
                consequent_end,
                consequent,
                alternate_end,
                alternate,
                span,
            ) {
                Ok(value) => Computation::value(value),
                Err(error) => Computation::error(error),
            }
        })
    })
}

#[allow(clippy::too_many_arguments)]
fn evaluate_ordering_arms(
    context: Rc<Context>,
    module_path: Rc<String>,
    environment: Environment,
    runtime: Runtime,
    target: RuntimeValue,
    arms: Vec<crate::ast::Arm>,
    index: usize,
    outcomes: Vec<(i8, bool)>,
    span: Span,
) -> Computation {
    let Some(arm) = arms.get(index).cloned() else {
        if outcomes.len() != 3 {
            return Computation::error(Diagnostic::new(
                "BLOT_UNSUPPORTED_LOWERING",
                "A dynamic ordering case must cover Less, Equal, and Greater.",
                span,
            ));
        }
        let true_signs = outcomes
            .into_iter()
            .filter_map(|(sign, outcome)| if outcome { Some(sign) } else { None })
            .collect::<Vec<_>>();
        let Some(trace) = runtime.residual else {
            return Computation::error(Diagnostic::new(
                "BLOT_RUST_INVARIANT",
                "A runtime ordering exists without a residual trace.",
                span,
            ));
        };
        return match trace
            .borrow_mut()
            .ordering_boolean(&target, &true_signs, span)
        {
            Ok(value) => Computation::value(value),
            Err(error) => Computation::error(error),
        };
    };
    let loaded = match module(&context, &module_path) {
        Ok(module) => module,
        Err(error) => return Computation::error(error),
    };
    let pattern = &loaded.arena.patterns[arm.pattern.0 as usize];
    let Pattern::Constructor {
        name,
        payload: None,
        ..
    } = pattern
    else {
        return Computation::error(Diagnostic::new(
            "BLOT_UNSUPPORTED_LOWERING",
            "A dynamic ordering arm must be a payload-free constructor.",
            span,
        ));
    };
    let sign = match name.as_str() {
        "Less" => -1,
        "Equal" => 0,
        "Greater" => 1,
        _ => {
            return Computation::error(Diagnostic::new(
                "BLOT_UNSUPPORTED_LOWERING",
                format!("`#{name}` is not an ordering constructor."),
                span,
            ));
        }
    };
    let next_context = context.clone();
    let next_module = module_path.clone();
    let next_environment = environment.clone();
    let next_runtime = runtime.clone();
    evaluate_expression(context, module_path, arm.body, environment, runtime).and_then(
        move |value| {
            let outcome = match truth(&value, span) {
                Ok(outcome) => outcome,
                Err(_) => {
                    return Computation::error(Diagnostic::new(
                        "BLOT_UNSUPPORTED_LOWERING",
                        "A dynamic ordering arm must reduce to Boolean.",
                        span,
                    ));
                }
            };
            let mut outcomes = outcomes;
            outcomes.push((sign, outcome));
            evaluate_ordering_arms(
                next_context,
                next_module,
                next_environment,
                next_runtime,
                target,
                arms,
                index + 1,
                outcomes,
                span,
            )
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn evaluate_sum_case(
    context: Rc<Context>,
    module_path: Rc<String>,
    environment: Environment,
    runtime: Runtime,
    target: RuntimeValue,
    cases: Vec<String>,
    arms: Vec<crate::ast::Arm>,
    span: Span,
) -> Computation {
    if cases.is_empty() || cases.len() > 2 {
        return Computation::error(Diagnostic::new(
            "BLOT_UNSUPPORTED_LOWERING",
            "The Rust residual calculus currently lowers sums with one or two cases.",
            span,
        ));
    }
    let loaded = match module(&context, &module_path) {
        Ok(module) => module,
        Err(error) => return Computation::error(error),
    };
    let selected = cases
        .iter()
        .map(|case_name| {
            arms.iter()
                .find(|arm| {
                    matches!(
                        &loaded.arena.patterns[arm.pattern.0 as usize],
                        Pattern::Constructor { name, .. } if name == case_name
                    )
                })
                .cloned()
        })
        .collect::<Option<Vec<_>>>();
    let Some(selected) = selected else {
        return Computation::error(Diagnostic::new(
            "BLOT_UNSUPPORTED_LOWERING",
            "A dynamic sum case must cover both constructors explicitly.",
            span,
        ));
    };
    let Some(trace) = runtime.residual.clone() else {
        return Computation::error(Diagnostic::new(
            "BLOT_RUST_INVARIANT",
            "A runtime sum exists without a residual trace.",
            span,
        ));
    };
    if cases.len() == 1 {
        let scope = child_env(Some(environment));
        let payload = match trace.borrow_mut().sum_payload(&target, 0, span) {
            Ok(payload) => payload,
            Err(error) => return Computation::error(error),
        };
        let tagged = compiler_tag_value(cases[0].clone(), payload);
        if !match_pattern(&loaded, selected[0].pattern, &tagged, &scope) {
            return Computation::error(Diagnostic::new(
                "BLOT_UNSUPPORTED_LOWERING",
                "The dynamic sum pattern cannot bind its payload.",
                span,
            ));
        }
        return evaluate_expression(context, module_path, selected[0].body, scope, runtime);
    }
    let condition = match trace.borrow_mut().sum_condition(&target, span) {
        Ok(condition) => condition,
        Err(error) => return Computation::error(error),
    };
    let branches = match trace.borrow_mut().begin_conditional(&condition, span) {
        Ok(branches) => branches,
        Err(error) => return Computation::error(error),
    };

    trace.borrow_mut().select_block(branches.consequent);
    let consequent_scope = child_env(Some(environment.clone()));
    let consequent_payload = match trace.borrow_mut().sum_payload(&target, 0, span) {
        Ok(payload) => payload,
        Err(error) => return Computation::error(error),
    };
    let consequent_tag = compiler_tag_value(cases[0].clone(), consequent_payload);
    if !match_pattern(
        &loaded,
        selected[0].pattern,
        &consequent_tag,
        &consequent_scope,
    ) {
        return Computation::error(Diagnostic::new(
            "BLOT_UNSUPPORTED_LOWERING",
            "The first dynamic sum pattern cannot bind its payload.",
            span,
        ));
    }

    let alternate_context = context.clone();
    let join_context = context.clone();
    let alternate_module = module_path.clone();
    let alternate_runtime = runtime.clone();
    let alternate_trace = trace.clone();
    let alternate_loaded = loaded.clone();
    let alternate_arm = selected[1].clone();
    let alternate_case = cases[1].clone();
    let alternate_target = target.clone();
    evaluate_expression(
        context,
        module_path,
        selected[0].body,
        consequent_scope,
        runtime,
    )
    .map_result(move |consequent_result| {
        let consequent = match consequent_result {
            Ok(value) => Some(value),
            Err(error) if error.code == "BLOT_PANIC" => {
                alternate_trace
                    .borrow_mut()
                    .trap_current_block(&error.message, span);
                None
            }
            Err(error) => return Computation::error(error),
        };
        let consequent_end = alternate_trace.borrow().current_block();
        alternate_trace
            .borrow_mut()
            .select_block(branches.alternate);
        let alternate_scope = child_env(Some(environment));
        let alternate_payload =
            match alternate_trace
                .borrow_mut()
                .sum_payload(&alternate_target, 1, span)
            {
                Ok(payload) => payload,
                Err(error) => return Computation::error(error),
            };
        let alternate_tag = compiler_tag_value(alternate_case, alternate_payload);
        if !match_pattern(
            &alternate_loaded,
            alternate_arm.pattern,
            &alternate_tag,
            &alternate_scope,
        ) {
            return Computation::error(Diagnostic::new(
                "BLOT_UNSUPPORTED_LOWERING",
                "The second dynamic sum pattern cannot bind its payload.",
                span,
            ));
        }
        let join_trace = alternate_trace.clone();
        evaluate_expression(
            alternate_context,
            alternate_module,
            alternate_arm.body,
            alternate_scope,
            alternate_runtime,
        )
        .map_result(move |alternate_result| {
            let alternate = match alternate_result {
                Ok(value) => Some(value),
                Err(error) if error.code == "BLOT_PANIC" && consequent.is_some() => {
                    join_trace
                        .borrow_mut()
                        .trap_current_block(&error.message, span);
                    None
                }
                Err(error) => return Computation::error(error),
            };
            let alternate_end = join_trace.borrow().current_block();
            match (consequent, alternate) {
                (Some(consequent), Some(alternate)) => {
                    match join_trace.borrow_mut().join_conditional(
                        &join_context,
                        branches,
                        consequent_end,
                        consequent,
                        alternate_end,
                        alternate,
                        span,
                    ) {
                        Ok(value) => Computation::value(value),
                        Err(error) => Computation::error(error),
                    }
                }
                (Some(consequent), None) => {
                    join_trace
                        .borrow_mut()
                        .join_survivor(&branches, consequent_end, span);
                    Computation::value(consequent)
                }
                (None, Some(alternate)) => {
                    join_trace
                        .borrow_mut()
                        .join_survivor(&branches, alternate_end, span);
                    Computation::value(alternate)
                }
                (None, None) => {
                    unreachable!("a trapped alternate propagates when the consequent trapped")
                }
            }
        })
    })
}

fn compiler_tag_value(name: String, payload: Value) -> Value {
    if !name.contains('$') {
        let payload = if matches!(payload, Value::Unit) {
            None
        } else {
            Some(Box::new(payload))
        };
        return Value::Tag { name, payload };
    }
    Value::Tag {
        name,
        payload: Some(Box::new(Value::Shape(OrderedFields::from([(
            "value".to_owned(),
            payload,
        )])))),
    }
}

fn evaluate_array(
    context: Rc<Context>,
    module_path: Rc<String>,
    environment: Environment,
    runtime: Runtime,
    progress: ArrayProgress,
) -> Computation {
    let Some(element) = progress.elements.get(progress.index).cloned() else {
        return Computation::value(Value::Array(progress.values));
    };
    let next_context = context.clone();
    let next_module = module_path.clone();
    let next_environment = environment.clone();
    let next_runtime = runtime.clone();
    evaluate_expression(context, module_path, element.value, environment, runtime).and_then(
        move |value| {
            let mut values = progress.values;
            if element.spread {
                let spread = match value {
                    Value::Array(spread) => spread,
                    Value::EmptyArray { .. } => Vec::new(),
                    _ => {
                        return Computation::error(Diagnostic::new(
                            "BLOT_TYPE",
                            format!("`...` spreads an array, found {}.", show(&value)),
                            progress.span,
                        ));
                    }
                };
                values.extend(spread);
            } else {
                values.push(value);
            }
            evaluate_array(
                next_context,
                next_module,
                next_environment,
                next_runtime,
                ArrayProgress {
                    elements: progress.elements,
                    index: progress.index + 1,
                    values,
                    span: progress.span,
                },
            )
        },
    )
}

fn evaluate_shape(
    context: Rc<Context>,
    module_path: Rc<String>,
    environment: Environment,
    runtime: Runtime,
    progress: ShapeProgress,
) -> Computation {
    let Some(member) = progress.members.get(progress.index).cloned() else {
        return Computation::value(Value::Shape(progress.fields));
    };
    let value_id = match member {
        ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => value,
    };
    let next_context = context.clone();
    let next_module = module_path.clone();
    let next_environment = environment.clone();
    let next_runtime = runtime.clone();
    evaluate_expression(context, module_path, value_id, environment, runtime).and_then(
        move |value| {
            let mut fields = progress.fields;
            match member {
                ShapeMember::Field { name, .. } => {
                    fields.insert(name, value);
                }
                ShapeMember::Spread { .. } => {
                    let Value::Shape(spread) = value else {
                        return Computation::error(Diagnostic::new(
                            "BLOT_TYPE",
                            format!("`...` spreads a shape, found {}.", show(&value)),
                            progress.span,
                        ));
                    };
                    fields.extend(spread);
                }
            }
            evaluate_shape(
                next_context,
                next_module,
                next_environment,
                next_runtime,
                ShapeProgress {
                    members: progress.members,
                    index: progress.index + 1,
                    fields,
                    span: progress.span,
                },
            )
        },
    )
}

fn evaluate_if(
    context: Rc<Context>,
    module_path: Rc<String>,
    environment: Environment,
    runtime: Runtime,
    progress: BranchProgress,
) -> Computation {
    let Some(branch) = progress.branches.get(progress.index).cloned() else {
        return match progress.fallback {
            Some(fallback) => {
                evaluate_expression(context, module_path, fallback, environment, runtime)
            }
            None => Computation::error(Diagnostic::new(
                "BLOT_NO_BRANCH",
                "No branch matched and there is no `else`.",
                progress.span,
            )),
        };
    };
    let next_context = context.clone();
    let next_module = module_path.clone();
    let next_environment = environment.clone();
    let next_runtime = runtime.clone();
    evaluate_expression(context, module_path, branch.condition, environment, runtime).and_then(
        move |condition| match &condition {
            Value::Runtime(condition) => evaluate_dynamic_if(
                next_context,
                next_module,
                next_environment,
                next_runtime,
                progress,
                branch,
                condition.clone(),
            ),
            _ => match truth(&condition, progress.span) {
                Ok(true) => evaluate_expression(
                    next_context,
                    next_module,
                    branch.consequence,
                    next_environment,
                    next_runtime,
                ),
                Ok(false) => evaluate_if(
                    next_context,
                    next_module,
                    next_environment,
                    next_runtime,
                    BranchProgress {
                        branches: progress.branches,
                        fallback: progress.fallback,
                        index: progress.index + 1,
                        span: progress.span,
                    },
                ),
                Err(error) => Computation::error(error),
            },
        },
    )
}

fn evaluate_dynamic_if(
    context: Rc<Context>,
    module_path: Rc<String>,
    environment: Environment,
    runtime: Runtime,
    progress: BranchProgress,
    branch: crate::ast::Branch,
    condition: RuntimeValue,
) -> Computation {
    if progress.fallback.is_none() {
        return Computation::error(Diagnostic::new(
            "BLOT_UNSUPPORTED_LOWERING",
            "A value-producing dynamic conditional requires `else`.",
            progress.span,
        ));
    }
    let Some(trace) = runtime.residual.clone() else {
        return Computation::error(Diagnostic::new(
            "BLOT_RUST_INVARIANT",
            "A runtime condition exists without a residual trace.",
            progress.span,
        ));
    };
    let branches = match trace
        .borrow_mut()
        .begin_conditional(&condition, progress.span)
    {
        Ok(branches) => branches,
        Err(error) => return Computation::error(error),
    };
    trace.borrow_mut().select_block(branches.consequent);
    let alternate_context = context.clone();
    let join_context = context.clone();
    let alternate_module = module_path.clone();
    let alternate_environment = environment.clone();
    let alternate_runtime = runtime.clone();
    let alternate_progress = BranchProgress {
        branches: progress.branches,
        fallback: progress.fallback,
        index: progress.index + 1,
        span: progress.span,
    };
    evaluate_expression(
        context,
        module_path,
        branch.consequence,
        environment,
        runtime,
    )
    .map_result(move |consequent_result| {
        let consequent = match consequent_result {
            Ok(value) => Some(value),
            Err(error) if error.code == "BLOT_PANIC" => {
                trace
                    .borrow_mut()
                    .trap_current_block(&error.message, progress.span);
                None
            }
            Err(error) => return Computation::error(error),
        };
        let consequent_end = trace.borrow().current_block();
        trace.borrow_mut().select_block(branches.alternate);
        let join_trace = trace.clone();
        evaluate_if(
            alternate_context,
            alternate_module,
            alternate_environment,
            alternate_runtime,
            alternate_progress,
        )
        .map_result(move |alternate_result| {
            let alternate = match alternate_result {
                Ok(value) => Some(value),
                Err(error) if error.code == "BLOT_PANIC" && consequent.is_some() => {
                    join_trace
                        .borrow_mut()
                        .trap_current_block(&error.message, progress.span);
                    None
                }
                Err(error) => return Computation::error(error),
            };
            let alternate_end = join_trace.borrow().current_block();
            match (consequent, alternate) {
                (Some(consequent), Some(alternate)) => {
                    match join_trace.borrow_mut().join_conditional(
                        &join_context,
                        branches,
                        consequent_end,
                        consequent,
                        alternate_end,
                        alternate,
                        progress.span,
                    ) {
                        Ok(value) => Computation::value(value),
                        Err(error) => Computation::error(error),
                    }
                }
                (Some(consequent), None) => {
                    join_trace
                        .borrow_mut()
                        .join_survivor(&branches, consequent_end, progress.span);
                    Computation::value(consequent)
                }
                (None, Some(alternate)) => {
                    join_trace
                        .borrow_mut()
                        .join_survivor(&branches, alternate_end, progress.span);
                    Computation::value(alternate)
                }
                (None, None) => {
                    unreachable!("a trapped alternate propagates when the consequent trapped")
                }
            }
        })
    })
}

fn evaluate_declarations(
    context: Rc<Context>,
    module_path: Rc<String>,
    declarations: LiveDeclarations,
    index: usize,
    environment: Environment,
    runtime: Runtime,
    result: ExpressionId,
) -> Computation {
    let Some(declaration_id) = declarations.get(index).copied() else {
        return evaluate_expression(context, module_path, result, environment, runtime);
    };
    let declaration = match module_declaration(&context, &module_path, declaration_id) {
        Ok(declaration) => declaration,
        Err(error) => return Computation::error(error),
    };
    let span = declaration_span(&declaration);
    let next_context = context.clone();
    let next_module = module_path.clone();
    let next_environment = environment.clone();
    let next_runtime = runtime.clone();
    let continue_with = move || {
        evaluate_declarations(
            next_context,
            next_module,
            declarations,
            index + 1,
            next_environment,
            next_runtime,
            result,
        )
    };
    match declaration {
        Declaration::Binding {
            kind: DeclarationKind::Sig,
            pattern,
            value,
            ..
        } => {
            let signature_environment = environment.clone();
            let signature_context = context.clone();
            let signature_module = module_path.clone();
            evaluate_expression(context, module_path, value, environment, runtime.comptime())
                .and_then(move |signature| {
                    let module = match module(&signature_context, &signature_module) {
                        Ok(module) => module,
                        Err(error) => return Computation::error(error),
                    };
                    let Pattern::Name { name, .. } = &module.arena.patterns[pattern.0 as usize]
                    else {
                        return Computation::error(Diagnostic::new(
                            "BLOT_SIG_PATTERN",
                            "A signature must name one binding.",
                            span,
                        ));
                    };
                    signature_environment
                        .signatures
                        .borrow_mut()
                        .insert(name.clone(), signature);
                    continue_with()
                })
        }
        Declaration::Binding {
            kind,
            pattern,
            value,
            ..
        } => {
            let binding_runtime = if kind == DeclarationKind::Const {
                runtime.comptime()
            } else {
                runtime
            };
            let binding_context = context.clone();
            let binding_module = module_path.clone();
            let binding_environment = environment.clone();
            let effect_context = context.clone();
            let effect_runtime = binding_runtime.clone();
            evaluate_binding(
                context,
                module_path,
                pattern,
                value,
                environment,
                binding_runtime,
            )
            .and_then(move |value| {
                if kind == DeclarationKind::Effect {
                    force_effect_value(effect_context, value, span, effect_runtime)
                } else {
                    Computation::value(value)
                }
            })
            .and_then(move |mut value| {
                let module = match module(&binding_context, &binding_module) {
                    Ok(module) => module,
                    Err(error) => return Computation::error(error),
                };
                if let Pattern::Name { name, .. } = &module.arena.patterns[pattern.0 as usize]
                    && let Some(signature) = lookup_signature(&binding_environment, name)
                {
                    attach_signature(&mut value, &signature);
                }
                if !match_pattern(&module, pattern, &value, &binding_environment) {
                    return Computation::error(Diagnostic::new(
                        "BLOT_BINDING_MISMATCH",
                        format!("{} does not match this pattern.", show(&value)),
                        span,
                    ));
                }
                continue_with()
            })
        }
        Declaration::Shadow { name, value, .. } => {
            if lookup(&environment, &name).is_none() {
                return Computation::error(Diagnostic::new(
                    "BLOT_UNBOUND",
                    format!("`{name} := ...` cannot shadow a name that is not in scope."),
                    span,
                ));
            }
            let shadow_environment = environment.clone();
            evaluate_expression(context, module_path, value, environment, runtime).and_then(
                move |value| {
                    shadow_environment.names.borrow_mut().insert(name, value);
                    continue_with()
                },
            )
        }
        Declaration::Open { value, .. } => {
            let open_environment = environment.clone();
            evaluate_expression(context, module_path, value, environment, runtime).and_then(
                move |value| {
                    let Value::Shape(fields) = value else {
                        return Computation::error(Diagnostic::new(
                            "BLOT_CANNOT_OPEN",
                            format!("`open` spreads a record, found {}.", show(&value)),
                            span,
                        ));
                    };
                    let mut sources_by_target = BTreeMap::new();
                    for source in fields.keys() {
                        sources_by_target.insert(source.clone(), source.clone());
                    }
                    open_environment
                        .opens
                        .borrow_mut()
                        .push(OpenedValues::new(fields, sources_by_target));
                    continue_with()
                },
            )
        }
    }
}

pub(crate) fn evaluate_binding(
    context: Rc<Context>,
    module_path: Rc<String>,
    pattern: PatternId,
    value: ExpressionId,
    environment: Environment,
    runtime: Runtime,
) -> Computation {
    let expression = match module_expression(&context, &module_path, value) {
        Ok(expression) => expression,
        Err(error) => return Computation::error(error),
    };
    let loaded_module = match module(&context, &module_path) {
        Ok(module) => module,
        Err(error) => return Computation::error(error),
    };
    let Expression::Rec { lambda, span } = expression else {
        let binding_name = match &loaded_module.arena.patterns[pattern.0 as usize] {
            Pattern::Name { name, .. } => Some(name.clone()),
            _ => None,
        };
        return evaluate_expression(context, module_path, value, environment, runtime).and_then(
            move |value| {
                Computation::value(match &binding_name {
                    Some(name) => named_effect(value, name),
                    None => value,
                })
            },
        );
    };
    let Pattern::Name { name, .. } = &loaded_module.arena.patterns[pattern.0 as usize] else {
        return Computation::error(Diagnostic::new(
            "BLOT_MISPLACED_REC",
            "`rec` marks a `let rec` or `const rec` binding to a single name.",
            span,
        ));
    };
    let self_name = name.clone();
    evaluate_expression(context, module_path, lambda, environment, runtime).and_then(move |value| {
        let Value::Closure {
            module: closure_module,
            parameter,
            body,
            environment,
            imports,
            signature,
            deferred,
            ..
        } = value
        else {
            return Computation::error(Diagnostic::new(
                "BLOT_TYPE",
                "A recursive binding must bind a lambda.",
                span,
            ));
        };
        Computation::value(Value::Closure {
            module: closure_module,
            parameter,
            body,
            deferred,
            environment,
            self_name: Some(self_name),
            imports,
            signature,
        })
    })
}

fn named_effect(value: Value, name: &str) -> Value {
    let Value::Effect {
        id,
        name: effect_name,
        operations,
        host,
    } = value
    else {
        return value;
    };
    if effect_name != "Effect" {
        return Value::Effect {
            id,
            name: effect_name,
            operations,
            host,
        };
    }
    Value::Effect {
        id,
        name: name.to_owned(),
        operations,
        host,
    }
}

pub(crate) fn force_effect_value(
    context: Rc<Context>,
    value: Value,
    span: Span,
    runtime: Runtime,
) -> Computation {
    let runs_with_unit = match &value {
        Value::Closure {
            module,
            parameter,
            signature,
            ..
        } => match self::module(&context, module) {
            Ok(module) => {
                matches!(
                    module.arena.patterns[parameter.0 as usize],
                    Pattern::Unit { .. }
                ) || matches!(
                    signature.as_deref().map(signature_body),
                    Some(Value::Arrow { domain, .. }) if matches!(domain.as_ref(), Value::Unit)
                )
            }
            Err(error) => return Computation::error(error),
        },
        Value::Operation { effect, name } => match effect.as_ref() {
            Value::Effect { operations, .. } => matches!(
                operations.get(name),
                Some(Value::Arrow { domain, .. }) if matches!(domain.as_ref(), Value::Unit)
            ),
            _ => false,
        },
        _ => false,
    };
    if !runs_with_unit {
        return Computation::value(value);
    }
    apply(context, value, Value::Unit, span, runtime)
}

pub fn apply(
    context: Rc<Context>,
    function: Value,
    argument: Value,
    span: Span,
    runtime: Runtime,
) -> Computation {
    match function {
        Value::ModuleClosure { module } => {
            if runtime.phase == Phase::Comptime
                && runtime.residual.is_none()
                && matches!(argument, Value::Unit)
                && let Some(value) = context.module_results.borrow().get(&module).cloned()
            {
                return Computation::value(value);
            }
            evaluate_module(context, module, argument, runtime)
        }
        Value::IndexedStep { elements } => {
            let Value::Int(index) = argument else {
                return Computation::error(Diagnostic::new(
                    "BLOT_TYPE",
                    "An indexed iterator state is not an integer.",
                    span,
                ));
            };
            let Some(position) = num_traits::ToPrimitive::to_usize(&index) else {
                return Computation::value(Value::Tag {
                    name: "None".to_owned(),
                    payload: None,
                });
            };
            let Some(value) = elements.get(position).cloned() else {
                return Computation::value(Value::Tag {
                    name: "None".to_owned(),
                    payload: None,
                });
            };
            Computation::value(Value::Tag {
                name: "Some".to_owned(),
                payload: Some(Box::new(tuple(vec![
                    tuple(vec![Value::Int(index.clone()), value]),
                    Value::Int(index + 1),
                ]))),
            })
        }
        Value::ClosureChoice {
            selector,
            alternatives,
        } => apply_closure_choice(context, selector, alternatives, 0, argument, span, runtime),
        Value::Closure {
            module: closure_module,
            parameter,
            body,
            deferred: _,
            environment,
            self_name,
            imports: _,
            signature,
        } => {
            let mut argument = argument;
            let mut environment = environment;
            let mut residual_compilation = None;
            let recursive_signature = self_name
                .as_deref()
                .and_then(|name| lookup_signature(&environment, name));
            let inferred_signature = context
                .closure_signatures
                .borrow()
                .get(&(closure_module.as_ref().clone(), body))
                .cloned();
            let signature = signature
                .or_else(|| recursive_signature.map(Box::new))
                .or_else(|| inferred_signature.map(Box::new));
            let signature =
                signature.map(|signature| Box::new(substitute_signature(&signature, &environment)));
            let loaded = match module(&context, &closure_module) {
                Ok(module) => module,
                Err(error) => return Computation::error(error),
            };
            if self_name.is_some()
                && let Some(trace) = runtime.residual.clone()
            {
                let name = self_name.as_deref().expect("checked recursive closure");
                let call = trace.borrow_mut().begin_recursive_function(
                    crate::hir::ResidualClosure {
                        context: &context,
                        module: &closure_module,
                        parameter,
                        body,
                        name,
                        environment: &environment,
                        signature: signature.as_deref(),
                    },
                    &argument,
                    span,
                );
                match call {
                    Ok(crate::hir::ResidualFunctionCall::Static) => {}
                    Ok(crate::hir::ResidualFunctionCall::Existing(value)) => {
                        return Computation::value(value);
                    }
                    Ok(crate::hir::ResidualFunctionCall::Compile(compilation)) => {
                        argument = compilation.argument.clone();
                        environment = compilation.environment.clone();
                        residual_compilation = Some((trace, compilation));
                    }
                    Err(error) => return Computation::error(error),
                }
            }
            let scope = child_env(Some(environment));
            if let Some(Value::Arrow { domain, .. }) = signature.as_deref().map(signature_body) {
                record_signature_substitutions(&scope, domain, &argument);
            }
            if let Some(name) = self_name {
                scope.names.borrow_mut().insert(
                    name.clone(),
                    Value::Closure {
                        module: closure_module.clone(),
                        parameter,
                        body,
                        deferred: false,
                        environment: scope.parent.clone().expect("closure environment"),
                        self_name: Some(name),
                        imports: None,
                        signature: signature.clone(),
                    },
                );
            }
            let argument = match signature.as_deref().map(signature_body) {
                Some(Value::Arrow { domain, .. }) => match adapt_argument(argument, domain, span) {
                    Ok(argument) => argument,
                    Err(error) => return Computation::error(error),
                },
                _ => argument,
            };
            if !match_pattern(&loaded, parameter, &argument, &scope) {
                return Computation::error(Diagnostic::new(
                    "BLOT_ARGUMENT_MISMATCH",
                    format!("{} does not match this parameter.", show(&argument)),
                    span,
                ));
            }
            let mut closure_runtime = runtime;
            closure_runtime.module = closure_module.clone();
            Rc::make_mut(&mut closure_runtime.effect_scope).push(Rc::new(argument));
            evaluate_expression(context, closure_module, body, scope, closure_runtime).and_then(
                move |mut value| {
                    if let Some(Value::Arrow { codomain, .. }) =
                        signature.as_deref().map(signature_body)
                    {
                        attach_signature(&mut value, codomain);
                    }
                    let Some((trace, compilation)) = residual_compilation else {
                        return Computation::value(value);
                    };
                    match trace
                        .borrow_mut()
                        .finish_recursive_function(compilation, value)
                    {
                        Ok(value) => Computation::value(value),
                        Err(error) => Computation::error(error),
                    }
                },
            )
        }
        Value::Tag {
            name,
            payload: None,
        } => Computation::value(Value::Tag {
            name,
            payload: Some(Box::new(argument)),
        }),
        Value::Tag { name, .. } => Computation::error(Diagnostic::new(
            "BLOT_TYPE",
            format!("`#{name}` already carries a payload."),
            span,
        )),
        Value::Operation { effect, name } => {
            let Value::Effect {
                id,
                name: effect_name,
                operations,
                host,
            } = *effect
            else {
                return Computation::error(Diagnostic::new(
                    "BLOT_TYPE",
                    "An operation lost its effect.",
                    span,
                ));
            };
            let result_type = match operations.get(&name) {
                Some(Value::Arrow { codomain, .. }) => (**codomain).clone(),
                _ => Value::Unbounded,
            };
            let request = Perform {
                effect_id: id,
                effect_name,
                operation: name,
                argument,
                result_type,
                span,
                host,
            };
            Computation::Perform {
                request,
                resume: Box::new(Computation::value),
            }
        }
        Value::Continuation { used, resume } => {
            if *used.borrow() {
                return Computation::error(Diagnostic::new(
                    "BLOT_RESUME_TWICE",
                    "`resume` is one-shot and has already been called.",
                    span,
                ));
            }
            *used.borrow_mut() = true;
            let Some(resume) = resume.borrow_mut().take() else {
                return Computation::error(Diagnostic::new(
                    "BLOT_RESUME_TWICE",
                    "`resume` is one-shot and has already been called.",
                    span,
                ));
            };
            resume(argument)
        }
        Value::Primitive {
            name,
            arity,
            mut applied,
        } => {
            applied.push(argument);
            if applied.len() < arity {
                return Computation::value(Value::Primitive {
                    name,
                    arity,
                    applied,
                });
            }
            run_special_or_primitive(context, &name, applied, span, runtime)
        }
        other => Computation::error(Diagnostic::new(
            "BLOT_NOT_CALLABLE",
            format!("{} is not a function.", show(&other)),
            span,
        )),
    }
}

/// Apply a defunctionalized function choice by dispatching on its tag. Each
/// branch projects its alternative's captures out of the payload, then applies
/// that alternative's body, so the body specializes for the concrete argument
/// representation this call site supplies. The last alternative needs no test.
fn apply_closure_choice(
    context: Rc<Context>,
    selector: RuntimeValue,
    alternatives: Rc<Vec<ClosureAlternative>>,
    index: usize,
    argument: Value,
    span: Span,
    runtime: Runtime,
) -> Computation {
    let Some(trace) = runtime.residual.clone() else {
        return Computation::error(Diagnostic::new(
            "BLOT_RUST_INVARIANT",
            "A function choice exists without a residual trace.",
            span,
        ));
    };
    let Some(alternative) = alternatives.get(index).cloned() else {
        return Computation::error(Diagnostic::new(
            "BLOT_RUST_INVARIANT",
            "A function choice dispatched outside its alternative table.",
            span,
        ));
    };
    let last = index + 1 == alternatives.len();
    let branches = if last {
        None
    } else {
        let condition = match trace.borrow_mut().choice_condition(&selector, index, span) {
            Ok(condition) => condition,
            Err(error) => return Computation::error(error),
        };
        match trace.borrow_mut().begin_conditional(&condition, span) {
            Ok(branches) => Some(branches),
            Err(error) => return Computation::error(error),
        }
    };
    if let Some(branches) = &branches {
        trace.borrow_mut().select_block(branches.consequent);
    }
    let selected =
        match trace
            .borrow_mut()
            .choice_function(&context, &selector, index, &alternative, span)
        {
            Ok(selected) => selected,
            Err(error) => return Computation::error(error),
        };
    let Some(branches) = branches else {
        return apply(context, selected, argument, span, runtime);
    };
    let alternate_context = context.clone();
    let join_context = context.clone();
    let alternate_argument = argument.clone();
    let alternate_runtime = runtime.clone();
    apply(context, selected, argument, span, runtime).and_then(move |consequent| {
        let consequent_end = trace.borrow().current_block();
        trace.borrow_mut().select_block(branches.alternate);
        let join_trace = trace.clone();
        apply_closure_choice(
            alternate_context,
            selector,
            alternatives,
            index + 1,
            alternate_argument,
            span,
            alternate_runtime,
        )
        .and_then(move |alternate| {
            let alternate_end = join_trace.borrow().current_block();
            match join_trace.borrow_mut().join_conditional(
                &join_context,
                branches,
                consequent_end,
                consequent,
                alternate_end,
                alternate,
                span,
            ) {
                Ok(value) => Computation::value(value),
                Err(error) => Computation::error(error),
            }
        })
    })
}

fn run_special_or_primitive(
    context: Rc<Context>,
    name: &str,
    arguments: Vec<Value>,
    span: Span,
    runtime: Runtime,
) -> Computation {
    if name == "@effect" || name == "@effect.host" || name == "@effect.named" {
        let (effect_name, operations, host) = if name == "@effect.named" {
            let Some(parts) = arguments.first().and_then(|value| as_tuple(value, 2)) else {
                return Computation::error(Diagnostic::new(
                    "BLOT_TYPE",
                    "`@effect.named` takes `(name, operations)`.",
                    span,
                ));
            };
            let Value::Text(effect_name) = &parts[0] else {
                return Computation::error(Diagnostic::new(
                    "BLOT_TYPE",
                    "The first `@effect.named` value must be text.",
                    span,
                ));
            };
            let Value::Shape(operations) = &parts[1] else {
                return Computation::error(Diagnostic::new(
                    "BLOT_TYPE",
                    "The second `@effect.named` value must be an operation shape.",
                    span,
                ));
            };
            (effect_name.clone(), operations.clone(), false)
        } else {
            let Some(Value::Shape(operations)) = arguments.first() else {
                return Computation::error(Diagnostic::new(
                    "BLOT_TYPE",
                    format!("`{name}` takes a shape of operation types."),
                    span,
                ));
            };
            (
                "Effect".to_owned(),
                operations.clone(),
                name == "@effect.host",
            )
        };
        if effect_name.is_empty() {
            return Computation::error(Diagnostic::new(
                "BLOT_TYPE",
                "An effect name must not be empty.",
                span,
            ));
        }
        return Computation::value(Value::Effect {
            id: if name == "@effect.named" {
                context.named_effect_id(&runtime.module, &effect_name, host)
            } else {
                context.effect_id(&runtime, span, host)
            },
            name: effect_name,
            operations,
            host,
        });
    }
    if name == "@forall" {
        let variable = context.type_variable();
        let function = arguments[0].clone();
        return apply(
            context,
            function,
            Value::TypeVariable(variable),
            span,
            runtime,
        )
        .and_then(move |body| {
            Computation::value(Value::Forall {
                variable,
                body: Box::new(body),
            })
        });
    }
    if name == "@include" {
        if runtime.phase != Phase::Comptime {
            return Computation::error(Diagnostic::new(
                "BLOT_INCLUDE_NOT_COMPTIME",
                "`@include` can only be evaluated at compile time.",
                span,
            ));
        }
        let Value::Text(specifier) = &arguments[0] else {
            return Computation::error(Diagnostic::new(
                "BLOT_INCLUDE_PATH",
                "`@include` takes a literal text path.",
                span,
            ));
        };
        let included = context
            .modules
            .borrow()
            .get(runtime.module.as_str())
            .and_then(|loaded| loaded.includes.get(specifier))
            .cloned();
        let Some(included) = included else {
            return Computation::error(Diagnostic::new(
                "BLOT_INCLUDE_PATH",
                format!("Included path `{specifier}` was not resolved."),
                span,
            ));
        };
        let source = Value::Shape(OrderedFields::from([
            ("specifier".to_owned(), Value::Text(specifier.clone())),
            ("path".to_owned(), Value::Text(included.path)),
            ("text".to_owned(), Value::Text(included.text)),
        ]));
        return apply(context, arguments[1].clone(), source, span, runtime);
    }
    if name == "@import" {
        let Value::Text(specifier) = &arguments[0] else {
            return Computation::error(Diagnostic::new(
                "BLOT_TYPE",
                "`@import` takes a text path.",
                span,
            ));
        };
        let Some(module_path) = current_import(&context, &runtime.module, specifier) else {
            return Computation::error(Diagnostic::new(
                "BLOT_UNRESOLVED_IMPORT",
                format!("`{specifier}` was not resolved."),
                span,
            ));
        };
        return match module_closure(&context, &module_path) {
            Ok(value) => Computation::value(value),
            Err(error) => Computation::error(error),
        };
    }
    if name == "@handle" {
        let Some(parts) = as_tuple(&arguments[0], 3) else {
            return Computation::error(Diagnostic::new(
                "BLOT_TYPE",
                "`@handle` takes `(effect, computation, handler)`.",
                span,
            ));
        };
        return handle(
            context,
            parts[0].clone(),
            parts[1].clone(),
            parts[2].clone(),
            span,
            runtime,
        );
    }
    if let Some(trace) = &runtime.residual {
        match trace.borrow_mut().primitive(name, &arguments, span) {
            Ok(Some(value)) => return Computation::value(value),
            Ok(None) => {}
            Err(error) => return Computation::error(error),
        }
    }
    match run_primitive(name, arguments, span, runtime.phase) {
        Ok(value) => Computation::value(value),
        Err(error) => Computation::error(error),
    }
}

fn handle(
    context: Rc<Context>,
    effect: Value,
    thunk: Value,
    handler: Value,
    span: Span,
    runtime: Runtime,
) -> Computation {
    let Value::Effect {
        id,
        name,
        operations,
        ..
    } = effect
    else {
        return Computation::error(Diagnostic::new(
            "BLOT_TYPE",
            "`@handle` takes the effect it discharges.",
            span,
        ));
    };
    let Value::Shape(handler) = handler else {
        return Computation::error(Diagnostic::new("BLOT_TYPE", "A handler is a shape.", span));
    };
    for operation in handler.keys() {
        if operation != "return" && !operations.contains_key(operation) {
            return Computation::error(Diagnostic::new(
                "BLOT_NO_OPERATION",
                format!("Effect `{name}` has no operation `{operation}`."),
                span,
            ));
        }
    }
    let computation = apply(context.clone(), thunk, Value::Unit, span, runtime.clone());
    drive(context, computation, id, Rc::new(handler), span, runtime)
}

fn drive(
    context: Rc<Context>,
    computation: Computation,
    effect_id: u32,
    handler: Rc<OrderedFields>,
    span: Span,
    runtime: Runtime,
) -> Computation {
    match computation {
        Computation::Done(Err(error)) => Computation::Done(Err(error)),
        Computation::Done(Ok(value)) => match handler.get("return").cloned() {
            Some(return_clause) => apply(context, return_clause, value, span, runtime),
            None => Computation::value(value),
        },
        Computation::Perform { request, resume } => {
            let operation = if request.effect_id == effect_id {
                handler.get(&request.operation).cloned()
            } else {
                None
            };
            let Some(operation) = operation else {
                let next_context = context.clone();
                let next_handler = handler.clone();
                let next_runtime = runtime.clone();
                return Computation::Perform {
                    request,
                    resume: Box::new(move |value| {
                        drive(
                            next_context,
                            resume(value),
                            effect_id,
                            next_handler,
                            span,
                            next_runtime,
                        )
                    }),
                };
            };
            let resume: Resume = Rc::new(RefCell::new(Some(Box::new({
                let next_context = context.clone();
                let next_handler = handler.clone();
                let next_runtime = runtime.clone();
                move |value| {
                    drive(
                        next_context,
                        resume(value),
                        effect_id,
                        next_handler,
                        span,
                        next_runtime,
                    )
                }
            }))));
            let continuation = Value::Continuation {
                used: Rc::new(RefCell::new(false)),
                resume,
            };
            apply(
                context,
                operation,
                tuple(vec![request.argument, continuation]),
                request.span,
                runtime,
            )
        }
    }
}

fn intrinsic(name: String, span: Span) -> Computation {
    if let Some(value) = constant(&name) {
        return Computation::value(value);
    }
    if let Some(arity) = primitive_arity(&name) {
        return Computation::value(Value::Primitive {
            name,
            arity,
            applied: Vec::new(),
        });
    }
    Computation::error(Diagnostic::new(
        "BLOT_UNKNOWN_PRIMITIVE",
        format!("`{name}` is not a primitive."),
        span,
    ))
}

fn project(target: Value, name: &str, span: Span) -> Computation {
    match target {
        Value::Extended { inner, members } => match members.get(name).cloned() {
            Some(value) => Computation::value(value),
            None => project(*inner, name, span),
        },
        Value::Shape(fields) => match fields.get(name).cloned() {
            Some(value) => Computation::value(value),
            None => Computation::error(Diagnostic::new(
                "BLOT_NO_FIELD",
                format!("No field `{name}` on this shape."),
                span,
            )),
        },
        Value::Effect {
            id,
            name: effect_name,
            operations,
            host,
        } => {
            if !operations.contains_key(name) {
                return Computation::error(Diagnostic::new(
                    "BLOT_NO_OPERATION",
                    format!("This effect has no operation `{name}`."),
                    span,
                ));
            }
            Computation::value(Value::Operation {
                effect: Box::new(Value::Effect {
                    id,
                    name: effect_name,
                    operations,
                    host,
                }),
                name: name.to_owned(),
            })
        }
        value => Computation::error(Diagnostic::new(
            "BLOT_NO_FIELD",
            format!("{} has no field `.{name}`.", show(&value)),
            span,
        )),
    }
}

fn truth(value: &Value, span: Span) -> Result<bool, Diagnostic> {
    match value {
        Value::Tag {
            name,
            payload: None,
        } if name == "True" => Ok(true),
        Value::Tag {
            name,
            payload: None,
        } if name == "False" => Ok(false),
        _ => Err(Diagnostic::new(
            "BLOT_TYPE",
            format!("A condition is `#True` or `#False`, found {}.", show(value)),
            span,
        )),
    }
}

pub(crate) fn match_pattern(
    module: &Module,
    pattern_id: PatternId,
    value: &Value,
    environment: &Environment,
) -> bool {
    if pattern_id.0 == u32::MAX {
        return true;
    }
    let pattern = &module.arena.patterns[pattern_id.0 as usize];
    match pattern {
        Pattern::Wildcard { .. } => true,
        Pattern::Name { name, .. } => {
            environment
                .names
                .borrow_mut()
                .insert(name.clone(), value.clone());
            true
        }
        Pattern::Pin { name, .. } => {
            lookup(environment, name).is_some_and(|pinned| equal(value, &pinned))
        }
        Pattern::Int {
            value: expected, ..
        } => {
            matches!(value, Value::Int(found) if found == expected)
        }
        Pattern::Float {
            value: expected, ..
        } => {
            matches!(value, Value::Float(found) if found.to_bits() == expected.to_bits())
        }
        Pattern::Text {
            value: expected, ..
        } => {
            matches!(value, Value::Text(found) if found == expected)
        }
        Pattern::Unit { .. } => matches!(value, Value::Unit),
        Pattern::Constructor { name, payload, .. } => {
            let Value::Tag {
                name: found,
                payload: found_payload,
            } = value
            else {
                return false;
            };
            if found != name {
                return false;
            }
            match (payload, found_payload) {
                (None, None) => true,
                (Some(pattern), Some(value)) => match_pattern(module, *pattern, value, environment),
                _ => false,
            }
        }
        Pattern::Array { elements, .. } => {
            let values = match value {
                Value::Array(values) => values.as_slice(),
                Value::EmptyArray { .. } => &[],
                _ => return false,
            };
            elements.len() == values.len()
                && elements
                    .iter()
                    .zip(values)
                    .all(|(pattern, value)| match_pattern(module, *pattern, value, environment))
        }
        Pattern::Tuple { elements, .. } => {
            let Some(values) = as_tuple(value, elements.len()) else {
                return false;
            };
            elements
                .iter()
                .zip(values)
                .all(|(pattern, value)| match_pattern(module, *pattern, &value, environment))
        }
        Pattern::Shape { fields, .. } => {
            let Value::Shape(values) = value else {
                return false;
            };
            fields.iter().all(|field| {
                values
                    .get(&field.name)
                    .is_some_and(|value| match_pattern(module, field.pattern, value, environment))
            })
        }
    }
}

fn module(context: &Context, path: &str) -> Result<Rc<Module>, Diagnostic> {
    if let Some((cached_path, module)) = context.module_cache.borrow().as_ref()
        && cached_path == path
    {
        return Ok(module.clone());
    }
    let module = context
        .modules
        .borrow()
        .get(path)
        .map(|loaded| loaded.module.clone())
        .ok_or_else(|| {
            Diagnostic::new(
                "BLOT_UNRESOLVED_IMPORT",
                format!("Module `{path}` was not loaded."),
                Span { start: 0, end: 0 },
            )
        })?;
    *context.module_cache.borrow_mut() = Some((path.to_owned(), module.clone()));
    Ok(module)
}

fn module_expression(
    context: &Context,
    path: &str,
    expression: ExpressionId,
) -> Result<Expression, Diagnostic> {
    let module = module(context, path)?;
    module
        .arena
        .expressions
        .get(expression.0 as usize)
        .cloned()
        .ok_or_else(|| {
            Diagnostic::new(
                "BLOT_RUST_INVARIANT",
                format!("Expression {} is outside module `{path}`.", expression.0),
                module.span,
            )
        })
}

fn module_declaration(
    context: &Context,
    path: &str,
    declaration: DeclarationId,
) -> Result<Declaration, Diagnostic> {
    let module = module(context, path)?;
    module
        .arena
        .declarations
        .get(declaration.0 as usize)
        .cloned()
        .ok_or_else(|| {
            Diagnostic::new(
                "BLOT_RUST_INVARIANT",
                format!("Declaration {} is outside module `{path}`.", declaration.0),
                module.span,
            )
        })
}

fn expression_span(expression: &Expression) -> Span {
    match expression {
        Expression::Var { span, .. }
        | Expression::Int { span, .. }
        | Expression::Float { span, .. }
        | Expression::Text { span, .. }
        | Expression::Unit { span }
        | Expression::Intrinsic { span, .. }
        | Expression::Tag { span, .. }
        | Expression::Apply { span, .. }
        | Expression::Field { span, .. }
        | Expression::Lambda { span, .. }
        | Expression::Array { span, .. }
        | Expression::Tuple { span, .. }
        | Expression::Shape { span, .. }
        | Expression::If { span, .. }
        | Expression::Case { span, .. }
        | Expression::Block { span, .. }
        | Expression::Rec { span, .. }
        | Expression::Comptime { span, .. } => *span,
    }
}

fn declaration_span(declaration: &Declaration) -> Span {
    match declaration {
        Declaration::Binding { span, .. }
        | Declaration::Shadow { span, .. }
        | Declaration::Open { span, .. } => *span,
    }
}

fn live_declarations_for(
    context: &Context,
    module_path: &str,
    module: &Module,
    block: Option<ExpressionId>,
    declarations: &[DeclarationId],
    result: ExpressionId,
) -> LiveDeclarations {
    let key = (module_path.to_owned(), block);
    if let Some(live) = context.live_declarations.borrow().get(&key) {
        return live.clone();
    }
    let mut needed = free_names_expression(module, result);
    let mut live = Vec::new();
    for declaration_id in declarations.iter().rev() {
        let declaration = &module.arena.declarations[declaration_id.0 as usize];
        let (bound, reads, forced) = declaration_names(module, declaration);
        if forced || bound.iter().any(|name| needed.contains(name)) {
            live.push(*declaration_id);
            for name in bound {
                needed.remove(&name);
            }
            needed.extend(reads);
        }
    }
    live.reverse();
    let live = Rc::new(live);
    context
        .live_declarations
        .borrow_mut()
        .insert(key, live.clone());
    live
}

fn declaration_names(
    module: &Module,
    declaration: &Declaration,
) -> (Vec<String>, HashSet<String>, bool) {
    match declaration {
        Declaration::Binding {
            kind,
            pattern,
            value,
            ..
        } => (
            pattern_names(module, *pattern),
            free_names_expression(module, *value),
            *kind == DeclarationKind::Sig
                || *kind == DeclarationKind::Effect
                || matches!(
                    module.arena.expressions[value.0 as usize],
                    Expression::Rec { .. }
                ),
        ),
        Declaration::Shadow { name, value, .. } => (
            vec![name.clone()],
            free_names_expression(module, *value),
            true,
        ),
        Declaration::Open { value, .. } => {
            (Vec::new(), free_names_expression(module, *value), true)
        }
    }
}

fn adapt_argument(argument: Value, expected: &Value, span: Span) -> Result<Value, Diagnostic> {
    let expected = match expected {
        Value::Extended { inner, .. } => inner.as_ref(),
        expected => expected,
    };
    let Value::Shape(required) = expected else {
        return Ok(argument);
    };
    let Value::Shape(present) = argument else {
        return Ok(argument);
    };
    let mut adapted = OrderedFields::default();
    for (name, expected) in required {
        if let Some(value) = present.get(name) {
            adapted.insert(name.clone(), value.clone());
            continue;
        }
        if admits_omission(expected) {
            adapted.insert(name.clone(), Value::Unit);
            continue;
        }
        return Err(Diagnostic::new(
            "BLOT_NO_FIELD",
            format!("Record argument is missing required field `.{name}`."),
            span,
        ));
    }
    Ok(Value::Shape(adapted))
}

fn signature_body(mut signature: &Value) -> &Value {
    while let Value::Forall { body, .. } = signature {
        signature = body;
    }
    signature
}

fn substitute_signature(signature: &Value, environment: &Environment) -> Value {
    fn substitution(environment: &Environment, variable: u32) -> Option<Value> {
        let mut scope = Some(environment.clone());
        while let Some(current) = scope {
            if let Some(value) = current.type_substitutions.borrow().get(&variable) {
                return Some(value.clone());
            }
            scope = current.parent.clone();
        }
        None
    }

    match signature {
        Value::TypeVariable(variable) => {
            substitution(environment, *variable).unwrap_or_else(|| signature.clone())
        }
        Value::Shape(fields) => Value::Shape(
            fields
                .iter()
                .map(|(name, value)| (name.clone(), substitute_signature(value, environment)))
                .collect(),
        ),
        Value::Array(elements) => Value::Array(
            elements
                .iter()
                .map(|value| substitute_signature(value, environment))
                .collect(),
        ),
        Value::EmptyArray { element } => Value::EmptyArray {
            element: Box::new(substitute_signature(element, environment)),
        },
        Value::Union(members) => Value::Union(
            members
                .iter()
                .map(|value| substitute_signature(value, environment))
                .collect(),
        ),
        Value::Tag { name, payload } => Value::Tag {
            name: name.clone(),
            payload: payload
                .as_deref()
                .map(|value| Box::new(substitute_signature(value, environment))),
        },
        Value::Range { low, high, domain } => Value::Range {
            low: Box::new(substitute_signature(low, environment)),
            high: Box::new(substitute_signature(high, environment)),
            domain: *domain,
        },
        Value::Arrow {
            domain,
            codomain,
            effects,
            effect_tail,
        } => Value::Arrow {
            domain: Box::new(substitute_signature(domain, environment)),
            codomain: Box::new(substitute_signature(codomain, environment)),
            effects: effects
                .iter()
                .map(|effect| substitute_signature(effect, environment))
                .collect(),
            effect_tail: *effect_tail,
        },
        Value::Forall { variable, body } => Value::Forall {
            variable: *variable,
            body: Box::new(substitute_signature(body, environment)),
        },
        Value::Extended { inner, members } => Value::Extended {
            inner: Box::new(substitute_signature(inner, environment)),
            members: members
                .iter()
                .map(|(name, value)| (name.clone(), substitute_signature(value, environment)))
                .collect(),
        },
        Value::Sealed { name, inner } => Value::Sealed {
            name: name.clone(),
            inner: Box::new(substitute_signature(inner, environment)),
        },
        _ => signature.clone(),
    }
}

fn record_signature_substitutions(environment: &Environment, expected: &Value, actual: &Value) {
    fn value_signature(value: &Value) -> Option<Value> {
        match value {
            Value::Closure {
                signature: Some(signature),
                ..
            } => Some((**signature).clone()),
            Value::Int(_) => Some(Value::Range {
                low: Box::new(Value::Unbounded),
                high: Box::new(Value::Unbounded),
                domain: Some(ValueDomain::Int),
            }),
            Value::Text(_) => Some(Value::Range {
                low: Box::new(Value::Unbounded),
                high: Box::new(Value::Unbounded),
                domain: Some(ValueDomain::Text),
            }),
            Value::Unit => Some(Value::Unit),
            Value::Shape(fields) => Some(Value::Shape(
                fields
                    .iter()
                    .map(|(name, value)| Some((name.clone(), value_signature(value)?)))
                    .collect::<Option<OrderedFields>>()?,
            )),
            Value::Array(elements) => Some(Value::Array(vec![value_signature(elements.first()?)?])),
            Value::EmptyArray { element } => Some(Value::Array(vec![(**element).clone()])),
            Value::Tag { name, payload } => Some(Value::Tag {
                name: name.clone(),
                payload: payload.as_deref().and_then(value_signature).map(Box::new),
            }),
            Value::Extended { inner, .. } | Value::Sealed { inner, .. } => value_signature(inner),
            _ => None,
        }
    }

    fn record_types(environment: &Environment, expected: &Value, actual: &Value) {
        let expected = signature_body(expected);
        let actual = signature_body(actual);
        match (expected, actual) {
            (Value::TypeVariable(variable), actual) => {
                environment
                    .type_substitutions
                    .borrow_mut()
                    .entry(*variable)
                    .or_insert_with(|| actual.clone());
            }
            (Value::Shape(expected), Value::Shape(actual)) => {
                for (name, expected) in expected {
                    if let Some(actual) = actual.get(name) {
                        record_types(environment, expected, actual);
                    }
                }
            }
            (Value::Array(expected), Value::Array(actual)) => {
                if let (Some(expected), Some(actual)) = (expected.first(), actual.first()) {
                    record_types(environment, expected, actual);
                }
            }
            (Value::Array(expected), Value::EmptyArray { element }) => {
                if let Some(expected) = expected.first() {
                    record_types(environment, expected, element);
                }
            }
            (
                Value::Arrow {
                    domain: expected_domain,
                    codomain: expected_codomain,
                    ..
                },
                Value::Arrow {
                    domain: actual_domain,
                    codomain: actual_codomain,
                    ..
                },
            ) => {
                record_types(environment, expected_domain, actual_domain);
                record_types(environment, expected_codomain, actual_codomain);
            }
            _ => {}
        }
    }

    match (signature_body(expected), actual) {
        (Value::Shape(expected), Value::Shape(actual)) => {
            for (name, expected) in expected {
                if let Some(actual) = actual.get(name) {
                    record_signature_substitutions(environment, expected, actual);
                }
            }
        }
        (Value::Array(expected), Value::Array(actual)) => {
            if let (Some(expected), Some(actual)) = (expected.first(), actual.first()) {
                record_signature_substitutions(environment, expected, actual);
            }
        }
        (Value::Array(expected), Value::EmptyArray { element }) => {
            if let Some(expected) = expected.first() {
                record_signature_substitutions(environment, expected, element);
            }
        }
        (expected @ Value::Arrow { .. }, Value::Closure { .. })
        | (expected @ Value::TypeVariable(_), Value::Closure { .. }) => {
            if let Some(actual) = value_signature(actual) {
                record_types(environment, expected, &actual);
            }
        }
        (Value::TypeVariable(variable), actual) => {
            if let Some(actual) = value_signature(actual) {
                environment
                    .type_substitutions
                    .borrow_mut()
                    .entry(*variable)
                    .or_insert(actual);
            }
        }
        _ => {}
    }
}

fn admits_omission(value: &Value) -> bool {
    match value {
        Value::Unit => true,
        Value::Extended { inner, .. } => admits_omission(inner),
        Value::Union(members) => members.iter().any(admits_omission),
        _ => false,
    }
}

fn pattern_names(module: &Module, pattern: PatternId) -> Vec<String> {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Name { name, .. } => vec![name.clone()],
        Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => elements
            .iter()
            .flat_map(|pattern| pattern_names(module, *pattern))
            .collect(),
        Pattern::Constructor {
            payload: Some(payload),
            ..
        } => pattern_names(module, *payload),
        Pattern::Shape { fields, .. } => fields
            .iter()
            .flat_map(|field| pattern_names(module, field.pattern))
            .collect(),
        _ => Vec::new(),
    }
}

fn free_names_expression(module: &Module, root: ExpressionId) -> HashSet<String> {
    let mut free = HashSet::new();
    let mut bound = Vec::<HashSet<String>>::new();
    collect_free(module, root, &mut bound, &mut free);
    free
}

pub(crate) fn closure_free_names(
    context: &Context,
    module_path: &str,
    parameter: PatternId,
    body: ExpressionId,
    self_name: Option<&str>,
) -> Result<Vec<String>, Diagnostic> {
    let module = module(context, module_path)?;
    let mut local = pattern_names(&module, parameter)
        .into_iter()
        .collect::<HashSet<_>>();
    if let Some(name) = self_name {
        local.insert(name.to_owned());
    }
    let mut free = HashSet::new();
    collect_free(&module, body, &mut vec![local], &mut free);
    let mut free = free.into_iter().collect::<Vec<_>>();
    free.sort();
    Ok(free)
}

fn collect_free(
    module: &Module,
    expression_id: ExpressionId,
    bound: &mut Vec<HashSet<String>>,
    free: &mut HashSet<String>,
) {
    let expression = &module.arena.expressions[expression_id.0 as usize];
    match expression {
        Expression::Var { name, .. } => {
            if !bound.iter().rev().any(|scope| scope.contains(name)) {
                free.insert(name.clone());
            }
        }
        Expression::Apply {
            function, argument, ..
        } => {
            collect_free(module, *function, bound, free);
            collect_free(module, *argument, bound, free);
        }
        Expression::Field { target, .. }
        | Expression::Rec { lambda: target, .. }
        | Expression::Comptime { body: target, .. } => {
            collect_free(module, *target, bound, free);
        }
        Expression::Lambda {
            parameter, body, ..
        } => {
            bound.push(pattern_names(module, *parameter).into_iter().collect());
            collect_free(module, *body, bound, free);
            bound.pop();
        }
        Expression::Array { elements, .. } => {
            for element in elements {
                collect_free(module, element.value, bound, free);
            }
        }
        Expression::Tuple { elements, .. } => {
            for element in elements {
                collect_free(module, *element, bound, free);
            }
        }
        Expression::Shape { members, .. } => {
            for member in members {
                let value = match member {
                    ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => *value,
                };
                collect_free(module, value, bound, free);
            }
        }
        Expression::If {
            branches, fallback, ..
        } => {
            for branch in branches {
                collect_free(module, branch.condition, bound, free);
                collect_free(module, branch.consequence, bound, free);
            }
            if let Some(fallback) = fallback {
                collect_free(module, *fallback, bound, free);
            }
        }
        Expression::Case { target, arms, .. } => {
            collect_free(module, *target, bound, free);
            for arm in arms {
                free.extend(pattern_pins(module, arm.pattern));
                bound.push(pattern_names(module, arm.pattern).into_iter().collect());
                collect_free(module, arm.body, bound, free);
                bound.pop();
            }
        }
        Expression::Block {
            declarations,
            result,
            ..
        } => {
            let mut scope = HashSet::new();
            for declaration in declarations {
                let declaration = &module.arena.declarations[declaration.0 as usize];
                let (_, reads, _) = declaration_names(module, declaration);
                for name in reads {
                    if !scope.contains(&name)
                        && !bound.iter().rev().any(|outer| outer.contains(&name))
                    {
                        free.insert(name);
                    }
                }
                match declaration {
                    Declaration::Binding { pattern, .. } => {
                        scope.extend(pattern_names(module, *pattern));
                    }
                    Declaration::Shadow { name, .. } => {
                        scope.insert(name.clone());
                    }
                    Declaration::Open { .. } => {}
                }
            }
            bound.push(scope);
            collect_free(module, *result, bound, free);
            bound.pop();
        }
        Expression::Int { .. }
        | Expression::Float { .. }
        | Expression::Text { .. }
        | Expression::Unit { .. }
        | Expression::Intrinsic { .. }
        | Expression::Tag { .. } => {}
    }
}

fn pattern_pins(module: &Module, pattern: PatternId) -> Vec<String> {
    match &module.arena.patterns[pattern.0 as usize] {
        Pattern::Pin { name, .. } => vec![name.clone()],
        Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => elements
            .iter()
            .flat_map(|pattern| pattern_pins(module, *pattern))
            .collect(),
        Pattern::Constructor {
            payload: Some(payload),
            ..
        } => pattern_pins(module, *payload),
        Pattern::Shape { fields, .. } => fields
            .iter()
            .flat_map(|field| pattern_pins(module, field.pattern))
            .collect(),
        _ => Vec::new(),
    }
}

fn current_import(context: &Context, importer: &str, specifier: &str) -> Option<String> {
    context
        .modules
        .borrow()
        .get(importer)
        .and_then(|loaded| loaded.imports.get(specifier).cloned())
}

struct BigIntExt;

impl BigIntExt {
    fn two_to_63() -> num_bigint::BigInt {
        num_bigint::BigInt::from(1_u64) << 63
    }

    fn two_to_63_minus_one() -> num_bigint::BigInt {
        Self::two_to_63() - 1
    }
}
