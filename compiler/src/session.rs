use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

use serde::{Deserialize, Serialize};

use crate::ast::{
    AstArena, Declaration, DeclarationId, Expression, ExpressionId, Module, Pattern, PatternId,
};
use crate::backend::{ClosedProgram, CompiledModule};
use crate::diagnostic::Diagnostic;
use crate::eval::{Context, IncludedFile, LoadedModule, Phase, Runtime, evaluate_module, run};
use crate::frontend::FrontendState;
use crate::typecheck::{
    CHECKED_MODULE_CERTIFICATE_SCHEMA, CachedModuleAnalyses, CachedModuleInterface,
    CheckedModuleCertificate, Checker,
};
use crate::value::{Value, show};

#[derive(Deserialize, Serialize)]
struct ModuleSnapshot {
    schema: u32,
    ast: Module,
    certificate: CheckedModuleCertificate,
}

pub struct CompilerSession {
    context: Rc<Context>,
    frontends: HashMap<String, FrontendState>,
    module_interfaces: Rc<RefCell<HashMap<String, CachedModuleInterface>>>,
    module_analyses: Rc<RefCell<HashMap<String, CachedModuleAnalyses>>>,
    checker: Checker,
    closed_programs: RefCell<HashMap<String, Rc<ClosedProgram>>>,
}

impl Default for CompilerSession {
    fn default() -> Self {
        let context = Rc::new(Context::default());
        let module_interfaces = Rc::new(RefCell::new(HashMap::new()));
        let module_analyses = Rc::new(RefCell::new(HashMap::new()));
        let checker = Checker::with_caches(
            context.clone(),
            module_interfaces.clone(),
            module_analyses.clone(),
        );
        Self {
            context,
            frontends: HashMap::new(),
            module_interfaces,
            module_analyses,
            checker,
            closed_programs: RefCell::new(HashMap::new()),
        }
    }
}

#[derive(Serialize)]
pub struct AddedModule {
    pub imports: Vec<String>,
    pub includes: Vec<String>,
}

pub(crate) use crate::source::SourceError as AddSourceError;

impl CompilerSession {
    pub fn install_module_snapshot(&mut self, path: &str, bytes: &[u8]) -> Result<(), String> {
        let snapshot: ModuleSnapshot = rmp_serde::from_slice(bytes)
            .map_err(|error| format!("module snapshot for {path} is invalid: {error}"))?;
        if snapshot.schema != CHECKED_MODULE_CERTIFICATE_SCHEMA {
            return Err(format!(
                "module snapshot for {path} has schema {}, expected {}",
                snapshot.schema, CHECKED_MODULE_CERTIFICATE_SCHEMA,
            ));
        }
        snapshot.ast.validate()?;
        snapshot.certificate.validate()?;
        let dependencies = module_dependencies(&snapshot.ast);
        if !dependencies.imports.is_empty() || !dependencies.includes.is_empty() {
            return Err(format!(
                "module snapshot for {path} must be dependency-free"
            ));
        }
        self.install_module(path.to_owned(), snapshot.ast)?;
        self.checker
            .install_certificate(path, snapshot.certificate)?;
        let value = run(evaluate_module(
            self.context.clone(),
            path.to_owned(),
            Value::Unit,
            Runtime::new(Phase::Comptime, path.to_owned()),
        ))
        .map_err(|diagnostic| {
            format!(
                "module snapshot evaluation for {path} failed: {} ({})",
                diagnostic.message, diagnostic.code,
            )
        })?;
        self.context
            .module_results
            .borrow_mut()
            .insert(path.to_owned(), value);
        Ok(())
    }

    pub fn add_source(
        &mut self,
        path: String,
        source: Vec<u16>,
    ) -> Result<AddedModule, AddSourceError> {
        let lowered = crate::source::lower_incremental(&source, self.frontends.get(&path))?;
        self.frontends.insert(path.clone(), lowered.frontend);
        self.install_module(path, lowered.module)
            .map_err(AddSourceError::Lowering)
    }

    pub fn add_module(&mut self, path: String, module: Module) -> Result<AddedModule, String> {
        module.validate()?;
        self.install_module(path, module)
    }

    fn install_module(&mut self, path: String, module: Module) -> Result<AddedModule, String> {
        let dependencies = module_dependencies(&module);
        let previous = self.context.modules.borrow().get(&path).cloned();
        let unchanged = previous
            .as_ref()
            .is_some_and(|loaded| loaded.module.as_ref() == &module);
        if unchanged {
            return Ok(AddedModule {
                imports: dependencies.imports,
                includes: dependencies.includes,
            });
        }

        let retained_bindings = previous.as_ref().and_then(|loaded| {
            if loaded.module.parameter != module.parameter
                || loaded.module.fixities != module.fixities
            {
                return None;
            }
            let unchanged_declarations =
                UnchangedDeclarations::new(&loaded.module, &module).prefix_len();
            let unchanged_bindings = loaded
                .module
                .declarations
                .iter()
                .take(unchanged_declarations)
                .filter_map(|declaration| {
                    match &loaded.module.arena.declarations[declaration.0 as usize] {
                        Declaration::Binding { pattern, value, .. } => Some((*pattern, *value)),
                        Declaration::Shadow { .. } | Declaration::Open { .. } => None,
                    }
                })
                .collect::<HashSet<_>>();
            self.context
                .evaluated_bindings
                .borrow()
                .get(&path)
                .map(|bindings| {
                    bindings
                        .iter()
                        .filter(|((pattern, expression, _), _)| {
                            unchanged_bindings.contains(&(*pattern, *expression))
                        })
                        .map(|(key, value)| (*key, value.clone()))
                        .collect::<HashMap<_, _>>()
                })
        });
        let imports = previous
            .as_ref()
            .map_or_else(BTreeMap::new, |loaded| loaded.imports.clone());
        let includes = previous
            .as_ref()
            .map_or_else(BTreeMap::new, |loaded| loaded.includes.clone());
        self.invalidate(&path);
        self.context.modules.borrow_mut().insert(
            path.clone(),
            LoadedModule {
                module: Rc::new(module),
                imports,
                includes,
            },
        );
        if let Some(bindings) = retained_bindings
            && !bindings.is_empty()
        {
            self.context
                .evaluated_bindings
                .borrow_mut()
                .insert(path, bindings);
        }
        Ok(AddedModule {
            imports: dependencies.imports,
            includes: dependencies.includes,
        })
    }

