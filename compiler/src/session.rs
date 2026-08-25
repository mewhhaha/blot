use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

use serde::{Deserialize, Serialize};

use crate::ast::{
    AstArena, Declaration, DeclarationId, Expression, ExpressionId, Module, Pattern, PatternId,
};
use crate::backend::{ClosedProgram, CompiledModule};
use crate::diagnostic::{Diagnostic, FailureClass};
use crate::eval::{
    Computation, Context, IncludedFile, LoadedModule, Phase, Runtime, evaluate_expression,
    evaluate_module, evaluate_module_environment, run,
};
use crate::frontend::{FrontendState, SyntaxSnapshot};
use crate::typecheck::{
    CachedModuleAnalyses, CachedModuleInterface, CheckedModuleCertificate, Checker, empty_effects,
    type_exposes_generative_effect,
};
use crate::value::{OrderedFields, Value, reusable_across_module_instances, show};
use crate::value_capsule::ValueCapsule;

const MODULE_SNAPSHOT_SCHEMA: u32 = 2;

#[derive(Deserialize, Serialize)]
struct ModuleSnapshot {
    schema: u32,
    ast: Module,
    certificate: CheckedModuleCertificate,
    comptime_environment: Option<ValueCapsule>,
}

#[derive(Clone, Eq, PartialEq)]
enum BoundaryFingerprint {
    Prepublished,
    Complete(Rc<[u8]>),
    RevisionBound {
        bytes: Rc<[u8]>,
        revision: crate::eval::ModuleRevision,
    },
}

#[derive(Clone)]
struct PublishedBoundary {
    id: u64,
    fingerprint: BoundaryFingerprint,
}

pub struct CompilerSession {
    context: Rc<Context>,
    registered_paths: Vec<String>,
    path_ids: HashMap<String, u32>,
    frontends: HashMap<String, FrontendState>,
    module_interfaces: Rc<RefCell<HashMap<String, CachedModuleInterface>>>,
    module_analyses: Rc<RefCell<HashMap<String, CachedModuleAnalyses>>>,
    checker: Checker,
    closed_programs: RefCell<HashMap<String, Rc<ClosedProgram>>>,
    published_boundaries: RefCell<HashMap<String, PublishedBoundary>>,
    next_boundary_id: Cell<u64>,
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
            registered_paths: Vec::new(),
            path_ids: HashMap::new(),
            frontends: HashMap::new(),
            module_interfaces,
            module_analyses,
            checker,
            closed_programs: RefCell::new(HashMap::new()),
            published_boundaries: RefCell::new(HashMap::new()),
            next_boundary_id: Cell::new(0),
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
    pub syntax_snapshot: Option<SyntaxSnapshot>,
}

pub(crate) use crate::source::SourceError as AddSourceError;

impl CompilerSession {
    pub fn register_paths(&mut self, paths: Vec<String>) -> Result<Vec<u32>, String> {
        let mut ids = Vec::with_capacity(paths.len());
        for path in paths {
            if path.is_empty() {
                return Err(
                    "compiler ABI path registration cannot contain an empty path".to_owned(),
                );
            }
            if let Some(id) = self.path_ids.get(&path) {
                ids.push(*id);
                continue;
            }
            let id = u32::try_from(self.registered_paths.len() + 1)
                .map_err(|_| "compiler ABI path registry exhausted u32 IDs".to_owned())?;
            self.registered_paths.push(path.clone());
            self.path_ids.insert(path, id);
            ids.push(id);
        }
        Ok(ids)
    }

    pub fn registered_path(&self, id: u32) -> Result<&str, String> {
        let index = id
            .checked_sub(1)
            .ok_or_else(|| "compiler ABI module ID 0 is invalid".to_owned())?;
        self.registered_paths
            .get(index as usize)
            .map(String::as_str)
            .ok_or_else(|| format!("unknown compiler ABI module ID {id}"))
    }

    pub fn remove_module(&mut self, path: &str) -> bool {
        let existed = self.context.modules.borrow().contains_key(path);
        if !existed {
            return false;
        }
        self.invalidate_direct_importers(path);
        self.invalidate_exact(&HashSet::from([path.to_owned()]));
        self.context.remove_module_state(path);
        self.frontends.remove(path);
        self.published_boundaries.borrow_mut().remove(path);
        self.dirty_modules.borrow_mut().remove(path);
        self.invalidation
            .borrow_mut()
            .invalidation_reasons
            .remove(path);
        true
    }

