use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::rc::Rc;

use crate::ast::{
    Declaration, DeclarationId, DeclarationKind, Expression, ExpressionId, Module, Pattern,
    PatternId, ShapeMember, Span,
};
use crate::diagnostic::Diagnostic;
use crate::primitives::{constant, primitive_arity, run_primitive};
use crate::value::{
    ClosureAlternative, Domain as ValueDomain, EffectOperationOwnership, EffectOwnership,
    Environment, OpenedValues, OrderedFields, Resume, RuntimeMeaning, RuntimeValue, Value,
    as_tuple, attach_signature, child_env, equal, lookup, lookup_signature, opened_members, show,
    tuple,
};
use crate::value_capsule::ValueCapsule;

pub(crate) type RuntimeTypeResolver = Rc<dyn Fn(ExpressionId) -> Option<Value>>;

#[derive(Clone)]
struct SignatureHoles {
    module: Rc<String>,
    expressions: HashMap<ExpressionId, u32>,
}

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
    revision: ModuleRevision,
}

impl LoadedModule {
    pub(crate) fn new(
        path: &str,
        module: Rc<Module>,
        imports: BTreeMap<String, String>,
        includes: BTreeMap<String, IncludedFile>,
    ) -> Self {
        Self {
            module,
            imports,
            includes,
            revision: ModuleRevision::new(path),
        }
    }

    pub(crate) fn renew_revision(&mut self, path: &str) {
        self.revision = ModuleRevision::new(path);
    }

    pub(crate) fn revision(&self) -> ModuleRevision {
        self.revision.clone()
    }
}

#[derive(Clone)]
pub(crate) struct ModuleRevision {
    module: String,
    identity: Rc<()>,
}

impl ModuleRevision {
    fn new(module: &str) -> Self {
        Self {
            module: module.to_owned(),
            identity: Rc::new(()),
        }
    }

    fn references_module(&self, module: &str) -> bool {
        self.module == module
    }
}

impl PartialEq for ModuleRevision {
    fn eq(&self, other: &Self) -> bool {
        self.module == other.module && Rc::ptr_eq(&self.identity, &other.identity)
    }
}

impl Eq for ModuleRevision {}

impl Hash for ModuleRevision {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.module.hash(state);
        Rc::as_ptr(&self.identity).hash(state);
    }
}

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
pub(crate) enum RecognitionProbe {
    Integer { left: i8, right: i8 },
    Boolean { left: bool, right: bool },
    BooleanUnary { argument: bool },
}

#[derive(Clone, Eq, Hash, PartialEq)]
pub(crate) enum CompilerApplication {
    ForceEffectDeclaration,
    ForallBody,
    IncludeParser,
    HandleThunk,
    HandleReturn,
    HandleOperation {
        operation: String,
        request: Box<ApplicationSite>,
    },
    RequirementPredicate,
    RecognitionArgument {
        probe: RecognitionProbe,
        position: u8,
    },
    RuntimeExportParameter(u32),
}

#[derive(Clone, Eq, Hash, PartialEq)]
pub(crate) enum ApplicationRoot {
    Expression {
        revision: ModuleRevision,
        expression: ExpressionId,
    },
    Declaration {
        revision: ModuleRevision,
        declaration: DeclarationId,
    },
}

#[derive(Clone, Eq, Hash, PartialEq)]
pub(crate) struct ApplicationSite {
    pub(crate) root: ApplicationRoot,
    pub(crate) compiler_steps: Vec<CompilerApplication>,
}

#[derive(Clone, Eq, Hash, PartialEq)]
pub struct ClosureApplication {
    pub(crate) application: ApplicationSite,
    pub(crate) creation_scope: Rc<EffectScope>,
}

impl ClosureApplication {
    fn references_module(&self, module: &str) -> bool {
        self.application.references_module(module)
            || self
                .creation_scope
                .iter()
                .any(|frame| frame.references_module(module))
    }
}

pub type EffectScope = Vec<ClosureApplication>;

impl ApplicationSite {
    fn expression(revision: ModuleRevision, expression: ExpressionId) -> Self {
        Self {
            root: ApplicationRoot::Expression {
                revision,
                expression,
            },
            compiler_steps: Vec::new(),
        }
    }

    fn declaration(revision: ModuleRevision, declaration: DeclarationId) -> Self {
        Self {
            root: ApplicationRoot::Declaration {
                revision,
                declaration,
            },
            compiler_steps: Vec::new(),
        }
    }

    pub(crate) fn for_expression(
        context: &Context,
        module: &str,
        expression: ExpressionId,
    ) -> Result<Self, Diagnostic> {
        Ok(Self::expression(
            context.module_revision(module)?,
            expression,
        ))
    }

    pub(crate) fn compiler(mut self, step: CompilerApplication) -> Self {
        self.compiler_steps.push(step);
        self
    }

    fn references_module(&self, module: &str) -> bool {
        let root_references_module = match &self.root {
            ApplicationRoot::Expression { revision, .. }
            | ApplicationRoot::Declaration { revision, .. } => revision.references_module(module),
        };
        root_references_module
            || self.compiler_steps.iter().any(|step| match step {
                CompilerApplication::HandleOperation { request, .. } => {
                    request.references_module(module)
                }
                CompilerApplication::ForceEffectDeclaration
                | CompilerApplication::ForallBody
                | CompilerApplication::IncludeParser
                | CompilerApplication::HandleThunk
                | CompilerApplication::HandleReturn
                | CompilerApplication::RequirementPredicate
                | CompilerApplication::RecognitionArgument { .. }
                | CompilerApplication::RuntimeExportParameter(_) => false,
            })
    }
}

#[derive(Clone, Eq, Hash, PartialEq)]
pub struct ModuleInstanceSite {
    pub(crate) application: ApplicationSite,
    pub(crate) imported: ModuleRevision,
}

pub type ModuleInstanceScope = Vec<ModuleInstanceSite>;

#[derive(Clone, Eq, Hash, PartialEq)]
struct EffectIdentity {
    module: String,
    source: ApplicationSite,
    scope: EffectScope,
    instances: ModuleInstanceScope,
    host: bool,
}

impl EffectIdentity {
    fn references_module(&self, module: &str) -> bool {
        self.module == module
            || self.source.references_module(module)
            || self
                .scope
                .iter()
                .any(|frame| frame.references_module(module))
            || self.instances.iter().any(|instance| {
                instance.application.references_module(module)
                    || instance.imported.references_module(module)
            })
    }
}

type EffectSignatures = Vec<(
    OrderedFields,
    BTreeMap<String, EffectOperationOwnership>,
    u32,
)>;

type LiveDeclarations = Rc<Vec<DeclarationId>>;
type LivenessCache = HashMap<(String, Option<ExpressionId>), LiveDeclarations>;
type EvaluatedBindings = HashMap<String, HashMap<(PatternId, ExpressionId, Phase), Value>>;

#[derive(Clone, Default)]
struct ResidentEffectValue {
    declaration: Option<(String, Value)>,
    attachments: Vec<(String, Value)>,
}

impl ResidentEffectValue {
    fn remove_module(&mut self, path: &str) {
        if self
            .declaration
            .as_ref()
            .is_some_and(|(module, _)| module == path)
        {
            self.declaration = None;
        }
        self.attachments.retain(|(module, _)| module != path);
    }

    fn remove_modules(&mut self, paths: &HashSet<String>) {
        if self
            .declaration
            .as_ref()
            .is_some_and(|(module, _)| paths.contains(module))
        {
            self.declaration = None;
        }
        self.attachments
            .retain(|(module, _)| !paths.contains(module));
    }

    fn value(&self) -> Option<&Value> {
        self.attachments
            .last()
            .map(|(_, value)| value)
            .or_else(|| self.declaration.as_ref().map(|(_, value)| value))
    }

    fn is_empty(&self) -> bool {
        self.declaration.is_none() && self.attachments.is_empty()
    }
}

#[derive(Default)]
pub struct Context {
    pub modules: RefCell<HashMap<String, LoadedModule>>,
    pub module_results: RefCell<HashMap<String, Value>>,
    pub(crate) reusable_module_results: RefCell<HashSet<String>>,
    pub(crate) module_result_templates:
        RefCell<HashMap<String, (ModuleRevision, Rc<ValueCapsule>)>>,
    pub(crate) module_cache: RefCell<Option<(String, Rc<Module>)>>,
    pub(crate) live_declarations: RefCell<LivenessCache>,
    pub(crate) evaluated_bindings: RefCell<EvaluatedBindings>,
    pub(crate) captured_binding_modules: RefCell<HashSet<String>>,
    pub(crate) expression_types: RefCell<HashMap<(String, ExpressionId), Value>>,
    pub(crate) expression_type_resolvers: RefCell<HashMap<String, RuntimeTypeResolver>>,
    pub(crate) closure_signatures: RefCell<HashMap<(String, ExpressionId), Value>>,
    pub(crate) closure_signature_resolvers: RefCell<HashMap<String, RuntimeTypeResolver>>,
    pub(crate) recursive_closures: RefCell<HashSet<(String, ExpressionId)>>,
    pub(crate) ownership_contracts:
        RefCell<HashMap<(String, ExpressionId), crate::ownership::OwnershipContract>>,
    next_effect: Cell<u32>,
    effect_ids: RefCell<HashMap<EffectIdentity, EffectSignatures>>,
    effect_values: RefCell<BTreeMap<u32, ResidentEffectValue>>,
    next_type_variable: Cell<u32>,
}

impl Context {
    pub(crate) fn expression_type(&self, module: &str, expression: ExpressionId) -> Option<Value> {
        let key = (module.to_owned(), expression);
        if let Some(type_) = self.expression_types.borrow().get(&key).cloned() {
            return Some(type_);
        }
        let resolver = self
            .expression_type_resolvers
            .borrow()
            .get(module)
            .cloned()?;
        let type_ = resolver(expression)?;
        self.expression_types
            .borrow_mut()
            .insert(key, type_.clone());
        Some(type_)
    }