    pub fn configure_module(
        &mut self,
        path: &str,
        imports: BTreeMap<String, String>,
        includes: BTreeMap<String, IncludedFile>,
    ) -> Result<(), String> {
        let mut modules = self.context.modules.borrow_mut();
        let module = modules
            .get_mut(path)
            .ok_or_else(|| format!("cannot configure unknown module {path}"))?;
        if module.imports != imports || module.includes != includes {
            module.imports = imports;
            module.includes = includes;
            drop(modules);
            self.invalidate(path);
        }
        Ok(())
    }

    pub fn evaluate_module(&self, path: &str) -> serde_json::Value {
        let computation = evaluate_module(
            self.context.clone(),
            path.to_owned(),
            Value::Unit,
            Runtime::new(Phase::Runtime, path.to_owned()),
        );
        match run(computation) {
            Ok(value) => serde_json::json!({
                "ok": true,
                "value": json_value(&value),
                "display": show(&value),
            }),
            Err(diagnostic) => serde_json::json!({
                "ok": false,
                "diagnostic": {
                    "code": diagnostic.code,
                    "message": diagnostic.message,
                    "span": {
                        "start": diagnostic.span.start,
                        "end": diagnostic.span.end,
                    },
                },
            }),
        }
    }

    pub fn check_module(&self, path: &str) -> serde_json::Value {
        self.checker.begin_request();
        self.checker.check_json(path)
    }

    pub fn module_snapshot(&self, path: &str) -> Result<Vec<u8>, String> {
        let ast = self
            .context
            .modules
            .borrow()
            .get(path)
            .map(|loaded| loaded.module.as_ref().clone())
            .ok_or_else(|| format!("cannot snapshot unknown module {path}"))?;
        let certificate = self.checker.certificate(path)?;
        rmp_serde::to_vec(&ModuleSnapshot {
            schema: CHECKED_MODULE_CERTIFICATE_SCHEMA,
            ast,
            certificate,
        })
        .map_err(|error| format!("could not encode module snapshot: {error}"))
    }

    pub fn prepare_runtime_hir(&self, path: &str) -> serde_json::Value {
        match self.close_program(path) {
            Ok(program) => serde_json::json!({ "ok": true, "module": program.runtime() }),
            Err(diagnostic) => diagnostic_json(diagnostic),
        }
    }

    pub fn compile_module(&self, path: &str) -> Result<CompiledModule, Diagnostic> {
        let program = self.close_program(path)?;
        program.compile().map_err(|message| {
            Diagnostic::new(
                "BLOT_BACKEND_ERROR",
                message,
                crate::ast::Span { start: 0, end: 0 },
            )
            .at(path)
        })
    }

    fn close_program(&self, path: &str) -> Result<Rc<ClosedProgram>, Diagnostic> {
        if let Some(program) = self.closed_programs.borrow().get(path) {
            return Ok(program.clone());
        }
        self.checker.begin_request();
        let checked = self
            .checker
            .check(path)
            .map_err(|diagnostic| diagnostic.at(path))?;
        let runtime = crate::hir::elaborate(self.context.clone(), path, checked)
            .map_err(|diagnostic| diagnostic.at(path))?;
        let program = Rc::new(crate::backend::close(runtime).map_err(|message| {
            Diagnostic::new(
                "BLOT_BACKEND_ERROR",
                message,
                crate::ast::Span { start: 0, end: 0 },
            )
            .at(path)
        })?);
        self.closed_programs
            .borrow_mut()
            .insert(path.to_owned(), program.clone());
        Ok(program)
    }

    fn invalidate(&self, changed: &str) {
        self.context.module_cache.borrow_mut().take();
        let modules = self.context.modules.borrow();
        let mut invalidated = HashSet::from([changed.to_owned()]);
        loop {
            let previous = invalidated.len();
            for (path, loaded) in modules.iter() {
                if loaded
                    .imports
                    .values()
                    .any(|dependency| invalidated.contains(dependency))
                {
                    invalidated.insert(path.clone());
                }
            }
            if invalidated.len() == previous {
                break;
            }
        }
        drop(modules);
        self.context
            .live_declarations
            .borrow_mut()
            .retain(|(path, _), _| !invalidated.contains(path));
        self.context
            .evaluated_bindings
            .borrow_mut()
            .retain(|path, _| !invalidated.contains(path));
        self.context
            .closure_signatures
            .borrow_mut()
            .retain(|(path, _), _| !invalidated.contains(path));
        self.context
            .recursive_closures
            .borrow_mut()
            .retain(|(path, _)| !invalidated.contains(path));
        self.module_interfaces
            .borrow_mut()
            .retain(|path, _| !invalidated.contains(path));
        self.module_analyses
            .borrow_mut()
            .retain(|path, _| !invalidated.contains(path));
        self.checker.invalidate(&invalidated);
        self.context
            .module_results
            .borrow_mut()
            .retain(|path, _| !invalidated.contains(path));
        self.closed_programs
            .borrow_mut()
            .retain(|path, _| !invalidated.contains(path));
    }
}

