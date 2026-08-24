use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

use serde::{Deserialize, Serialize};

use crate::ast::{
    AstArena, Declaration, DeclarationId, Expression, ExpressionId, Module, Pattern, PatternId,
};
use crate::backend::{ClosedProgram, CompiledModule};
use crate::diagnostic::{Diagnostic, FailureClass};
use crate::eval::{
    Computation, Context, IncludedFile, LoadedModule, Phase, Runtime, evaluate_module, run,
};
use crate::frontend::FrontendState;
use crate::typecheck::{
    CHECKED_MODULE_CERTIFICATE_SCHEMA, CachedModuleAnalyses, CachedModuleInterface,
    CheckedModuleCertificate, Checker,
};
use crate::value::{OrderedFields, Value, show};

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
    published_boundaries: RefCell<HashMap<String, Rc<[u8]>>>,
    dirty_modules: RefCell<HashSet<String>>,
    invalidation: RefCell<InvalidationTelemetry>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct InvalidationTelemetry {
    dirty_modules: Vec<String>,
    invalidation_reasons: BTreeMap<String, String>,
    checked_modules: Vec<String>,
    boundary_changed: Vec<String>,
    boundary_unchanged: Vec<String>,
    invalidated_importers: Vec<String>,
    reused_artifacts: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetPreflight {
    supported: bool,
    code: Option<&'static str>,
    export: Option<String>,
    inferred_type: String,
    unsupported_component: Option<String>,
    alternatives: Vec<&'static str>,
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
            published_boundaries: RefCell::new(HashMap::new()),
            dirty_modules: RefCell::new(HashSet::new()),
            invalidation: RefCell::new(InvalidationTelemetry::default()),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencySite {
    pub specifier: String,
    pub span: crate::ast::Span,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedModule {
    pub imports: Vec<String>,
    pub includes: Vec<String>,
    pub import_sites: Vec<DependencySite>,
    pub include_sites: Vec<DependencySite>,
    pub module_handle: String,
    pub portable_ast_digest: String,
    pub syntax_diagnostics: Vec<Diagnostic>,
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
        self.checker.check(path).map_err(|diagnostic| {
            format!(
                "module snapshot interface for {path} failed to inflate: {} ({})",
                diagnostic.message, diagnostic.code,
            )
        })?;
        self.context
            .captured_binding_modules
            .borrow_mut()
            .insert(path.to_owned());
        let evaluated = run(evaluate_module(
            self.context.clone(),
            path.to_owned(),
            Value::Unit,
            Runtime::new(Phase::Comptime, path.to_owned()),
        ));
        self.context
            .captured_binding_modules
            .borrow_mut()
            .remove(path);
        let value = evaluated.map_err(|diagnostic| {
            format!(
                "module snapshot evaluation for {path} failed: {} ({})",
                diagnostic.message, diagnostic.code,
            )
        })?;
        self.context
            .module_results
            .borrow_mut()
            .insert(path.to_owned(), value);
        self.publish_boundary(path)
            .map_err(|error| format!("module snapshot boundary for {path} is invalid: {error}"))?;
        self.dirty_modules.borrow_mut().remove(path);
        Ok(())
    }

    pub fn add_source(
        &mut self,
        path: String,
        source: Vec<u16>,
    ) -> Result<AddedModule, AddSourceError> {
        let lowered = crate::source::lower_incremental(&source, self.frontends.get(&path))?;
        let dependencies = module_dependencies(&lowered.module);
        if let Some(span) = dependencies.invalid_include_paths.first() {
            return Err(AddSourceError::Diagnostics(vec![Diagnostic::new(
                "BLOT_INCLUDE_PATH",
                "`@include` requires a literal text path.",
                *span,
            )]));
        }
        self.frontends.insert(path.clone(), lowered.frontend);
        self.install_module(path, lowered.module)
            .map_err(AddSourceError::Lowering)
    }

    pub fn add_module(&mut self, path: String, module: Module) -> Result<AddedModule, String> {
        module.validate()?;
        if !module_dependencies(&module)
            .invalid_include_paths
            .is_empty()
        {
            return Err("`@include` requires a literal text path".to_owned());
        }
        self.install_module(path, module)
    }

    fn install_module(&mut self, path: String, module: Module) -> Result<AddedModule, String> {
        let dependencies = module_dependencies(&module);
        let added = added_module(&path, &module, &dependencies)?;
        let previous = self.context.modules.borrow().get(&path).cloned();
        let unchanged = previous
            .as_ref()
            .is_some_and(|loaded| loaded.module.as_ref() == &module);
        if unchanged {
            return Ok(added);
        }

        let retained_bindings = previous.as_ref().and_then(|loaded| {
            if loaded.module.parameter != module.parameter {
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
                        Declaration::Signature { .. }
                        | Declaration::Shadow { .. }
                        | Declaration::Open { .. } => None,
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
        self.mark_dirty(&path, "payload changed");
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
        Ok(added)
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
            self.mark_dirty(path, "configuration changed");
        }
        Ok(())
    }

    pub fn evaluate_module(&self, path: &str) -> serde_json::Value {
        if let Err(diagnostic) = self.begin_semantic_request(path) {
            return diagnostic_json(diagnostic);
        }
        let checked = match self.checker.check(path) {
            Ok(checked) => checked,
            Err(diagnostic) => return compiler_failure_json(diagnostic, "evaluation"),
        };
        let argument = if checked.parameter.is_some() {
            tool_grants()
        } else {
            Value::Unit
        };
        let computation = evaluate_module(
            self.context.clone(),
            path.to_owned(),
            argument,
            Runtime::new(Phase::Runtime, path.to_owned()),
        );
        match run_tool(computation) {
            Ok((value, writes)) => serde_json::json!({
                "ok": true,
                "value": json_value(&value),
                "display": show(&value),
                "writes": writes,
            }),
            Err(diagnostic) => compiler_failure_json(diagnostic, "evaluation"),
        }
    }

    pub fn check_module(&self, path: &str) -> serde_json::Value {
        if let Err(diagnostic) = self.begin_semantic_request(path) {
            return diagnostic_json(diagnostic);
        }
        self.checker.check_json(path)
    }

    pub fn analyze_module(&self, path: &str) -> serde_json::Value {
        if let Err(diagnostic) = self.begin_semantic_request(path) {
            return diagnostic_json(diagnostic);
        }
        let mut analysis = self.checker.analysis_json(path);
        if let Some(object) = analysis.as_object_mut() {
            let inferred_type = object
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("<unknown>")
                .to_owned();
            let invalidation = serde_json::to_value(&*self.invalidation.borrow())
                .expect("invalidation telemetry serialization failed");
            let target_preflight = match self.close_program(path) {
                Ok(_) => TargetPreflight {
                    supported: true,
                    code: None,
                    export: None,
                    inferred_type,
                    unsupported_component: None,
                    alternatives: Vec::new(),
                },
                Err(diagnostic) => TargetPreflight {
                    supported: false,
                    code: Some("BLOT_TARGET_REFUSAL"),
                    export: target_refusal_export(&diagnostic.message),
                    inferred_type,
                    unsupported_component: Some(diagnostic.message),
                    alternatives: vec![
                        "publish a first-order scalar, Text, Array, record, variant, or seal",
                        "finish Scratch or Region values before exporting them",
                        "extract SIMD lanes before the public boundary",
                        "keep compiler-private function choices behind one concrete wrapper",
                    ],
                },
            };
            object.insert("invalidation".to_owned(), invalidation);
            object.insert(
                "targetPreflight".to_owned(),
                serde_json::to_value(target_preflight)
                    .expect("target preflight serialization failed"),
            );
        }
        analysis
    }

    pub fn test_module(&mut self, path: &str) -> serde_json::Value {
        if let Err(diagnostic) = self.begin_semantic_request(path) {
            return diagnostic_json(diagnostic);
        }
        let checked = match self.checker.check(path) {
            Ok(checked) => checked,
            Err(diagnostic) => return compiler_failure_json(diagnostic, "test execution"),
        };
        let loaded = match self.context.modules.borrow().get(path).cloned() {
            Some(loaded) => loaded,
            None => {
                return diagnostic_json(
                    Diagnostic::new(
                        "BLOT_UNRESOLVED_IMPORT",
                        format!("Module `{path}` was not loaded."),
                        crate::ast::Span { start: 0, end: 0 },
                    )
                    .at(path),
                );
            }
        };
        let top_level = loaded
            .module
            .declarations
            .iter()
            .map(|declaration| declaration_span(&loaded.module, *declaration))
            .collect::<HashSet<_>>();
        for declaration in &loaded.module.arena.declarations {
            let span = declaration_span_value(declaration);
            if self
                .checker
                .declaration_tag_names(path, span)
                .iter()
                .any(|name| name == "test")
                && !top_level.contains(&span)
            {
                return diagnostic_json(
                    Diagnostic::new(
                        "BLOT_BAD_TEST",
                        "A `test` tag is discoverable only on a top-level named binding.",
                        span,
                    )
                    .at(path),
                );
            }
        }

        let mut tests = Vec::new();
        for (ordinal, declaration_id) in loaded.module.declarations.iter().enumerate() {
            let declaration = &loaded.module.arena.declarations[declaration_id.0 as usize];
            let span = declaration_span_value(declaration);
            if !self
                .checker
                .declaration_tag_names(path, span)
                .iter()
                .any(|name| name == "test")
            {
                continue;
            }
            let Declaration::Binding { pattern, value, .. } = declaration else {
                return diagnostic_json(
                    Diagnostic::new(
                        "BLOT_BAD_TEST",
                        "A `test` tag requires a named top-level `let` or `const` binding.",
                        span,
                    )
                    .at(path),
                );
            };
            let Pattern::Name { name, .. } = &loaded.module.arena.patterns[pattern.0 as usize]
            else {
                return diagnostic_json(
                    Diagnostic::new(
                        "BLOT_BAD_TEST",
                        "A `test` tag requires a named top-level `let` or `const` binding.",
                        span,
                    )
                    .at(path),
                );
            };
            let type_ = self
                .checker
                .expression_type_string(path, *value)
                .unwrap_or_else(|| "<unknown>".to_owned());
            if !self.checker.expression_is_nullary_unit(path, *value) {
                return diagnostic_json(
                    Diagnostic::new(
                        "BLOT_BAD_TEST",
                        format!("Test `{name}` must have type `() -> ()`, found {type_}."),
                        span,
                    )
                    .at(path),
                );
            }
            tests.push((ordinal, name.clone(), span));
        }
        if tests.is_empty() {
            return serde_json::json!({ "ok": true, "outcomes": [] });
        }
        if loaded.module.parameter.is_some() {
            return diagnostic_json(
                Diagnostic::new(
                    "BLOT_BAD_TEST",
                    "A file run by `blot test` cannot declare a module input.",
                    loaded.module.span,
                )
                .at(path),
            );
        }
        if !self.checker.effects_are_empty(&checked.effects) {
            return diagnostic_json(
                Diagnostic::new(
                    "BLOT_BAD_TEST",
                    "A file run by `blot test` must initialize without effects.",
                    loaded.module.span,
                )
                .at(path),
            );
        }

        let mut outcomes = Vec::new();
        for (ordinal, name, span) in tests {
            let result = self.run_test(path, &loaded, ordinal, &name, span);
            match result {
                Ok(()) => outcomes.push(serde_json::json!({
                    "status": "passed",
                    "path": path,
                    "name": name,
                    "span": span,
                })),
                Err(mut diagnostic) => {
                    diagnostic.origin = Some(path.to_owned());
                    if diagnostic.failure_class() != FailureClass::Source {
                        return compiler_failure_json(diagnostic, "test execution");
                    }
                    outcomes.push(serde_json::json!({
                        "status": "failed",
                        "path": path,
                        "name": name,
                        "span": span,
                        "diagnostic": {
                            "code": diagnostic.code,
                            "message": diagnostic.message,
                            "span": diagnostic.span,
                        },
                    }));
                }
            }
        }
        serde_json::json!({ "ok": true, "outcomes": outcomes })
    }

    fn run_test(
        &mut self,
        path: &str,
        loaded: &LoadedModule,
        ordinal: usize,
        name: &str,
        span: crate::ast::Span,
    ) -> Result<(), Diagnostic> {
        let mut module = loaded.module.as_ref().clone();
        module.declarations.truncate(ordinal + 1);
        let function = module.arena.expression(Expression::Var {
            name: name.to_owned(),
            span,
        });
        let argument = module.arena.expression(Expression::Unit { span });
        module.result = module.arena.expression(Expression::Apply {
            function,
            argument,
            span,
        });
        let temporary = format!("{path}\0test");
        self.install_module(temporary.clone(), module)
            .map_err(|message| Diagnostic::new("BLOT_RUST_INVARIANT", message, span).at(path))?;
        self.configure_module(&temporary, loaded.imports.clone(), loaded.includes.clone())
            .map_err(|message| Diagnostic::new("BLOT_RUST_INVARIANT", message, span).at(path))?;
        self.begin_semantic_request(&temporary)
            .map_err(|mut diagnostic| {
                diagnostic.origin = Some(path.to_owned());
                diagnostic
            })?;
        let computation = evaluate_module(
            self.context.clone(),
            temporary,
            Value::Unit,
            Runtime::new(Phase::Runtime, path.to_owned()),
        );
        let (value, _) = run_tool(computation).map_err(|mut diagnostic| {
            diagnostic.origin = Some(path.to_owned());
            diagnostic
        })?;
        if !matches!(value, Value::Unit) {
            return Err(Diagnostic::new(
                "BLOT_RUST_INVARIANT",
                format!("Test `{name}` returned a non-unit value after checking."),
                span,
            )
            .at(path));
        }
        Ok(())
    }

    pub fn module_snapshot(&self, path: &str) -> Result<Vec<u8>, String> {
        self.begin_semantic_request(path).map_err(|diagnostic| {
            format!(
                "cannot snapshot module {path}: {} ({})",
                diagnostic.message, diagnostic.code
            )
        })?;
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

    pub fn module_ast(&self, path: &str) -> Result<String, String> {
        let module = self
            .context
            .modules
            .borrow()
            .get(path)
            .map(|loaded| loaded.module.clone())
            .ok_or_else(|| format!("cannot export unknown module {path}"))?;
        serde_json::to_string(module.as_ref())
            .map_err(|error| format!("could not encode portable module AST: {error}"))
    }

    pub fn prepare_runtime_hir(&self, path: &str) -> serde_json::Value {
        match self.close_program(path) {
            Ok(program) => serde_json::json!({ "ok": true, "module": program.runtime() }),
            Err(diagnostic) => compiler_failure_json(diagnostic, "Runtime HIR preparation"),
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
        self.begin_semantic_request(path)?;
        if let Some(program) = self.closed_programs.borrow().get(path) {
            return Ok(program.clone());
        }
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

    fn begin_semantic_request(&self, path: &str) -> Result<(), Diagnostic> {
        let pending_reasons = self.invalidation.borrow().invalidation_reasons.clone();
        let mut invalidation = InvalidationTelemetry::default();
        for dirty in self.dirty_modules.borrow().iter() {
            invalidation.dirty_modules.push(dirty.clone());
            invalidation.invalidation_reasons.insert(
                dirty.clone(),
                pending_reasons
                    .get(dirty)
                    .cloned()
                    .unwrap_or_else(|| "dependency boundary changed".to_owned()),
            );
        }
        invalidation.dirty_modules.sort();
        *self.invalidation.borrow_mut() = invalidation;
        self.checker.begin_request();
        self.ensure_current(path, &mut HashSet::new())
    }

    fn ensure_current(&self, path: &str, visiting: &mut HashSet<String>) -> Result<(), Diagnostic> {
        if !visiting.insert(path.to_owned()) {
            return Ok(());
        }
        let dependencies = self
            .context
            .modules
            .borrow()
            .get(path)
            .map(|loaded| loaded.imports.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for dependency in dependencies {
            self.ensure_current(&dependency, visiting)?;
        }
        visiting.remove(path);
        if !self.dirty_modules.borrow().contains(path) {
            if self.published_boundaries.borrow().contains_key(path) {
                self.invalidation
                    .borrow_mut()
                    .reused_artifacts
                    .push(format!("module-interface:{path}"));
            }
            return Ok(());
        }
        self.invalidation
            .borrow_mut()
            .checked_modules
            .push(path.to_owned());
        let checked = self.checker.check(path);
        match checked {
            Ok(_) => {
                let changed = self.publish_boundary(path).map_err(|message| {
                    Diagnostic::new(
                        "BLOT_RUST_INVARIANT",
                        message,
                        crate::ast::Span { start: 0, end: 0 },
                    )
                    .at(path)
                })?;
                self.dirty_modules.borrow_mut().remove(path);
                if changed {
                    self.invalidation
                        .borrow_mut()
                        .boundary_changed
                        .push(path.to_owned());
                    self.invalidate_direct_importers(path);
                } else {
                    self.invalidation
                        .borrow_mut()
                        .boundary_unchanged
                        .push(path.to_owned());
                }
                Ok(())
            }
            Err(diagnostic) => {
                self.published_boundaries.borrow_mut().remove(path);
                self.dirty_modules.borrow_mut().remove(path);
                self.invalidate_direct_importers(path);
                Err(diagnostic)
            }
        }
    }

    fn publish_boundary(&self, path: &str) -> Result<bool, String> {
        let mut boundary = self.checker.sealed_boundary_bytes(path)?;
        let dependencies = self
            .context
            .modules
            .borrow()
            .get(path)
            .map(|loaded| loaded.imports.clone())
            .unwrap_or_default();
        for (specifier, dependency) in dependencies {
            append_boundary_string(&mut boundary, &specifier);
            let dependency_boundary = self
                .published_boundaries
                .borrow()
                .get(&dependency)
                .cloned()
                .ok_or_else(|| {
                    format!("module {path} reached unpublished dependency boundary {dependency}")
                })?;
            append_boundary_bytes(&mut boundary, &dependency_boundary);
        }
        if let Some(value) = self.context.module_results.borrow().get(path) {
            boundary.push(1);
            encode_boundary_value(value, &mut boundary)?;
        } else {
            boundary.push(0);
        }
        let bytes = Rc::<[u8]>::from(boundary);
        let previous = self
            .published_boundaries
            .borrow_mut()
            .insert(path.to_owned(), bytes.clone());
        Ok(previous.as_deref() != Some(bytes.as_ref()))
    }

    fn invalidate_direct_importers(&self, changed: &str) {
        let importers = self
            .context
            .modules
            .borrow()
            .iter()
            .filter_map(|(path, loaded)| {
                loaded
                    .imports
                    .values()
                    .any(|dependency| dependency == changed)
                    .then_some(path.clone())
            })
            .collect::<HashSet<_>>();
        if importers.is_empty() {
            return;
        }
        for importer in &importers {
            self.invalidation
                .borrow_mut()
                .invalidated_importers
                .push(importer.clone());
            self.dirty_modules.borrow_mut().insert(importer.clone());
        }
        self.invalidate_exact(&importers);
    }

    fn mark_dirty(&self, changed: &str, reason: &str) {
        self.dirty_modules.borrow_mut().insert(changed.to_owned());
        self.invalidation
            .borrow_mut()
            .invalidation_reasons
            .insert(changed.to_owned(), reason.to_owned());
        self.invalidate_exact(&HashSet::from([changed.to_owned()]));
    }

    fn invalidate_exact(&self, invalidated: &HashSet<String>) {
        self.context.module_cache.borrow_mut().take();
        self.context
            .live_declarations
            .borrow_mut()
            .retain(|(path, _), _| !invalidated.contains(path));
        self.context
            .evaluated_bindings
            .borrow_mut()
            .retain(|path, _| !invalidated.contains(path));
        self.context
            .expression_types
            .borrow_mut()
            .retain(|(path, _), _| !invalidated.contains(path));
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

fn tool_grants() -> Value {
    let operations = OrderedFields::from_iter([(
        "write".to_owned(),
        Value::Arrow {
            deferred: false,
            domain: Box::new(Value::Unbounded),
            codomain: Box::new(Value::Unit),
            effects: Vec::new(),
            effect_tail: None,
        },
    )]);
    let effect = Value::Effect {
        id: u32::MAX,
        name: "Console".to_owned(),
        operations,
        host: true,
    };
    Value::Shape(OrderedFields::from_iter([(
        "print".to_owned(),
        Value::Operation {
            effect: Box::new(effect),
            name: "write".to_owned(),
        },
    )]))
}

fn append_boundary_bytes(target: &mut Vec<u8>, bytes: &[u8]) {
    target.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
    target.extend_from_slice(bytes);
}

fn append_boundary_string(target: &mut Vec<u8>, value: &str) {
    append_boundary_bytes(target, value.as_bytes());
}

fn encode_boundary_value(value: &Value, target: &mut Vec<u8>) -> Result<(), String> {
    match value {
        Value::Int(value) => {
            target.push(0);
            append_boundary_bytes(target, &value.to_signed_bytes_be());
        }
        Value::Float(value) => {
            target.push(1);
            target.extend_from_slice(&value.to_bits().to_le_bytes());
        }
        Value::Float32(value) => {
            target.push(2);
            target.extend_from_slice(&value.to_bits().to_le_bytes());
        }
        Value::Vector(values) => {
            target.push(3);
            for value in values {
                target.extend_from_slice(&value.to_bits().to_le_bytes());
            }
        }
        Value::VectorMask(values) => {
            target.push(4);
            for value in values {
                target.push(u8::from(*value));
            }
        }
        Value::IntegerVector { bits, lanes } => {
            target.extend([5, *bits]);
            target.extend_from_slice(&(lanes.len() as u64).to_le_bytes());
            for lane in lanes {
                target.extend_from_slice(&lane.to_le_bytes());
            }
        }
        Value::IntegerVectorMask { bits, lanes } => {
            target.extend([6, *bits]);
            target.extend_from_slice(&(lanes.len() as u64).to_le_bytes());
            for lane in lanes {
                target.push(u8::from(*lane));
            }
        }
        Value::Text(value) => {
            target.push(7);
            append_boundary_string(target, value);
        }
        Value::Unit => target.push(8),
        Value::Shape(fields) => {
            target.push(9);
            target.extend_from_slice(&(fields.len() as u64).to_le_bytes());
            let mut fields = fields.iter().collect::<Vec<_>>();
            fields.sort_by(|left, right| left.0.cmp(right.0));
            for (name, value) in fields {
                append_boundary_string(target, name);
                encode_boundary_value(value, target)?;
            }
        }
        Value::Array(values) => {
            target.push(10);
            target.extend_from_slice(&(values.len() as u64).to_le_bytes());
            for value in values {
                encode_boundary_value(value, target)?;
            }
        }
        Value::RegionType(element) => {
            target.push(11);
            encode_boundary_value(element, target)?;
        }
        Value::ScratchType(element) => {
            target.push(12);
            encode_boundary_value(element, target)?;
        }
        Value::Scratch { values, capacity } => {
            target.push(13);
            target.extend_from_slice(&(*capacity as u64).to_le_bytes());
            target.extend_from_slice(&(values.len() as u64).to_le_bytes());
            for value in values {
                encode_boundary_value(value, target)?;
            }
        }
        Value::DeferredScratch { capacity } => {
            target.push(14);
            encode_boundary_value(capacity, target)?;
        }
        Value::Region { start, end, .. } => {
            target.push(15);
            target.extend_from_slice(&(*start as u64).to_le_bytes());
            target.extend_from_slice(&(*end as u64).to_le_bytes());
        }
        Value::RegionRejoin {
            start, middle, end, ..
        } => {
            target.push(16);
            target.extend_from_slice(&(*start as u64).to_le_bytes());
            target.extend_from_slice(&(*middle as u64).to_le_bytes());
            target.extend_from_slice(&(*end as u64).to_le_bytes());
        }
        Value::EmptyArray { element } => {
            target.push(17);
            encode_boundary_value(element, target)?;
        }
        Value::Tag { name, payload } => {
            target.push(18);
            append_boundary_string(target, name);
            if let Some(payload) = payload {
                target.push(1);
                encode_boundary_value(payload, target)?;
            } else {
                target.push(0);
            }
        }
        Value::Closure {
            module,
            body,
            self_name,
            signature,
            deferred,
            ..
        } => {
            target.push(19);
            append_boundary_string(target, module);
            target.extend_from_slice(&body.0.to_le_bytes());
            target.push(u8::from(*deferred));
            if let Some(self_name) = self_name {
                target.push(1);
                append_boundary_string(target, self_name);
            } else {
                target.push(0);
            }
            if let Some(signature) = signature {
                target.push(1);
                encode_boundary_value(signature, target)?;
            } else {
                target.push(0);
            }
        }
        Value::Deferred {
            module, expression, ..
        } => {
            target.push(20);
            append_boundary_string(target, module);
            target.extend_from_slice(&expression.0.to_le_bytes());
        }
        Value::ClosureChoice { selector, .. } => {
            target.push(21);
            target.extend_from_slice(&(selector.id as u64).to_le_bytes());
            target.extend_from_slice(&(selector.type_id as u64).to_le_bytes());
        }
        Value::ModuleClosure { module } => {
            target.push(22);
            append_boundary_string(target, module);
        }
        Value::IndexedStep { elements } => {
            target.push(23);
            target.extend_from_slice(&(elements.len() as u64).to_le_bytes());
            for element in elements {
                encode_boundary_value(element, target)?;
            }
        }
        Value::Primitive {
            name,
            arity,
            applied,
        } => {
            target.push(24);
            append_boundary_string(target, name);
            target.extend_from_slice(&(*arity as u64).to_le_bytes());
            target.extend_from_slice(&(applied.len() as u64).to_le_bytes());
            for value in applied {
                encode_boundary_value(value, target)?;
            }
        }
        Value::Range { low, high, domain } => {
            target.push(25);
            target.push(match domain {
                Some(crate::value::Domain::Int) => 1,
                Some(crate::value::Domain::Text) => 2,
                Some(crate::value::Domain::Float) => 3,
                Some(crate::value::Domain::Float32) => 4,
                None => 0,
            });
            encode_boundary_value(low, target)?;
            encode_boundary_value(high, target)?;
        }
        Value::Union(values) => {
            target.push(26);
            target.extend_from_slice(&(values.len() as u64).to_le_bytes());
            for value in values {
                encode_boundary_value(value, target)?;
            }
        }
        Value::Unbounded => target.push(27),
        Value::Arrow {
            deferred,
            domain,
            codomain,
            effects,
            effect_tail,
        } => {
            target.push(28);
            target.push(u8::from(*deferred));
            encode_boundary_value(domain, target)?;
            encode_boundary_value(codomain, target)?;
            target.extend_from_slice(&(effects.len() as u64).to_le_bytes());
            for effect in effects {
                encode_boundary_value(effect, target)?;
            }
            target.extend_from_slice(&effect_tail.unwrap_or(u32::MAX).to_le_bytes());
        }
        Value::TypeVariable(variable) => {
            target.push(29);
            target.extend_from_slice(&variable.to_le_bytes());
        }
        Value::Forall { variable, body } => {
            target.push(30);
            target.extend_from_slice(&variable.to_le_bytes());
            encode_boundary_value(body, target)?;
        }
        Value::Effect {
            id,
            name,
            operations,
            host,
        } => {
            target.push(31);
            target.extend_from_slice(&id.to_le_bytes());
            append_boundary_string(target, name);
            target.push(u8::from(*host));
            encode_boundary_value(&Value::Shape(operations.clone()), target)?;
        }
        Value::Operation { effect, name } => {
            target.push(32);
            encode_boundary_value(effect, target)?;
            append_boundary_string(target, name);
        }
        Value::Extended { inner, members } => {
            target.push(33);
            encode_boundary_value(inner, target)?;
            encode_boundary_value(&Value::Shape(members.clone()), target)?;
        }
        Value::Sealed { name, inner } => {
            target.push(34);
            append_boundary_string(target, name);
            encode_boundary_value(inner, target)?;
        }
        Value::OpaqueType(name) => {
            target.push(35);
            append_boundary_string(target, name);
        }
        Value::Runtime(runtime) => {
            target.push(36);
            target.extend_from_slice(&(runtime.id as u64).to_le_bytes());
            target.extend_from_slice(&(runtime.type_id as u64).to_le_bytes());
            match &runtime.meaning {
                crate::value::RuntimeMeaning::Plain => target.push(0),
                crate::value::RuntimeMeaning::ReusableStore => target.push(1),
                crate::value::RuntimeMeaning::Ordering => target.push(2),
                crate::value::RuntimeMeaning::ScalarOrdering { right } => {
                    target.push(3);
                    target.extend_from_slice(&(*right as u64).to_le_bytes());
                }
                crate::value::RuntimeMeaning::Sum { cases } => {
                    target.push(4);
                    target.extend_from_slice(&(cases.len() as u64).to_le_bytes());
                    for case in cases {
                        append_boundary_string(target, case);
                    }
                }
            }
        }
        Value::Continuation { .. } => {
            return Err("a live continuation cannot enter a sealed module boundary".to_owned());
        }
    }
    Ok(())
}

fn run_tool(mut computation: Computation) -> Result<(Value, Vec<String>), Diagnostic> {
    let mut writes = Vec::new();
    loop {
        match computation {
            Computation::Done(result) => return result.map(|value| (value, writes)),
            Computation::Step(step) => computation = step(),
            Computation::Perform { request, resume }
                if request.host
                    && request.effect_name == "Console"
                    && request.operation == "write" =>
            {
                let line = match request.argument {
                    Value::Text(text) => text,
                    value => show(&value),
                };
                writes.push(line);
                computation = resume(Value::Unit);
            }
            Computation::Perform { request, .. } => {
                return Err(Diagnostic::new(
                    "BLOT_UNHANDLED_EFFECT",
                    format!(
                        "No handler for `{}.{}`.",
                        request.effect_name, request.operation
                    ),
                    request.span,
                ));
            }
        }
    }
}

fn declaration_span(module: &Module, declaration: DeclarationId) -> crate::ast::Span {
    declaration_span_value(&module.arena.declarations[declaration.0 as usize])
}

fn declaration_span_value(declaration: &Declaration) -> crate::ast::Span {
    match declaration {
        Declaration::Signature { span, .. }
        | Declaration::Binding { span, .. }
        | Declaration::Shadow { span, .. }
        | Declaration::Open { span, .. } => *span,
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

fn target_refusal_export(message: &str) -> Option<String> {
    let marker = "export '";
    if let Some(start) = message.find(marker) {
        let remainder = &message[start + marker.len()..];
        if let Some(end) = remainder.find('\'') {
            return Some(remainder[..end].to_owned());
        }
    }
    Some("default".to_owned())
}

pub fn compiler_failure_json(
    diagnostic: crate::diagnostic::Diagnostic,
    phase: &str,
) -> serde_json::Value {
    diagnostic.failure_json(phase)
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
        Value::ScratchType(element) => serde_json::json!({
            "tag": "scratch-type",
            "element": json_value(element),
        }),
        Value::Scratch { values, capacity } => serde_json::json!({
            "tag": "opaque",
            "display": format!("<scratch {}/{}>", values.len(), capacity),
        }),
        Value::DeferredScratch { .. } => serde_json::json!({
            "tag": "opaque",
            "display": "<scratch empty>",
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
            deferred,
            domain,
            codomain,
            effects,
            effect_tail,
        } => {
            let mut value = serde_json::json!({
                "tag": "arrow",
                "deferred": deferred,
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
            Declaration::Signature { value, .. } => self.expression(value),
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
    import_sites: Vec<DependencySite>,
    include_sites: Vec<DependencySite>,
    invalid_include_paths: Vec<crate::ast::Span>,
    seen_imports: HashSet<String>,
    seen_includes: HashSet<String>,
}

fn added_module(
    path: &str,
    module: &Module,
    dependencies: &ModuleDependencies,
) -> Result<AddedModule, String> {
    let encoded = serde_json::to_vec(module)
        .map_err(|error| format!("portable AST digest encoding failed: {error}"))?;
    let mut digest = 0xcbf29ce484222325_u64;
    for byte in encoded {
        digest ^= u64::from(byte);
        digest = digest.wrapping_mul(0x100000001b3);
    }
    Ok(AddedModule {
        imports: dependencies.imports.clone(),
        includes: dependencies.includes.clone(),
        import_sites: dependencies.import_sites.clone(),
        include_sites: dependencies.include_sites.clone(),
        module_handle: path.to_owned(),
        portable_ast_digest: format!("fnv1a64:{digest:016x}"),
        syntax_diagnostics: Vec::new(),
    })
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
        Declaration::Signature { value, .. }
        | Declaration::Binding { value, .. }
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
            if let Expression::Intrinsic { name, .. } = &arena.expressions[function.0 as usize] {
                if let Expression::Text { value, span } = &arena.expressions[argument.0 as usize] {
                    if name == "@import" && dependencies.seen_imports.insert(value.clone()) {
                        dependencies.imports.push(value.clone());
                        dependencies.import_sites.push(DependencySite {
                            specifier: value.clone(),
                            span: *span,
                        });
                    }
                    if name == "@include" && dependencies.seen_includes.insert(value.clone()) {
                        dependencies.includes.push(value.clone());
                        dependencies.include_sites.push(DependencySite {
                            specifier: value.clone(),
                            span: *span,
                        });
                    }
                }
                if name == "@include"
                    && !matches!(
                        arena.expressions[argument.0 as usize],
                        Expression::Text { .. }
                    )
                {
                    dependencies
                        .invalid_include_paths
                        .push(source_expression_span(
                            &arena.expressions[argument.0 as usize],
                        ));
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

fn source_expression_span(expression: &Expression) -> crate::ast::Span {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{AstArena, Expression, ResultEffects, Span};

    #[test]
    fn binary_module_snapshot_restores_interface_and_value() {
        const MODULE_PATH: &str = "snapshot:library";
        const MODULE_SOURCE: &str = "let rec increment = fn value => @int.add value 1\n\u{e000}const identity = fn value => value\n\u{e000}return { .increment = increment; .identity = identity; }\u{e000}\n";
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
        consumer
            .add_source(
                "snapshot:consumer".to_owned(),
                source(
                    "const library = import \"library\"\n\u{e000}let number = library.identity 42\n\u{e000}let text = library.identity \"ok\"\n\u{e000}return (library.increment 42, number, text)\u{e000}\n",
                ),
            )
            .expect("consumer source should load");
        consumer
            .configure_module(
                "snapshot:consumer",
                BTreeMap::from([("library".to_owned(), MODULE_PATH.to_owned())]),
                BTreeMap::new(),
            )
            .expect("consumer should configure");
        assert_eq!(
            consumer.evaluate_module("snapshot:consumer")["display"],
            "(43, 42, \"ok\")"
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
    fn analysis_reports_resident_checker_work() {
        let mut session = CompilerSession::default();
        session
            .add_source(
                "main.blot".to_owned(),
                source("let identity = fn value => value\n\u{e000}return identity 1\u{e000}"),
            )
            .expect("analysis source should load");
        session
            .configure_module("main.blot", BTreeMap::new(), BTreeMap::new())
            .expect("analysis source should configure");

        let analysis = session.analyze_module("main.blot");
        assert_eq!(analysis["ok"], true);
        assert_eq!(analysis["targetPreflight"]["supported"], true, "{analysis}");
        assert_eq!(analysis["work"]["schema"], 1);
        assert!(analysis["work"]["typeNodes"].as_u64().unwrap_or_default() > 0);
        assert!(analysis["work"]["constraints"].as_u64().unwrap_or_default() > 0);
        assert!(
            analysis["work"]["boundaryMaterializations"]
                .as_u64()
                .unwrap_or_default()
                > 0
        );
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

        let analysis = session.analyze_module("main.blot");
        assert_eq!(analysis["ok"], true, "{analysis}");
        assert_eq!(
            analysis["targetPreflight"]["code"], "BLOT_TARGET_REFUSAL",
            "{analysis}"
        );
        assert_eq!(analysis["targetPreflight"]["export"], "default");

        let prepared = session.prepare_runtime_hir("main.blot");
        assert_eq!(prepared["ok"], false, "{}", prepared);
        assert_eq!(
            prepared["targetRefusal"]["code"], "BLOT_TARGET_REFUSAL",
            "{}",
            prepared["targetRefusal"]
        );
        assert!(prepared.get("diagnostic").is_none());
    }

    #[test]
    fn module_capability_signatures_follow_monomorphic_effect_results() {
        let mut session = CompilerSession::default();
        session
            .add_source(
                "main.blot".to_owned(),
                source(
                    "module with init\n\nvalue <- init.read ()\n<- init.observe (@int.add value 1)\nreturn ()\n",
                ),
            )
            .expect("source should load");
        session
            .configure_module("main.blot", BTreeMap::new(), BTreeMap::new())
            .expect("source should configure");

        let prepared = session.prepare_runtime_hir("main.blot");
        assert_eq!(prepared["ok"], true, "{prepared}");
        assert_eq!(
            prepared["module"]["capabilities"][0]["operations"][0]["name"],
            "read"
        );
        assert_eq!(
            prepared["module"]["capabilities"][0]["operations"][1]["name"],
            "observe"
        );
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
    fn dependency_changes_invalidate_importers_after_boundary_publication() {
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
            session
                .context
                .evaluated_bindings
                .borrow()
                .contains_key(root_path)
        );
        let analysis = session.analyze_module(root_path);
        assert_eq!(analysis["ok"], true, "{analysis}");
        assert_eq!(
            analysis["invalidation"]["checkedModules"],
            serde_json::json!([dependency_path, root_path]),
        );
        assert_eq!(
            analysis["invalidation"]["invalidatedImporters"],
            serde_json::json!([root_path]),
        );
    }

    #[test]
    fn unchanged_dependency_boundary_stops_reverse_invalidation() {
        let dependency_path = "dependency.blot";
        let root_path = "main.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(
                dependency_path.to_owned(),
                source(
                    "let private = fn value => @int.add value 1\n\u{e000}return { .answer = 42; }\u{e000}",
                ),
            )
            .expect("dependency source should load");
        session
            .configure_module(dependency_path, BTreeMap::new(), BTreeMap::new())
            .expect("dependency source should configure");
        session
            .add_source(
                root_path.to_owned(),
                source(
                    "const dependency = import \"dep\"\n\u{e000}return dependency.answer\u{e000}",
                ),
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

        session
            .add_source(
                dependency_path.to_owned(),
                source(
                    "let private = fn value => @int.add value 2\n\u{e000}return { .answer = 42; }\u{e000}",
                ),
            )
            .expect("private edit should load");
        let analysis = session.analyze_module(root_path);
        assert_eq!(analysis["ok"], true, "{analysis}");
        assert_eq!(
            analysis["invalidation"]["checkedModules"],
            serde_json::json!([dependency_path]),
        );
        assert_eq!(
            analysis["invalidation"]["boundaryUnchanged"],
            serde_json::json!([dependency_path]),
        );
        assert_eq!(
            analysis["invalidation"]["invalidatedImporters"],
            serde_json::json!([]),
        );
    }

    #[test]
    fn shape_update_preserves_unknown_record_width() {
        let path = "main.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(
                path.to_owned(),
                source(
                    "sig replacement = @type.int\n\u{e000}const replacement = 2\n\u{e000}const set_x = fn record => @shape.update record { .x = replacement; }\n\u{e000}return (set_x { .x = 1; .y = \"kept\"; }).y\u{e000}",
                ),
            )
            .expect("shape update source should load");
        session
            .configure_module(path, BTreeMap::new(), BTreeMap::new())
            .expect("shape update source should configure");

        let evaluated = session.evaluate_module(path);
        assert_eq!(evaluated["ok"], true, "{evaluated}");
        assert_eq!(evaluated["display"], "\"kept\"");
    }

    #[test]
    fn source_inspection_returns_dependency_sites_and_a_stable_ast_digest() {
        let path = "main.blot";
        let text = "const dependency = import \"dep\"\n\u{e000}const included = @include \"data.txt\" (fn text => text)\n\u{e000}return dependency\u{e000}";
        let mut session = CompilerSession::default();
        let first = session
            .add_source(path.to_owned(), source(text))
            .expect("inspected source should load");
        let second = session
            .add_source(path.to_owned(), source(text))
            .expect("unchanged inspected source should load");

        assert_eq!(first.imports, vec!["dep"]);
        assert_eq!(first.includes, vec!["data.txt"]);
        assert_eq!(first.import_sites[0].specifier, "dep");
        assert_eq!(first.include_sites[0].specifier, "data.txt");
        assert!(first.import_sites[0].span.end > first.import_sites[0].span.start);
        assert_eq!(first.module_handle, path);
        assert_eq!(first.portable_ast_digest, second.portable_ast_digest);
        assert!(first.portable_ast_digest.starts_with("fnv1a64:"));
    }

    #[test]
    fn source_inspection_rejects_a_nonliteral_include_path() {
        let mut session = CompilerSession::default();
        let result = session.add_source(
            "main.blot".to_owned(),
            source(
                "const path = \"data.txt\"\n\u{e000}return @include path (fn text => text)\u{e000}",
            ),
        );
        let AddSourceError::Diagnostics(diagnostics) =
            result.expect_err("dynamic include should fail inspection")
        else {
            panic!("dynamic include failed without a source diagnostic");
        };
        assert_eq!(diagnostics[0].code, "BLOT_INCLUDE_PATH");
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

    const DIRECT_CHOICE: &str = "const positive = fn value => case @int.cmp value 0 of\n  \u{e000}\u{e001}#Greater => #True\n  \u{e000}#Less => #False\n  \u{e000}#Equal => #False\n\n\u{e000}\u{e002}\u{e000}let pick :: @type.int -> { .x = @type.int; } -> @type.int\n\u{e000}let pick = fn flag => do:\n  \u{e000}\u{e001}return case positive flag of\n    \u{e000}\u{e001}#True => fn record => @int.add record.x flag\n    \u{e000}#False => fn record => @int.sub record.x flag\n\n\u{e000}\u{e002}\u{e000}\u{e002}\u{e000}return { .pick = pick; }\u{e000}\n";

    const SHARED_BODY_CHOICE: &str = "const positive = fn value => case @int.cmp value 0 of\n  \u{e000}\u{e001}#Greater => #True\n  \u{e000}#Less => #False\n  \u{e000}#Equal => #False\n\n\u{e000}\u{e002}\u{e000}const bump = fn step => fn value => @int.add value step\n\n\u{e000}let run :: @type.int -> @type.int\n\u{e000}let run = fn flag => do:\n  \u{e000}\u{e001}let selected = case positive flag of\n    \u{e000}\u{e001}#True => bump 1\n    \u{e000}#False => bump 2\n  \u{e000}\u{e002}\u{e000}return selected flag\n\n\u{e000}\u{e002}\u{e000}return { .run = run; }\u{e000}\n";

    const PRIMITIVE_CHOICE: &str = "const positive = fn value => case @int.cmp value 0 of\n  \u{e000}\u{e001}#Greater => #True\n  \u{e000}#Less => #False\n  \u{e000}#Equal => #False\n\n\u{e000}\u{e002}\u{e000}let run :: @type.int -> @type.int\n\u{e000}let run = fn flag => do:\n  \u{e000}\u{e001}let selected = case positive flag of\n    \u{e000}\u{e001}#True => @int.add flag\n    \u{e000}#False => @int.sub flag\n  \u{e000}\u{e002}\u{e000}let first = selected 10\n  \u{e000}let second = selected 20\n  \u{e000}return @int.add first second\n\n\u{e000}\u{e002}\u{e000}return { .run = run; }\u{e000}\n";

    const EXPORTED_CHOICE: &str = "const positive = fn value => case @int.cmp value 0 of\n  \u{e000}\u{e001}#Greater => #True\n  \u{e000}#Less => #False\n  \u{e000}#Equal => #False\n\n\u{e000}\u{e002}\u{e000}let hold :: @type.int -> { .apply = { .x = @type.int; } -> @type.int; }\n\u{e000}let hold = fn flag => do:\n  \u{e000}\u{e001}let chosen = case positive flag of\n    \u{e000}\u{e001}#True => fn record => @int.add record.x flag\n    \u{e000}#False => fn record => @int.sub record.x flag\n  \u{e000}\u{e002}\u{e000}return { .apply = chosen; }\n\n\u{e000}\u{e002}\u{e000}return { .hold = hold; }\u{e000}\n";

    const INCOMPATIBLE_CAPTURES: &str = "const positive = fn value => case @int.cmp value 0 of\n  \u{e000}\u{e001}#Greater => #True\n  \u{e000}#Less => #False\n  \u{e000}#Equal => #False\n\n\u{e000}\u{e002}\u{e000}let run :: @type.int -> @type.int\n\u{e000}let run = fn flag => do:\n  \u{e000}\u{e001}let ratio = @float.of_int flag\n  \u{e000}let selected = case positive flag of\n    \u{e000}\u{e001}#True => fn n => @int.add n flag\n    \u{e000}#False => do:\n      \u{e000}\u{e001}let scaled = @float.mul ratio 2.0\n      \u{e000}return fn n => @int.add n (@int.of_float scaled)\n  \u{e000}\u{e002}\u{e000}\u{e002}\u{e000}let first = selected 10\n  \u{e000}let second = selected 20\n  \u{e000}return @int.add first second\n\n\u{e000}\u{e002}\u{e000}return { .run = run; }\u{e000}\n";

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
        assert_eq!(
            prepared["targetRefusal"]["code"],
            "BLOT_UNSUPPORTED_LOWERING"
        );
        let message = prepared["targetRefusal"]["message"]
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

    #[test]
    fn a_consumer_in_a_dead_declaration_does_not_spend_a_linear_binding() {
        let text = "const consume = fn !value => @int.add value 1\n\
                    \u{e000}let !token = 41\n\
                    \u{e000}let erased = consume (!token)\n\
                    \u{e000}return consume (!token)\u{e000}";
        let mut session = CompilerSession::default();
        session
            .add_source("main.blot".to_owned(), source(text))
            .expect("source should load");
        session
            .configure_module("main.blot", BTreeMap::new(), BTreeMap::new())
            .expect("source should configure");

        let checked = session.check_module("main.blot");

        assert_eq!(checked["ok"], true, "{}", checked["diagnostic"]);
        assert_eq!(checked["type"], "Int");
    }

    #[test]
    fn recursive_empty_array_accumulator_closes_from_pushed_elements() {
        std::thread::Builder::new()
            .stack_size(8 * 1024 * 1024)
            .spawn(|| {
                let mut session = CompilerSession::default();
                session
                    .add_source(
                        "prelude.blot".to_owned(),
                        source(include_str!("../../src/prelude/prelude.blot")),
                    )
                    .expect("prelude should load");
                session
                    .add_source(
                        "main.blot".to_owned(),
                        source(include_str!("../../examples/collect_principal_type.blot")),
                    )
                    .expect("source should load");
                session
                    .configure_module("prelude.blot", BTreeMap::new(), BTreeMap::new())
                    .expect("prelude should configure");
                session
                    .configure_module(
                        "main.blot",
                        BTreeMap::from([("blot:prelude".to_owned(), "prelude.blot".to_owned())]),
                        BTreeMap::new(),
                    )
                    .expect("source should configure");

                let checked = session.check_module("main.blot");

                assert_eq!(checked["ok"], true, "{}", checked["diagnostic"]);
                assert_eq!(checked["type"], "[Int]");
            })
            .expect("collect test thread should start")
            .join()
            .expect("collect test thread should finish");
    }

    #[test]
    fn short_circuit_bounds_refine_direct_array_access() {
        std::thread::Builder::new()
            .stack_size(8 * 1024 * 1024)
            .spawn(|| {
                let mut session = CompilerSession::default();
                session
                    .add_source(
                        "prelude.blot".to_owned(),
                        source(include_str!("../../src/prelude/prelude.blot")),
                    )
                    .expect("prelude should load");
                session
                    .add_source(
                        "main.blot".to_owned(),
                        source(include_str!("../../examples/advanced_refinements.blot")),
                    )
                    .expect("source should load");
                session
                    .configure_module("prelude.blot", BTreeMap::new(), BTreeMap::new())
                    .expect("prelude should configure");
                session
                    .configure_module(
                        "main.blot",
                        BTreeMap::from([("blot:prelude".to_owned(), "prelude.blot".to_owned())]),
                        BTreeMap::new(),
                    )
                    .expect("source should configure");

                let checked = session.check_module("main.blot");
                assert_eq!(checked["ok"], true, "{}", checked["diagnostic"]);
            })
            .expect("short-circuit refinement test thread should start")
            .join()
            .expect("short-circuit refinement test thread should finish");
    }

    #[test]
    fn an_empty_scratch_uses_its_specialized_result_layout() {
        std::thread::Builder::new()
            .stack_size(8 * 1024 * 1024)
            .spawn(|| {
                let mut session = CompilerSession::default();
                session
                    .add_source(
                        "prelude.blot".to_owned(),
                        source(include_str!("../../src/prelude/prelude.blot")),
                    )
                    .expect("prelude should load");
                session
                    .add_source(
                        "main.blot".to_owned(),
                        source(concat!(
                            "open import \"blot:prelude\"\n",
                            "const empty_length :: Int -> Int\n",
                            "const empty_length = fn capacity => do:\n",
                            "  let values :: [Int]\n",
                            "  let values = Scratch.finish (Scratch.with_capacity capacity)\n",
                            "  return Array.length (&values)\n",
                            "return { .empty_length = empty_length; }\n",
                        )),
                    )
                    .expect("source should load");
                session
                    .configure_module("prelude.blot", BTreeMap::new(), BTreeMap::new())
                    .expect("prelude should configure");
                session
                    .configure_module(
                        "main.blot",
                        BTreeMap::from([("blot:prelude".to_owned(), "prelude.blot".to_owned())]),
                        BTreeMap::new(),
                    )
                    .expect("source should configure");

                let prepared = session.prepare_runtime_hir("main.blot");
                assert_eq!(prepared["ok"], true, "{}", prepared["diagnostic"]);
                let operations = prepared["module"]["functions"]
                    .as_array()
                    .expect("runtime functions")
                    .iter()
                    .flat_map(|function| {
                        function["blocks"]
                            .as_array()
                            .expect("runtime blocks")
                            .iter()
                    })
                    .flat_map(|block| {
                        block["operations"]
                            .as_array()
                            .expect("runtime operations")
                            .iter()
                    })
                    .filter_map(|operation| operation["kind"].as_str())
                    .collect::<Vec<_>>();
                assert!(operations.contains(&"scratch.with-capacity"));
                assert!(operations.contains(&"scratch.finish"));
            })
            .expect("empty Scratch test thread should start")
            .join()
            .expect("empty Scratch test thread should finish");
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