    pub(crate) fn closure_signature(&self, module: &str, body: ExpressionId) -> Option<Value> {
        let key = (module.to_owned(), body);
        if let Some(signature) = self.closure_signatures.borrow().get(&key).cloned() {
            return Some(signature);
        }
        let resolver = self
            .closure_signature_resolvers
            .borrow()
            .get(module)
            .cloned()?;
        let signature = resolver(body)?;
        self.closure_signatures
            .borrow_mut()
            .insert(key, signature.clone());
        Some(signature)
    }

    pub(crate) fn snapshot_staging(&self, path: &str) -> Self {
        let replaced = HashSet::from([path.to_owned()]);
        let removed_effects = self.effect_ids_referencing(&replaced);
        Self {
            next_effect: Cell::new(self.next_effect.get()),
            effect_ids: RefCell::new(
                self.effect_ids
                    .borrow()
                    .iter()
                    .filter(|(identity, _)| !identity.references_module(path))
                    .map(|(identity, signatures)| (identity.clone(), signatures.clone()))
                    .collect(),
            ),
            effect_values: RefCell::new(
                self.effect_values
                    .borrow()
                    .iter()
                    .filter_map(|(id, value)| {
                        if removed_effects.contains(id) {
                            return None;
                        }
                        let mut value = value.clone();
                        value.remove_module(path);
                        (!value.is_empty()).then_some((*id, value))
                    })
                    .collect(),
            ),
            next_type_variable: Cell::new(self.next_type_variable.get()),
            ..Self::default()
        }
    }

    pub(crate) fn commit_staged_snapshot(&self, path: &str, staged: &Self) {
        self.next_effect.set(staged.next_effect.get());
        self.next_type_variable.set(staged.next_type_variable.get());
        self.effect_ids
            .borrow_mut()
            .retain(|identity, _| !identity.references_module(path));
        self.effect_ids.borrow_mut().extend(
            staged
                .effect_ids
                .borrow()
                .iter()
                .filter(|(identity, _)| identity.references_module(path))
                .map(|(identity, signatures)| (identity.clone(), signatures.clone())),
        );
        *self.effect_values.borrow_mut() = staged.effect_values.borrow().clone();

        self.live_declarations
            .borrow_mut()
            .retain(|(module, _), _| module != path);
        self.live_declarations
            .borrow_mut()
            .extend(staged.live_declarations.borrow_mut().drain());
        let evaluated_bindings = staged.evaluated_bindings.borrow_mut().remove(path);
        self.evaluated_bindings.borrow_mut().remove(path);
        if let Some(bindings) = evaluated_bindings {
            self.evaluated_bindings
                .borrow_mut()
                .insert(path.to_owned(), bindings);
        }
        self.module_result_templates.borrow_mut().remove(path);
        if let Some(template) = staged.module_result_templates.borrow().get(path).cloned() {
            self.module_result_templates
                .borrow_mut()
                .insert(path.to_owned(), template);
        }

        self.expression_types
            .borrow_mut()
            .retain(|(module, _), _| module != path);
        self.expression_types
            .borrow_mut()
            .extend(staged.expression_types.borrow_mut().drain());
        self.expression_type_resolvers.borrow_mut().remove(path);
        if let Some(resolver) = staged.expression_type_resolvers.borrow().get(path).cloned() {
            self.expression_type_resolvers
                .borrow_mut()
                .insert(path.to_owned(), resolver);
        }
        self.closure_signatures
            .borrow_mut()
            .retain(|(module, _), _| module != path);
        self.closure_signatures
            .borrow_mut()
            .extend(staged.closure_signatures.borrow_mut().drain());
        self.closure_signature_resolvers.borrow_mut().remove(path);
        if let Some(resolver) = staged
            .closure_signature_resolvers
            .borrow()
            .get(path)
            .cloned()
        {
            self.closure_signature_resolvers
                .borrow_mut()
                .insert(path.to_owned(), resolver);
        }
        self.recursive_closures
            .borrow_mut()
            .retain(|(module, _)| module != path);
        self.recursive_closures
            .borrow_mut()
            .extend(staged.recursive_closures.borrow_mut().drain());
        self.ownership_contracts
            .borrow_mut()
            .retain(|(module, _), _| module != path);
        self.ownership_contracts
            .borrow_mut()
            .extend(staged.ownership_contracts.borrow_mut().drain());
        if self
            .module_cache
            .borrow()
            .as_ref()
            .is_some_and(|(module, _)| module == path)
        {
            self.module_cache.borrow_mut().take();
        }
    }

    pub(crate) fn remove_module_state(&self, path: &str) {
        self.modules.borrow_mut().remove(path);
        self.module_results.borrow_mut().remove(path);
        self.reusable_module_results.borrow_mut().remove(path);
        self.module_result_templates.borrow_mut().remove(path);
        self.live_declarations
            .borrow_mut()
            .retain(|(module, _), _| module != path);
        self.evaluated_bindings.borrow_mut().remove(path);
        self.captured_binding_modules.borrow_mut().remove(path);
        self.expression_types
            .borrow_mut()
            .retain(|(module, _), _| module != path);
        self.expression_type_resolvers.borrow_mut().remove(path);
        self.closure_signatures
            .borrow_mut()
            .retain(|(module, _), _| module != path);
        self.closure_signature_resolvers.borrow_mut().remove(path);
        self.recursive_closures
            .borrow_mut()
            .retain(|(module, _)| module != path);
        self.ownership_contracts
            .borrow_mut()
            .retain(|(module, _), _| module != path);
        self.remove_effect_state(&HashSet::from([path.to_owned()]));
        if self
            .module_cache
            .borrow()
            .as_ref()
            .is_some_and(|(module, _)| module == path)
        {
            self.module_cache.borrow_mut().take();
        }
    }

    fn fresh_effect_id(&self) -> u32 {
        let id = self.next_effect.get() + 1;
        self.next_effect.set(id);
        id
    }

    fn module_revision(&self, path: &str) -> Result<ModuleRevision, Diagnostic> {
        self.modules
            .borrow()
            .get(path)
            .map(|loaded| loaded.revision.clone())
            .ok_or_else(|| {
                Diagnostic::new(
                    "BLOT_RUST_INVARIANT",
                    format!("Compiler application provenance refers to unloaded module `{path}`."),
                    Span { start: 0, end: 0 },
                )
            })
    }

    fn effect_id(
        &self,
        runtime: &Runtime,
        source: ApplicationSite,
        signature: &OrderedFields,
        ownership: &BTreeMap<String, EffectOperationOwnership>,
        host: bool,
    ) -> u32 {
        let key = EffectIdentity {
            module: runtime.module.as_ref().clone(),
            source,
            scope: runtime.effect_scope.as_ref().clone(),
            instances: runtime.module_instances.as_ref().clone(),
            host,
        };
        if let Some(signatures) = self.effect_ids.borrow().get(&key)
            && let Some((_, _, id)) =
                signatures
                    .iter()
                    .find(|(candidate_signature, candidate_ownership, _)| {
                        effect_signatures_equal(candidate_signature, signature)
                            && candidate_ownership == ownership
                    })
        {
            return *id;
        }
        let id = self.fresh_effect_id();
        self.effect_ids.borrow_mut().entry(key).or_default().push((
            signature.clone(),
            ownership.clone(),
            id,
        ));
        id
    }

    fn register_effect_declaration(&self, module: &str, value: &Value) {
        if let Some(id) = effect_value_id(value) {
            self.effect_values
                .borrow_mut()
                .entry(id)
                .or_default()
                .declaration = Some((module.to_owned(), value.clone()));
        }
    }

    fn register_effect_attachment(&self, module: &str, value: &Value) {
        if let Some(id) = effect_value_id(value) {
            let mut values = self.effect_values.borrow_mut();
            let resident = values.entry(id).or_default();
            resident.attachments.retain(|(owner, _)| owner != module);
            resident
                .attachments
                .push((module.to_owned(), value.clone()));
        }
    }

    pub(crate) fn effect_value(&self, label: &str) -> Option<Value> {
        let mut parts = label.splitn(3, ':');
        match parts.next()? {
            "host" | "effect" => {}
            _ => return None,
        }
        let id = parts.next()?.parse().ok()?;
        parts.next()?;
        self.effect_values
            .borrow()
            .get(&id)
            .and_then(ResidentEffectValue::value)
            .cloned()
    }

    fn effect_ids_referencing(&self, paths: &HashSet<String>) -> HashSet<u32> {
        self.effect_ids
            .borrow()
            .iter()
            .filter(|(identity, _)| paths.iter().any(|path| identity.references_module(path)))
            .flat_map(|(_, signatures)| signatures.iter().map(|(_, _, id)| *id))
            .collect()
    }

    pub(crate) fn remove_effect_state(&self, paths: &HashSet<String>) {
        let removed = self.effect_ids_referencing(paths);
        self.effect_ids
            .borrow_mut()
            .retain(|identity, _| !paths.iter().any(|path| identity.references_module(path)));
        self.effect_values.borrow_mut().retain(|_, value| {
            value.remove_modules(paths);
            !value.is_empty()
        });
        self.effect_values
            .borrow_mut()
            .retain(|id, _| !removed.contains(id));
    }

    pub(crate) fn type_variable(&self) -> u32 {
        let id = self.next_type_variable.get() + 1;
        self.next_type_variable.set(id);
        id
    }
}

fn effect_signatures_equal(left: &OrderedFields, right: &OrderedFields) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .all(|(name, value)| right.get(name).is_some_and(|other| equal(value, other)))
}

fn normalize_effect_operations(
    operations: &OrderedFields,
    span: Span,
) -> Result<(OrderedFields, BTreeMap<String, EffectOperationOwnership>), Diagnostic> {
    let mut signatures = OrderedFields::default();
    let mut ownership = BTreeMap::new();
    for (name, descriptor) in operations {
        let (signature, operation_ownership) = normalize_effect_operation(name, descriptor, span)?;
        signatures.insert(name.clone(), signature);
        ownership.insert(name.clone(), operation_ownership);
    }
    Ok((signatures, ownership))
}