fn diagnostic_json(diagnostic: crate::diagnostic::Diagnostic) -> serde_json::Value {
    serde_json::json!({
        "ok": false,
        "diagnostic": {
            "code": diagnostic.code,
            "message": diagnostic.message,
            "origin": diagnostic.origin,
            "span": {
                "start": diagnostic.span.start,
                "end": diagnostic.span.end,
            },
        },
    })
}

fn json_value(value: &Value) -> serde_json::Value {
    match value {
        Value::Deferred { .. } => serde_json::json!({ "tag": "deferred" }),
        Value::Int(value) => serde_json::json!({ "tag": "int", "value": value.to_string() }),
        Value::Float(value) => serde_json::json!({ "tag": "float", "value": value }),
        Value::Float32(value) => serde_json::json!({ "tag": "float32", "value": value }),
        Value::Vector(lanes) => serde_json::json!({ "tag": "vector", "lanes": lanes }),
        Value::VectorMask(lanes) => serde_json::json!({ "tag": "vector-mask", "lanes": lanes }),
        Value::IntegerVector { bits, lanes } => {
            serde_json::json!({ "tag": "integer-vector", "bits": bits, "lanes": lanes })
        }
        Value::IntegerVectorMask { bits, lanes } => {
            serde_json::json!({ "tag": "integer-vector-mask", "bits": bits, "lanes": lanes })
        }
        Value::Text(value) => serde_json::json!({ "tag": "text", "value": value }),
        Value::Unit => serde_json::json!({ "tag": "unit" }),
        Value::Shape(fields) => serde_json::json!({
            "tag": "shape",
            "fields": fields.iter().map(|(name, value)| {
                serde_json::json!([name, json_value(value)])
            }).collect::<Vec<_>>(),
        }),
        Value::Array(elements) => serde_json::json!({
            "tag": "array",
            "elements": elements.iter().map(json_value).collect::<Vec<_>>(),
        }),
        Value::RegionType(element) => serde_json::json!({
            "tag": "region-type",
            "element": json_value(element),
        }),
        Value::Region { start, end, .. } => serde_json::json!({
            "tag": "opaque",
            "display": format!("<region {start}..{end}>"),
        }),
        Value::RegionRejoin {
            start, middle, end, ..
        } => serde_json::json!({
            "tag": "opaque",
            "display": format!("<rejoin {start}..{middle}..{end}>"),
        }),
        Value::EmptyArray { .. } => serde_json::json!({
            "tag": "array",
            "elements": [],
        }),
        Value::Tag { name, payload } => serde_json::json!({
            "tag": "tag",
            "name": name,
            "payload": payload.as_deref().map(json_value),
        }),
        Value::Range { low, high, domain } => serde_json::json!({
            "tag": "range",
            "low": json_value(low),
            "high": json_value(high),
            "domain": domain.map(|domain| format!("{domain:?}").to_lowercase()),
        }),
        Value::Union(members) => serde_json::json!({
            "tag": "union",
            "members": members.iter().map(json_value).collect::<Vec<_>>(),
        }),
        Value::Unbounded => serde_json::json!({ "tag": "unbounded" }),
        Value::Arrow {
            domain,
            codomain,
            effects,
            effect_tail,
        } => {
            let mut value = serde_json::json!({
                "tag": "arrow",
                "domain": json_value(domain),
                "codomain": json_value(codomain),
                "effects": effects.iter().map(json_value).collect::<Vec<_>>(),
            });
            if let Some(effect_tail) = effect_tail {
                value["effect_tail"] = serde_json::json!(effect_tail);
            }
            value
        }
        Value::TypeVariable(id) => serde_json::json!({ "tag": "type-variable", "id": id }),
        Value::Forall { variable, body } => serde_json::json!({
            "tag": "forall", "variable": variable, "body": json_value(body),
        }),
        Value::Effect {
            id,
            name,
            operations,
            host,
        } => serde_json::json!({
            "tag": "effect", "id": id, "name": name, "host": host,
            "operations": operations.iter().map(|(name, value)| {
                serde_json::json!([name, json_value(value)])
            }).collect::<Vec<_>>(),
        }),
        Value::Operation { effect, name } => serde_json::json!({
            "tag": "operation", "effect": json_value(effect), "name": name,
        }),
        Value::Extended { inner, members } => serde_json::json!({
            "tag": "extended", "inner": json_value(inner),
            "members": members.iter().map(|(name, value)| {
                serde_json::json!([name, json_value(value)])
            }).collect::<Vec<_>>(),
        }),
        Value::Sealed { name, inner } => serde_json::json!({
            "tag": "sealed", "name": name, "inner": json_value(inner),
        }),
        Value::OpaqueType(name) => serde_json::json!({ "tag": "opaque-type", "name": name }),
        Value::Runtime(value) => serde_json::json!({
            "tag": "runtime", "value": value.id, "type": value.type_id,
        }),
        Value::Closure { .. }
        | Value::ClosureChoice { .. }
        | Value::ModuleClosure { .. }
        | Value::IndexedStep { .. }
        | Value::Primitive { .. }
        | Value::Continuation { .. } => {
            serde_json::json!({ "tag": "opaque", "display": show(value) })
        }
    }
}

struct UnchangedDeclarations<'a> {
    previous: &'a Module,
    current: &'a Module,
    expressions: HashSet<ExpressionId>,
    patterns: HashSet<PatternId>,
    declarations: HashSet<DeclarationId>,
}

impl<'a> UnchangedDeclarations<'a> {
    fn new(previous: &'a Module, current: &'a Module) -> Self {
        Self {
            previous,
            current,
            expressions: HashSet::new(),
            patterns: HashSet::new(),
            declarations: HashSet::new(),
        }
    }