    /// Installs a snapshot whose caller authenticated as part of its compiler
    /// distribution. Decoding still enforces every structural cache invariant.
    pub fn install_trusted_module_snapshot(
        &mut self,
        path: &str,
        bytes: &[u8],
    ) -> Result<(), String> {
        let snapshot: ModuleSnapshot = rmp_serde::from_slice(bytes)
            .map_err(|error| format!("module snapshot for {path} is invalid: {error}"))?;
        if snapshot.schema != MODULE_SNAPSHOT_SCHEMA {
            return Err(format!(
                "module snapshot for {path} has schema {}, expected {}",
                snapshot.schema, MODULE_SNAPSHOT_SCHEMA,
            ));
        }
        snapshot.ast.validate()?;
        let dependencies = module_dependencies(&snapshot.ast);
        if !dependencies.imports.is_empty() || !dependencies.includes.is_empty() {
            return Err(format!(
                "module snapshot for {path} must be dependency-free"
            ));
        }
        let empty_resident = self.context.modules.borrow().is_empty();
        let replacing_resident = self.context.modules.borrow().contains_key(path);
        let ModuleSnapshot {
            ast,
            certificate,
            comptime_environment,
            ..
        } = snapshot;
        let module = Rc::new(ast);
        let result = module.result;
        let loaded_module =
            LoadedModule::new(path, module.clone(), BTreeMap::new(), BTreeMap::new());
        let module_revision = loaded_module.revision();
        let staged_context = Rc::new(self.context.snapshot_staging(path));
        let use_cached_interface = comptime_environment.is_some()
            && !certificate.contains_generative_effect_identity()
            && !module.arena.expressions.iter().any(|expression| {
                matches!(
                    expression,
                    Expression::Intrinsic { name, .. }
                        if matches!(name.as_str(), "@effect" | "@effect.host")
                )
            });
        let result_template = use_cached_interface.then(|| {
            Rc::new(
                comptime_environment
                    .expect("cached snapshot interface requires a compile-time environment"),
            )
        });
        let interface = CachedModuleInterface::from_certificate(certificate)?;
        staged_context
            .modules
            .borrow_mut()
            .insert(path.to_owned(), loaded_module.clone());
        let staged_interfaces = Rc::new(RefCell::new(HashMap::new()));
        let staged_analyses = Rc::new(RefCell::new(HashMap::new()));
        let staged_checker = self.checker.snapshot_staging(
            staged_context.clone(),
            staged_interfaces.clone(),
            staged_analyses.clone(),
        );
        if use_cached_interface {
            staged_checker.install_interface(path, interface)?;
        } else {
            staged_checker.validate_interface(path, &interface)?;
        }
        let checked = staged_checker.check(path).map_err(|diagnostic| {
            let operation = if use_cached_interface {
                "interface inflation"
            } else {
                "source check"
            };
            format!(
                "module snapshot {operation} for {path} failed: {} ({})",
                diagnostic.message, diagnostic.code,
            )
        })?;
        let installed_interface = staged_interfaces.borrow().get(path).cloned().ok_or_else(
            || {
                format!(
                    "module snapshot source check for {path} produced no closed checked interface"
                )
            },
        )?;
        let value = if checked.parameter.is_some() {
            None
        } else {
            let evaluated = if let Some(capsule) = &result_template {
                let base_module_instances = Vec::new();
                let base_effect_scope = Rc::new(Vec::new());
                let environment = capsule.decode(
                    path,
                    module.as_ref(),
                    &module_revision,
                    &staged_context.closure_signatures.borrow(),
                    &base_module_instances,
                    &base_effect_scope,
                )?;
                run(evaluate_expression(
                    staged_context.clone(),
                    Rc::new(path.to_owned()),
                    result,
                    environment,
                    Runtime::new(Phase::Comptime, path.to_owned()),
                ))
            } else {
                staged_context
                    .captured_binding_modules
                    .borrow_mut()
                    .insert(path.to_owned());
                let evaluated = run(evaluate_module(
                    staged_context.clone(),
                    path.to_owned(),
                    Value::Unit,
                    Runtime::new(Phase::Comptime, path.to_owned()),
                ));
                staged_context
                    .captured_binding_modules
                    .borrow_mut()
                    .remove(path);
                evaluated
            };
            Some(evaluated.map_err(|diagnostic| {
                format!(
                    "module snapshot evaluation for {path} failed: {} ({})",
                    diagnostic.message, diagnostic.code,
                )
            })?)
        };
        if let Some(template) = result_template {
            staged_context
                .module_result_templates
                .borrow_mut()
                .insert(path.to_owned(), (module_revision.clone(), template));
        }
        let id =
            self.next_boundary_id.get().checked_add(1).ok_or_else(|| {
                "compiler session exhausted module boundary identities".to_owned()
            })?;
        let reusable = checked.parameter.is_none()
            && empty_effects(&checked.effects)
            && !type_exposes_generative_effect(&checked.result)
            && value.as_ref().is_some_and(reusable_across_module_instances);
        if empty_resident {
            if let Some(value) = value {
                staged_context
                    .module_results
                    .borrow_mut()
                    .insert(path.to_owned(), value);
            }
            if reusable {
                staged_context
                    .reusable_module_results
                    .borrow_mut()
                    .insert(path.to_owned());
            }
            self.context = staged_context;
            self.module_interfaces = staged_interfaces;
            self.module_analyses = staged_analyses;
            self.checker = staged_checker;
        } else {
            self.mark_dirty(path, "snapshot installed");
            self.context
                .modules
                .borrow_mut()
                .insert(path.to_owned(), loaded_module);
            self.context.commit_staged_snapshot(path, &staged_context);
            self.checker
                .commit_staged_snapshot(path, installed_interface, &staged_checker);
            if let Some(value) = value {
                self.context
                    .module_results
                    .borrow_mut()
                    .insert(path.to_owned(), value);
            }
            if reusable {
                self.context
                    .reusable_module_results
                    .borrow_mut()
                    .insert(path.to_owned());
            }
        }
        self.next_boundary_id.set(id);
        self.published_boundaries.borrow_mut().insert(
            path.to_owned(),
            PublishedBoundary {
                id,
                fingerprint: BoundaryFingerprint::Prepublished,
            },
        );
        if replacing_resident {
            self.invalidate_direct_importers(path);
        }
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
        let snapshot = lowered.frontend.snapshot();
        self.frontends.insert(path.clone(), lowered.frontend);
        let mut added = self
            .install_module(path, lowered.module)
            .map_err(AddSourceError::Lowering)?;
        added.syntax_snapshot = Some(snapshot);
        Ok(added)
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
            let can_retain_values = loaded.module.parameter.is_none()
                && loaded.module.parameter == module.parameter
                && !loaded.module.arena.expressions.iter().any(|expression| {
                    matches!(
                        expression,
                        Expression::Intrinsic { name, .. }
                            if matches!(name.as_str(), "@effect" | "@effect.host")
                    )
                })
                && loaded.imports.values().all(|dependency| {
                    self.context
                        .reusable_module_results
                        .borrow()
                        .contains(dependency)
                });
            if !can_retain_values {
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
                        .filter(|((pattern, expression, _), value)| {
                            unchanged_bindings.contains(&(*pattern, *expression))
                                && reusable_across_module_instances(value)
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
            LoadedModule::new(&path, Rc::new(module), imports, includes),
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
        let (ast, module_revision) = self
            .context
            .modules
            .borrow()
            .get(path)
            .map(|loaded| (loaded.module.as_ref().clone(), loaded.revision()))
            .ok_or_else(|| format!("cannot snapshot unknown module {path}"))?;
        let certificate = self.checker.certificate(path)?;
        let checked = self.checker.check(path).map_err(|diagnostic| {
            format!(
                "cannot snapshot module {path}: {} ({})",
                diagnostic.message, diagnostic.code
            )
        })?;
        let comptime_environment = if ast.parameter.is_none()
            && empty_effects(&checked.effects)
            && !type_exposes_generative_effect(&checked.result)
        {
            let environment = match checked.evaluated {
                Some(environment) => environment,
                None => {
                    evaluate_module_environment(
                        self.context.clone(),
                        path.to_owned(),
                        Value::Unit,
                        Runtime::new(Phase::Comptime, path.to_owned()),
                    )
                    .map_err(|diagnostic| {
                        format!(
                            "cannot snapshot module {path}: {} ({})",
                            diagnostic.message, diagnostic.code
                        )
                    })?
                    .1
                }
            };
            ValueCapsule::encode(&environment, path, &module_revision)?
        } else {
            None
        };
        rmp_serde::to_vec(&ModuleSnapshot {
            schema: MODULE_SNAPSHOT_SCHEMA,
            ast,
            certificate,
            comptime_environment,
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
        let modules = self.context.modules.borrow();
        let loaded = modules
            .get(path)
            .ok_or_else(|| format!("cannot publish unknown module {path}"))?;
        let dependencies = loaded.imports.clone();
        let revision = loaded.revision();
        drop(modules);
        for (specifier, dependency) in dependencies {
            append_boundary_string(&mut boundary, &specifier);
            let dependency_boundary_id = self
                .published_boundaries
                .borrow()
                .get(&dependency)
                .map(|boundary| boundary.id)
                .ok_or_else(|| {
                    format!("module {path} reached unpublished dependency boundary {dependency}")
                })?;
            boundary.extend_from_slice(&dependency_boundary_id.to_le_bytes());
        }
        let value_identity = if let Some(value) = self.context.module_results.borrow().get(path) {
            boundary.push(1);
            encode_boundary_value(value, &mut boundary)?
        } else {
            boundary.push(0);
            BoundaryValueIdentity::RevisionBound
        };
        let bytes = Rc::<[u8]>::from(boundary);
        let fingerprint = match value_identity {
            BoundaryValueIdentity::Complete => BoundaryFingerprint::Complete(bytes),
            BoundaryValueIdentity::RevisionBound => {
                BoundaryFingerprint::RevisionBound { bytes, revision }
            }
        };
        let mut published_boundaries = self.published_boundaries.borrow_mut();
        if published_boundaries
            .get(path)
            .is_some_and(|previous| previous.fingerprint == fingerprint)
        {
            return Ok(false);
        }
        let id = self.allocate_boundary_id()?;
        published_boundaries.insert(path.to_owned(), PublishedBoundary { id, fingerprint });
        Ok(true)
    }

    fn allocate_boundary_id(&self) -> Result<u64, String> {
        let id =
            self.next_boundary_id.get().checked_add(1).ok_or_else(|| {
                "compiler session exhausted module boundary identities".to_owned()
            })?;
        self.next_boundary_id.set(id);
        Ok(id)
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
        self.context.remove_effect_state(invalidated);
        let mut modules = self.context.modules.borrow_mut();
        for path in invalidated {
            if let Some(module) = modules.get_mut(path) {
                module.renew_revision(path);
            }
        }
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
        self.checker.invalidate(invalidated);
        self.context
            .module_results
            .borrow_mut()
            .retain(|path, _| !invalidated.contains(path));
        self.context
            .reusable_module_results
            .borrow_mut()
            .retain(|path| !invalidated.contains(path));
        self.context
            .module_result_templates
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

#[derive(Clone, Copy, Eq, PartialEq)]
enum BoundaryValueIdentity {
    Complete,
    RevisionBound,
}

impl BoundaryValueIdentity {
    fn include(&mut self, nested: Self) {
        if nested == Self::RevisionBound {
            *self = Self::RevisionBound;
        }
    }
}

fn encode_boundary_value(
    value: &Value,
    target: &mut Vec<u8>,
) -> Result<BoundaryValueIdentity, String> {
    let mut identity = BoundaryValueIdentity::Complete;
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
                identity.include(encode_boundary_value(value, target)?);
            }
        }
        Value::Array(values) => {
            target.push(10);
            target.extend_from_slice(&(values.len() as u64).to_le_bytes());
            for value in values {
                identity.include(encode_boundary_value(value, target)?);
            }
        }
        Value::RegionType(element) => {
            target.push(11);
            identity.include(encode_boundary_value(element, target)?);
        }
        Value::ScratchType(element) => {
            target.push(12);
            identity.include(encode_boundary_value(element, target)?);
        }
        Value::Scratch { values, capacity } => {
            target.push(13);
            target.extend_from_slice(&(*capacity as u64).to_le_bytes());
            target.extend_from_slice(&(values.len() as u64).to_le_bytes());
            for value in values {
                identity.include(encode_boundary_value(value, target)?);
            }
        }
        Value::DeferredScratch { capacity } => {
            target.push(14);
            identity.include(encode_boundary_value(capacity, target)?);
        }
        Value::EmptyArray { element } => {
            target.push(17);
            identity.include(encode_boundary_value(element, target)?);
        }
        Value::Tag { name, payload } => {
            target.push(18);
            append_boundary_string(target, name);
            if let Some(payload) = payload {
                target.push(1);
                identity.include(encode_boundary_value(payload, target)?);
            } else {
                target.push(0);
            }
        }
        Value::ModuleClosure { module } => {
            target.push(22);
            append_boundary_string(target, module);
        }
        Value::IndexedStep { elements } => {
            target.push(23);
            target.extend_from_slice(&(elements.len() as u64).to_le_bytes());
            for element in elements {
                identity.include(encode_boundary_value(element, target)?);
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
                identity.include(encode_boundary_value(value, target)?);
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
            identity.include(encode_boundary_value(low, target)?);
            identity.include(encode_boundary_value(high, target)?);
        }
        Value::Union(values) => {
            target.push(26);
            target.extend_from_slice(&(values.len() as u64).to_le_bytes());
            for value in values {
                identity.include(encode_boundary_value(value, target)?);
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
            identity.include(encode_boundary_value(domain, target)?);
            identity.include(encode_boundary_value(codomain, target)?);
            target.extend_from_slice(&(effects.len() as u64).to_le_bytes());
            for effect in effects {
                identity.include(encode_boundary_value(effect, target)?);
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
            identity.include(encode_boundary_value(body, target)?);
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
            identity.include(encode_boundary_value(
                &Value::Shape(operations.clone()),
                target,
            )?);
        }
        Value::Operation { effect, name } => {
            target.push(32);
            identity.include(encode_boundary_value(effect, target)?);
            append_boundary_string(target, name);
        }
        Value::Extended { inner, members } => {
            target.push(33);
            identity.include(encode_boundary_value(inner, target)?);
            identity.include(encode_boundary_value(
                &Value::Shape(members.clone()),
                target,
            )?);
        }
        Value::Sealed { name, inner } => {
            target.push(34);
            append_boundary_string(target, name);
            identity.include(encode_boundary_value(inner, target)?);
        }
        Value::OpaqueType(name) => {
            target.push(35);
            append_boundary_string(target, name);
        }
        Value::Closure { .. }
        | Value::Deferred { .. }
        | Value::ClosureChoice { .. }
        | Value::Region { .. }
        | Value::RegionRejoin { .. }
        | Value::Runtime(_) => identity = BoundaryValueIdentity::RevisionBound,
        Value::Continuation { .. } => {
            return Err("a live continuation cannot enter a sealed module boundary".to_owned());
        }
    }
    Ok(identity)
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
        syntax_snapshot: None,
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
    use crate::eval::{ApplicationSite, apply};

    const TOP_LEVEL_FAULT_SOURCE: &str = "const Fault = @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}const Extended = @type.attach Fault \"origin\" \"snapshot\"\n\u{e000}let action = fn () => do:\n  result <- Fault.raise ()\n  return result\n\u{e000}return { .action = action; .origin = @shape.get (@type.members Extended) \"origin\"; }\u{e000}\n";
    const CLOSURE_LOCAL_FAULT_SOURCE: &str = "let action = fn () => do:\n  const Fault = @effect { .raise = @type.unit -> @type.unit; }\n  const Extended = @type.attach Fault \"origin\" \"snapshot\"\n  let origin = @shape.get (@type.members Extended) \"origin\"\n  result <- Fault.raise ()\n  return result\n\u{e000}return @type.reflect (@type.of action)\n";
    const CLOSURE_PROVENANCE_SOURCE: &str = "const make = fn captured => fn constructor => constructor { .raise = @type.unit -> @type.unit; }\n\u{e000}const first = make 1\n\u{e000}const second = make 2\n\u{e000}return { .first = first; .second = second; }\u{e000}\n";

    fn snapshot_from_source(path: &str, text: &str) -> Vec<u8> {
        let mut session = CompilerSession::default();
        session
            .add_source(path.to_owned(), source(text))
            .expect("snapshot source should load");
        session
            .configure_module(path, BTreeMap::new(), BTreeMap::new())
            .expect("snapshot source should configure");
        session
            .module_snapshot(path)
            .expect("module snapshot should encode")
    }

    #[test]
    fn binary_module_snapshot_restores_interface_and_value() {
        const MODULE_PATH: &str = "snapshot:library";
        const MODULE_SOURCE: &str = "let rec increment = fn value => @int.add value 1\n\u{e000}const identity = fn value => value\n\u{e000}return { .increment = increment; .identity = identity; }\u{e000}\n";
        let bytes = snapshot_from_source(MODULE_PATH, MODULE_SOURCE);
        let snapshot: ModuleSnapshot =
            rmp_serde::from_slice(&bytes).expect("module snapshot should decode");
        assert!(snapshot.comptime_environment.is_some());
        let mut consumer = CompilerSession::default();
        consumer
            .install_trusted_module_snapshot(MODULE_PATH, &bytes)
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
    fn snapshot_capsule_preserves_closure_application_provenance() {
        const MODULE_PATH: &str = "snapshot:closure-application-provenance";
        let bytes = snapshot_from_source(MODULE_PATH, CLOSURE_PROVENANCE_SOURCE);
        let snapshot: ModuleSnapshot =
            rmp_serde::from_slice(&bytes).expect("module snapshot should decode");
        assert!(snapshot.comptime_environment.is_some());

        let mut consumer = CompilerSession::default();
        consumer
            .install_trusted_module_snapshot(MODULE_PATH, &bytes)
            .expect("module snapshot should install");
        assert!(
            consumer
                .context
                .module_result_templates
                .borrow()
                .contains_key(MODULE_PATH)
        );
        assert!(
            !consumer
                .context
                .reusable_module_results
                .borrow()
                .contains(MODULE_PATH)
        );
        let results = consumer.context.module_results.borrow();
        let Value::Shape(closures) = &results[MODULE_PATH] else {
            panic!("snapshot module should evaluate to its closure shape");
        };
        let closure = |name| {
            let closure = closures
                .get(name)
                .unwrap_or_else(|| panic!("snapshot result should contain field {name}"));
            let Value::Closure { effect_scope, .. } = closure else {
                panic!("snapshot field {name} should be a closure");
            };
            (closure.clone(), effect_scope.clone())
        };
        let (first, first_scope) = closure("first");
        let (second, second_scope) = closure("second");
        assert!(!first_scope.is_empty());
        assert!(!second_scope.is_empty());
        assert!(first_scope != second_scope);
        drop(results);

        let application = ApplicationSite::for_expression(
            &consumer.context,
            MODULE_PATH,
            consumer.context.modules.borrow()[MODULE_PATH].module.result,
        )
        .expect("snapshot result should provide application provenance");
        let runtime = Runtime::new(Phase::Comptime, MODULE_PATH.to_owned());
        let constructor = Value::Primitive {
            name: "@effect".to_owned(),
            arity: 1,
            applied: Vec::new(),
        };
        let mint = |wrapper| {
            let effect = run(apply(
                consumer.context.clone(),
                wrapper,
                constructor.clone(),
                Span { start: 0, end: 0 },
                runtime.clone(),
                application.clone(),
            ))
            .expect("snapshot wrapper should mint its supplied effect");
            let Value::Effect { id, .. } = effect else {
                panic!("snapshot wrapper should return an effect");
            };
            id
        };
        assert_ne!(mint(first), mint(second));

        consumer
            .add_source(
                "snapshot:closure-application-provenance-consumer".to_owned(),
                source(
                    "const library = import \"library\"\n\u{e000}let first = library.first (fn operations => 41)\n\u{e000}let second = library.second (fn operations => 42)\n\u{e000}return (first, second)\u{e000}\n",
                ),
            )
            .expect("consumer source should load");
        consumer
            .configure_module(
                "snapshot:closure-application-provenance-consumer",
                BTreeMap::from([("library".to_owned(), MODULE_PATH.to_owned())]),
                BTreeMap::new(),
            )
            .expect("consumer should configure");

        assert_eq!(
            consumer.evaluate_module("snapshot:closure-application-provenance-consumer")["display"],
            "(41, 42)"
        );
    }

    #[test]
    fn snapshot_template_instantiates_closures_for_each_import_occurrence() {
        const MODULE_PATH: &str = "snapshot:closure-template";
        const CONSUMER_PATH: &str = "snapshot:closure-template-consumer";
        let bytes = snapshot_from_source(MODULE_PATH, CLOSURE_PROVENANCE_SOURCE);
        let mut consumer = CompilerSession::default();
        consumer
            .install_trusted_module_snapshot(MODULE_PATH, &bytes)
            .expect("module snapshot should install");
        consumer
            .add_source(
                CONSUMER_PATH.to_owned(),
                source(
                    "const left = import \"left\"\n\u{e000}const right = import \"right\"\n\u{e000}return { .left = left.first; .right = right.first; }\u{e000}\n",
                ),
            )
            .expect("consumer source should load");
        consumer
            .configure_module(
                CONSUMER_PATH,
                BTreeMap::from([
                    ("left".to_owned(), MODULE_PATH.to_owned()),
                    ("right".to_owned(), MODULE_PATH.to_owned()),
                ]),
                BTreeMap::new(),
            )
            .expect("consumer should configure");

        let result = run(crate::eval::evaluate_module(
            consumer.context.clone(),
            CONSUMER_PATH.to_owned(),
            Value::Unit,
            Runtime::new(Phase::Comptime, CONSUMER_PATH.to_owned()),
        ))
        .expect("consumer should evaluate");
        let Value::Shape(fields) = result else {
            panic!("consumer should return a closure shape");
        };
        let module_instances = |name| {
            let field = fields
                .get(name)
                .unwrap_or_else(|| panic!("consumer should contain field {name}"));
            let Value::Closure {
                module_instances, ..
            } = field
            else {
                panic!("consumer field {name} should be a closure");
            };
            module_instances.clone()
        };

        assert!(module_instances("left") != module_instances("right"));
    }

    #[test]
    fn snapshot_provenance_encoding_is_deterministic_across_sessions() {
        const PATH: &str = "snapshot:deterministic-provenance";
        let first = snapshot_from_source(PATH, CLOSURE_PROVENANCE_SOURCE);
        let second = snapshot_from_source(PATH, CLOSURE_PROVENANCE_SOURCE);

        assert!(first == second);
    }

    #[test]
    fn closure_module_results_are_evaluated_per_import_occurrence() {
        const LIBRARY_PATH: &str = "instance-specific-library.blot";
        const IMPORTER_PATH: &str = "instance-specific-importer.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(
                LIBRARY_PATH.to_owned(),
                source("return fn callback => callback ()\n"),
            )
            .expect("library source should load");
        session
            .configure_module(LIBRARY_PATH, BTreeMap::new(), BTreeMap::new())
            .expect("library source should configure");
        assert_eq!(session.check_module(LIBRARY_PATH)["ok"], true);
        assert!(
            !session
                .context
                .reusable_module_results
                .borrow()
                .contains(LIBRARY_PATH)
        );

        session
            .add_source(
                IMPORTER_PATH.to_owned(),
                source(
                    "const first = import \"first\"\n\u{e000}const second = import \"second\"\n\u{e000}return { .first = first; .second = second; }\u{e000}\n",
                ),
            )
            .expect("importer source should load");
        session
            .configure_module(
                IMPORTER_PATH,
                BTreeMap::from([
                    ("first".to_owned(), LIBRARY_PATH.to_owned()),
                    ("second".to_owned(), LIBRARY_PATH.to_owned()),
                ]),
                BTreeMap::new(),
            )
            .expect("importer source should configure");
        assert_eq!(session.check_module(IMPORTER_PATH)["ok"], true);

        let results = session.context.module_results.borrow();
        let Value::Shape(closures) = &results[IMPORTER_PATH] else {
            panic!("importer should evaluate to its closure shape");
        };
        let module_instances = |name| {
            let Value::Closure {
                module_instances, ..
            } = closures
                .get(name)
                .unwrap_or_else(|| panic!("importer result should contain field {name}"))
            else {
                panic!("importer field {name} should be a closure");
            };
            module_instances.clone()
        };
        let first_instances = module_instances("first");
        let second_instances = module_instances("second");
        assert!(!first_instances.is_empty());
        assert!(!second_instances.is_empty());
        assert!(first_instances != second_instances);
    }

    #[test]
    fn parameterized_snapshot_is_instantiated_with_the_import_argument() {
        const MODULE_PATH: &str = "snapshot:parameterized";
        const IMPORTER_PATH: &str = "snapshot:parameterized-importer";
        let snapshot =
            snapshot_from_source(MODULE_PATH, "module with input\nreturn @int.add input 1\n");
        let decoded: ModuleSnapshot =
            rmp_serde::from_slice(&snapshot).expect("module snapshot should decode");
        assert!(decoded.comptime_environment.is_none());

        let mut consumer = CompilerSession::default();
        consumer
            .install_trusted_module_snapshot(MODULE_PATH, &snapshot)
            .expect("parameterized module snapshot should install");
        consumer
            .add_source(
                IMPORTER_PATH.to_owned(),
                source("return import \"library\" with 41\n"),
            )
            .expect("snapshot importer source should load");
        consumer
            .configure_module(
                IMPORTER_PATH,
                BTreeMap::from([("library".to_owned(), MODULE_PATH.to_owned())]),
                BTreeMap::new(),
            )
            .expect("snapshot importer should configure");

        assert_eq!(consumer.evaluate_module(IMPORTER_PATH)["display"], "42");
    }

    #[test]
    fn module_snapshot_replays_effect_extensions_from_an_ineligible_environment() {
        const PATH: &str = "snapshot:effect-extension";
        let snapshot = snapshot_from_source(PATH, TOP_LEVEL_FAULT_SOURCE);
        let decoded: ModuleSnapshot =
            rmp_serde::from_slice(&snapshot).expect("module snapshot should decode");
        assert!(decoded.comptime_environment.is_none());

        let mut consumer = CompilerSession::default();
        consumer
            .install_trusted_module_snapshot(PATH, &snapshot)
            .expect("module snapshot should install");
        consumer
            .add_source(
                "snapshot:effect-extension-consumer".to_owned(),
                source(
                    "const library = import \"library\"\n\u{e000}return @type.reflect (@type.of library.action)\u{e000}\n",
                ),
            )
            .expect("consumer source should load");
        consumer
            .configure_module(
                "snapshot:effect-extension-consumer",
                BTreeMap::from([("library".to_owned(), PATH.to_owned())]),
                BTreeMap::new(),
            )
            .expect("consumer source should configure");

        let evaluated = consumer.evaluate_module("snapshot:effect-extension-consumer");
        assert_snapshot_fault(reflected_arrow_effect(&evaluated));
    }

    #[test]
    fn effect_minting_ast_rejects_a_forged_effect_free_certificate_fast_path() {
        const PATH: &str = "snapshot:forged-effect-free-certificate";
        let snapshot = snapshot_from_source(PATH, CLOSURE_LOCAL_FAULT_SOURCE);
        let snapshot: ModuleSnapshot =
            rmp_serde::from_slice(&snapshot).expect("module snapshot should decode");
        let mut encoded = serde_json::to_value(snapshot).expect("snapshot should serialize");
        for node in encoded["certificate"]["types"]
            .as_array_mut()
            .expect("certificate should contain types")
        {
            if let Some(labels) = node
                .get_mut("Effects")
                .and_then(serde_json::Value::as_array_mut)
            {
                labels.retain(|label| {
                    !label.as_str().is_some_and(|label| {
                        label.starts_with("effect:") || label.starts_with("host:")
                    })
                });
            }
            if let Some(labels) = node
                .get_mut("OpenEffects")
                .and_then(|open| open.get_mut("labels"))
                .and_then(serde_json::Value::as_array_mut)
            {
                labels.retain(|label| {
                    !label.as_str().is_some_and(|label| {
                        label.starts_with("effect:") || label.starts_with("host:")
                    })
                });
            }
            if node
                .get("Opaque")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|name| name.starts_with("Effect:"))
            {
                node["Opaque"] = serde_json::json!("ForgedEffect");
            }
        }
        let forged: ModuleSnapshot =
            serde_json::from_value(encoded).expect("forged snapshot should deserialize");
        assert!(forged.comptime_environment.is_some());
        assert!(!forged.certificate.contains_generative_effect_identity());
        let forged = rmp_serde::to_vec(&forged).expect("forged snapshot should encode");

        let mut consumer = CompilerSession::default();
        consumer
            .install_trusted_module_snapshot(PATH, &forged)
            .expect("effect-minting AST should be checked from source");
        let evaluated = consumer.evaluate_module(PATH);
        assert_snapshot_fault(reflected_arrow_effect(&evaluated));
    }

    #[test]
    fn occupied_session_rechecks_capsuled_generative_effect_metadata_with_local_identity() {
        const PATH: &str = "snapshot:occupied-effect-operations";
        let snapshot = snapshot_from_source(PATH, CLOSURE_LOCAL_FAULT_SOURCE);
        let decoded: ModuleSnapshot =
            rmp_serde::from_slice(&snapshot).expect("module snapshot should decode");
        assert!(decoded.comptime_environment.is_some());

        let mut consumer = CompilerSession::default();
        consumer
            .add_source(
                "snapshot:occupied-effect-resident".to_owned(),
                source(
                    "const Occupied = @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}const Extended = @type.attach Occupied \"origin\" \"resident\"\n\u{e000}return @shape.get (@type.members Extended) \"origin\"\u{e000}\n",
                ),
            )
            .expect("resident source should load");
        consumer
            .configure_module(
                "snapshot:occupied-effect-resident",
                BTreeMap::new(),
                BTreeMap::new(),
            )
            .expect("resident source should configure");
        assert_eq!(
            consumer.evaluate_module("snapshot:occupied-effect-resident")["display"],
            "\"resident\""
        );
        consumer
            .install_trusted_module_snapshot(PATH, &snapshot)
            .expect("module snapshot should install");
        let evaluated = consumer.evaluate_module(PATH);
        let effect = reflected_arrow_effect(&evaluated);
        assert_snapshot_fault(effect);
        assert_eq!(effect["inner"]["id"], 2, "{evaluated}");
    }

    #[test]
    fn occupied_snapshot_source_recheck_preserves_fresh_session_analysis() {
        const PATH: &str = "snapshot:analysis-parity";
        let snapshot = snapshot_from_source(
            PATH,
            "const apply = fn function => function 1\n\u{e000}let first = apply (fn value => value)\n\u{e000}let second = apply (fn value => { .value = value; })\n\u{e000}let action = fn () => do:\n  const Fault = @effect { .raise = @type.unit -> @type.unit; }\n  result <- Fault.raise ()\n  return result\n\u{e000}return { .first = first; .second = second; .signature = @type.reflect (@type.of action); }\u{e000}\n",
        );

        let mut fresh = CompilerSession::default();
        fresh
            .install_trusted_module_snapshot(PATH, &snapshot)
            .expect("fresh analysis snapshot should install");
        let fresh_analysis = fresh.analyze_module(PATH);

        let mut occupied = CompilerSession::default();
        occupied
            .add_source(
                "snapshot:analysis-resident".to_owned(),
                source("return 0\n"),
            )
            .expect("resident source should load");
        occupied
            .configure_module(
                "snapshot:analysis-resident",
                BTreeMap::new(),
                BTreeMap::new(),
            )
            .expect("resident source should configure");
        occupied
            .install_trusted_module_snapshot(PATH, &snapshot)
            .expect("occupied analysis snapshot should install");
        let occupied_analysis = occupied.analyze_module(PATH);

        assert_eq!(fresh_analysis["ok"], true, "{fresh_analysis}");
        assert_eq!(occupied_analysis["ok"], true, "{occupied_analysis}");
        for field in [
            "type",
            "effects",
            "types",
            "tags",
            "ownership",
            "specializations",
        ] {
            assert_eq!(
                occupied_analysis[field], fresh_analysis[field],
                "analysis field {field} differs"
            );
        }
        assert_eq!(
            fresh_analysis["specializations"][0]["specializationCount"],
            2
        );
    }

    #[test]
    fn occupied_snapshot_source_recheck_preserves_polymorphic_interface() {
        const PATH: &str = "snapshot:polymorphic-parity";
        let snapshot = snapshot_from_source(
            PATH,
            "const Hidden = @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}let identity = fn value => value\n\u{e000}return identity\u{e000}\n",
        );

        let mut fresh = CompilerSession::default();
        fresh
            .install_trusted_module_snapshot(PATH, &snapshot)
            .expect("fresh polymorphic snapshot should install");
        let fresh_check = fresh.check_module(PATH);

        let mut occupied = CompilerSession::default();
        occupied
            .add_source(
                "snapshot:polymorphic-resident".to_owned(),
                source("return 0\n"),
            )
            .expect("resident source should load");
        occupied
            .configure_module(
                "snapshot:polymorphic-resident",
                BTreeMap::new(),
                BTreeMap::new(),
            )
            .expect("resident source should configure");
        occupied
            .install_trusted_module_snapshot(PATH, &snapshot)
            .expect("occupied polymorphic snapshot should install");
        let occupied_check = occupied.check_module(PATH);

        assert_eq!(fresh_check["ok"], true, "{fresh_check}");
        assert_eq!(occupied_check, fresh_check);
    }

    #[test]
    fn snapshot_replacement_clears_configuration_and_invalidates_importers() {
        const MODULE_PATH: &str = "snapshot:replacement";
        const IMPORTER_PATH: &str = "snapshot:replacement-importer";
        let snapshot = snapshot_from_source(MODULE_PATH, "return 2\n");

        let mut session = CompilerSession::default();
        session
            .add_source("snapshot:resident".to_owned(), source("return 1\n"))
            .expect("resident source should load");
        session
            .configure_module("snapshot:resident", BTreeMap::new(), BTreeMap::new())
            .expect("resident source should configure");
        session
            .add_source(
                MODULE_PATH.to_owned(),
                source(
                    "const resident = import \"resident\"\n\u{e000}const included = @include \"old.txt\" (fn text => text)\n\u{e000}return resident\u{e000}\n",
                ),
            )
            .expect("replaceable source should load");
        session
            .configure_module(
                MODULE_PATH,
                BTreeMap::from([("resident".to_owned(), "snapshot:resident".to_owned())]),
                BTreeMap::from([(
                    "old.txt".to_owned(),
                    IncludedFile {
                        path: "snapshot:old.txt".to_owned(),
                        text: "old".to_owned(),
                    },
                )]),
            )
            .expect("replaceable source should configure");
        session
            .add_source(
                IMPORTER_PATH.to_owned(),
                source("const dependency = import \"dependency\"\nreturn dependency\n"),
            )
            .expect("importer source should load");
        session
            .configure_module(
                IMPORTER_PATH,
                BTreeMap::from([("dependency".to_owned(), MODULE_PATH.to_owned())]),
                BTreeMap::new(),
            )
            .expect("importer source should configure");
        assert_eq!(session.check_module(IMPORTER_PATH)["type"], "1");

        session
            .install_trusted_module_snapshot(MODULE_PATH, &snapshot)
            .expect("module snapshot should replace source");

        let modules = session.context.modules.borrow();
        assert!(modules[MODULE_PATH].imports.is_empty());
        assert!(modules[MODULE_PATH].includes.is_empty());
        drop(modules);
        assert!(session.dirty_modules.borrow().contains(IMPORTER_PATH));
        assert!(
            session
                .invalidation
                .borrow()
                .invalidated_importers
                .iter()
                .any(|path| path == IMPORTER_PATH)
        );
        assert_eq!(session.check_module(IMPORTER_PATH)["type"], "2");
    }

    #[test]
    fn corrupt_snapshot_capsule_leaves_the_resident_module_unchanged() {
        const PATH: &str = "snapshot:transaction-capsule";
        let bytes = snapshot_from_source(
            PATH,
            "let identity = fn value => value\nreturn identity 42\n",
        );
        let snapshot: ModuleSnapshot =
            rmp_serde::from_slice(&bytes).expect("module snapshot should decode");
        let mut encoded = serde_json::to_value(snapshot).expect("snapshot should serialize");
        encoded["comptime_environment"]["schema"] = serde_json::json!(u32::MAX);
        let corrupt: ModuleSnapshot =
            serde_json::from_value(encoded).expect("corrupt snapshot should deserialize");
        let corrupt = rmp_serde::to_vec(&corrupt).expect("corrupt snapshot should encode");

        let mut consumer = CompilerSession::default();
        consumer
            .add_source(PATH.to_owned(), source("return 7\n"))
            .expect("resident source should load");
        consumer
            .configure_module(PATH, BTreeMap::new(), BTreeMap::new())
            .expect("resident source should configure");
        assert_eq!(consumer.check_module(PATH)["type"], "7");

        let error = consumer
            .install_trusted_module_snapshot(PATH, &corrupt)
            .expect_err("corrupt capsule should be rejected");
        assert!(error.contains("value capsule has schema"), "{error}");
        assert_eq!(consumer.check_module(PATH)["type"], "7");
        assert_eq!(consumer.evaluate_module(PATH)["display"], "7");
    }

    #[test]
    fn invalid_cached_closure_body_leaves_the_resident_module_unchanged() {
        const PATH: &str = "snapshot:transaction-closure";
        let bytes = snapshot_from_source(
            PATH,
            "let identity = fn value => value\nreturn identity 42\n",
        );
        let snapshot: ModuleSnapshot =
            rmp_serde::from_slice(&bytes).expect("module snapshot should decode");
        let mut encoded = serde_json::to_value(snapshot).expect("snapshot should serialize");
        let closure = encoded["comptime_environment"]["environments"]
            .as_array_mut()
            .expect("value capsule should contain environments")
            .iter_mut()
            .find_map(|environment| environment["names"].get_mut("identity"))
            .expect("value capsule should contain the identity closure");
        closure["Closure"]["body"] = serde_json::json!(u32::MAX);
        let corrupt: ModuleSnapshot =
            serde_json::from_value(encoded).expect("corrupt snapshot should deserialize");
        let corrupt = rmp_serde::to_vec(&corrupt).expect("corrupt snapshot should encode");

        let mut consumer = CompilerSession::default();
        consumer
            .add_source(PATH.to_owned(), source("return 7\n"))
            .expect("resident source should load");
        consumer
            .configure_module(PATH, BTreeMap::new(), BTreeMap::new())
            .expect("resident source should configure");
        assert_eq!(consumer.check_module(PATH)["type"], "7");
        assert_eq!(consumer.evaluate_module(PATH)["display"], "7");
        let boundary = consumer.published_boundaries.borrow()[PATH].id;

        let error = consumer
            .install_trusted_module_snapshot(PATH, &corrupt)
            .expect_err("invalid closure body should be rejected");

        assert!(error.contains("has no matching source lambda"), "{error}");
        assert_eq!(consumer.check_module(PATH)["type"], "7");
        assert_eq!(consumer.evaluate_module(PATH)["display"], "7");
        assert_eq!(consumer.published_boundaries.borrow()[PATH].id, boundary);
    }

    #[test]
    fn snapshot_rejects_a_missing_effect_scope() {
        const PATH: &str = "snapshot:missing-effect-scope";
        let bytes = snapshot_from_source(PATH, CLOSURE_PROVENANCE_SOURCE);
        let snapshot: ModuleSnapshot =
            rmp_serde::from_slice(&bytes).expect("module snapshot should decode");
        let mut encoded = serde_json::to_value(snapshot).expect("snapshot should serialize");
        let frame = encoded["comptime_environment"]["effect_scopes"]
            .as_array_mut()
            .expect("value capsule should contain effect scopes")
            .iter_mut()
            .find_map(|effect_scope| effect_scope.as_array_mut()?.first_mut())
            .expect("value capsule should contain an application frame");
        frame["creation_scope"] = serde_json::json!(u32::MAX);
        let corrupt: ModuleSnapshot =
            serde_json::from_value(encoded).expect("corrupt snapshot should deserialize");
        let corrupt = rmp_serde::to_vec(&corrupt).expect("corrupt snapshot should encode");

        let mut consumer = CompilerSession::default();
        let error = consumer
            .install_trusted_module_snapshot(PATH, &corrupt)
            .expect_err("missing effect scope should be rejected");

        assert!(error.contains("missing effect scope"), "{error}");
    }

    #[test]
    fn snapshot_rejects_application_provenance_outside_its_ast() {
        const PATH: &str = "snapshot:invalid-application-provenance";
        let bytes = snapshot_from_source(PATH, CLOSURE_PROVENANCE_SOURCE);
        let snapshot: ModuleSnapshot =
            rmp_serde::from_slice(&bytes).expect("module snapshot should decode");
        let mut encoded = serde_json::to_value(snapshot).expect("snapshot should serialize");
        let frame = encoded["comptime_environment"]["effect_scopes"]
            .as_array_mut()
            .expect("value capsule should contain effect scopes")
            .iter_mut()
            .find_map(|effect_scope| effect_scope.as_array_mut()?.first_mut())
            .expect("value capsule should contain an application frame");
        let root = frame["application"]["root"]
            .as_object_mut()
            .expect("application root should be a tagged identity");
        let expression = root
            .values_mut()
            .next()
            .expect("application root should contain its AST identity");
        *expression = serde_json::json!(u32::MAX);
        let corrupt: ModuleSnapshot =
            serde_json::from_value(encoded).expect("corrupt snapshot should deserialize");
        let corrupt = rmp_serde::to_vec(&corrupt).expect("corrupt snapshot should encode");

        let mut consumer = CompilerSession::default();
        let error = consumer
            .install_trusted_module_snapshot(PATH, &corrupt)
            .expect_err("application outside the AST should be rejected");

        assert!(error.contains("references missing expression"), "{error}");
    }

    #[test]
    fn snapshot_rejects_duplicate_closure_signature_bodies() {
        const PATH: &str = "snapshot:duplicate-closure-signature";
        let bytes = snapshot_from_source(
            PATH,
            "let identity = fn value => value\nreturn identity 42\n",
        );
        let snapshot: ModuleSnapshot =
            rmp_serde::from_slice(&bytes).expect("module snapshot should decode");
        let mut encoded = serde_json::to_value(snapshot).expect("snapshot should serialize");
        let signatures = encoded["certificate"]["closure_signatures"]
            .as_array_mut()
            .expect("snapshot certificate should contain closure signatures");
        let duplicate = signatures
            .first()
            .expect("snapshot should contain an identity closure signature")
            .clone();
        signatures.push(duplicate);
        let corrupt: ModuleSnapshot =
            serde_json::from_value(encoded).expect("corrupt snapshot should deserialize");
        let corrupt = rmp_serde::to_vec(&corrupt).expect("corrupt snapshot should encode");

        let mut consumer = CompilerSession::default();
        let error = consumer
            .install_trusted_module_snapshot(PATH, &corrupt)
            .expect_err("duplicate closure signature should be rejected");
        assert!(
            error.contains("repeats closure signature expression"),
            "{error}"
        );
    }

    #[test]
    fn snapshot_rejects_a_closure_signature_body_outside_its_ast() {
        const PATH: &str = "snapshot:missing-closure-body";
        let bytes = snapshot_from_source(
            PATH,
            "let identity = fn value => value\nreturn identity 42\n",
        );
        let snapshot: ModuleSnapshot =
            rmp_serde::from_slice(&bytes).expect("module snapshot should decode");
        let mut encoded = serde_json::to_value(snapshot).expect("snapshot should serialize");
        encoded["certificate"]["closure_signatures"][0][0] = serde_json::json!(u32::MAX);
        encoded["certificate"]["ownership_contracts"] = serde_json::json!([]);
        let corrupt: ModuleSnapshot =
            serde_json::from_value(encoded).expect("corrupt snapshot should deserialize");
        let corrupt = rmp_serde::to_vec(&corrupt).expect("corrupt snapshot should encode");

        let mut consumer = CompilerSession::default();
        let error = consumer
            .install_trusted_module_snapshot(PATH, &corrupt)
            .expect_err("missing closure body should be rejected");
        assert!(error.contains("missing closure expression"), "{error}");
    }

    #[test]
    fn snapshot_evaluation_failure_leaves_the_resident_module_unchanged() {
        const PATH: &str = "snapshot:transaction-evaluation";
        const EFFECT_LABEL: &str = "effect:1:Fault";
        let snapshot = snapshot_from_source(
            PATH,
            "const Fault = @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}return do:\n  let attached = @type.attach Fault \"origin\" \"snapshot\"\n  let origin = @shape.get (@type.members attached) \"origin\"\n  return @int.div (@text.len origin) 0\u{e000}\n",
        );

        let mut consumer = CompilerSession::default();
        consumer
            .add_source(
                PATH.to_owned(),
                source(
                    "const Fault = @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}const Extended = @type.attach Fault \"origin\" \"resident\"\n\u{e000}return 7\u{e000}\n",
                ),
            )
            .expect("resident source should load");
        consumer
            .configure_module(PATH, BTreeMap::new(), BTreeMap::new())
            .expect("resident source should configure");
        assert_eq!(consumer.check_module(PATH)["type"], "7");
        let resident = consumer.context.modules.borrow()[PATH].module.clone();
        let boundary = consumer.published_boundaries.borrow()[PATH].id;
        let next_boundary = consumer.next_boundary_id.get();
        let invalidation = serde_json::to_value(&*consumer.invalidation.borrow())
            .expect("invalidation should serialize");
        let extension = consumer
            .context
            .effect_value(EFFECT_LABEL)
            .expect("resident effect should reify");
        let Value::Extended { members, .. } = extension else {
            panic!("resident effect should retain its extension")
        };
        assert_eq!(
            show(
                members
                    .get("origin")
                    .expect("resident extension has origin")
            ),
            "\"resident\""
        );

        let error = consumer
            .install_trusted_module_snapshot(PATH, &snapshot)
            .expect_err("trapping snapshot should be rejected");
        assert!(error.contains("BLOT_DIVIDE_BY_ZERO"), "{error}");
        assert!(Rc::ptr_eq(
            &resident,
            &consumer.context.modules.borrow()[PATH].module
        ));
        assert_eq!(consumer.published_boundaries.borrow()[PATH].id, boundary);
        assert_eq!(consumer.next_boundary_id.get(), next_boundary);
        assert_eq!(
            serde_json::to_value(&*consumer.invalidation.borrow())
                .expect("invalidation should serialize"),
            invalidation
        );
        assert!(!consumer.dirty_modules.borrow().contains(PATH));
        let extension = consumer
            .context
            .effect_value(EFFECT_LABEL)
            .expect("resident effect should still reify");
        let Value::Extended { members, .. } = extension else {
            panic!("failed snapshot should not replace the resident extension")
        };
        assert_eq!(
            show(
                members
                    .get("origin")
                    .expect("resident extension has origin")
            ),
            "\"resident\""
        );
        assert_eq!(consumer.check_module(PATH)["type"], "7");
        assert_eq!(consumer.evaluate_module(PATH)["display"], "7");
    }

    #[test]
    fn effect_extensions_do_not_cross_compiler_sessions() {
        const PATH: &str = "effect-extension-isolation.blot";
        let mut producer = CompilerSession::default();
        producer
            .add_source(
                PATH.to_owned(),
                source(
                    "const Fault = @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}const Extended = @type.attach Fault \"origin\" \"producer\"\n\u{e000}return @text.len (@shape.get (@type.members Extended) \"origin\")\u{e000}\n",
                ),
            )
            .expect("producer source should load");
        producer
            .configure_module(PATH, BTreeMap::new(), BTreeMap::new())
            .expect("producer source should configure");
        assert_eq!(producer.evaluate_module(PATH)["display"], "8");

        let mut consumer = CompilerSession::default();
        consumer
            .add_source(
                PATH.to_owned(),
                source(
                    "const Fault = @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}let action = fn () => do:\n  result <- Fault.raise ()\n  return result\n\u{e000}return @type.reflect (@type.of action)\u{e000}\n",
                ),
            )
            .expect("consumer source should load");
        consumer
            .configure_module(PATH, BTreeMap::new(), BTreeMap::new())
            .expect("consumer source should configure");

        let evaluated = consumer.evaluate_module(PATH);
        let effect = reflected_arrow_effect(&evaluated);
        assert_eq!(effect["tag"], "effect", "{evaluated}");
        assert!(effect.get("members").is_none(), "{evaluated}");
    }

    #[test]
    fn same_named_effects_do_not_share_extensions_between_modules() {
        let mut session = CompilerSession::default();
        session
            .add_source(
                "effect-extension-producer.blot".to_owned(),
                source(
                    "const Fault = @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}const Extended = @type.attach Fault \"origin\" \"producer\"\n\u{e000}return @text.len (@shape.get (@type.members Extended) \"origin\")\u{e000}\n",
                ),
            )
            .expect("producer source should load");
        session
            .configure_module(
                "effect-extension-producer.blot",
                BTreeMap::new(),
                BTreeMap::new(),
            )
            .expect("producer source should configure");
        assert_eq!(
            session.evaluate_module("effect-extension-producer.blot")["display"],
            "8"
        );

        session
            .add_source(
                "effect-extension-consumer.blot".to_owned(),
                source(
                    "const Fault = @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}let action = fn () => do:\n  result <- Fault.raise ()\n  return result\n\u{e000}return @type.reflect (@type.of action)\u{e000}\n",
                ),
            )
            .expect("consumer source should load");
        session
            .configure_module(
                "effect-extension-consumer.blot",
                BTreeMap::new(),
                BTreeMap::new(),
            )
            .expect("consumer source should configure");

        let evaluated = session.evaluate_module("effect-extension-consumer.blot");
        let effect = reflected_arrow_effect(&evaluated);
        assert_eq!(effect["tag"], "effect", "{evaluated}");
        assert!(effect.get("members").is_none(), "{evaluated}");
    }

    #[test]
    fn removing_an_importer_reclaims_its_nested_effect_instance() {
        const LIBRARY_PATH: &str = "effect-overlay-library.blot";
        const ATTACHMENT_PATH: &str = "effect-overlay-attachment.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(
                LIBRARY_PATH.to_owned(),
                source(
                    "const Fault = @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}let action = fn () => do:\n  result <- Fault.raise ()\n  return result\n\u{e000}return { .Fault = Fault; .action = action; }\u{e000}\n",
                ),
            )
            .expect("effect library source should load");
        session
            .configure_module(LIBRARY_PATH, BTreeMap::new(), BTreeMap::new())
            .expect("effect library should configure");
        assert_eq!(session.evaluate_module(LIBRARY_PATH)["ok"], true);

        session
            .add_source(
                ATTACHMENT_PATH.to_owned(),
                source(
                    "const library = import \"library\"\n\u{e000}const Alias = library.Fault\n\u{e000}const Extended = @type.attach Alias \"origin\" \"attachment\"\n\u{e000}return @shape.get (@type.members Extended) \"origin\"\u{e000}\n",
                ),
            )
            .expect("effect attachment source should load");
        session
            .configure_module(
                ATTACHMENT_PATH,
                BTreeMap::from([("library".to_owned(), LIBRARY_PATH.to_owned())]),
                BTreeMap::new(),
            )
            .expect("effect attachment should configure");
        assert_eq!(
            session.evaluate_module(ATTACHMENT_PATH)["display"],
            "\"attachment\""
        );

        assert!(session.remove_module(ATTACHMENT_PATH));
        assert!(session.context.effect_value("effect:2:Fault").is_none());
        let effect = session
            .context
            .effect_value("effect:1:Fault")
            .expect("the library's independent effect instance should remain registered");
        let Value::Effect {
            name, operations, ..
        } = effect
        else {
            panic!("the library effect should retain its declaration")
        };
        assert_eq!(name, "Fault");
        assert!(operations.get("raise").is_some());
    }

    #[test]
    fn distinct_written_calls_with_same_displayed_argument_mint_distinct_effects() {
        const PATH: &str = "effect-call-provenance.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(
                PATH.to_owned(),
                source(
                    "const make = fn argument => @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}const first = make (fn () => 1)\n\u{e000}const second = make (fn () => 2)\n\u{e000}return @type.equal first second\n",
                ),
            )
            .expect("effect factory source should load");
        session
            .configure_module(PATH, BTreeMap::new(), BTreeMap::new())
            .expect("effect factory source should configure");

        assert_eq!(session.evaluate_module(PATH)["display"], "#False");
    }

    #[test]
    fn aliases_preserve_one_generated_effect_identity() {
        const PATH: &str = "effect-alias-provenance.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(
                PATH.to_owned(),
                source(
                    "const make = fn argument => @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}const generated = make (fn () => 1)\n\u{e000}const alias = generated\n\u{e000}return @type.equal generated alias\n",
                ),
            )
            .expect("effect alias source should load");
        session
            .configure_module(PATH, BTreeMap::new(), BTreeMap::new())
            .expect("effect alias source should configure");

        assert_eq!(session.evaluate_module(PATH)["display"], "#True");
    }

    #[test]
    fn administrative_reevaluation_recovers_the_same_effect_identity() {
        const PATH: &str = "effect-reevaluation-provenance.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(
                PATH.to_owned(),
                source(
                    "const make = fn argument => @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}return make 1\n",
                ),
            )
            .expect("effect source should load");
        session
            .configure_module(PATH, BTreeMap::new(), BTreeMap::new())
            .expect("effect source should configure");

        let first = session.evaluate_module(PATH);
        let second = session.evaluate_module(PATH);
        assert_eq!(first["value"]["id"], second["value"]["id"]);
    }

    #[test]
    fn parameterized_import_occurrences_mint_distinct_effects() {
        const LIBRARY_PATH: &str = "parameterized-effect-library.blot";
        const IMPORTER_PATH: &str = "parameterized-effect-importer.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(
                LIBRARY_PATH.to_owned(),
                source(
                    "module with argument\nconst Fault = @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}return Fault\n",
                ),
            )
            .expect("parameterized effect library should load");
        session
            .configure_module(LIBRARY_PATH, BTreeMap::new(), BTreeMap::new())
            .expect("parameterized effect library should configure");
        session
            .add_source(
                IMPORTER_PATH.to_owned(),
                source(
                    "const first = import \"library\" with (fn () => 1)\n\u{e000}const second = import \"library\" with (fn () => 2)\n\u{e000}return @type.equal first second\n",
                ),
            )
            .expect("parameterized effect importer should load");
        session
            .configure_module(
                IMPORTER_PATH,
                BTreeMap::from([("library".to_owned(), LIBRARY_PATH.to_owned())]),
                BTreeMap::new(),
            )
            .expect("parameterized effect importer should configure");

        assert_eq!(session.evaluate_module(IMPORTER_PATH)["display"], "#False");
    }

    #[test]
    fn dependency_value_changes_renew_effect_call_provenance() {
        const DEPENDENCY_PATH: &str = "effect-provenance-dependency.blot";
        const IMPORTER_PATH: &str = "effect-provenance-importer.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(DEPENDENCY_PATH.to_owned(), source("return 1\n"))
            .expect("effect dependency should load");
        session
            .configure_module(DEPENDENCY_PATH, BTreeMap::new(), BTreeMap::new())
            .expect("effect dependency should configure");
        session
            .add_source(
                IMPORTER_PATH.to_owned(),
                source(
                    "const dependency = import \"dependency\"\n\u{e000}const make = fn argument => @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}return make dependency\n",
                ),
            )
            .expect("effect importer should load");
        session
            .configure_module(
                IMPORTER_PATH,
                BTreeMap::from([("dependency".to_owned(), DEPENDENCY_PATH.to_owned())]),
                BTreeMap::new(),
            )
            .expect("effect importer should configure");
        let first = session.evaluate_module(IMPORTER_PATH);

        session
            .add_source(DEPENDENCY_PATH.to_owned(), source("return 2\n"))
            .expect("changed effect dependency should load");
        let second = session.evaluate_module(IMPORTER_PATH);

        assert_ne!(first["value"]["id"], second["value"]["id"]);
    }

    #[test]
    fn changing_only_an_effect_signature_mints_a_new_identity() {
        const PATH: &str = "effect-signature-revision.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(
                PATH.to_owned(),
                source(
                    "const Fault = @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}return Fault\n",
                ),
            )
            .expect("first effect signature should load");
        session
            .configure_module(PATH, BTreeMap::new(), BTreeMap::new())
            .expect("first effect signature should configure");
        let first = session.evaluate_module(PATH);

        session
            .add_source(
                PATH.to_owned(),
                source(
                    "const Fault = @effect { .stop = @type.unit -> @type.unit; }\n\u{e000}return Fault\n",
                ),
            )
            .expect("changed effect signature should load");
        let second = session.evaluate_module(PATH);

        assert_ne!(first["value"]["id"], second["value"]["id"]);
        assert_eq!(second["value"]["operations"][0][0], "stop");
    }