fn normalize_effect_operation(
    operation: &str,
    descriptor: &Value,
    span: Span,
) -> Result<(Value, EffectOperationOwnership), Diagnostic> {
    if effect_arrow(descriptor).is_some() {
        return Ok((descriptor.clone(), EffectOperationOwnership::unrestricted()));
    }
    let Value::Shape(fields) = descriptor else {
        return Err(effect_ownership_error(
            operation,
            "descriptor",
            format!(
                "expected a function signature or a record with `.signature`, `.input`, and `.result`, found {}",
                show(descriptor)
            ),
            span,
        ));
    };
    let expected_fields = ["signature", "input", "result"];
    if fields.len() != expected_fields.len()
        || expected_fields
            .iter()
            .any(|field| !fields.contains_key(field))
    {
        let found = fields
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join(", ");
        return Err(effect_ownership_error(
            operation,
            "descriptor",
            format!(
                "expected exactly `.signature`, `.input`, and `.result`, found fields [{found}]"
            ),
            span,
        ));
    }
    let signature = fields
        .get("signature")
        .expect("checked effect descriptor signature");
    let Some((domain, codomain)) = effect_arrow(signature) else {
        return Err(effect_ownership_error(
            operation,
            "signature",
            format!("expected a function type, found {}", show(signature)),
            span,
        ));
    };
    let input = parse_effect_ownership(
        fields
            .get("input")
            .expect("checked effect descriptor input"),
        domain,
        operation,
        "input",
        span,
    )?;
    let result = parse_effect_ownership(
        fields
            .get("result")
            .expect("checked effect descriptor result"),
        codomain,
        operation,
        "result",
        span,
    )?;
    Ok((
        signature.clone(),
        EffectOperationOwnership { input, result },
    ))
}

fn effect_arrow(signature: &Value) -> Option<(&Value, &Value)> {
    let Value::Arrow {
        domain, codomain, ..
    } = signature_body(signature)
    else {
        return None;
    };
    Some((domain, codomain))
}