    fn prefix_len(mut self) -> usize {
        for (ordinal, (previous, current)) in self
            .previous
            .declarations
            .iter()
            .zip(&self.current.declarations)
            .enumerate()
        {
            if previous != current || !self.declaration(*current) {
                return ordinal;
            }
        }
        self.previous
            .declarations
            .len()
            .min(self.current.declarations.len())
    }

    fn pattern(&mut self, id: PatternId) -> bool {
        let Some(previous) = self.previous.arena.patterns.get(id.0 as usize) else {
            return false;
        };
        let Some(current) = self.current.arena.patterns.get(id.0 as usize) else {
            return false;
        };
        if previous != current {
            return false;
        }
        if !self.patterns.insert(id) {
            return true;
        }
        match current.clone() {
            Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => {
                elements.into_iter().all(|pattern| self.pattern(pattern))
            }
            Pattern::Constructor { payload, .. } => {
                payload.is_none_or(|pattern| self.pattern(pattern))
            }
            Pattern::Shape { fields, .. } => {
                fields.into_iter().all(|field| self.pattern(field.pattern))
            }
            Pattern::Name { .. }
            | Pattern::Wildcard { .. }
            | Pattern::Pin { .. }
            | Pattern::Int { .. }
            | Pattern::Float { .. }
            | Pattern::Text { .. }
            | Pattern::Unit { .. } => true,
        }
    }

    fn declaration(&mut self, id: DeclarationId) -> bool {
        let Some(previous) = self.previous.arena.declarations.get(id.0 as usize) else {
            return false;
        };
        let Some(current) = self.current.arena.declarations.get(id.0 as usize) else {
            return false;
        };
        if previous != current {
            return false;
        }
        if !self.declarations.insert(id) {
            return true;
        }
        match current.clone() {
            Declaration::Binding {
                tags,
                pattern,
                value,
                ..
            } => {
                tags.into_iter().all(|tag| self.expression(tag.descriptor))
                    && self.pattern(pattern)
                    && self.expression(value)
            }
            Declaration::Shadow { value, .. } | Declaration::Open { value, .. } => {
                self.expression(value)
            }
        }
    }

    fn expression(&mut self, id: ExpressionId) -> bool {
        let Some(previous) = self.previous.arena.expressions.get(id.0 as usize) else {
            return false;
        };
        let Some(current) = self.current.arena.expressions.get(id.0 as usize) else {
            return false;
        };
        if previous != current {
            return false;
        }
        if !self.expressions.insert(id) {
            return true;
        }
        match current.clone() {
            Expression::Apply {
                function, argument, ..
            } => self.expression(function) && self.expression(argument),
            Expression::Field { target, .. } => self.expression(target),
            Expression::Lambda {
                parameter, body, ..
            } => self.pattern(parameter) && self.expression(body),
            Expression::Array { elements, .. } => elements
                .into_iter()
                .all(|element| self.expression(element.value)),
            Expression::Tuple { elements, .. } => elements
                .into_iter()
                .all(|expression| self.expression(expression)),
            Expression::Shape { members, .. } => members.into_iter().all(|member| {
                let value = match member {
                    crate::ast::ShapeMember::Field { value, .. }
                    | crate::ast::ShapeMember::Spread { value } => value,
                };
                self.expression(value)
            }),
            Expression::If {
                branches, fallback, ..
            } => {
                branches.into_iter().all(|branch| {
                    self.expression(branch.condition) && self.expression(branch.consequence)
                }) && fallback.is_none_or(|fallback| self.expression(fallback))
            }
            Expression::Case { target, arms, .. } => {
                self.expression(target)
                    && arms
                        .into_iter()
                        .all(|arm| self.pattern(arm.pattern) && self.expression(arm.body))
            }
            Expression::Block {
                declarations,
                result,
                ..
            } => {
                declarations
                    .into_iter()
                    .all(|declaration| self.declaration(declaration))
                    && self.expression(result)
            }
            Expression::Rec { lambda, .. } => self.expression(lambda),
            Expression::Comptime { body, .. } => self.expression(body),
            Expression::Var { .. }
            | Expression::Int { .. }
            | Expression::Float { .. }
            | Expression::Text { .. }
            | Expression::Unit { .. }
            | Expression::Intrinsic { .. }
            | Expression::Tag { .. } => true,
        }
    }
}

#[derive(Default)]
struct ModuleDependencies {
    imports: Vec<String>,
    includes: Vec<String>,
    seen_imports: HashSet<String>,
    seen_includes: HashSet<String>,
}

fn module_dependencies(module: &Module) -> ModuleDependencies {
    let mut dependencies = ModuleDependencies::default();
    for declaration in &module.declarations {
        collect_declaration_dependencies(
            &module.arena.declarations[declaration.0 as usize],
            &module.arena,
            &mut dependencies,
        );
    }
    collect_expression_dependencies(module.result, &module.arena, &mut dependencies);
    dependencies
}

fn collect_declaration_dependencies(
    declaration: &Declaration,
    arena: &AstArena,
    dependencies: &mut ModuleDependencies,
) {
    let value = match declaration {
        Declaration::Binding { value, .. }
        | Declaration::Shadow { value, .. }
        | Declaration::Open { value, .. } => *value,
    };
    collect_expression_dependencies(value, arena, dependencies);
}