    #[test]
    fn suffix_edits_do_not_retain_an_effect_from_the_previous_revision() {
        const PATH: &str = "effect-prefix-revision.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(
                PATH.to_owned(),
                source(
                    "const Fault = @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}const marker = 1\n\u{e000}return Fault\n",
                ),
            )
            .expect("first effect revision should load");
        session
            .configure_module(PATH, BTreeMap::new(), BTreeMap::new())
            .expect("first effect revision should configure");
        let first = session.evaluate_module(PATH);

        session
            .add_source(
                PATH.to_owned(),
                source(
                    "const Fault = @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}const marker = 2\n\u{e000}return Fault\n",
                ),
            )
            .expect("suffix edit should load");
        let second = session.evaluate_module(PATH);

        assert_ne!(first["value"]["id"], second["value"]["id"]);
    }

    #[test]
    fn residual_type_attachment_registers_with_the_session_context() {
        const PATH: &str = "effect-extension-residual.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(
                PATH.to_owned(),
                source(
                    "const Fault = @effect { .raise = @type.unit -> @type.unit; }\n\u{e000}let attach :: @type.int -> @type.int\n\u{e000}let attach = fn value => @shape.get (@type.members (@type.attach Fault \"origin\" value)) \"origin\"\n\u{e000}return attach\u{e000}\n",
                ),
            )
            .expect("residual attachment source should load");
        session
            .configure_module(PATH, BTreeMap::new(), BTreeMap::new())
            .expect("residual attachment source should configure");

        let prepared = session.prepare_runtime_hir(PATH);
        assert_eq!(prepared["ok"], true, "{prepared}");
        assert!(matches!(
            session.context.effect_value("effect:1:Fault"),
            Some(Value::Extended { .. })
        ));
    }

    #[test]
    fn module_snapshot_replays_an_ineligible_private_environment() {
        const MODULE_PATH: &str = "snapshot:private-effect";
        let bytes = snapshot_from_source(
            MODULE_PATH,
            "const Hidden = @effect { .read = @type.unit -> @type.int; }\nreturn 42\n",
        );
        let snapshot: ModuleSnapshot =
            rmp_serde::from_slice(&bytes).expect("module snapshot should decode");
        assert!(snapshot.comptime_environment.is_none());

        let mut consumer = CompilerSession::default();
        consumer
            .install_trusted_module_snapshot(MODULE_PATH, &bytes)
            .expect("module snapshot should install");
        assert_eq!(consumer.evaluate_module(MODULE_PATH)["display"], "42");
    }

    #[test]
    fn removed_module_reclaims_private_revision_state() {
        const PATH: &str = "removed:module";
        let mut session = CompilerSession::default();
        session
            .add_source(
                PATH.to_owned(),
                source("let value = 1\n\u{e000}return value\u{e000}"),
            )
            .expect("module source should load");
        session
            .configure_module(PATH, BTreeMap::new(), BTreeMap::new())
            .expect("module should configure");
        assert_eq!(session.analyze_module(PATH)["ok"], true);
        assert!(session.module_interfaces.borrow().contains_key(PATH));

        assert!(session.remove_module(PATH));
        assert!(!session.context.modules.borrow().contains_key(PATH));
        assert!(!session.module_interfaces.borrow().contains_key(PATH));
        assert!(!session.module_analyses.borrow().contains_key(PATH));
        assert!(!session.published_boundaries.borrow().contains_key(PATH));
        assert!(!session.remove_module(PATH));

        session
            .add_source(PATH.to_owned(), source("return 2\u{e000}"))
            .expect("replacement source should load");
        session
            .configure_module(PATH, BTreeMap::new(), BTreeMap::new())
            .expect("replacement should configure");
        assert_eq!(session.evaluate_module(PATH)["display"], "2");
    }

    #[test]
    fn removing_a_dependency_invalidates_its_importers() {
        const DEPENDENCY_PATH: &str = "removed:dependency";
        const IMPORTER_PATH: &str = "removed:importer";
        let mut session = CompilerSession::default();
        session
            .add_source(DEPENDENCY_PATH.to_owned(), source("return 1\n"))
            .expect("dependency source should load");
        session
            .configure_module(DEPENDENCY_PATH, BTreeMap::new(), BTreeMap::new())
            .expect("dependency source should configure");
        session
            .add_source(
                IMPORTER_PATH.to_owned(),
                source("const dependency = import \"dependency\"\nreturn dependency\n"),
            )
            .expect("importer source should load");
        session
            .configure_module(
                IMPORTER_PATH,
                BTreeMap::from([("dependency".to_owned(), DEPENDENCY_PATH.to_owned())]),
                BTreeMap::new(),
            )
            .expect("importer source should configure");
        assert_eq!(session.evaluate_module(IMPORTER_PATH)["display"], "1");
        assert_eq!(session.prepare_runtime_hir(IMPORTER_PATH)["ok"], true);
        assert!(session.closed_programs.borrow().contains_key(IMPORTER_PATH));

        assert!(session.remove_module(DEPENDENCY_PATH));

        assert!(session.dirty_modules.borrow().contains(IMPORTER_PATH));
        assert!(!session.closed_programs.borrow().contains_key(IMPORTER_PATH));
        assert_eq!(session.evaluate_module(IMPORTER_PATH)["ok"], false);
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
        assert_eq!(analysis["work"]["schema"], 3);
        assert!(
            analysis["work"]["solverWorklistPeak"]
                .as_u64()
                .unwrap_or_default()
                > 0
        );
        assert!(analysis["work"]["typeNodes"].as_u64().unwrap_or_default() > 0);
        assert!(analysis["work"]["constraints"].as_u64().unwrap_or_default() > 0);
        assert!(
            analysis["work"]["boundaryMaterializations"]
                .as_u64()
                .unwrap_or_default()
                > 0
        );

        let unchanged = session.analyze_module("main.blot");
        assert_eq!(unchanged["work"], serde_json::Value::Null);
    }

    #[test]
    fn open_materializes_only_referenced_fields() {
        let mut session = CompilerSession::default();
        session
            .add_source(
                "main.blot".to_owned(),
                source(
                    "open { .used = 1; .unused = fn value => value; }\n\
                     return used\n",
                ),
            )
            .expect("source should load");
        session
            .configure_module("main.blot", BTreeMap::new(), BTreeMap::new())
            .expect("source should configure");

        let analysis = session.analyze_module("main.blot");
        assert_eq!(analysis["ok"], true, "{analysis}");
        assert_eq!(analysis["work"]["interfaceFieldsDemanded"], 1);
    }

    #[test]
    fn analysis_reports_compiler_authoritative_specializations() {
        let mut session = CompilerSession::default();
        session
            .add_source(
                "main.blot".to_owned(),
                source(
                    "const apply = fn function => function 1\n\
                     let first = apply (fn value => value)\n\
                     let second = apply (fn value => { .value = value; })\n\
                     return (first, second)\n",
                ),
            )
            .expect("specialization source should load");
        session
            .configure_module("main.blot", BTreeMap::new(), BTreeMap::new())
            .expect("specialization source should configure");

        let analysis = session.analyze_module("main.blot");

        assert_eq!(analysis["ok"], true, "{analysis}");
        assert_eq!(analysis["specializations"][0]["binding"]["name"], "apply");
        assert_eq!(analysis["specializations"][0]["specializationCount"], 2);
        assert_eq!(
            analysis["specializations"][0]["keys"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn specialization_bomb_stops_at_the_deterministic_hard_limit() {
        let mut source_text = String::from("const apply = fn function => function 1\n");
        for index in 0..257 {
            source_text.push_str(&format!(
                "let value_{index} = apply (fn value => {{ .field_{index} = value; }})\n"
            ));
        }
        source_text.push_str("return value_0\n");
        let mut session = CompilerSession::default();
        session
            .add_source("main.blot".to_owned(), source(&source_text))
            .expect("specialization bomb should load");
        session
            .configure_module("main.blot", BTreeMap::new(), BTreeMap::new())
            .expect("specialization bomb should configure");

        let checked = session.check_module("main.blot");

        assert_eq!(checked["ok"], false, "{checked}");
        assert_eq!(checked["diagnostic"]["code"], "BLOT_SPECIALIZATION_LIMIT");
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
    fn declaration_prefix_reuse_drops_revision_bound_closures() {
        const PATH: &str = "prefix-closure.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(
                PATH.to_owned(),
                source(
                    "const wrapper = fn callback => callback ()\n\u{e000}const answer = 42\n\u{e000}return answer\u{e000}\n",
                ),
            )
            .expect("initial source should load");
        session
            .configure_module(PATH, BTreeMap::new(), BTreeMap::new())
            .expect("initial source should configure");
        assert_eq!(session.check_module(PATH)["ok"], true);
        assert_eq!(session.context.evaluated_bindings.borrow()[PATH].len(), 2);

        session
            .add_source(
                PATH.to_owned(),
                source(
                    "const wrapper = fn callback => callback ()\n\u{e000}const answer = 42\n\u{e000}let unused = answer\n\u{e000}return answer\u{e000}\n",
                ),
            )
            .expect("appended declaration should load");
        let retained = session.context.evaluated_bindings.borrow();
        assert_eq!(retained[PATH].len(), 1);
        assert!(matches!(
            retained[PATH].values().next(),
            Some(Value::Int(_))
        ));
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
    fn captured_closure_change_invalidates_importers() {
        let dependency_path = "dependency.blot";
        let root_path = "main.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(
                dependency_path.to_owned(),
                source(
                    "const captured :: @type.int\n\u{e000}const captured = 1\n\u{e000}const read :: @type.unit -> @type.int\n\u{e000}const read = fn () => captured\n\u{e000}return read\u{e000}\n",
                ),
            )
            .expect("dependency source should load");
        session
            .configure_module(dependency_path, BTreeMap::new(), BTreeMap::new())
            .expect("dependency source should configure");
        session
            .add_source(
                root_path.to_owned(),
                source("const read = import \"dep\"\n\u{e000}return read ()\u{e000}\n"),
            )
            .expect("root source should load");
        session
            .configure_module(
                root_path,
                BTreeMap::from([("dep".to_owned(), dependency_path.to_owned())]),
                BTreeMap::new(),
            )
            .expect("root source should configure");
        assert_eq!(session.evaluate_module(root_path)["display"], "1");
        assert_eq!(session.prepare_runtime_hir(root_path)["ok"], true);

        session
            .add_source(
                dependency_path.to_owned(),
                source(
                    "const captured :: @type.int\n\u{e000}const captured = 2\n\u{e000}const read :: @type.unit -> @type.int\n\u{e000}const read = fn () => captured\n\u{e000}return read\u{e000}\n",
                ),
            )
            .expect("changed dependency should load");
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
        assert_eq!(session.evaluate_module(root_path)["display"], "2");
    }

    #[test]
    fn parameterized_module_change_invalidates_importers_without_a_cached_result() {
        let dependency_path = "dependency.blot";
        let root_path = "main.blot";
        let mut session = CompilerSession::default();
        session
            .add_source(
                dependency_path.to_owned(),
                source("module with input\n\u{e000}return @int.add input 1\u{e000}\n"),
            )
            .expect("dependency source should load");
        session
            .configure_module(dependency_path, BTreeMap::new(), BTreeMap::new())
            .expect("dependency source should configure");
        session
            .add_source(
                root_path.to_owned(),
                source("return import \"dep\" with 40\u{e000}\n"),
            )
            .expect("root source should load");
        session
            .configure_module(
                root_path,
                BTreeMap::from([("dep".to_owned(), dependency_path.to_owned())]),
                BTreeMap::new(),
            )
            .expect("root source should configure");
        assert_eq!(session.evaluate_module(root_path)["display"], "41");
        assert_eq!(session.prepare_runtime_hir(root_path)["ok"], true);

        session
            .add_source(
                dependency_path.to_owned(),
                source("module with input\n\u{e000}return @int.add input 2\u{e000}\n"),
            )
            .expect("changed dependency should load");
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
        assert_eq!(session.evaluate_module(root_path)["display"], "42");
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
        let dependency_boundary_id = session.published_boundaries.borrow()[dependency_path].id;

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
        assert_eq!(
            session.published_boundaries.borrow()[dependency_path].id,
            dependency_boundary_id,
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
                    "const replacement :: @type.int\n\u{e000}const replacement = 2\n\u{e000}const set_x = fn record => @shape.update record { .x = replacement; }\n\u{e000}return (set_x { .x = 1; .y = \"kept\"; }).y\u{e000}",
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
    fn affine_refinement_budget_refuses_an_unbounded_proof_graph() {
        let mut source_text = String::new();
        for index in 0..513 {
            source_text.push_str(&format!("let value_{index} = {index}\n"));
        }
        source_text.push_str("return @array.get [1] 0\n");
        let mut session = CompilerSession::default();
        session
            .add_source("main.blot".to_owned(), source(&source_text))
            .expect("budget source should load");
        session
            .configure_module("main.blot", BTreeMap::new(), BTreeMap::new())
            .expect("budget source should configure");

        let checked = session.check_module("main.blot");

        assert_eq!(checked["ok"], false, "{checked}");
        assert_eq!(checked["diagnostic"]["code"], "BLOT_REFINEMENT_BUDGET");
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

    fn reflected_arrow_effect(evaluated: &serde_json::Value) -> &serde_json::Value {
        let fields = evaluated["value"]["payload"]["fields"]
            .as_array()
            .expect("reflected arrow should contain fields");
        let effects = fields
            .iter()
            .find(|field| field[0] == "effects")
            .expect("reflected arrow should contain effects");
        &effects[1]["elements"][0]
    }

    fn assert_snapshot_fault(effect: &serde_json::Value) {
        assert_eq!(effect["tag"], "extended", "{effect}");
        assert_fault_effect(&effect["inner"]);
        assert!(
            effect["members"]
                .as_array()
                .is_some_and(|members| members.iter().any(|member| {
                    member[0] == "origin"
                        && member[1]["tag"] == "text"
                        && member[1]["value"] == "snapshot"
                })),
            "{effect}"
        );
    }

    fn assert_fault_effect(effect: &serde_json::Value) {
        assert_eq!(effect["tag"], "effect", "{effect}");
        assert_eq!(effect["name"], "Fault", "{effect}");
        assert!(
            effect["operations"]
                .as_array()
                .is_some_and(|operations| operations
                    .iter()
                    .any(|operation| operation[0] == "raise")),
            "{effect}"
        );
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