fn parse_effect_ownership(
    summary: &Value,
    signature: &Value,
    operation: &str,
    path: &str,
    span: Span,
) -> Result<EffectOwnership, Diagnostic> {
    if let Value::Tag {
        name,
        payload: None,
    } = summary
    {
        return match name.as_str() {
            "Unrestricted" => Ok(EffectOwnership::Unrestricted),
            "Affine" => Ok(EffectOwnership::Affine),
            "Linear" => Ok(EffectOwnership::Linear),
            _ => Err(effect_ownership_error(
                operation,
                path,
                format!("expected `#Unrestricted`, `#Affine`, or `#Linear`, found `#{name}`"),
                span,
            )),
        };
    }
    let Value::Shape(summary_fields) = summary else {
        return Err(effect_ownership_error(
            operation,
            path,
            format!(
                "expected an ownership mode or structural record, found {}",
                show(summary)
            ),
            span,
        ));
    };
    if let Value::Shape(signature_fields) = signature {
        if summary_fields.len() != signature_fields.len()
            || signature_fields
                .keys()
                .any(|name| !summary_fields.contains_key(name))
        {
            return Err(effect_structure_error(
                operation,
                path,
                signature_fields,
                summary_fields,
                span,
            ));
        }
        let fields = signature_fields
            .iter()
            .map(|(name, signature)| {
                let child_path = format!("{path}.{name}");
                parse_effect_ownership(
                    summary_fields
                        .get(name)
                        .expect("checked effect ownership field"),
                    signature,
                    operation,
                    &child_path,
                    span,
                )
                .map(|ownership| (name.clone(), ownership))
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        return Ok(EffectOwnership::Record(fields));
    }
    if let Some(cases) = effect_variant_cases(signature) {
        if summary_fields.len() != cases.len()
            || cases.keys().any(|name| !summary_fields.contains_key(name))
        {
            let expected = cases.keys().cloned().collect::<Vec<_>>().join(", ");
            let found = summary_fields
                .keys()
                .cloned()
                .collect::<Vec<_>>()
                .join(", ");
            return Err(effect_ownership_error(
                operation,
                path,
                format!("expected variant cases [{expected}], found [{found}]"),
                span,
            ));
        }
        let cases = cases
            .into_iter()
            .map(|(name, signature)| {
                let child_path = format!("{path}.#{name}");
                parse_effect_ownership(
                    summary_fields
                        .get(&name)
                        .expect("checked effect ownership case"),
                    &signature,
                    operation,
                    &child_path,
                    span,
                )
                .map(|ownership| (name, ownership))
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        return Ok(EffectOwnership::Variant(cases));
    }
    Err(effect_ownership_error(
        operation,
        path,
        format!(
            "structural ownership requires a record, tuple, or variant type, found {}",
            show(signature)
        ),
        span,
    ))
}

fn effect_variant_cases(signature: &Value) -> Option<BTreeMap<String, Value>> {
    let Value::Union(members) = signature else {
        return None;
    };
    let mut cases = BTreeMap::new();
    for member in members {
        let Value::Tag { name, payload } = member else {
            return None;
        };
        cases.insert(
            name.clone(),
            payload.as_deref().cloned().unwrap_or(Value::Unit),
        );
    }
    Some(cases)
}

fn effect_structure_error(
    operation: &str,
    path: &str,
    signature: &OrderedFields,
    summary: &OrderedFields,
    span: Span,
) -> Diagnostic {
    let expected = signature.keys().cloned().collect::<Vec<_>>().join(", ");
    let found = summary.keys().cloned().collect::<Vec<_>>().join(", ");
    effect_ownership_error(
        operation,
        path,
        format!("expected fields [{expected}], found [{found}]"),
        span,
    )
}

fn effect_ownership_error(operation: &str, path: &str, evidence: String, span: Span) -> Diagnostic {
    Diagnostic::new(
        "BLOT_EFFECT_OWNERSHIP_CONTRACT",
        format!("Effect operation `.{operation}` has an invalid `{path}` contract: {evidence}."),
        span,
    )
}

fn effect_value_id(value: &Value) -> Option<u32> {
    match value {
        Value::Effect { id, .. } => Some(*id),
        Value::Extended { inner, .. } => effect_value_id(inner),
        _ => None,
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
    signature_holes: Option<Rc<SignatureHoles>>,
    effect_scope: Rc<EffectScope>,
    module_instances: Rc<ModuleInstanceScope>,
    checked_arguments: Rc<RefCell<HashMap<ApplicationSite, Value>>>,
}

struct ArrayProgress {
    elements: Vec<crate::ast::ArrayElement>,
    index: usize,
    array: Value,
    checked_type: Option<Value>,
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
            signature_holes: None,
            effect_scope: Rc::new(Vec::new()),
            module_instances: Rc::new(Vec::new()),
            checked_arguments: Rc::new(RefCell::new(HashMap::new())),
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

    pub(crate) fn signature(mut self, holes: HashMap<ExpressionId, u32>) -> Self {
        self.phase = Phase::Comptime;
        self.signature_holes = Some(Rc::new(SignatureHoles {
            module: self.module.clone(),
            expressions: holes,
        }));
        self
    }

    fn comptime(&self) -> Self {
        Self {
            phase: Phase::Comptime,
            fuel: self.fuel.clone(),
            limit: self.limit,
            module: self.module.clone(),
            residual: self.residual.clone(),
            signature_holes: self.signature_holes.clone(),
            effect_scope: self.effect_scope.clone(),
            module_instances: self.module_instances.clone(),
            checked_arguments: self.checked_arguments.clone(),
        }
    }
}

pub enum Computation {
    Done(Result<Value, Diagnostic>),
    Step(Box<dyn FnOnce() -> Computation>),
    Perform {
        request: Box<Perform>,
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

    fn step(next: impl FnOnce() -> Computation + 'static) -> Self {
        Self::Step(Box::new(next))
    }

    pub fn and_then(self, next: impl FnOnce(Value) -> Computation + 'static) -> Computation {
        match self {
            Computation::Done(Ok(value)) => next(value),
            Computation::Done(Err(error)) => Computation::Done(Err(error)),
            Computation::Step(step) => Computation::step(move || step().and_then(next)),
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
            Computation::Step(step) => Computation::step(move || step().map_result(next)),
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
            Computation::Step(step) => Computation::step(move || step().at(origin)),
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
    pub operation_ownership: EffectOperationOwnership,
    pub span: Span,
    pub host: bool,
    application: ApplicationSite,
}

pub fn run(mut computation: Computation) -> Result<Value, Diagnostic> {
    loop {
        match computation {
            Computation::Done(result) => return result,
            Computation::Step(step) => computation = step(),
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

pub fn evaluate_module(
    context: Rc<Context>,
    path: String,
    argument: Value,
    runtime: Runtime,
) -> Computation {
    evaluate_module_with_capture(context, path, argument, runtime, None)
}

pub fn evaluate_module_environment(
    context: Rc<Context>,
    path: String,
    argument: Value,
    runtime: Runtime,
) -> Result<(Value, Environment), Diagnostic> {
    let captured = Rc::new(RefCell::new(None));
    let value = run(evaluate_module_with_capture(
        context,
        path,
        argument,
        runtime,
        Some(captured.clone()),
    ))?;
    let environment = captured.borrow_mut().take().ok_or_else(|| {
        Diagnostic::new(
            "BLOT_RUST_INVARIANT",
            "Module evaluation completed without its compile-time environment.",
            Span { start: 0, end: 0 },
        )
    })?;
    Ok((value, environment))
}

fn evaluate_module_with_capture(
    context: Rc<Context>,
    path: String,
    argument: Value,
    mut runtime: Runtime,
    capture: Option<Rc<RefCell<Option<Environment>>>>,
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
        DeclarationTail {
            result: loaded.module.result,
            capture,
        },
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

    let signature_hole = runtime
        .signature_holes
        .as_ref()
        .filter(|holes| holes.module == module_path)
        .and_then(|holes| holes.expressions.get(&expression_id))
        .copied();
    if let Some(variable) = signature_hole {
        return Computation::value(Value::TypeVariable(variable));
    }
    let checked_representation = context
        .expression_type(module_path.as_str(), expression_id)
        .map(|type_| substitute_signature(&type_, &environment));
    let representation_trace = runtime.residual.clone();
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
                demands,
            }) => {
                let block = runtime
                    .residual
                    .as_ref()
                    .map(|trace| trace.borrow().current_block());
                let conflicts = demands.borrow().iter().any(|prior| match (*prior, block) {
                    (None, _) | (_, None) => true,
                    (Some(prior), Some(current)) => runtime
                        .residual
                        .as_ref()
                        .is_some_and(|trace| trace.borrow().blocks_share_path(prior, current)),
                });
                if conflicts {
                    return Computation::error(Diagnostic::new(
                        "BLOT_DEFERRED_DEMANDED_TWICE",
                        format!(
                            "Deferred parameter `{name}` was demanded more than once. Force it once into an ordinary `let` binding before reusing the value."
                        ),
                        span,
                    ));
                }
                demands.borrow_mut().push(block);
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
            let application = match ApplicationSite::for_expression(
                &context,
                module_path.as_str(),
                expression_id,
            ) {
                Ok(application) => application,
                Err(error) => return Computation::error(error),
            };
            let expected_result = context
                .expression_type(module_path.as_str(), expression_id)
                .map(|type_| substitute_signature(&type_, &environment));
            let function = *function;
            let argument = *argument;
            let expected_argument = context
                .expression_type(module_path.as_str(), argument)
                .map(|type_| substitute_signature(&type_, &environment));
            if let Some(expected_argument) = &expected_argument {
                runtime
                    .checked_arguments
                    .borrow_mut()
                    .insert(application.clone(), expected_argument.clone());
            }
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
                let deferred = match &function {
                    Value::Closure { deferred, .. } => *deferred,
                    Value::ClosureChoice { alternatives, .. } => {
                        let deferred = alternatives.first().is_some_and(|item| item.deferred());
                        if alternatives.iter().any(|item| item.deferred() != deferred) {
                            return Computation::error(Diagnostic::new(
                                "BLOT_RUST_INVARIANT",
                                "One runtime function choice mixed strict and deferred arrows.",
                                span,
                            ));
                        }
                        deferred
                    }
                    _ => false,
                };
                if deferred {
                    let suspended = Value::Deferred {
                        module: argument_module,
                        expression: argument,
                        environment: argument_environment,
                        demands: Rc::new(RefCell::new(Vec::new())),
                    };
                    return apply_with_expected(
                        argument_context,
                        function,
                        ApplicationCall {
                            argument: suspended,
                            expected_argument: expected_argument.clone(),
                            span,
                            runtime: argument_runtime,
                            expected_result: expected_result.clone(),
                            application: application.clone(),
                        },
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
                    apply_with_expected(
                        argument_context,
                        function,
                        ApplicationCall {
                            argument,
                            expected_argument,
                            span,
                            runtime: argument_runtime,
                            expected_result,
                            application,
                        },
                    )
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
                .closure_signature(module_path.as_str(), *body)
                .map(Box::new);
            Computation::value(Value::Closure {
                module: module_path,
                module_instances: runtime.module_instances.clone(),
                effect_scope: runtime.effect_scope,
                parameter: *parameter,
                body: *body,
                deferred: *deferred,
                environment,
                self_name: None,
                imports: None,
                signature,
                reuse_assertion: None,
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
            Value::Array(elements) => Computation::value(tuple(elements.to_vec())),
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
                array: Value::Array(Vec::new().into()),
                checked_type: checked_representation.clone(),
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
                DeclarationTail {
                    result: *result,
                    capture: None,
                },
            )
        }
        Expression::Rec { .. } => Computation::error(Diagnostic::new(
            "BLOT_MISPLACED_REC",
            "`rec` marks a `let rec` or `const rec` binding.",
            span,
        )),
    };
    computation
        .and_then(move |value| {
            if let (Some(trace), Some(type_)) = (
                representation_trace.as_ref(),
                checked_representation.as_ref(),
            ) {
                trace
                    .borrow_mut()
                    .record_checked_aggregate_representation(&value, type_);
            }
            Computation::value(value)
        })
        .at(origin)
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
        return Computation::value(Value::Array(values.into()));
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
    let loaded = match module(&context, &module_path) {
        Ok(module) => module,
        Err(error) => return Computation::error(error),
    };
    let mut matches = Vec::new();
    let mut fallback = None;
    for arm in arms {
        match &loaded.arena.patterns[arm.pattern.0 as usize] {
            Pattern::Int { value, .. } if fallback.is_none() => {
                matches.push((Value::Int(value.clone()), arm.body));
            }
            Pattern::Pin { name, .. } if fallback.is_none() => match lookup(&environment, name) {
                Some(Value::Int(value)) => matches.push((Value::Int(value), arm.body)),
                _ => {
                    return Computation::error(Diagnostic::new(
                        "BLOT_UNSUPPORTED_LOWERING",
                        "A dynamic pinned integer pattern must name a staged integer.",
                        span,
                    ));
                }
            },
            Pattern::Wildcard { .. } if fallback.is_none() => fallback = Some(arm.body),
            _ => {
                return Computation::error(Diagnostic::new(
                    "BLOT_UNSUPPORTED_LOWERING",
                    "A dynamic integer case requires literal or staged pinned integer arms followed by one wildcard.",
                    span,
                ));
            }
        }
    }
    let Some(fallback) = fallback else {
        return Computation::error(Diagnostic::new(
            "BLOT_UNSUPPORTED_LOWERING",
            "The final dynamic integer arm must be a wildcard.",
            span,
        ));
    };
    let Some(trace) = runtime.residual.clone() else {
        return Computation::error(Diagnostic::new(
            "BLOT_RUST_INVARIANT",
            "A runtime integer exists without a residual trace.",
            span,
        ));
    };
    let switch = match trace.borrow_mut().begin_switch(
        &target,
        matches
            .iter()
            .map(|(value, _)| {
                let Value::Int(value) = value else {
                    unreachable!("dynamic integer matches contain integers")
                };
                crate::hir::WireConstant::SignedInteger64(value.to_string())
            })
            .collect(),
        span,
    ) {
        Ok(switch) => Rc::new(switch),
        Err(error) => return Computation::error(error),
    };
    evaluate_integer_switch_arm(
        context,
        module_path,
        environment,
        runtime,
        Rc::new(matches),
        fallback,
        0,
        switch,
        Vec::new(),
        span,
    )
}

#[allow(clippy::too_many_arguments)]
fn evaluate_integer_switch_arm(
    context: Rc<Context>,
    module_path: Rc<String>,
    environment: Environment,
    runtime: Runtime,
    matches: Rc<Vec<(Value, ExpressionId)>>,
    fallback: ExpressionId,
    index: usize,
    switch: Rc<crate::hir::ResidualSwitch>,
    outcomes: Vec<(usize, Option<Value>)>,
    span: Span,
) -> Computation {
    let Some(trace) = runtime.residual.clone() else {
        return Computation::error(Diagnostic::new(
            "BLOT_RUST_INVARIANT",
            "A runtime integer exists without a residual trace.",
            span,
        ));
    };
    let (block, body) = match matches.get(index) {
        Some((_, body)) => (switch.arms[index], *body),
        None => (switch.fallback, fallback),
    };
    trace.borrow_mut().select_block(block);
    let next_context = context.clone();
    let join_context = context.clone();
    let next_module = module_path.clone();
    let next_environment = environment.clone();
    let next_runtime = runtime.clone();
    let next_matches = matches.clone();
    let next_switch = switch.clone();
    evaluate_expression(
        context,
        module_path,
        body,
        child_env(Some(environment)),
        runtime,
    )
    .map_result(move |result| {
        let value = match result {
            Ok(value) => Some(value),
            Err(error) if error.code == "BLOT_PANIC" => {
                trace.borrow_mut().trap_current_block(&error.message, span);
                None
            }
            Err(error) => return Computation::error(error),
        };
        let end = trace.borrow().current_block();
        let mut outcomes = outcomes;
        outcomes.push((end, value));
        if index < next_matches.len() {
            return evaluate_integer_switch_arm(
                next_context,
                next_module,
                next_environment,
                next_runtime,
                next_matches,
                fallback,
                index + 1,
                next_switch,
                outcomes,
                span,
            );
        }
        match trace
            .borrow_mut()
            .join_switch(&join_context, (*next_switch).clone(), outcomes, span)
        {
            Ok(value) => Computation::value(value),
            Err(error) => Computation::error(error),
        }
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
    if cases.is_empty() {
        return Computation::error(Diagnostic::new(
            "BLOT_RUST_INVARIANT",
            "A dynamic sum case has no constructors.",
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
            "A dynamic sum case must cover every constructor explicitly.",
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
    let tag = match trace.borrow_mut().sum_tag(&target, span) {
        Ok(tag) => tag,
        Err(error) => return Computation::error(error),
    };
    let switch = match trace.borrow_mut().begin_switch(
        &tag,
        (0..cases.len().saturating_sub(1))
            .map(|case| crate::hir::WireConstant::SignedInteger32(case as i32))
            .collect(),
        span,
    ) {
        Ok(switch) => Rc::new(switch),
        Err(error) => return Computation::error(error),
    };
    evaluate_sum_switch_arm(
        context,
        module_path,
        environment,
        runtime,
        target,
        Rc::new(cases),
        Rc::new(selected),
        0,
        switch,
        Vec::new(),
        span,
    )
}

#[allow(clippy::too_many_arguments)]
fn evaluate_sum_switch_arm(
    context: Rc<Context>,
    module_path: Rc<String>,
    environment: Environment,
    runtime: Runtime,
    target: RuntimeValue,
    cases: Rc<Vec<String>>,
    arms: Rc<Vec<crate::ast::Arm>>,
    index: usize,
    switch: Rc<crate::hir::ResidualSwitch>,
    outcomes: Vec<(usize, Option<Value>)>,
    span: Span,
) -> Computation {
    let loaded = match module(&context, &module_path) {
        Ok(module) => module,
        Err(error) => return Computation::error(error),
    };
    let Some(trace) = runtime.residual.clone() else {
        return Computation::error(Diagnostic::new(
            "BLOT_RUST_INVARIANT",
            "A runtime sum exists without a residual trace.",
            span,
        ));
    };
    let Some(case_name) = cases.get(index).cloned() else {
        return Computation::error(Diagnostic::new(
            "BLOT_RUST_INVARIANT",
            "Dynamic sum dispatch exhausted its checked constructor set.",
            span,
        ));
    };
    let arm = arms[index].clone();
    let block = if index + 1 == cases.len() {
        switch.fallback
    } else {
        switch.arms[index]
    };
    trace.borrow_mut().select_block(block);
    let scope = child_env(Some(environment.clone()));
    let payload = match trace.borrow_mut().sum_payload(&target, index, span) {
        Ok(payload) => payload,
        Err(error) => return Computation::error(error),
    };
    let tagged = compiler_tag_value(case_name, payload);
    if !match_pattern(&loaded, arm.pattern, &tagged, &scope) {
        return Computation::error(Diagnostic::new(
            "BLOT_UNSUPPORTED_LOWERING",
            "A dynamic sum pattern cannot bind its payload.",
            span,
        ));
    }

    let next_context = context.clone();
    let join_context = context.clone();
    let next_module = module_path.clone();
    let next_runtime = runtime.clone();
    let next_target = target.clone();
    let next_cases = cases.clone();
    let next_arms = arms.clone();
    let next_switch = switch.clone();
    evaluate_expression(context, module_path, arm.body, scope, runtime).map_result(move |result| {
        let value = match result {
            Ok(value) => Some(value),
            Err(error) if error.code == "BLOT_PANIC" => {
                trace.borrow_mut().trap_current_block(&error.message, span);
                None
            }
            Err(error) => return Computation::error(error),
        };
        let end = trace.borrow().current_block();
        let mut outcomes = outcomes;
        outcomes.push((end, value));
        if index + 1 < next_cases.len() {
            return evaluate_sum_switch_arm(
                next_context,
                next_module,
                environment,
                next_runtime,
                next_target,
                next_cases,
                next_arms,
                index + 1,
                next_switch,
                outcomes,
                span,
            );
        }
        match trace
            .borrow_mut()
            .join_switch(&join_context, (*next_switch).clone(), outcomes, span)
        {
            Ok(value) => Computation::value(value),
            Err(error) => Computation::error(error),
        }
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
        return Computation::value(progress.array);
    };
    let next_context = context.clone();
    let next_module = module_path.clone();
    let next_environment = environment.clone();
    let next_runtime = runtime.clone();
    evaluate_expression(context, module_path, element.value, environment, runtime).and_then(
        move |value| {
            let array = match (progress.array, element.spread, value) {
                (Value::Array(mut values), false, value) => {
                    values.push(value);
                    Value::Array(values)
                }
                (Value::Array(mut values), true, Value::Array(spread)) => {
                    values.extend(spread);
                    Value::Array(values)
                }
                (array, true, Value::EmptyArray { .. }) => array,
                (mut array, true, Value::Array(spread)) => {
                    let Some(trace) = next_runtime.residual.as_ref() else {
                        return Computation::error(Diagnostic::new(
                            "BLOT_RUST_INVARIANT",
                            "A runtime array accumulator has no residual trace.",
                            progress.span,
                        ));
                    };
                    for value in spread {
                        array = match trace.borrow_mut().append_array_element(
                            &array,
                            &value,
                            progress.checked_type.as_ref(),
                            progress.span,
                        ) {
                            Ok(array) => array,
                            Err(error) => return Computation::error(error),
                        };
                    }
                    array
                }
                (array, spread, value) => {
                    let Some(trace) = next_runtime.residual.as_ref() else {
                        return Computation::error(Diagnostic::new(
                            "BLOT_TYPE",
                            format!("`...` spreads an array, found {}.", show(&value)),
                            progress.span,
                        ));
                    };
                    let lowered = if spread {
                        trace.borrow_mut().append_array_spread(
                            &array,
                            &value,
                            progress.checked_type.as_ref(),
                            progress.span,
                        )
                    } else {
                        trace.borrow_mut().append_array_element(
                            &array,
                            &value,
                            progress.checked_type.as_ref(),
                            progress.span,
                        )
                    };
                    match lowered {
                        Ok(array) => array,
                        Err(error) => return Computation::error(error),
                    }
                }
            };
            evaluate_array(
                next_context,
                next_module,
                next_environment,
                next_runtime,
                ArrayProgress {
                    elements: progress.elements,
                    index: progress.index + 1,
                    array,
                    checked_type: progress.checked_type,
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
    if let ShapeMember::Computed { name, value } = &member {
        let name = *name;
        let value = *value;
        let name_context = context.clone();
        let name_module = module_path.clone();
        let name_environment = environment.clone();
        let name_runtime = runtime.clone();
        return evaluate_expression(context, module_path, name, environment, runtime.comptime())
            .and_then(move |name| {
                let Value::Text(name) = name else {
                    return Computation::error(Diagnostic::new(
                        "BLOT_DYNAMIC_SHAPE_FIELD",
                        "A computed record field name must resolve at compile time to Text.",
                        progress.span,
                    ));
                };
                evaluate_expression(
                    name_context.clone(),
                    name_module.clone(),
                    value,
                    name_environment.clone(),
                    name_runtime.clone(),
                )
                .and_then(move |value| {
                    let mut fields = progress.fields;
                    fields.insert(name, value);
                    evaluate_shape(
                        name_context,
                        name_module,
                        name_environment,
                        name_runtime,
                        ShapeProgress {
                            members: progress.members,
                            index: progress.index + 1,
                            fields,
                            span: progress.span,
                        },
                    )
                })
            });
    }
    let value_id = match member {
        ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => value,
        ShapeMember::Computed { .. } => unreachable!("computed fields return above"),
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
                ShapeMember::Computed { .. } => unreachable!("computed fields return above"),
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

struct DeclarationTail {
    result: ExpressionId,
    capture: Option<Rc<RefCell<Option<Environment>>>>,
}

fn evaluate_declarations(
    context: Rc<Context>,
    module_path: Rc<String>,
    declarations: LiveDeclarations,
    index: usize,
    environment: Environment,
    runtime: Runtime,
    tail: DeclarationTail,
) -> Computation {
    let Some(declaration_id) = declarations.get(index).copied() else {
        if let Some(capture) = tail.capture {
            *capture.borrow_mut() = Some(environment.clone());
        }
        return evaluate_expression(context, module_path, tail.result, environment, runtime);
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
            tail,
        )
    };
    match declaration {
        Declaration::Signature { name, value, .. } => {
            let module = match module(&context, &module_path) {
                Ok(module) => module,
                Err(error) => return Computation::error(error),
            };
            let signature_holes = signature_hole_expressions(&module, value)
                .into_iter()
                .map(|expression| (expression, context.type_variable()))
                .collect();
            let signature_environment = environment.clone();
            evaluate_expression(
                context,
                module_path,
                value,
                environment,
                runtime.signature(signature_holes),
            )
            .and_then(move |signature| {
                signature_environment
                    .signatures
                    .borrow_mut()
                    .insert(name, signature);
                continue_with()
            })
        }
        Declaration::Binding {
            kind,
            pattern,
            value: value_id,
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
            let binding_phase = binding_runtime.phase;
            let effect_context = context.clone();
            let effect_runtime = binding_runtime.clone();
            let representation_runtime = binding_runtime.clone();
            evaluate_binding(
                context,
                module_path,
                pattern,
                value_id,
                environment,
                binding_runtime,
            )
            .and_then(move |value| {
                if kind == DeclarationKind::Effect {
                    force_effect_value(effect_context, value, declaration_id, span, effect_runtime)
                } else {
                    Computation::value(value)
                }
            })
            .and_then(move |mut value| {
                if binding_context
                    .captured_binding_modules
                    .borrow()
                    .contains(binding_module.as_str())
                {
                    binding_context
                        .evaluated_bindings
                        .borrow_mut()
                        .entry(binding_module.as_ref().clone())
                        .or_default()
                        .insert((pattern, value_id, binding_phase), value.clone());
                }
                let module = match module(&binding_context, &binding_module) {
                    Ok(module) => module,
                    Err(error) => return Computation::error(error),
                };
                if let Pattern::Name { name, .. } = &module.arena.patterns[pattern.0 as usize]
                    && let Some(signature) = lookup_signature(&binding_environment, name)
                {
                    attach_signature(&mut value, &signature);
                    if let Some(trace) = &representation_runtime.residual {
                        trace
                            .borrow_mut()
                            .record_checked_aggregate_representation(&value, &signature);
                    }
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
                    let Some(fields) = opened_members(&value) else {
                        return Computation::error(Diagnostic::new(
                            "BLOT_CANNOT_OPEN",
                            format!(
                                "`open` requires a compile-time record or effect, found {}.",
                                show(&value)
                            ),
                            span,
                        ));
                    };
                    open_environment
                        .opens
                        .borrow_mut()
                        .push(OpenedValues::new(fields));
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
        let binding_context = context.clone();
        let binding_module = module_path.clone();
        return evaluate_expression(context, module_path, value, environment, runtime).and_then(
            move |value| {
                let declares_effect = binding_name.is_some()
                    && matches!(&value, Value::Effect { name, .. } if name == "Effect");
                let value = match &binding_name {
                    Some(name) => named_effect(value, name),
                    None => value,
                };
                if declares_effect {
                    binding_context.register_effect_declaration(&binding_module, &value);
                }
                Computation::value(value)
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
            module_instances,
            effect_scope,
            parameter,
            body,
            environment,
            imports,
            signature,
            reuse_assertion,
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
            module_instances,
            effect_scope,
            parameter,
            body,
            deferred,
            environment,
            self_name: Some(self_name),
            imports,
            signature,
            reuse_assertion,
        })
    })
}

fn named_effect(value: Value, name: &str) -> Value {
    let Value::Effect {
        id,
        name: effect_name,
        operations,
        operation_ownership,
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
            operation_ownership,
            host,
        };
    }
    Value::Effect {
        id,
        name: name.to_owned(),
        operations,
        operation_ownership,
        host,
    }
}

pub(crate) fn force_effect_value(
    context: Rc<Context>,
    value: Value,
    declaration: DeclarationId,
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
    let revision = match context.module_revision(runtime.module.as_str()) {
        Ok(revision) => revision,
        Err(error) => return Computation::error(error),
    };
    let application = ApplicationSite::declaration(revision, declaration)
        .compiler(CompilerApplication::ForceEffectDeclaration);
    apply(context, value, Value::Unit, span, runtime, application)
}

fn enter_module_instance(
    mut runtime: Runtime,
    imported: ModuleRevision,
    application: ApplicationSite,
) -> Runtime {
    let site = ModuleInstanceSite {
        application,
        imported,
    };
    Rc::make_mut(&mut runtime.module_instances).push(site);
    runtime
}

pub(crate) fn apply(
    context: Rc<Context>,
    function: Value,
    argument: Value,
    span: Span,
    runtime: Runtime,
    application: ApplicationSite,
) -> Computation {
    apply_with_expected(
        context,
        function,
        ApplicationCall {
            argument,
            expected_argument: None,
            span,
            runtime,
            expected_result: None,
            application,
        },
    )
}

#[derive(Clone)]
struct ApplicationCall {
    argument: Value,
    expected_argument: Option<Value>,
    span: Span,
    runtime: Runtime,
    expected_result: Option<Value>,
    application: ApplicationSite,
}

fn apply_with_expected(
    context: Rc<Context>,
    function: Value,
    call: ApplicationCall,
) -> Computation {
    let ApplicationCall {
        argument,
        expected_argument,
        span,
        runtime,
        expected_result,
        application,
    } = call;
    match function {
        Value::ModuleClosure { module } => {
            let reusable = matches!(argument, Value::Unit)
                && context.reusable_module_results.borrow().contains(&module);
            if reusable && let Some(value) = context.module_results.borrow().get(&module).cloned() {
                return Computation::value(value);
            }
            // A cached module result is a definition-level value. Reusing it
            // across import expressions is valid only when the closed interface
            // proves that no generative identity is observable. Otherwise,
            // re-evaluate under the written occurrence's stable instance stack.
            let imported_revision = match context.module_revision(&module) {
                Ok(revision) => revision,
                Err(error) => return Computation::error(error),
            };
            let module_runtime =
                enter_module_instance(runtime, imported_revision.clone(), application);
            let result_template = context
                .module_result_templates
                .borrow()
                .get(&module)
                .filter(|(revision, _)| revision == &imported_revision)
                .map(|(_, capsule)| capsule.clone());
            if matches!(argument, Value::Unit)
                && let Some(result_template) = result_template
            {
                let loaded = match context.modules.borrow().get(&module).cloned() {
                    Some(loaded) => loaded,
                    None => {
                        return Computation::error(Diagnostic::new(
                            "BLOT_UNRESOLVED_IMPORT",
                            format!("Module `{module}` was not loaded."),
                            span,
                        ));
                    }
                };
                let environment = match result_template.decode(
                    &module,
                    loaded.module.as_ref(),
                    &imported_revision,
                    context.as_ref(),
                    module_runtime.module_instances.as_ref(),
                    &module_runtime.effect_scope,
                ) {
                    Ok(environment) => environment,
                    Err(error) => {
                        return Computation::error(Diagnostic::new(
                            "BLOT_RUST_INVARIANT",
                            format!("module result template for `{module}` failed: {error}"),
                            span,
                        ));
                    }
                };
                return evaluate_expression(
                    context,
                    Rc::new(module),
                    loaded.module.result,
                    environment,
                    module_runtime,
                );
            }
            evaluate_module(context, module, argument, module_runtime)
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
        } => apply_closure_choice(
            context,
            selector,
            alternatives,
            0,
            ApplicationCall {
                argument,
                expected_argument,
                span,
                runtime,
                expected_result,
                application,
            },
        ),
        Value::Closure {
            module: closure_module,
            module_instances,
            effect_scope: creation_scope,
            parameter,
            body,
            deferred: _,
            environment,
            self_name,
            imports: _,
            signature,
            reuse_assertion,
        } => {
            let mut argument = argument;
            let mut environment = environment;
            let mut residual_compilation = None;
            let recursive_signature = self_name
                .as_deref()
                .and_then(|name| lookup_signature(&environment, name));
            let inferred_signature = context.closure_signature(closure_module.as_str(), body);
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
                        reuse: reuse_assertion.is_some(),
                    },
                    &argument,
                    expected_argument.as_ref(),
                    expected_result.as_ref(),
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
            if let Some(Value::Arrow {
                domain, codomain, ..
            }) = signature.as_deref().map(signature_body)
            {
                record_signature_substitutions(&scope, domain, &argument);
                if let Some(expected_result) = &expected_result {
                    record_signature_substitutions(&scope, codomain, expected_result);
                }
            }
            if let Some(name) = self_name {
                scope.names.borrow_mut().insert(
                    name.clone(),
                    Value::Closure {
                        module: closure_module.clone(),
                        module_instances: module_instances.clone(),
                        effect_scope: creation_scope.clone(),
                        parameter,
                        body,
                        deferred: false,
                        environment: scope.parent.borrow().clone().expect("closure environment"),
                        self_name: Some(name),
                        imports: None,
                        signature: signature.clone(),
                        reuse_assertion,
                    },
                );
            }
            let mut argument = match signature.as_deref().map(signature_body) {
                Some(Value::Arrow { domain, .. }) => match adapt_argument(argument, domain, span) {
                    Ok(argument) => argument,
                    Err(error) => return Computation::error(error),
                },
                _ => argument,
            };
            if let Value::DeferredScratch { capacity } = &argument
                && let Some(Value::Arrow { domain, .. }) = signature.as_deref().map(signature_body)
                && let Some(trace) = &runtime.residual
            {
                let expected = substitute_signature(domain, &scope);
                match trace.borrow_mut().primitive(
                    "@scratch.with_capacity",
                    &[(**capacity).clone()],
                    &[],
                    Some(&expected),
                    span,
                ) {
                    Ok(Some(specialized)) => argument = specialized,
                    Ok(None) => {}
                    Err(error) => return Computation::error(error),
                }
            }
            let reuse_scope = if reuse_assertion.is_some() {
                runtime.residual.as_ref().map(|trace| {
                    let scope = trace.borrow().begin_reuse_scope();
                    (trace.clone(), scope)
                })
            } else {
                None
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
            closure_runtime.module_instances = module_instances;
            Rc::make_mut(&mut closure_runtime.effect_scope).push(ClosureApplication {
                application,
                creation_scope,
            });
            Computation::step(move || {
                evaluate_expression(context, closure_module, body, scope, closure_runtime).and_then(
                    move |mut value| {
                        if let Some((trace, scope)) = reuse_scope
                            && let Err(error) = trace.borrow().finish_reuse_scope(
                                scope,
                                reuse_assertion.expect("checked reuse assertion"),
                            )
                        {
                            return Computation::error(error);
                        }
                        if let Some(Value::Arrow { codomain, .. }) =
                            signature.as_deref().map(signature_body)
                        {
                            attach_signature(&mut value, codomain);
                        }
                        if let Some(span) = reuse_assertion
                            && let Value::Closure {
                                reuse_assertion: nested,
                                ..
                            } = &mut value
                            && nested.is_none()
                        {
                            *nested = Some(span);
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
            })
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
                operation_ownership,
                host,
            } = *effect
            else {
                return Computation::error(Diagnostic::new(
                    "BLOT_TYPE",
                    "An operation lost its effect.",
                    span,
                ));
            };
            let declared_result = match operations.get(&name) {
                Some(Value::Arrow { codomain, .. }) => (**codomain).clone(),
                _ => Value::Unbounded,
            };
            let result_type =
                if matches!(declared_result, Value::Unbounded | Value::TypeVariable(_)) {
                    expected_result
                        .filter(|expected| {
                            !matches!(
                                expected,
                                Value::Unbounded | Value::TypeVariable(_) | Value::Forall { .. }
                            )
                        })
                        .unwrap_or(declared_result)
                } else {
                    declared_result
                };
            let operation_ownership = operation_ownership
                .get(&name)
                .cloned()
                .expect("effect operation has an ownership contract");
            let request = Perform {
                effect_id: id,
                effect_name,
                operation: name,
                argument,
                result_type,
                operation_ownership,
                span,
                host,
                application,
            };
            Computation::Perform {
                request: Box::new(request),
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
            let computation = run_special_or_primitive(
                context,
                &name,
                applied,
                span,
                runtime,
                expected_result.as_ref(),
                application,
            );
            match expected_result {
                Some(signature) => computation.and_then(move |mut value| {
                    attach_signature(&mut value, &signature);
                    Computation::value(value)
                }),
                None => computation,
            }
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
    call: ApplicationCall,
) -> Computation {
    let Some(trace) = call.runtime.residual.clone() else {
        return Computation::error(Diagnostic::new(
            "BLOT_RUST_INVARIANT",
            "A function choice exists without a residual trace.",
            call.span,
        ));
    };
    let Some(alternative) = alternatives.get(index).cloned() else {
        return Computation::error(Diagnostic::new(
            "BLOT_RUST_INVARIANT",
            "A function choice dispatched outside its alternative table.",
            call.span,
        ));
    };
    let last = index + 1 == alternatives.len();
    let branches = if last {
        None
    } else {
        let condition = match trace
            .borrow_mut()
            .choice_condition(&selector, index, call.span)
        {
            Ok(condition) => condition,
            Err(error) => return Computation::error(error),
        };
        match trace.borrow_mut().begin_conditional(&condition, call.span) {
            Ok(branches) => Some(branches),
            Err(error) => return Computation::error(error),
        }
    };
    if let Some(branches) = &branches {
        trace.borrow_mut().select_block(branches.consequent);
    }
    let selected = match trace.borrow_mut().choice_function(
        &context,
        &selector,
        index,
        &alternative,
        call.span,
    ) {
        Ok(selected) => selected,
        Err(error) => return Computation::error(error),
    };
    let Some(branches) = branches else {
        return apply_with_expected(context, selected, call);
    };
    let alternate_context = context.clone();
    let join_context = context.clone();
    let alternate_call = call.clone();
    let span = call.span;
    apply_with_expected(context, selected, call).and_then(move |consequent| {
        let consequent_end = trace.borrow().current_block();
        trace.borrow_mut().select_block(branches.alternate);
        let join_trace = trace.clone();
        apply_closure_choice(
            alternate_context,
            selector,
            alternatives,
            index + 1,
            alternate_call,
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
    expected_result: Option<&Value>,
    application: ApplicationSite,
) -> Computation {
    if name == "@effect" || name == "@effect.host" {
        let Some(Value::Shape(operations)) = arguments.first() else {
            return Computation::error(Diagnostic::new(
                "BLOT_TYPE",
                format!("`{name}` takes a shape of operation types."),
                span,
            ));
        };
        let (operations, operation_ownership) = match normalize_effect_operations(operations, span)
        {
            Ok(normalized) => normalized,
            Err(error) => return Computation::error(error),
        };
        let host = name == "@effect.host";
        let value = Value::Effect {
            id: context.effect_id(
                &runtime,
                application,
                &operations,
                &operation_ownership,
                host,
            ),
            name: "Effect".to_owned(),
            operations,
            operation_ownership,
            host,
        };
        context.register_effect_declaration(&runtime.module, &value);
        return Computation::value(value);
    }
    if name == "@forall" {
        let variable = context.type_variable();
        let function = arguments[0].clone();
        let application = application.compiler(CompilerApplication::ForallBody);
        return apply(
            context,
            function,
            Value::TypeVariable(variable),
            span,
            runtime,
            application,
        )
        .and_then(move |body| {
            Computation::value(Value::Forall {
                variable,
                body: Box::new(body),
            })
        });
    }
    if name == "@type.refine" {
        if runtime.phase != Phase::Comptime {
            return Computation::error(Diagnostic::new(
                "BLOT_REFINEMENT_NOT_COMPTIME",
                "`@type.refine` can only construct a type at compile time.",
                span,
            ));
        }
        return match crate::predicate_refinement::refine(
            &context,
            &arguments[0],
            &arguments[1],
            span,
        ) {
            Ok(value) => Computation::value(value),
            Err(error) => Computation::error(error),
        };
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
        let application = application.compiler(CompilerApplication::IncludeParser);
        return apply(
            context,
            arguments[1].clone(),
            source,
            span,
            runtime,
            application,
        );
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
            application,
        );
    }
    if let Some(trace) = &runtime.residual {
        let checked_arguments =
            checked_primitive_arguments(&context, &runtime, &application, arguments.len());
        match trace.borrow_mut().primitive(
            name,
            &arguments,
            &checked_arguments,
            expected_result,
            span,
        ) {
            Ok(Some(value)) => {
                if name == "@type.attach" {
                    context.register_effect_attachment(&runtime.module, &value);
                }
                return Computation::value(value);
            }
            Ok(None) => {}
            Err(error) => return Computation::error(error),
        }
    }
    match run_primitive(name, arguments, span, runtime.phase) {
        Ok(value) => {
            if name == "@type.attach" {
                context.register_effect_attachment(&runtime.module, &value);
            }
            Computation::value(value)
        }
        Err(error) => Computation::error(error),
    }
}

fn checked_primitive_arguments(
    context: &Context,
    runtime: &Runtime,
    application: &ApplicationSite,
    argument_count: usize,
) -> Vec<Option<Value>> {
    if !application.compiler_steps.is_empty() {
        return vec![None; argument_count];
    }
    let ApplicationRoot::Expression {
        revision,
        expression,
    } = &application.root
    else {
        return vec![None; argument_count];
    };
    let loaded = match context.modules.borrow().get(&revision.module).cloned() {
        Some(loaded) => loaded,
        None => return vec![None; argument_count],
    };
    let mut current = *expression;
    let mut types = Vec::new();
    while types.len() < argument_count {
        let Some(Expression::Apply { function, .. }) =
            loaded.module.arena.expressions.get(current.0 as usize)
        else {
            break;
        };
        let site = ApplicationSite::expression(revision.clone(), current);
        types.push(runtime.checked_arguments.borrow().get(&site).cloned());
        current = *function;
    }
    types.reverse();
    if types.len() == argument_count {
        return types;
    }
    vec![None; argument_count]
}

fn handle(
    context: Rc<Context>,
    effect: Value,
    thunk: Value,
    handler: Value,
    span: Span,
    runtime: Runtime,
    application: ApplicationSite,
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
    let thunk_application = application
        .clone()
        .compiler(CompilerApplication::HandleThunk);
    let computation = apply(
        context.clone(),
        thunk,
        Value::Unit,
        span,
        runtime.clone(),
        thunk_application,
    );
    drive(
        context,
        computation,
        id,
        Rc::new(handler),
        span,
        runtime,
        application,
    )
}

fn drive(
    context: Rc<Context>,
    computation: Computation,
    effect_id: u32,
    handler: Rc<OrderedFields>,
    span: Span,
    runtime: Runtime,
    application: ApplicationSite,
) -> Computation {
    match computation {
        Computation::Done(Err(error)) => Computation::Done(Err(error)),
        Computation::Done(Ok(value)) => match handler.get("return").cloned() {
            Some(return_clause) => {
                let return_application = application.compiler(CompilerApplication::HandleReturn);
                apply(
                    context,
                    return_clause,
                    value,
                    span,
                    runtime,
                    return_application,
                )
            }
            None => Computation::value(value),
        },
        Computation::Step(step) => Computation::step(move || {
            drive(
                context,
                step(),
                effect_id,
                handler,
                span,
                runtime,
                application,
            )
        }),
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
                let next_application = application.clone();
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
                            next_application,
                        )
                    }),
                };
            };
            let resume: Resume = Rc::new(RefCell::new(Some(Box::new({
                let next_context = context.clone();
                let next_handler = handler.clone();
                let next_runtime = runtime.clone();
                let next_application = application.clone();
                move |value| {
                    drive(
                        next_context,
                        resume(value),
                        effect_id,
                        next_handler,
                        span,
                        next_runtime,
                        next_application,
                    )
                }
            }))));
            let continuation = Value::Continuation {
                used: Rc::new(RefCell::new(false)),
                resume,
            };
            let operation_application =
                application.compiler(CompilerApplication::HandleOperation {
                    operation: request.operation.clone(),
                    request: Box::new(request.application.clone()),
                });
            apply(
                context,
                operation,
                tuple(vec![request.argument, continuation]),
                request.span,
                runtime,
                operation_application,
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
            operation_ownership,
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
                    operation_ownership,
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
        | Expression::Rec { span, .. } => *span,
    }
}

fn declaration_span(declaration: &Declaration) -> Span {
    match declaration {
        Declaration::Signature { span, .. }
        | Declaration::Binding { span, .. }
        | Declaration::Shadow { span, .. }
        | Declaration::Open { span, .. } => *span,
    }
}

pub(crate) fn signature_hole_expressions(
    module: &Module,
    expression: ExpressionId,
) -> Vec<ExpressionId> {
    fn collect(module: &Module, expression: ExpressionId, holes: &mut Vec<ExpressionId>) {
        match &module.arena.expressions[expression.0 as usize] {
            Expression::Var { name, .. } if name == "_" => holes.push(expression),
            Expression::Apply {
                function, argument, ..
            } => {
                collect(module, *function, holes);
                collect(module, *argument, holes);
            }
            Expression::Field { target, .. } => collect(module, *target, holes),
            Expression::Lambda { body, .. } | Expression::Rec { lambda: body, .. } => {
                collect(module, *body, holes)
            }
            Expression::Array { elements, .. } => {
                for element in elements {
                    collect(module, element.value, holes);
                }
            }
            Expression::Tuple { elements, .. } => {
                for element in elements {
                    collect(module, *element, holes);
                }
            }
            Expression::Shape { members, .. } => {
                for member in members {
                    match member {
                        ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => {
                            collect(module, *value, holes);
                        }
                        ShapeMember::Computed { name, value } => {
                            collect(module, *name, holes);
                            collect(module, *value, holes);
                        }
                    }
                }
            }
            Expression::If {
                branches, fallback, ..
            } => {
                for branch in branches {
                    collect(module, branch.condition, holes);
                    collect(module, branch.consequence, holes);
                }
                if let Some(fallback) = fallback {
                    collect(module, *fallback, holes);
                }
            }
            Expression::Case { target, arms, .. } => {
                collect(module, *target, holes);
                for arm in arms {
                    collect(module, arm.body, holes);
                }
            }
            Expression::Block {
                declarations,
                result,
                ..
            } => {
                for declaration in declarations {
                    let value = match &module.arena.declarations[declaration.0 as usize] {
                        Declaration::Signature { value, .. }
                        | Declaration::Binding { value, .. }
                        | Declaration::Shadow { value, .. }
                        | Declaration::Open { value, .. } => *value,
                    };
                    collect(module, value, holes);
                }
                collect(module, *result, holes);
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

    let mut holes = Vec::new();
    collect(module, expression, &mut holes);
    holes
}

pub(crate) fn live_declarations_for(
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
        Declaration::Signature { value, .. } => {
            (Vec::new(), free_names_expression(module, *value), true)
        }
        Declaration::Binding {
            kind,
            pattern,
            value,
            ..
        } => (
            pattern_names(module, *pattern),
            free_names_expression(module, *value),
            *kind == DeclarationKind::Effect
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
            scope = current.parent.borrow().clone();
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
        Value::ScratchType(element) => {
            Value::ScratchType(Box::new(substitute_signature(element, environment)))
        }
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
            deferred,
            domain,
            codomain,
            effects,
            effect_tail,
        } => Value::Arrow {
            deferred: *deferred,
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
            Value::Range { .. }
            | Value::Arrow { .. }
            | Value::RegionType(_)
            | Value::ScratchType(_)
            | Value::TypeVariable(_) => Some(value.clone()),
            Value::Shape(fields) => Some(Value::Shape(
                fields
                    .iter()
                    .map(|(name, value)| Some((name.clone(), value_signature(value)?)))
                    .collect::<Option<OrderedFields>>()?,
            )),
            Value::Array(elements) => Some(Value::Array(
                vec![value_signature(elements.first()?)?].into(),
            )),
            Value::EmptyArray { element } => Some(Value::Array(vec![(**element).clone()].into())),
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
        Expression::Field { target, .. } | Expression::Rec { lambda: target, .. } => {
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
                match member {
                    ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => {
                        collect_free(module, *value, bound, free);
                    }
                    ShapeMember::Computed { name, value } => {
                        collect_free(module, *name, bound, free);
                        collect_free(module, *value, bound, free);
                    }
                }
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
                    Declaration::Signature { .. } => {}
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

#[cfg(test)]
mod tests {
    use super::*;

    fn effect_id_for_instance(
        context: &Context,
        mut runtime: Runtime,
        effect_revision: ModuleRevision,
    ) -> u32 {
        runtime.module = Rc::new("dependency.blot".to_owned());
        context.effect_id(
            &runtime,
            ApplicationSite::expression(effect_revision, ExpressionId(10)),
            &OrderedFields::default(),
            &BTreeMap::new(),
            false,
        )
    }

    #[test]
    fn import_occurrence_is_part_of_generative_effect_identity() {
        let context = Context::default();
        let base = Runtime::new(Phase::Comptime, "root.blot".to_owned());
        let root_revision = ModuleRevision::new("root.blot");
        let dependency_revision = ModuleRevision::new("dependency.blot");
        let first_site = ApplicationSite::expression(root_revision.clone(), ExpressionId(1));
        let second_site = ApplicationSite::expression(root_revision, ExpressionId(2));

        let first = enter_module_instance(
            base.clone(),
            dependency_revision.clone(),
            first_site.clone(),
        );
        let first_again =
            enter_module_instance(base.clone(), dependency_revision.clone(), first_site);
        let second = enter_module_instance(base, dependency_revision.clone(), second_site);

        let first_id = effect_id_for_instance(&context, first, dependency_revision.clone());
        assert_eq!(
            first_id,
            effect_id_for_instance(&context, first_again, dependency_revision.clone())
        );
        assert_ne!(
            first_id,
            effect_id_for_instance(&context, second, dependency_revision)
        );
    }

    #[test]
    fn effect_signatures_use_exact_alpha_equivalence() {
        let context = Context::default();
        let runtime = Runtime::new(Phase::Comptime, "effect.blot".to_owned());
        let revision = ModuleRevision::new("effect.blot");
        let application = ApplicationSite::expression(revision, ExpressionId(1));
        let signature = |variable| {
            OrderedFields::from([(
                "map".to_owned(),
                Value::Forall {
                    variable,
                    body: Box::new(Value::Arrow {
                        deferred: false,
                        domain: Box::new(Value::TypeVariable(variable)),
                        codomain: Box::new(Value::TypeVariable(variable)),
                        effects: Vec::new(),
                        effect_tail: None,
                    }),
                },
            )])
        };
        let different = OrderedFields::from([(
            "map".to_owned(),
            Value::Arrow {
                deferred: false,
                domain: Box::new(Value::Unit),
                codomain: Box::new(Value::Unit),
                effects: Vec::new(),
                effect_tail: None,
            },
        )]);
        let ownership =
            BTreeMap::from([("map".to_owned(), EffectOperationOwnership::unrestricted())]);

        let first = context.effect_id(
            &runtime,
            application.clone(),
            &signature(1),
            &ownership,
            false,
        );
        let alpha_equivalent = context.effect_id(
            &runtime,
            application.clone(),
            &signature(7),
            &ownership,
            false,
        );
        assert_eq!(first, alpha_equivalent);
        assert_ne!(
            first,
            context.effect_id(&runtime, application.clone(), &different, &ownership, false,)
        );
        let linear_result = BTreeMap::from([(
            "map".to_owned(),
            EffectOperationOwnership {
                input: EffectOwnership::Unrestricted,
                result: EffectOwnership::Linear,
            },
        )]);
        assert_ne!(
            first,
            context.effect_id(&runtime, application, &signature(1), &linear_result, false,)
        );
    }

    #[test]
    fn recursive_applications_at_one_call_site_have_distinct_depths() {
        let context = Context::default();
        let revision = ModuleRevision::new("recursive-effect.blot");
        let call = ApplicationSite::expression(revision.clone(), ExpressionId(1));
        let source = ApplicationSite::expression(revision, ExpressionId(2));
        let frame = ClosureApplication {
            application: call,
            creation_scope: Rc::new(Vec::new()),
        };
        let mut shallow = Runtime::new(Phase::Comptime, "recursive-effect.blot".to_owned());
        Rc::make_mut(&mut shallow.effect_scope).push(frame.clone());
        let mut recursive = shallow.clone();
        Rc::make_mut(&mut recursive.effect_scope).push(frame);

        let shallow_id = context.effect_id(
            &shallow,
            source.clone(),
            &OrderedFields::default(),
            &BTreeMap::new(),
            false,
        );
        assert_eq!(
            shallow_id,
            context.effect_id(
                &shallow,
                source.clone(),
                &OrderedFields::default(),
                &BTreeMap::new(),
                false,
            )
        );
        assert_ne!(
            shallow_id,
            context.effect_id(
                &recursive,
                source,
                &OrderedFields::default(),
                &BTreeMap::new(),
                false,
            )
        );
    }

    #[test]
    fn returned_closures_retain_their_distinct_creation_scopes() {
        let context = Context::default();
        let revision = ModuleRevision::new("returned-effect.blot");
        let creation_scope = |expression| {
            Rc::new(vec![ClosureApplication {
                application: ApplicationSite::expression(revision.clone(), expression),
                creation_scope: Rc::new(Vec::new()),
            }])
        };
        let invocation = ApplicationSite::expression(revision.clone(), ExpressionId(3));
        let runtime_for = |creation_scope| {
            let mut runtime = Runtime::new(Phase::Comptime, "returned-effect.blot".to_owned());
            Rc::make_mut(&mut runtime.effect_scope).push(ClosureApplication {
                application: invocation.clone(),
                creation_scope,
            });
            runtime
        };
        let first = runtime_for(creation_scope(ExpressionId(1)));
        let second = runtime_for(creation_scope(ExpressionId(2)));
        let source = ApplicationSite::expression(revision, ExpressionId(4));

        assert_ne!(
            context.effect_id(
                &first,
                source.clone(),
                &OrderedFields::default(),
                &BTreeMap::new(),
                false,
            ),
            context.effect_id(
                &second,
                source,
                &OrderedFields::default(),
                &BTreeMap::new(),
                false,
            ),
        );
    }

    #[test]
    fn deterministic_nullary_module_uses_its_resident_result() {
        let context = Rc::new(Context::default());
        context
            .module_results
            .borrow_mut()
            .insert("dependency.blot".to_owned(), Value::Int(42.into()));
        context
            .reusable_module_results
            .borrow_mut()
            .insert("dependency.blot".to_owned());

        let result = run(apply(
            context,
            Value::ModuleClosure {
                module: "dependency.blot".to_owned(),
            },
            Value::Unit,
            Span { start: 1, end: 2 },
            Runtime::new(Phase::Comptime, "root.blot".to_owned()),
            ApplicationSite::expression(ModuleRevision::new("root.blot"), ExpressionId(1)),
        ))
        .expect("resident module result should evaluate");

        assert!(matches!(result, Value::Int(value) if value == 42.into()));
    }

    #[test]
    fn parent_instance_keeps_nested_imports_distinct() {
        let context = Context::default();
        let base = Runtime::new(Phase::Comptime, "root.blot".to_owned());
        let root_revision = ModuleRevision::new("root.blot");
        let parent_revision = ModuleRevision::new("parent.blot");
        let dependency_revision = ModuleRevision::new("dependency.blot");
        let nested_site = ApplicationSite::expression(parent_revision.clone(), ExpressionId(7));

        let first_parent = enter_module_instance(
            base.clone(),
            parent_revision.clone(),
            ApplicationSite::expression(root_revision.clone(), ExpressionId(1)),
        );
        let second_parent = enter_module_instance(
            base,
            parent_revision,
            ApplicationSite::expression(root_revision, ExpressionId(2)),
        );
        let first_nested = enter_module_instance(
            first_parent,
            dependency_revision.clone(),
            nested_site.clone(),
        );
        let second_nested =
            enter_module_instance(second_parent, dependency_revision.clone(), nested_site);

        assert_ne!(
            effect_id_for_instance(&context, first_nested, dependency_revision.clone()),
            effect_id_for_instance(&context, second_nested, dependency_revision)
        );
    }
}