fn collect_expression_dependencies(
    expression: ExpressionId,
    arena: &AstArena,
    dependencies: &mut ModuleDependencies,
) {
    let expression = &arena.expressions[expression.0 as usize];
    match expression {
        Expression::Apply {
            function, argument, ..
        } => {
            if let Expression::Intrinsic { name, .. } = &arena.expressions[function.0 as usize]
                && let Expression::Text { value, .. } = &arena.expressions[argument.0 as usize]
            {
                if name == "@import" && dependencies.seen_imports.insert(value.clone()) {
                    dependencies.imports.push(value.clone());
                }
                if name == "@include" && dependencies.seen_includes.insert(value.clone()) {
                    dependencies.includes.push(value.clone());
                }
            }
            collect_expression_dependencies(*function, arena, dependencies);
            collect_expression_dependencies(*argument, arena, dependencies);
        }
        Expression::Field { target, .. } => {
            collect_expression_dependencies(*target, arena, dependencies);
        }
        Expression::Lambda { body, .. } | Expression::Comptime { body, .. } => {
            collect_expression_dependencies(*body, arena, dependencies);
        }
        Expression::Rec { lambda, .. } => {
            collect_expression_dependencies(*lambda, arena, dependencies);
        }
        Expression::Array { elements, .. } => {
            for element in elements {
                collect_expression_dependencies(element.value, arena, dependencies);
            }
        }
        Expression::Tuple { elements, .. } => {
            for element in elements {
                collect_expression_dependencies(*element, arena, dependencies);
            }
        }
        Expression::Shape { members, .. } => {
            for member in members {
                let value = match member {
                    crate::ast::ShapeMember::Field { value, .. }
                    | crate::ast::ShapeMember::Spread { value } => *value,
                };
                collect_expression_dependencies(value, arena, dependencies);
            }
        }
        Expression::If {
            branches, fallback, ..
        } => {
            for branch in branches {
                collect_expression_dependencies(branch.condition, arena, dependencies);
                collect_expression_dependencies(branch.consequence, arena, dependencies);
            }
            if let Some(fallback) = fallback {
                collect_expression_dependencies(*fallback, arena, dependencies);
            }
        }
        Expression::Case { target, arms, .. } => {
            collect_expression_dependencies(*target, arena, dependencies);
            for arm in arms {
                collect_expression_dependencies(arm.body, arena, dependencies);
            }
        }
        Expression::Block {
            declarations,
            result,
            ..
        } => {
            for declaration in declarations {
                collect_declaration_dependencies(
                    &arena.declarations[declaration.0 as usize],
                    arena,
                    dependencies,
                );
            }
            collect_expression_dependencies(*result, arena, dependencies);
        }
        Expression::Var { .. }
        | Expression::Int { .. }
        | Expression::Float { .. }
        | Expression::Text { .. }
        | Expression::Unit { .. }
        | Expression::Intrinsic { .. }
        | Expression::Tag { .. } => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{AstArena, Expression, ResultEffects, Span};

    #[test]
    fn binary_module_snapshot_restores_interface_and_value() {
        const MODULE_PATH: &str = "snapshot:library";
        const MODULE_SOURCE: &str = "let rec increment = fn value => @int.add value 1\n\u{e000}return { .answer = increment 42; }\u{e000}\n";
        let mut builder = CompilerSession::default();
        builder
            .add_source(MODULE_PATH.to_owned(), source(MODULE_SOURCE))
            .expect("module source should load");
        builder
            .configure_module(MODULE_PATH, BTreeMap::new(), BTreeMap::new())
            .expect("module source should configure");
        let bytes = builder
            .module_snapshot(MODULE_PATH)
            .expect("module snapshot should encode");
        let mut consumer = CompilerSession::default();
        consumer
            .install_module_snapshot(MODULE_PATH, &bytes)
            .expect("module snapshot should install");
        assert!(
            consumer
                .context
                .module_results
                .borrow()
                .contains_key(MODULE_PATH)
        );
        assert_eq!(consumer.check_module(MODULE_PATH)["ok"], true);
        assert!(
            consumer
                .context
                .closure_signatures
                .borrow()
                .keys()
                .any(|(path, _)| path == MODULE_PATH)
        );
    }

    #[test]
    fn comment_only_edit_preserves_resident_module() {
        let mut session = CompilerSession::default();
        session
            .add_source("main.blot".to_owned(), source("return 1\u{e000}"))
            .expect("initial source should load");
        let initial = session.context.modules.borrow()["main.blot"].module.clone();

        session
            .add_source(
                "main.blot".to_owned(),
                source("return 1\u{e000} // changed"),
            )
            .expect("edited source should load");
        let edited = session.context.modules.borrow()["main.blot"].module.clone();

        assert!(Rc::ptr_eq(&initial, &edited));
    }

    #[test]
    fn closed_program_and_artifact_follow_semantic_revision() {
        let mut session = CompilerSession::default();
        session
            .add_source("main.blot".to_owned(), source("return 1\u{e000}"))
            .expect("initial source should load");
        session
            .configure_module("main.blot", BTreeMap::new(), BTreeMap::new())
            .expect("initial source should configure");

        let prepared = session.prepare_runtime_hir("main.blot");
        assert_eq!(prepared["ok"], true);
        assert_eq!(session.closed_programs.borrow().len(), 1);

        let first = session
            .compile_module("main.blot")
            .expect("initial source should compile");
        let second = session
            .compile_module("main.blot")
            .expect("unchanged source should compile");
        assert_eq!(first.wasm, second.wasm);
        assert_eq!(session.closed_programs.borrow().len(), 1);

        session
            .add_source(
                "main.blot".to_owned(),
                source("return 1\u{e000} // changed"),
            )
            .expect("comment edit should load");
        assert_eq!(session.closed_programs.borrow().len(), 1);

        session
            .add_source("main.blot".to_owned(), source("return 2\u{e000}"))
            .expect("semantic edit should load");
        assert!(session.closed_programs.borrow().is_empty());
    }

    #[test]
    fn effectful_top_level_is_not_replayed_for_multiple_runtime_fields() {
        let mut session = CompilerSession::default();
        session
            .add_source(
                "main.blot".to_owned(),
                source(
                    "module with init\n\nvalue <- init.read ()\nreturn { .first = value; .second = value; }\n",
                ),
            )
            .expect("source should load");
        session
            .configure_module("main.blot", BTreeMap::new(), BTreeMap::new())
            .expect("source should configure");

        let prepared = session.prepare_runtime_hir("main.blot");
        assert_eq!(prepared["ok"], false, "{}", prepared);
        assert_eq!(
            prepared["diagnostic"]["code"], "BLOT_TARGET_REFUSAL",
            "{}",
            prepared["diagnostic"]
        );
        assert_ne!(prepared["diagnostic"]["span"]["end"], 0);
    }

    #[test]
    fn declaration_evaluations_follow_the_unchanged_ast_prefix() {
        let path = "main.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(
                path.to_owned(),
                source("const answer = 42\u{e000}return answer\u{e000}"),
            )
            .expect("initial source should load");
        session
            .configure_module(path, BTreeMap::new(), BTreeMap::new())
            .expect("initial source should configure");
        assert_eq!(session.check_module(path)["ok"], true);
        assert_eq!(session.context.evaluated_bindings.borrow()[path].len(), 1);

        session
            .add_source(
                path.to_owned(),
                source("const answer = 42\u{e000}let unused = answer\u{e000}return answer\u{e000}"),
            )
            .expect("appended declaration should load");
        assert_eq!(session.context.evaluated_bindings.borrow()[path].len(), 1);
        assert_eq!(session.check_module(path)["ok"], true);
        assert_eq!(session.context.evaluated_bindings.borrow()[path].len(), 2);

        session
            .add_source(
                path.to_owned(),
                source("const answer = 43\u{e000}let unused = answer\u{e000}return answer\u{e000}"),
            )
            .expect("changed prefix should load");
        assert!(
            !session
                .context
                .evaluated_bindings
                .borrow()
                .contains_key(path)
        );
    }

    #[test]
    fn dependency_changes_discard_cached_declaration_evaluations() {
        let dependency_path = "dependency.blot";
        let root_path = "main.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(dependency_path.to_owned(), source("return 1\u{e000}"))
            .expect("dependency source should load");
        session
            .configure_module(dependency_path, BTreeMap::new(), BTreeMap::new())
            .expect("dependency source should configure");
        session
            .add_source(
                root_path.to_owned(),
                source("const dependency = import \"dep\"\u{e000}return dependency\u{e000}"),
            )
            .expect("root source should load");
        session
            .configure_module(
                root_path,
                BTreeMap::from([("dep".to_owned(), dependency_path.to_owned())]),
                BTreeMap::new(),
            )
            .expect("root source should configure");
        assert_eq!(session.check_module(root_path)["ok"], true);
        assert!(
            session
                .context
                .evaluated_bindings
                .borrow()
                .contains_key(root_path)
        );

        session
            .add_source(dependency_path.to_owned(), source("return 2\u{e000}"))
            .expect("changed dependency should load");
        assert!(
            !session
                .context
                .evaluated_bindings
                .borrow()
                .contains_key(root_path)
        );
    }

    #[test]
    fn rejected_modules_discard_declaration_evaluations() {
        let path = "main.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(
                path.to_owned(),
                source("const answer = 42\u{e000}return missing\u{e000}"),
            )
            .expect("rejected source should load");
        session
            .configure_module(path, BTreeMap::new(), BTreeMap::new())
            .expect("rejected source should configure");

        assert_eq!(session.check_module(path)["ok"], false);
        assert!(
            !session
                .context
                .evaluated_bindings
                .borrow()
                .contains_key(path)
        );
    }

    #[test]
    fn dependencies_are_unique_in_source_traversal_order() {
        let span = Span { start: 0, end: 1 };
        let mut arena = AstArena::default();
        let import = arena.expression(Expression::Intrinsic {
            name: "@import".to_owned(),
            span,
        });
        let first_path = arena.expression(Expression::Text {
            value: "first.blot".to_owned(),
            span,
        });
        let first = arena.expression(Expression::Apply {
            function: import,
            argument: first_path,
            span,
        });
        let second_path = arena.expression(Expression::Text {
            value: "second.blot".to_owned(),
            span,
        });
        let second = arena.expression(Expression::Apply {
            function: import,
            argument: second_path,
            span,
        });
        let repeated = arena.expression(Expression::Apply {
            function: import,
            argument: first_path,
            span,
        });
        let include = arena.expression(Expression::Intrinsic {
            name: "@include".to_owned(),
            span,
        });
        let included_path = arena.expression(Expression::Text {
            value: "shader.wgsl".to_owned(),
            span,
        });
        let included_source = arena.expression(Expression::Apply {
            function: include,
            argument: included_path,
            span,
        });
        let parser = arena.expression(Expression::Var {
            name: "as_raw".to_owned(),
            span,
        });
        let included = arena.expression(Expression::Apply {
            function: included_source,
            argument: parser,
            span,
        });
        let result = arena.expression(Expression::Tuple {
            elements: vec![first, second, repeated, included],
            span,
        });
        let module = Module {
            parameter: None,
            fixities: Vec::new(),
            declarations: Vec::new(),
            result,
            result_effects: ResultEffects::Pure,
            span,
            arena,
        };

        let dependencies = module_dependencies(&module);
        assert_eq!(dependencies.imports, ["first.blot", "second.blot"]);
        assert_eq!(dependencies.includes, ["shader.wgsl"]);
    }

    const DIRECT_CHOICE: &str = "const positive = fn value => case @int.cmp value 0 of\n  \u{e000}\u{e001}#Greater => #True\n  \u{e000}#Less => #False\n  \u{e000}#Equal => #False\n\n\u{e000}\u{e002}\u{e000}sig pick = @type.int -> { .x = @type.int; } -> @type.int\n\u{e000}let pick = fn flag =>\n  \u{e000}\u{e001}return case positive flag of\n    \u{e000}\u{e001}#True => fn record => @int.add record.x flag\n    \u{e000}#False => fn record => @int.sub record.x flag\n\n\u{e000}\u{e002}\u{e000}\u{e002}\u{e000}return { .pick = pick; }\u{e000}\n";

    const SHARED_BODY_CHOICE: &str = "const positive = fn value => case @int.cmp value 0 of\n  \u{e000}\u{e001}#Greater => #True\n  \u{e000}#Less => #False\n  \u{e000}#Equal => #False\n\n\u{e000}\u{e002}\u{e000}const bump = fn step => fn value => @int.add value step\n\n\u{e000}sig run = @type.int -> @type.int\n\u{e000}let run = fn flag =>\n  \u{e000}\u{e001}let selected = case positive flag of\n    \u{e000}\u{e001}#True => bump 1\n    \u{e000}#False => bump 2\n  \u{e000}\u{e002}\u{e000}return selected flag\n\n\u{e000}\u{e002}\u{e000}return { .run = run; }\u{e000}\n";

    const PRIMITIVE_CHOICE: &str = "const positive = fn value => case @int.cmp value 0 of\n  \u{e000}\u{e001}#Greater => #True\n  \u{e000}#Less => #False\n  \u{e000}#Equal => #False\n\n\u{e000}\u{e002}\u{e000}sig run = @type.int -> @type.int\n\u{e000}let run = fn flag =>\n  \u{e000}\u{e001}let selected = case positive flag of\n    \u{e000}\u{e001}#True => @int.add flag\n    \u{e000}#False => @int.sub flag\n  \u{e000}\u{e002}\u{e000}let first = selected 10\n  \u{e000}let second = selected 20\n  \u{e000}return @int.add first second\n\n\u{e000}\u{e002}\u{e000}return { .run = run; }\u{e000}\n";

    const EXPORTED_CHOICE: &str = "const positive = fn value => case @int.cmp value 0 of\n  \u{e000}\u{e001}#Greater => #True\n  \u{e000}#Less => #False\n  \u{e000}#Equal => #False\n\n\u{e000}\u{e002}\u{e000}sig hold = @type.int -> { .apply = { .x = @type.int; } -> @type.int; }\n\u{e000}let hold = fn flag =>\n  \u{e000}\u{e001}let chosen = case positive flag of\n    \u{e000}\u{e001}#True => fn record => @int.add record.x flag\n    \u{e000}#False => fn record => @int.sub record.x flag\n  \u{e000}\u{e002}\u{e000}return { .apply = chosen; }\n\n\u{e000}\u{e002}\u{e000}return { .hold = hold; }\u{e000}\n";

    const INCOMPATIBLE_CAPTURES: &str = "const positive = fn value => case @int.cmp value 0 of\n  \u{e000}\u{e001}#Greater => #True\n  \u{e000}#Less => #False\n  \u{e000}#Equal => #False\n\n\u{e000}\u{e002}\u{e000}sig run = @type.int -> @type.int\n\u{e000}let run = fn flag =>\n  \u{e000}\u{e001}let ratio = @float.of_int flag\n  \u{e000}let selected = case positive flag of\n    \u{e000}\u{e001}#True => fn n => @int.add n flag\n    \u{e000}#False => do:\n      \u{e000}\u{e001}let scaled = @float.mul ratio 2.0\n      \u{e000}return fn n => @int.add n (@int.of_float scaled)\n  \u{e000}\u{e002}\u{e000}\u{e002}\u{e000}let first = selected 10\n  \u{e000}let second = selected 20\n  \u{e000}return @int.add first second\n\n\u{e000}\u{e002}\u{e000}return { .run = run; }\u{e000}\n";

    #[test]
    fn a_dynamic_function_choice_becomes_a_private_tagged_table() {
        let (session, module) = prepared(DIRECT_CHOICE);
        let cases = choice_cases(&module);
        assert_eq!(cases.len(), 2);
        // One case per closure source, each carrying the branch's capture
        // product. Both lambdas capture `flag` alone, so both payloads agree.
        assert_eq!(cases[0]["payloadType"], cases[1]["payloadType"]);
        assert!(
            session.compile_module("main.blot").is_ok(),
            "a closed function source set must compile"
        );
    }

    #[test]
    fn two_closures_from_one_body_stay_separate_alternatives() {
        // `bump 1` and `bump 2` share a body and capture no runtime value: only
        // the environment they closed over tells them apart. Merging them would
        // silently make one branch compute the other's answer.
        let (session, module) = prepared(SHARED_BODY_CHOICE);
        let cases = choice_cases(&module);
        assert_eq!(cases.len(), 2);
        assert!(session.compile_module("main.blot").is_ok());
    }

    #[test]
    fn a_partially_applied_primitive_is_a_choice_alternative() {
        let (session, module) = prepared(PRIMITIVE_CHOICE);
        let cases = choice_cases(&module);
        let names = cases
            .iter()
            .map(|case_| case_["name"].as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>();
        assert!(names[0].ends_with("@int.add/1"), "{names:?}");
        assert!(names[1].ends_with("@int.sub/1"), "{names:?}");
        assert!(session.compile_module("main.blot").is_ok());
    }

    #[test]
    fn alternatives_with_incompatible_captures_share_an_indirect_payload() {
        // One branch captures an `Int` and the other an `F64`, so the two
        // capture products cannot occupy the same payload slots directly.
        let (session, module) = prepared(INCOMPATIBLE_CAPTURES);
        let cases = choice_cases(&module);
        assert_eq!(cases.len(), 2);
        for case_ in &cases {
            let payload = case_["payloadType"].as_u64().expect("payload type");
            assert_eq!(
                module["types"][payload as usize]["kind"], "indirect",
                "an incompatible capture product must be carried indirectly"
            );
        }
        assert!(session.compile_module("main.blot").is_ok());
    }

    #[test]
    fn a_function_choice_cannot_cross_the_abi_boundary() {
        let mut session = CompilerSession::default();
        session
            .add_source("main.blot".to_owned(), source(EXPORTED_CHOICE))
            .expect("source should load");
        session
            .configure_module("main.blot", BTreeMap::new(), BTreeMap::new())
            .expect("source should configure");
        let prepared = session.prepare_runtime_hir("main.blot");
        assert_eq!(prepared["ok"], false);
        assert_eq!(prepared["diagnostic"]["code"], "BLOT_UNSUPPORTED_LOWERING");
        let message = prepared["diagnostic"]["message"]
            .as_str()
            .expect("a diagnostic message");
        assert!(
            message.contains("function choice") && message.contains("ABI 1"),
            "the refusal must name the private layout: {message}"
        );
    }

    fn prepared(text: &str) -> (CompilerSession, serde_json::Value) {
        let mut session = CompilerSession::default();
        session
            .add_source("main.blot".to_owned(), source(text))
            .expect("source should load");
        session
            .configure_module("main.blot", BTreeMap::new(), BTreeMap::new())
            .expect("source should configure");
        let prepared = session.prepare_runtime_hir("main.blot");
        assert_eq!(
            prepared["ok"], true,
            "preparation failed: {}",
            prepared["diagnostic"]
        );
        let module = prepared["module"].clone();
        (session, module)
    }

    /// The cases of the one private table a defunctionalized choice built.
    fn choice_cases(module: &serde_json::Value) -> Vec<serde_json::Value> {
        let mut tables = module["types"]
            .as_array()
            .expect("a type table")
            .iter()
            .filter_map(|type_| {
                let cases = type_["cases"].as_array()?;
                cases
                    .iter()
                    .all(|case_| {
                        case_["name"]
                            .as_str()
                            .is_some_and(|name| name.starts_with("choice$"))
                    })
                    .then(|| cases.clone())
            })
            .collect::<Vec<_>>();
        assert_eq!(
            tables.len(),
            1,
            "expected exactly one function-choice table"
        );
        tables.remove(0)
    }

    /// A tail call is not a transfer. This body hands the recursion a value it
    /// computed by spending the capture, so the next entry spends it again.
    const SPENDS_EACH_ITERATION: &str = "const positive = fn value => case @int.cmp value 0 of\n  \u{e000}\u{e001}#Greater => #True\n  \u{e000}#Less => #False\n  \u{e000}#Equal => #False\n\n\u{e000}\u{e002}\u{e000}const consume = fn !value => @int.add value 1\n\u{e000}let !token = 41\n\u{e000}let rec go =\n  \u{e000}\u{e001}fn (n, carried) => case positive n of\n    \u{e000}\u{e001}#True => go (@int.sub n 1, @int.add carried (consume (!token)))\n    \u{e000}#False => carried\n  \u{e000}\u{e002}\n\u{e000}\u{e002}\u{e000}return go (3, 0)\u{e000}\n";

    /// The same recursion spending the capture only where it stops.
    const SPENDS_WHERE_IT_ENDS: &str = "const positive = fn value => case @int.cmp value 0 of\n  \u{e000}\u{e001}#Greater => #True\n  \u{e000}#Less => #False\n  \u{e000}#Equal => #False\n\n\u{e000}\u{e002}\u{e000}const consume = fn !value => @int.add value 1\n\u{e000}let !token = 41\n\u{e000}let rec go =\n  \u{e000}\u{e001}fn (n, carried) => case positive n of\n    \u{e000}\u{e001}#True => go (@int.sub n 1, carried)\n    \u{e000}#False => @int.add carried (consume (!token))\n  \u{e000}\u{e002}\n\u{e000}\u{e002}\u{e000}return go (3, 0)\u{e000}\n";

    #[test]
    fn a_capture_spent_on_a_recursing_path_is_refused() {
        let mut session = CompilerSession::default();
        session
            .add_source("main.blot".to_owned(), source(SPENDS_EACH_ITERATION))
            .expect("source should load");
        session
            .configure_module("main.blot", BTreeMap::new(), BTreeMap::new())
            .expect("source should configure");
        let checked = session.check_module("main.blot");
        assert_eq!(checked["ok"], false);
        assert_eq!(
            checked["diagnostic"]["code"], "BLOT_LINEAR_CONSUMED_TWICE",
            "{}",
            checked["diagnostic"]
        );
    }

    #[test]
    fn a_capture_spent_where_the_recursion_ends_is_accepted() {
        let mut session = CompilerSession::default();
        session
            .add_source("main.blot".to_owned(), source(SPENDS_WHERE_IT_ENDS))
            .expect("source should load");
        session
            .configure_module("main.blot", BTreeMap::new(), BTreeMap::new())
            .expect("source should configure");
        let checked = session.check_module("main.blot");
        assert_eq!(checked["ok"], true, "{}", checked["diagnostic"]);
    }

    fn source(value: &str) -> Vec<u16> {
        let mut raw = String::with_capacity(value.len());
        for character in value.chars() {
            match character {
                '\u{e000}' => {
                    let line = raw.rsplit_once('\n').map_or(raw.as_str(), |(_, line)| line);
                    if line
                        .chars()
                        .any(|character| !matches!(character, ' ' | '\t' | '\r'))
                    {
                        raw.push('\n');
                    }
                }
                '\u{e001}' | '\u{e002}' => {}
                character => raw.push(character),
            }
        }
        raw.encode_utf16().collect()
    }
}
