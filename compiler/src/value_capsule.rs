use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

#[cfg(test)]
use std::cell::Cell;

use num_bigint::BigInt;
use serde::{Deserialize, Serialize};

use crate::ast::{
    Declaration, DeclarationId, DeclarationKind, Expression, ExpressionId, Module, Pattern,
    PatternId, Span,
};
use crate::eval::{
    ApplicationRoot, ApplicationSite, ClosureApplication, CompilerApplication, Context,
    EffectScope, ModuleInstanceScope, ModuleInstanceSite, ModuleRevision, RecognitionProbe,
};
use crate::protocol::VALUE_CAPSULE_SCHEMA;
use crate::value::{
    Domain, Environment, OpenedValues, OrderedFields, Value, capture_env, child_env,
    decoded_child_env, decoded_recursive_env, recursive_env,
};

const VALUE_CAPSULE_MAX_DEPTH: usize = 128;
const VALUE_CAPSULE_MAX_ENVIRONMENT_GRAPH_DEPTH: usize = 1_024;
const VALUE_CAPSULE_MAX_NODES: u64 = 1_048_576;
const VALUE_CAPSULE_MAX_ALLOCATION_BYTES: u64 = 64 * 1024 * 1024;
const MODULE_SNAPSHOT_MAX_BYTES: usize = 32 * 1024 * 1024;
const CAPSULE_COLLECTION_ENTRY_BYTES: u64 = 64;

#[derive(Clone, Copy)]
struct CapsuleLimits {
    depth: usize,
    nodes: u64,
    allocation_bytes: u64,
    serialized_bytes: usize,
}

const VALUE_CAPSULE_LIMITS: CapsuleLimits = CapsuleLimits {
    depth: VALUE_CAPSULE_MAX_DEPTH,
    nodes: VALUE_CAPSULE_MAX_NODES,
    allocation_bytes: VALUE_CAPSULE_MAX_ALLOCATION_BYTES,
    serialized_bytes: MODULE_SNAPSHOT_MAX_BYTES,
};

#[derive(Debug, Default)]
struct CapsuleBudget {
    nodes: u64,
    allocation_bytes: u64,
    maximum_depth: usize,
    module_instance_prefix_copies: u64,
    effect_scope_prefix_copies: u64,
}

#[cfg(test)]
thread_local! {
    static STRUCTURAL_BUDGET_SCAN_COUNT: Cell<usize> = const { Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn take_structural_budget_scan_count() -> usize {
    STRUCTURAL_BUDGET_SCAN_COUNT.with(|count| count.replace(0))
}

impl CapsuleBudget {
    fn claim_node(&mut self, depth: usize, limits: CapsuleLimits) -> Result<(), String> {
        if depth > limits.depth {
            return Err(format!(
                "value capsule exceeds its maximum structural depth of {}",
                limits.depth
            ));
        }
        self.maximum_depth = self.maximum_depth.max(depth);
        self.nodes = self
            .nodes
            .checked_add(1)
            .ok_or_else(|| "value capsule structural node count overflowed u64".to_owned())?;
        if self.nodes > limits.nodes {
            return Err(format!(
                "value capsule exceeds its maximum structural node count of {}",
                limits.nodes
            ));
        }
        self.claim_allocation(CAPSULE_COLLECTION_ENTRY_BYTES, limits)
    }

    fn claim_collection(&mut self, entries: usize, limits: CapsuleLimits) -> Result<(), String> {
        let entries = u64::try_from(entries)
            .map_err(|_| "value capsule collection length exceeds u64".to_owned())?;
        let bytes = entries
            .checked_mul(CAPSULE_COLLECTION_ENTRY_BYTES)
            .ok_or_else(|| "value capsule collection allocation overflowed u64".to_owned())?;
        self.claim_allocation(bytes, limits)
    }

    fn claim_bytes(&mut self, bytes: usize, limits: CapsuleLimits) -> Result<(), String> {
        self.claim_allocation(
            u64::try_from(bytes).map_err(|_| "value capsule byte length exceeds u64".to_owned())?,
            limits,
        )
    }

    fn claim_allocation(&mut self, bytes: u64, limits: CapsuleLimits) -> Result<(), String> {
        self.allocation_bytes = self
            .allocation_bytes
            .checked_add(bytes)
            .ok_or_else(|| "value capsule allocation estimate overflowed u64".to_owned())?;
        if self.allocation_bytes > limits.allocation_bytes {
            return Err(format!(
                "value capsule exceeds its maximum estimated allocation of {} bytes",
                limits.allocation_bytes
            ));
        }
        Ok(())
    }

    fn admits_reconstruction(
        &self,
        module_instance_prefix: usize,
        effect_scope_prefix: usize,
        allocation_limit: u64,
    ) -> bool {
        let Some(module_instance_prefix) = u64::try_from(module_instance_prefix).ok() else {
            return false;
        };
        let Some(effect_scope_prefix) = u64::try_from(effect_scope_prefix).ok() else {
            return false;
        };
        let Some(module_instance_prefix_copies) = self.module_instance_prefix_copies.checked_add(1)
        else {
            return false;
        };
        let Some(module_instance_entries) =
            module_instance_prefix.checked_mul(module_instance_prefix_copies)
        else {
            return false;
        };
        let Some(effect_scope_entries) =
            effect_scope_prefix.checked_mul(self.effect_scope_prefix_copies)
        else {
            return false;
        };
        let Some(prefix_bytes) = module_instance_entries
            .checked_add(effect_scope_entries)
            .and_then(|entries| entries.checked_mul(CAPSULE_COLLECTION_ENTRY_BYTES))
        else {
            return false;
        };
        self.allocation_bytes
            .checked_add(prefix_bytes)
            .is_some_and(|allocation| allocation <= allocation_limit)
    }
}

pub(crate) fn validate_snapshot_message_pack(bytes: &[u8]) -> Result<(), String> {
    scan_message_pack(bytes, VALUE_CAPSULE_LIMITS).map(|_| ())
}

fn scan_message_pack(bytes: &[u8], limits: CapsuleLimits) -> Result<CapsuleBudget, String> {
    if bytes.len() > limits.serialized_bytes {
        return Err(format!(
            "module snapshot exceeds its maximum encoded size of {} bytes",
            limits.serialized_bytes
        ));
    }
    let mut scanner = MessagePackScanner {
        bytes,
        offset: 0,
        pending_nodes: 1,
        containers: vec![1],
        budget: CapsuleBudget::default(),
        limits,
    };
    scanner.scan()?;
    Ok(scanner.budget)
}

struct MessagePackScanner<'a> {
    bytes: &'a [u8],
    offset: usize,
    pending_nodes: u64,
    containers: Vec<u64>,
    budget: CapsuleBudget,
    limits: CapsuleLimits,
}

impl MessagePackScanner<'_> {
    fn scan(&mut self) -> Result<(), String> {
        while self.pending_nodes > 0 {
            while self.containers.last() == Some(&0) {
                self.containers.pop();
            }
            let depth = self
                .containers
                .len()
                .checked_sub(1)
                .ok_or_else(|| "module snapshot MessagePack lost its root".to_owned())?;
            self.budget.claim_node(depth, self.limits)?;
            self.pending_nodes -= 1;
            *self
                .containers
                .last_mut()
                .ok_or_else(|| "module snapshot MessagePack lost its container".to_owned())? -= 1;
            let marker = self.read_byte("value marker")?;
            match marker {
                0x00..=0x7f | 0xe0..=0xff | 0xc0 | 0xc2 | 0xc3 => {}
                0x80..=0x8f => self.enter_map(u64::from(marker & 0x0f), depth)?,
                0x90..=0x9f => self.enter_container(u64::from(marker & 0x0f), depth)?,
                0xa0..=0xbf => {
                    self.read_allocated_payload(usize::from(marker & 0x1f), "fixed string")?
                }
                0xc1 => {
                    return Err(
                        "module snapshot MessagePack contains reserved marker 0xc1".to_owned()
                    );
                }
                0xc4 => {
                    let length = self.read_length(1, "bin8 length")?;
                    self.read_allocated_payload(length, "bin8 payload")?;
                }
                0xc5 => {
                    let length = self.read_length(2, "bin16 length")?;
                    self.read_allocated_payload(length, "bin16 payload")?;
                }
                0xc6 => {
                    let length = self.read_length(4, "bin32 length")?;
                    self.read_allocated_payload(length, "bin32 payload")?;
                }
                0xc7 => self.read_extension(1, "ext8")?,
                0xc8 => self.read_extension(2, "ext16")?,
                0xc9 => self.read_extension(4, "ext32")?,
                0xca => self.skip(4, "f32 payload")?,
                0xcb => self.skip(8, "f64 payload")?,
                0xcc | 0xd0 => self.skip(1, "8-bit integer payload")?,
                0xcd | 0xd1 => self.skip(2, "16-bit integer payload")?,
                0xce | 0xd2 => self.skip(4, "32-bit integer payload")?,
                0xcf | 0xd3 => self.skip(8, "64-bit integer payload")?,
                0xd4 => self.read_fixed_extension(1)?,
                0xd5 => self.read_fixed_extension(2)?,
                0xd6 => self.read_fixed_extension(4)?,
                0xd7 => self.read_fixed_extension(8)?,
                0xd8 => self.read_fixed_extension(16)?,
                0xd9 => {
                    let length = self.read_length(1, "str8 length")?;
                    self.read_allocated_payload(length, "str8 payload")?;
                }
                0xda => {
                    let length = self.read_length(2, "str16 length")?;
                    self.read_allocated_payload(length, "str16 payload")?;
                }
                0xdb => {
                    let length = self.read_length(4, "str32 length")?;
                    self.read_allocated_payload(length, "str32 payload")?;
                }
                0xdc => {
                    let length = self.read_length_u64(2, "array16 length")?;
                    self.enter_container(length, depth)?;
                }
                0xdd => {
                    let length = self.read_length_u64(4, "array32 length")?;
                    self.enter_container(length, depth)?;
                }
                0xde => {
                    let length = self.read_length_u64(2, "map16 length")?;
                    self.enter_map(length, depth)?;
                }
                0xdf => {
                    let length = self.read_length_u64(4, "map32 length")?;
                    self.enter_map(length, depth)?;
                }
            }
        }
        while self.containers.last() == Some(&0) {
            self.containers.pop();
        }
        if !self.containers.is_empty() {
            return Err("module snapshot MessagePack ended inside a container".to_owned());
        }
        if self.offset != self.bytes.len() {
            return Err(format!(
                "module snapshot MessagePack has {} trailing bytes after its root value",
                self.bytes.len() - self.offset
            ));
        }
        Ok(())
    }

    fn enter_map(&mut self, pairs: u64, depth: usize) -> Result<(), String> {
        let children = pairs
            .checked_mul(2)
            .ok_or_else(|| "module snapshot MessagePack map length overflowed u64".to_owned())?;
        self.enter_container(children, depth)
    }

    fn enter_container(&mut self, children: u64, depth: usize) -> Result<(), String> {
        if children == 0 {
            return Ok(());
        }
        let child_depth = depth
            .checked_add(1)
            .ok_or_else(|| "module snapshot MessagePack depth overflowed usize".to_owned())?;
        if child_depth > self.limits.depth {
            return Err(format!(
                "value capsule exceeds its maximum structural depth of {}",
                self.limits.depth
            ));
        }
        let declared_nodes = self
            .budget
            .nodes
            .checked_add(self.pending_nodes)
            .and_then(|nodes| nodes.checked_add(children))
            .ok_or_else(|| "module snapshot MessagePack node count overflowed u64".to_owned())?;
        if declared_nodes > self.limits.nodes {
            return Err(format!(
                "value capsule exceeds its maximum structural node count of {}",
                self.limits.nodes
            ));
        }
        let pending_allocation = self
            .pending_nodes
            .checked_add(children)
            .and_then(|nodes| nodes.checked_mul(CAPSULE_COLLECTION_ENTRY_BYTES))
            .ok_or_else(|| "module snapshot MessagePack allocation overflowed u64".to_owned())?;
        let declared_allocation = self
            .budget
            .allocation_bytes
            .checked_add(pending_allocation)
            .ok_or_else(|| "module snapshot MessagePack allocation overflowed u64".to_owned())?;
        if declared_allocation > self.limits.allocation_bytes {
            return Err(format!(
                "value capsule exceeds its maximum estimated allocation of {} bytes",
                self.limits.allocation_bytes
            ));
        }
        self.pending_nodes = self.pending_nodes.checked_add(children).ok_or_else(|| {
            "module snapshot MessagePack pending node count overflowed u64".to_owned()
        })?;
        self.containers.push(children);
        Ok(())
    }

    fn read_extension(&mut self, width: usize, description: &str) -> Result<(), String> {
        let length = self.read_length(width, &format!("{description} length"))?;
        self.skip(1, &format!("{description} type"))?;
        self.read_allocated_payload(length, &format!("{description} payload"))
    }

    fn read_fixed_extension(&mut self, length: usize) -> Result<(), String> {
        self.skip(1, "fixed extension type")?;
        self.read_allocated_payload(length, "fixed extension payload")
    }

    fn read_allocated_payload(&mut self, length: usize, description: &str) -> Result<(), String> {
        self.budget.claim_bytes(length, self.limits)?;
        self.skip(length, description)
    }

    fn read_length(&mut self, width: usize, description: &str) -> Result<usize, String> {
        usize::try_from(self.read_length_u64(width, description)?)
            .map_err(|_| format!("module snapshot MessagePack {description} exceeds usize"))
    }

    fn read_length_u64(&mut self, width: usize, description: &str) -> Result<u64, String> {
        let mut length = 0_u64;
        for _ in 0..width {
            let byte = self.read_byte(description)?;
            length = length
                .checked_mul(256)
                .and_then(|value| value.checked_add(u64::from(byte)))
                .ok_or_else(|| {
                    format!("module snapshot MessagePack {description} overflowed u64")
                })?;
        }
        Ok(length)
    }

    fn read_byte(&mut self, description: &str) -> Result<u8, String> {
        let byte = self
            .bytes
            .get(self.offset)
            .copied()
            .ok_or_else(|| format!("module snapshot MessagePack ended before {description}"))?;
        self.offset += 1;
        Ok(byte)
    }

    fn skip(&mut self, length: usize, description: &str) -> Result<(), String> {
        let end = self.offset.checked_add(length).ok_or_else(|| {
            format!("module snapshot MessagePack {description} offset overflowed usize")
        })?;
        if end > self.bytes.len() {
            return Err(format!(
                "module snapshot MessagePack ended inside {description}"
            ));
        }
        self.offset = end;
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
pub(crate) struct ValueCapsule {
    schema: u32,
    environments: Vec<CapsuleEnvironment>,
    effect_scopes: Vec<Vec<CapsuleClosureApplication>>,
    root: u32,
}

pub(crate) struct AdmittedCapsuleReconstruction<'capsule> {
    capsule: &'capsule ValueCapsule,
}

#[derive(Deserialize, Serialize)]
struct CapsuleEnvironment {
    parent: Option<u32>,
    names: BTreeMap<String, CapsuleValue>,
    recursive_names: BTreeMap<String, CapsuleClosure>,
    opens: Vec<Vec<(String, CapsuleValue)>>,
    type_substitutions: BTreeMap<u32, CapsuleValue>,
}

#[derive(Deserialize, Serialize)]
struct CapsuleClosure {
    module: CapsuleModule,
    module_instances: Vec<CapsuleModuleInstanceSite>,
    effect_scope: u32,
    parameter: PatternId,
    body: ExpressionId,
    self_name: Option<String>,
    imports: Option<BTreeMap<String, String>>,
    reuse_assertion: Option<Span>,
    deferred: bool,
}

#[derive(Deserialize, Serialize)]
enum CapsuleValue {
    Int(BigInt),
    Float(f64),
    Float32(f32),
    Vector([f32; 4]),
    VectorMask([bool; 4]),
    IntegerVector {
        bits: u8,
        lanes: Vec<i32>,
    },
    IntegerVectorMask {
        bits: u8,
        lanes: Vec<bool>,
    },
    Text(String),
    Unit,
    Shape(Vec<(String, CapsuleValue)>),
    Array(Vec<CapsuleValue>),
    RegionType(Box<CapsuleValue>),
    ScratchType(Box<CapsuleValue>),
    DeferredScratch {
        capacity: Box<CapsuleValue>,
    },
    EmptyArray {
        element: Box<CapsuleValue>,
    },
    Tag {
        name: String,
        payload: Option<Box<CapsuleValue>>,
    },
    Closure {
        closure: CapsuleClosure,
        environment: u32,
    },
    ModuleClosure {
        module: CapsuleModule,
    },
    IndexedStep {
        elements: Vec<CapsuleValue>,
    },
    Primitive {
        name: String,
        arity: u32,
        applied: Vec<CapsuleValue>,
    },
    Range {
        low: Box<CapsuleValue>,
        high: Box<CapsuleValue>,
        domain: Option<u8>,
    },
    Union(Vec<CapsuleValue>),
    Unbounded,
    Arrow {
        deferred: bool,
        domain: Box<CapsuleValue>,
        codomain: Box<CapsuleValue>,
        effects: Vec<CapsuleValue>,
        effect_tail: Option<u32>,
    },
    TypeVariable(u32),
    Forall {
        variable: u32,
        body: Box<CapsuleValue>,
    },
    Extended {
        inner: Box<CapsuleValue>,
        members: Vec<(String, CapsuleValue)>,
    },
    Sealed {
        name: String,
        inner: Box<CapsuleValue>,
    },
    OpaqueType(String),
}

#[derive(Deserialize, Serialize)]
enum CapsuleModule {
    Local,
    External(String),
}

#[derive(Deserialize, Serialize)]
enum CapsuleApplicationRoot {
    Expression(ExpressionId),
    Declaration(DeclarationId),
}

#[derive(Deserialize, Serialize)]
struct CapsuleApplicationSite {
    root: CapsuleApplicationRoot,
    compiler_steps: Vec<CapsuleCompilerApplication>,
}

#[derive(Deserialize, Serialize)]
enum CapsuleCompilerApplication {
    ForceEffectDeclaration,
    ForallBody,
    IncludeParser,
    HandleThunk,
    HandleReturn,
    HandleOperation {
        operation: String,
        request: Box<CapsuleApplicationSite>,
    },
    RequirementPredicate,
    RecognitionArgument {
        probe: CapsuleRecognitionProbe,
        position: u8,
    },
    RuntimeExportParameter(u32),
}

#[derive(Deserialize, Serialize)]
enum CapsuleRecognitionProbe {
    Integer { left: i8, right: i8 },
    Boolean { left: bool, right: bool },
    BooleanUnary { argument: bool },
}

#[derive(Deserialize, Serialize)]
struct CapsuleClosureApplication {
    application: CapsuleApplicationSite,
    creation_scope: u32,
}

#[derive(Deserialize, Serialize)]
struct CapsuleModuleInstanceSite {
    application: CapsuleApplicationSite,
}

struct CapsuleEncoder {
    module_path: String,
    module_revision: ModuleRevision,
    environment_ids: HashMap<usize, u32>,
    environments: Vec<Option<CapsuleEnvironment>>,
    pending_environments: Vec<(Environment, u32)>,
    encoding_environments: bool,
    effect_scope_ids: HashMap<usize, u32>,
    effect_scopes: Vec<Option<Vec<CapsuleClosureApplication>>>,
    budget: CapsuleBudget,
}

struct CapsuleDecodeProvenance<'a> {
    effect_scopes: &'a [Rc<EffectScope>],
    module_instances: &'a ModuleInstanceScope,
    module_revision: &'a ModuleRevision,
    source_closures: &'a HashSet<CapsuleClosureIdentity>,
}

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
struct CapsuleClosureIdentity {
    parameter: PatternId,
    body: ExpressionId,
    deferred: bool,
}

enum CapsuleEncodingFailure {
    Ineligible,
    Invalid(String),
}

enum CapsuleGraphFailure {
    OverBudget(String),
    Invalid(String),
}

impl CapsuleGraphFailure {
    fn into_message(self) -> String {
        match self {
            Self::OverBudget(message) | Self::Invalid(message) => message,
        }
    }
}

impl ValueCapsule {
    pub(crate) fn encode(
        environment: &Environment,
        module_path: &str,
        module: &Module,
        module_revision: &ModuleRevision,
    ) -> Result<Option<Self>, String> {
        let mut encoder = CapsuleEncoder {
            module_path: module_path.to_owned(),
            module_revision: module_revision.clone(),
            environment_ids: HashMap::new(),
            environments: Vec::new(),
            pending_environments: Vec::new(),
            encoding_environments: false,
            effect_scope_ids: HashMap::new(),
            effect_scopes: Vec::new(),
            budget: CapsuleBudget::default(),
        };
        let root = match encoder.encode_environment(environment) {
            Ok(root) => root,
            Err(CapsuleEncodingFailure::Ineligible) => return Ok(None),
            Err(CapsuleEncodingFailure::Invalid(message)) => return Err(message),
        };
        let environments = encoder
            .environments
            .into_iter()
            .enumerate()
            .map(|(id, environment)| {
                environment.ok_or_else(|| format!("value capsule omitted environment {id}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let effect_scopes = encoder
            .effect_scopes
            .into_iter()
            .enumerate()
            .map(|(id, effect_scope)| {
                effect_scope.ok_or_else(|| format!("value capsule omitted effect scope {id}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let capsule = Self {
            schema: VALUE_CAPSULE_SCHEMA,
            environments,
            effect_scopes,
            root,
        };
        if capsule.validate_structural_budget().is_err() {
            return Ok(None);
        }
        match capsule.validate_environment_graph_for_publication() {
            Ok(()) => {}
            Err(CapsuleGraphFailure::OverBudget(_)) => return Ok(None),
            Err(CapsuleGraphFailure::Invalid(message)) => return Err(message),
        }
        match capsule.validate_effect_scope_graph_for_publication() {
            Ok(()) => {}
            Err(CapsuleGraphFailure::OverBudget(_)) => return Ok(None),
            Err(CapsuleGraphFailure::Invalid(message)) => return Err(message),
        }
        capsule.validate_recursive_groups(module_path, &source_recursive_groups(module))?;
        Ok(Some(capsule))
    }

    pub(crate) fn decode(
        &self,
        module_path: &str,
        module: &Module,
        module_revision: &ModuleRevision,
        context: &Context,
        base_module_instances: &ModuleInstanceScope,
        base_effect_scope: &Rc<EffectScope>,
    ) -> Result<Environment, String> {
        self.validate_schema()?;
        self.validate_structural_budget()?;
        self.decode_after_structural_validation(
            module_path,
            module,
            module_revision,
            context,
            base_module_instances,
            base_effect_scope,
        )
    }

    fn decode_after_structural_validation(
        &self,
        module_path: &str,
        module: &Module,
        module_revision: &ModuleRevision,
        context: &Context,
        base_module_instances: &ModuleInstanceScope,
        base_effect_scope: &Rc<EffectScope>,
    ) -> Result<Environment, String> {
        self.validate_environment_graph()?;
        self.validate_effect_scope_graph()?;
        let effect_scopes = decode_effect_scopes(
            &self.effect_scopes,
            module_path,
            module,
            module_revision,
            base_effect_scope,
        )?;
        let source_closures = module
            .arena
            .expressions
            .iter()
            .filter_map(|expression| match expression {
                Expression::Lambda {
                    parameter,
                    body,
                    deferred,
                    ..
                } => Some(CapsuleClosureIdentity {
                    parameter: *parameter,
                    body: *body,
                    deferred: *deferred,
                }),
                _ => None,
            })
            .collect::<HashSet<_>>();
        let source_recursive_groups = source_recursive_groups(module);
        self.validate_recursive_groups(module_path, &source_recursive_groups)?;
        let provenance = CapsuleDecodeProvenance {
            effect_scopes: &effect_scopes,
            module_instances: base_module_instances,
            module_revision,
            source_closures: &source_closures,
        };
        let environment_identities = context.decoded_environment_identities(
            module_revision,
            base_module_instances,
            base_effect_scope,
            self.environments.len(),
        );
        let environments = self
            .environments
            .iter()
            .zip(environment_identities)
            .map(|(environment, identity)| match identity {
                Some(identity) if environment.recursive_names.is_empty() => {
                    decoded_child_env(None, identity)
                }
                Some(identity) => decoded_recursive_env(None, identity).0,
                None if environment.recursive_names.is_empty() => child_env(None),
                None => recursive_env(None).0,
            })
            .collect::<Vec<_>>();
        for (id, encoded) in self.environments.iter().enumerate() {
            if let Some(parent) = encoded.parent {
                *environments[id].parent.borrow_mut() = Some(
                    environments
                        .get(parent as usize)
                        .ok_or_else(|| {
                            format!("value capsule environment {id} has missing parent {parent}")
                        })?
                        .clone(),
                );
            }
        }
        for (id, encoded) in self.environments.iter().enumerate() {
            let environment = &environments[id];
            *environment.names.borrow_mut() = encoded
                .names
                .iter()
                .map(|(name, value)| {
                    Ok((
                        name.clone(),
                        decode_value(
                            value,
                            &environments,
                            &provenance,
                            module_path,
                            module,
                            context,
                        )?,
                    ))
                })
                .collect::<Result<_, String>>()?;
            if !encoded.recursive_names.is_empty() {
                let bindings = environment.recursive_bindings.as_ref().ok_or_else(|| {
                    format!("value capsule environment {id} lost its recursive group")
                })?;
                for (name, closure) in &encoded.recursive_names {
                    let value = decode_closure(
                        closure,
                        environment.clone(),
                        &provenance,
                        module_path,
                        module,
                        context,
                    )?;
                    bindings.insert(name.clone(), value).map_err(|error| {
                        format!(
                            "value capsule recursive binding {name:?} in environment {id} is invalid: {error:?}"
                        )
                    })?;
                }
            }
            *environment.opens.borrow_mut() = encoded
                .opens
                .iter()
                .map(|fields| {
                    Ok(OpenedValues::new(decode_fields(
                        fields,
                        &environments,
                        &provenance,
                        module_path,
                        module,
                        context,
                    )?))
                })
                .collect::<Result<_, String>>()?;
            *environment.type_substitutions.borrow_mut() = encoded
                .type_substitutions
                .iter()
                .map(|(variable, value)| {
                    Ok((
                        *variable,
                        decode_value(
                            value,
                            &environments,
                            &provenance,
                            module_path,
                            module,
                            context,
                        )?,
                    ))
                })
                .collect::<Result<_, String>>()?;
        }
        environments
            .get(self.root as usize)
            .cloned()
            .ok_or_else(|| format!("value capsule has missing root environment {}", self.root))
    }

    fn validate_schema(&self) -> Result<(), String> {
        if self.schema != VALUE_CAPSULE_SCHEMA {
            return Err(format!(
                "value capsule has schema {}, expected {VALUE_CAPSULE_SCHEMA}",
                self.schema
            ));
        }
        Ok(())
    }

    pub(crate) fn admit_reconstruction(
        &self,
        module_instance_prefix: usize,
        effect_scope_prefix: usize,
    ) -> Result<Option<AdmittedCapsuleReconstruction<'_>>, String> {
        self.admit_reconstruction_with_allocation_limit(
            module_instance_prefix,
            effect_scope_prefix,
            VALUE_CAPSULE_MAX_ALLOCATION_BYTES,
        )
    }

    fn admit_reconstruction_with_allocation_limit(
        &self,
        module_instance_prefix: usize,
        effect_scope_prefix: usize,
        allocation_limit: u64,
    ) -> Result<Option<AdmittedCapsuleReconstruction<'_>>, String> {
        self.validate_schema()?;
        let budget = self.structural_budget()?;
        if !budget.admits_reconstruction(
            module_instance_prefix,
            effect_scope_prefix,
            allocation_limit,
        ) {
            return Ok(None);
        }
        Ok(Some(AdmittedCapsuleReconstruction { capsule: self }))
    }

    fn validate_environment_graph(&self) -> Result<(), String> {
        self.validate_environment_graph_for_publication()
            .map_err(CapsuleGraphFailure::into_message)
    }

    fn validate_environment_graph_for_publication(&self) -> Result<(), CapsuleGraphFailure> {
        if self.root as usize >= self.environments.len() {
            return Err(CapsuleGraphFailure::Invalid(format!(
                "value capsule root environment {} is outside {} environments",
                self.root,
                self.environments.len()
            )));
        }
        let mut edges = Vec::with_capacity(self.environments.len());
        for (id, environment) in self.environments.iter().enumerate() {
            let mut references = Vec::new();
            if let Some(parent) = environment.parent {
                references.push(parent);
            }
            for value in environment.names.values() {
                collect_environment_references(value, &mut references);
            }
            for fields in &environment.opens {
                for (_, value) in fields {
                    collect_environment_references(value, &mut references);
                }
            }
            for value in environment.type_substitutions.values() {
                collect_environment_references(value, &mut references);
            }
            for reference in &references {
                if *reference as usize >= self.environments.len() {
                    return Err(CapsuleGraphFailure::Invalid(format!(
                        "value capsule environment {id} references missing environment {reference}"
                    )));
                }
            }
            edges.push(references);
        }

        let mut states = vec![0_u8; edges.len()];
        let mut longest_paths = vec![0_usize; edges.len()];
        for start in 0..edges.len() {
            if states[start] != 0 {
                continue;
            }
            states[start] = 1;
            let mut stack = vec![(start, 0)];
            while let Some((environment, next_edge)) = stack.last_mut() {
                let Some(reference) = edges[*environment].get(*next_edge).copied() else {
                    let environment = *environment;
                    let longest_path = edges[environment]
                        .iter()
                        .map(|reference| longest_paths[*reference as usize] + 1)
                        .max()
                        .unwrap_or_default();
                    if longest_path > VALUE_CAPSULE_MAX_ENVIRONMENT_GRAPH_DEPTH {
                        return Err(CapsuleGraphFailure::OverBudget(format!(
                            "value capsule environment graph exceeds its maximum depth of {VALUE_CAPSULE_MAX_ENVIRONMENT_GRAPH_DEPTH}"
                        )));
                    }
                    longest_paths[environment] = longest_path;
                    states[environment] = 2;
                    stack.pop();
                    continue;
                };
                *next_edge += 1;
                let reference = reference as usize;
                match states[reference] {
                    0 => {
                        states[reference] = 1;
                        stack.push((reference, 0));
                    }
                    1 => {
                        return Err(CapsuleGraphFailure::Invalid(format!(
                            "value capsule environments contain a strong-reference cycle from {environment} to {reference}"
                        )));
                    }
                    2 => {}
                    _ => unreachable!("environment graph states are internal"),
                }
            }
        }
        Ok(())
    }

    fn validate_effect_scope_graph(&self) -> Result<(), String> {
        self.validate_effect_scope_graph_for_publication()
            .map_err(CapsuleGraphFailure::into_message)
    }

    fn validate_effect_scope_graph_for_publication(&self) -> Result<(), CapsuleGraphFailure> {
        let mut edges = Vec::with_capacity(self.effect_scopes.len());
        for (id, frames) in self.effect_scopes.iter().enumerate() {
            let references = frames
                .iter()
                .map(|frame| frame.creation_scope)
                .collect::<Vec<_>>();
            for reference in &references {
                if *reference as usize >= self.effect_scopes.len() {
                    return Err(CapsuleGraphFailure::Invalid(format!(
                        "value capsule effect scope {id} references missing effect scope {reference}"
                    )));
                }
            }
            edges.push(references);
        }

        let mut states = vec![0_u8; edges.len()];
        let mut longest_paths = vec![0_usize; edges.len()];
        for start in 0..edges.len() {
            if states[start] != 0 {
                continue;
            }
            states[start] = 1;
            let mut stack = vec![(start, 0)];
            while let Some((effect_scope, next_edge)) = stack.last_mut() {
                let Some(reference) = edges[*effect_scope].get(*next_edge).copied() else {
                    let effect_scope = *effect_scope;
                    let longest_path = edges[effect_scope]
                        .iter()
                        .map(|reference| longest_paths[*reference as usize] + 1)
                        .max()
                        .unwrap_or_default();
                    if longest_path > VALUE_CAPSULE_MAX_DEPTH {
                        return Err(CapsuleGraphFailure::OverBudget(format!(
                            "value capsule effect-scope graph exceeds its maximum depth of {VALUE_CAPSULE_MAX_DEPTH}"
                        )));
                    }
                    longest_paths[effect_scope] = longest_path;
                    states[effect_scope] = 2;
                    stack.pop();
                    continue;
                };
                *next_edge += 1;
                let reference = reference as usize;
                match states[reference] {
                    0 => {
                        states[reference] = 1;
                        stack.push((reference, 0));
                    }
                    1 => {
                        return Err(CapsuleGraphFailure::Invalid(format!(
                            "value capsule effect scopes contain a cycle from {effect_scope} to {reference}"
                        )));
                    }
                    2 => {}
                    _ => unreachable!("effect-scope graph states are internal"),
                }
            }
        }
        Ok(())
    }

    fn validate_structural_budget(&self) -> Result<(), String> {
        self.structural_budget().map(|_| ())
    }

    fn structural_budget(&self) -> Result<CapsuleBudget, String> {
        #[cfg(test)]
        STRUCTURAL_BUDGET_SCAN_COUNT.with(|count| count.set(count.get() + 1));

        let mut budget = CapsuleBudget::default();
        budget.claim_collection(self.environments.len(), VALUE_CAPSULE_LIMITS)?;
        for environment in &self.environments {
            budget.claim_node(0, VALUE_CAPSULE_LIMITS)?;
            budget.claim_collection(environment.names.len(), VALUE_CAPSULE_LIMITS)?;
            for (name, value) in &environment.names {
                budget.claim_bytes(name.len(), VALUE_CAPSULE_LIMITS)?;
                measure_capsule_value(value, 1, &mut budget)?;
            }
            budget.claim_collection(environment.recursive_names.len(), VALUE_CAPSULE_LIMITS)?;
            for (name, closure) in &environment.recursive_names {
                budget.claim_bytes(name.len(), VALUE_CAPSULE_LIMITS)?;
                measure_capsule_closure(closure, 1, &mut budget)?;
            }
            budget.claim_collection(environment.opens.len(), VALUE_CAPSULE_LIMITS)?;
            for fields in &environment.opens {
                measure_capsule_fields(fields, 1, &mut budget)?;
            }
            budget.claim_collection(environment.type_substitutions.len(), VALUE_CAPSULE_LIMITS)?;
            for value in environment.type_substitutions.values() {
                measure_capsule_value(value, 1, &mut budget)?;
            }
        }
        budget.claim_collection(self.effect_scopes.len(), VALUE_CAPSULE_LIMITS)?;
        for frames in &self.effect_scopes {
            budget.claim_node(0, VALUE_CAPSULE_LIMITS)?;
            budget.claim_collection(frames.len(), VALUE_CAPSULE_LIMITS)?;
            if !frames.is_empty() {
                budget.effect_scope_prefix_copies = budget
                    .effect_scope_prefix_copies
                    .checked_add(1)
                    .ok_or_else(|| {
                        "value capsule effect-scope copy count overflowed u64".to_owned()
                    })?;
            }
            for frame in frames {
                budget.claim_node(1, VALUE_CAPSULE_LIMITS)?;
                measure_capsule_application(&frame.application, 2, &mut budget)?;
            }
        }
        Ok(budget)
    }

    fn validate_recursive_groups(
        &self,
        module_path: &str,
        source_groups: &[BTreeMap<String, CapsuleClosureIdentity>],
    ) -> Result<(), String> {
        for (environment, encoded) in self.environments.iter().enumerate() {
            if encoded.recursive_names.is_empty() {
                continue;
            }
            let mut group = BTreeMap::new();
            for (name, closure) in &encoded.recursive_names {
                if encoded.names.contains_key(name) {
                    return Err(format!(
                        "value capsule environment {environment} binds {name:?} as both an ordinary and recursive name"
                    ));
                }
                if !matches!(closure.module, CapsuleModule::Local) {
                    return Err(format!(
                        "value capsule recursive binding {name:?} in environment {environment} is not local to {module_path}"
                    ));
                }
                if closure.self_name.as_deref() != Some(name) {
                    return Err(format!(
                        "value capsule recursive binding {name:?} in environment {environment} has a different self name"
                    ));
                }
                group.insert(
                    name.clone(),
                    CapsuleClosureIdentity {
                        parameter: closure.parameter,
                        body: closure.body,
                        deferred: closure.deferred,
                    },
                );
            }
            if !source_groups.iter().any(|source| source == &group) {
                return Err(format!(
                    "value capsule recursive environment {environment} has no matching source group in {module_path}"
                ));
            }
        }
        Ok(())
    }
}

impl AdmittedCapsuleReconstruction<'_> {
    pub(crate) fn decode(
        self,
        module_path: &str,
        module: &Module,
        module_revision: &ModuleRevision,
        context: &Context,
        base_module_instances: &ModuleInstanceScope,
        base_effect_scope: &Rc<EffectScope>,
    ) -> Result<Environment, String> {
        self.capsule.decode_after_structural_validation(
            module_path,
            module,
            module_revision,
            context,
            base_module_instances,
            base_effect_scope,
        )
    }
}

fn measure_capsule_fields(
    fields: &[(String, CapsuleValue)],
    depth: usize,
    budget: &mut CapsuleBudget,
) -> Result<(), String> {
    budget.claim_collection(fields.len(), VALUE_CAPSULE_LIMITS)?;
    for (name, value) in fields {
        budget.claim_bytes(name.len(), VALUE_CAPSULE_LIMITS)?;
        measure_capsule_value(value, depth, budget)?;
    }
    Ok(())
}

fn measure_capsule_values(
    values: &[CapsuleValue],
    depth: usize,
    budget: &mut CapsuleBudget,
) -> Result<(), String> {
    budget.claim_collection(values.len(), VALUE_CAPSULE_LIMITS)?;
    for value in values {
        measure_capsule_value(value, depth, budget)?;
    }
    Ok(())
}

fn measure_capsule_value(
    value: &CapsuleValue,
    depth: usize,
    budget: &mut CapsuleBudget,
) -> Result<(), String> {
    budget.claim_node(depth, VALUE_CAPSULE_LIMITS)?;
    match value {
        CapsuleValue::Int(value) => {
            budget.claim_allocation(value.bits().div_ceil(8), VALUE_CAPSULE_LIMITS)?;
        }
        CapsuleValue::IntegerVector { lanes, .. } => {
            budget.claim_collection(lanes.len(), VALUE_CAPSULE_LIMITS)?;
        }
        CapsuleValue::IntegerVectorMask { lanes, .. } => {
            budget.claim_collection(lanes.len(), VALUE_CAPSULE_LIMITS)?;
        }
        CapsuleValue::Text(value) | CapsuleValue::OpaqueType(value) => {
            budget.claim_bytes(value.len(), VALUE_CAPSULE_LIMITS)?;
        }
        CapsuleValue::Shape(fields) => {
            measure_capsule_fields(fields, depth + 1, budget)?;
        }
        CapsuleValue::Array(values)
        | CapsuleValue::IndexedStep { elements: values }
        | CapsuleValue::Union(values) => {
            measure_capsule_values(values, depth + 1, budget)?;
        }
        CapsuleValue::RegionType(value)
        | CapsuleValue::ScratchType(value)
        | CapsuleValue::DeferredScratch { capacity: value }
        | CapsuleValue::EmptyArray { element: value }
        | CapsuleValue::Forall { body: value, .. } => {
            measure_capsule_value(value, depth + 1, budget)?;
        }
        CapsuleValue::Tag { name, payload } => {
            budget.claim_bytes(name.len(), VALUE_CAPSULE_LIMITS)?;
            if let Some(payload) = payload {
                measure_capsule_value(payload, depth + 1, budget)?;
            }
        }
        CapsuleValue::Closure { closure, .. } => {
            measure_capsule_closure(closure, depth + 1, budget)?;
        }
        CapsuleValue::ModuleClosure { module } => {
            measure_capsule_module(module, budget)?;
        }
        CapsuleValue::Primitive { name, applied, .. } => {
            budget.claim_bytes(name.len(), VALUE_CAPSULE_LIMITS)?;
            measure_capsule_values(applied, depth + 1, budget)?;
        }
        CapsuleValue::Range { low, high, .. } => {
            measure_capsule_value(low, depth + 1, budget)?;
            measure_capsule_value(high, depth + 1, budget)?;
        }
        CapsuleValue::Arrow {
            domain,
            codomain,
            effects,
            ..
        } => {
            measure_capsule_value(domain, depth + 1, budget)?;
            measure_capsule_value(codomain, depth + 1, budget)?;
            measure_capsule_values(effects, depth + 1, budget)?;
        }
        CapsuleValue::Extended { inner, members } => {
            measure_capsule_value(inner, depth + 1, budget)?;
            measure_capsule_fields(members, depth + 1, budget)?;
        }
        CapsuleValue::Sealed { name, inner } => {
            budget.claim_bytes(name.len(), VALUE_CAPSULE_LIMITS)?;
            measure_capsule_value(inner, depth + 1, budget)?;
        }
        CapsuleValue::Float(_)
        | CapsuleValue::Float32(_)
        | CapsuleValue::Vector(_)
        | CapsuleValue::VectorMask(_)
        | CapsuleValue::Unit
        | CapsuleValue::Unbounded
        | CapsuleValue::TypeVariable(_) => {}
    }
    Ok(())
}

fn measure_capsule_closure(
    closure: &CapsuleClosure,
    depth: usize,
    budget: &mut CapsuleBudget,
) -> Result<(), String> {
    budget.module_instance_prefix_copies = budget
        .module_instance_prefix_copies
        .checked_add(1)
        .ok_or_else(|| "value capsule closure copy count overflowed u64".to_owned())?;
    budget.claim_node(depth, VALUE_CAPSULE_LIMITS)?;
    measure_capsule_module(&closure.module, budget)?;
    budget.claim_collection(closure.module_instances.len(), VALUE_CAPSULE_LIMITS)?;
    for site in &closure.module_instances {
        budget.claim_node(depth + 1, VALUE_CAPSULE_LIMITS)?;
        measure_capsule_application(&site.application, depth + 2, budget)?;
    }
    if let Some(self_name) = &closure.self_name {
        budget.claim_bytes(self_name.len(), VALUE_CAPSULE_LIMITS)?;
    }
    if let Some(imports) = &closure.imports {
        budget.claim_collection(imports.len(), VALUE_CAPSULE_LIMITS)?;
        for (name, path) in imports {
            budget.claim_bytes(name.len(), VALUE_CAPSULE_LIMITS)?;
            budget.claim_bytes(path.len(), VALUE_CAPSULE_LIMITS)?;
        }
    }
    Ok(())
}

fn measure_capsule_application(
    application: &CapsuleApplicationSite,
    depth: usize,
    budget: &mut CapsuleBudget,
) -> Result<(), String> {
    budget.claim_node(depth, VALUE_CAPSULE_LIMITS)?;
    budget.claim_collection(application.compiler_steps.len(), VALUE_CAPSULE_LIMITS)?;
    for step in &application.compiler_steps {
        budget.claim_node(depth + 1, VALUE_CAPSULE_LIMITS)?;
        if let CapsuleCompilerApplication::HandleOperation { operation, request } = step {
            budget.claim_bytes(operation.len(), VALUE_CAPSULE_LIMITS)?;
            measure_capsule_application(request, depth + 2, budget)?;
        }
    }
    Ok(())
}

fn measure_capsule_module(
    module: &CapsuleModule,
    budget: &mut CapsuleBudget,
) -> Result<(), String> {
    if let CapsuleModule::External(path) = module {
        budget.claim_bytes(path.len(), VALUE_CAPSULE_LIMITS)?;
    }
    Ok(())
}

fn collect_environment_references(value: &CapsuleValue, references: &mut Vec<u32>) {
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            CapsuleValue::Closure { environment, .. } => references.push(*environment),
            CapsuleValue::Shape(fields) => {
                pending.extend(fields.iter().map(|(_, value)| value));
            }
            CapsuleValue::Extended { inner, members } => {
                pending.push(inner);
                pending.extend(members.iter().map(|(_, value)| value));
            }
            CapsuleValue::Array(values)
            | CapsuleValue::IndexedStep { elements: values }
            | CapsuleValue::Primitive {
                applied: values, ..
            }
            | CapsuleValue::Union(values) => pending.extend(values),
            CapsuleValue::RegionType(value)
            | CapsuleValue::ScratchType(value)
            | CapsuleValue::DeferredScratch { capacity: value }
            | CapsuleValue::EmptyArray { element: value }
            | CapsuleValue::Forall { body: value, .. }
            | CapsuleValue::Sealed { inner: value, .. } => pending.push(value),
            CapsuleValue::Tag { payload, .. } => pending.extend(payload.as_deref()),
            CapsuleValue::Range { low, high, .. } => {
                pending.push(low);
                pending.push(high);
            }
            CapsuleValue::Arrow {
                domain,
                codomain,
                effects,
                ..
            } => {
                pending.push(domain);
                pending.push(codomain);
                pending.extend(effects);
            }
            CapsuleValue::Int(_)
            | CapsuleValue::Float(_)
            | CapsuleValue::Float32(_)
            | CapsuleValue::Vector(_)
            | CapsuleValue::VectorMask(_)
            | CapsuleValue::IntegerVector { .. }
            | CapsuleValue::IntegerVectorMask { .. }
            | CapsuleValue::Text(_)
            | CapsuleValue::Unit
            | CapsuleValue::ModuleClosure { .. }
            | CapsuleValue::Unbounded
            | CapsuleValue::TypeVariable(_)
            | CapsuleValue::OpaqueType(_) => {}
        }
    }
}

fn source_recursive_groups(module: &Module) -> Vec<BTreeMap<String, CapsuleClosureIdentity>> {
    let mut groups = Vec::new();
    collect_source_recursive_groups(module, &module.declarations, &mut groups);
    for expression in &module.arena.expressions {
        if let Expression::Block { declarations, .. } = expression {
            collect_source_recursive_groups(module, declarations, &mut groups);
        }
    }
    groups
}

fn collect_source_recursive_groups(
    module: &Module,
    declarations: &[DeclarationId],
    groups: &mut Vec<BTreeMap<String, CapsuleClosureIdentity>>,
) {
    let mut active: Option<(DeclarationKind, usize)> = None;
    for declaration in declarations {
        let source = &module.arena.declarations[declaration.0 as usize];
        let Declaration::Binding {
            kind,
            tags,
            pattern,
            value,
            ..
        } = source
        else {
            if !matches!(source, Declaration::Signature { .. }) {
                active = None;
            }
            continue;
        };
        let Expression::Rec { lambda, .. } = &module.arena.expressions[value.0 as usize] else {
            active = None;
            continue;
        };
        let Pattern::Name { name, .. } = &module.arena.patterns[pattern.0 as usize] else {
            active = None;
            continue;
        };
        let Expression::Lambda {
            parameter,
            body,
            deferred,
            ..
        } = &module.arena.expressions[lambda.0 as usize]
        else {
            active = None;
            continue;
        };
        let group = match active {
            Some((active_kind, group)) if active_kind == *kind && tags.is_empty() => group,
            _ => {
                groups.push(BTreeMap::new());
                groups.len() - 1
            }
        };
        groups[group].insert(
            name.clone(),
            CapsuleClosureIdentity {
                parameter: *parameter,
                body: *body,
                deferred: *deferred,
            },
        );
        active = tags.is_empty().then_some((*kind, group));
    }
}

impl CapsuleEncoder {
    fn claim_node(&mut self, depth: usize) -> Result<(), CapsuleEncodingFailure> {
        self.budget
            .claim_node(depth, VALUE_CAPSULE_LIMITS)
            .map_err(|_| CapsuleEncodingFailure::Ineligible)
    }

    fn claim_collection(&mut self, entries: usize) -> Result<(), CapsuleEncodingFailure> {
        self.budget
            .claim_collection(entries, VALUE_CAPSULE_LIMITS)
            .map_err(|_| CapsuleEncodingFailure::Ineligible)
    }

    fn claim_bytes(&mut self, bytes: usize) -> Result<(), CapsuleEncodingFailure> {
        self.budget
            .claim_bytes(bytes, VALUE_CAPSULE_LIMITS)
            .map_err(|_| CapsuleEncodingFailure::Ineligible)
    }

    fn claim_allocation(&mut self, bytes: u64) -> Result<(), CapsuleEncodingFailure> {
        self.budget
            .claim_allocation(bytes, VALUE_CAPSULE_LIMITS)
            .map_err(|_| CapsuleEncodingFailure::Ineligible)
    }

    fn encode_environment(
        &mut self,
        environment: &Environment,
    ) -> Result<u32, CapsuleEncodingFailure> {
        let root = self.intern_environment(environment)?;
        if self.encoding_environments {
            return Ok(root);
        }
        self.encoding_environments = true;
        while let Some((environment, id)) = self.pending_environments.pop() {
            let parent = environment
                .parent
                .borrow()
                .as_ref()
                .map(|parent| self.intern_environment(parent))
                .transpose()?;
            self.encode_environment_record(&environment, id, parent)?;
        }
        self.encoding_environments = false;
        Ok(root)
    }

    fn intern_environment(
        &mut self,
        environment: &Environment,
    ) -> Result<u32, CapsuleEncodingFailure> {
        let identity = Rc::as_ptr(environment) as usize;
        if let Some(id) = self.environment_ids.get(&identity) {
            return Ok(*id);
        }
        self.claim_node(0)?;
        let id = u32::try_from(self.environments.len()).map_err(|_| {
            CapsuleEncodingFailure::Invalid(
                "value capsule exhausted u32 environment identities".to_owned(),
            )
        })?;
        self.environment_ids.insert(identity, id);
        self.environments.push(None);
        self.pending_environments.push((environment.clone(), id));
        Ok(id)
    }

    fn encode_environment_record(
        &mut self,
        environment: &Environment,
        id: u32,
        parent: Option<u32>,
    ) -> Result<(), CapsuleEncodingFailure> {
        self.claim_collection(environment.names.borrow().len())?;
        let names = environment
            .names
            .borrow()
            .iter()
            .map(|(name, value)| {
                self.claim_bytes(name.len())?;
                Ok((name.clone(), self.encode_value(value, 1)?))
            })
            .collect::<Result<_, CapsuleEncodingFailure>>()?;
        let recursive_binding_count = environment
            .recursive_bindings
            .as_ref()
            .map(|bindings| bindings.len())
            .unwrap_or_default();
        self.claim_collection(recursive_binding_count)?;
        let recursive_bindings = environment
            .recursive_bindings
            .as_ref()
            .map(|bindings| bindings.values())
            .unwrap_or_default();
        let recursive_names = recursive_bindings
            .into_iter()
            .map(|(name, value)| {
                self.claim_bytes(name.len())?;
                let Value::Closure {
                    environment: closure_environment,
                    ..
                } = &value
                else {
                    return Err(CapsuleEncodingFailure::Invalid(format!(
                        "recursive binding {name:?} is not a closure"
                    )));
                };
                if !Rc::ptr_eq(environment, closure_environment) {
                    return Err(CapsuleEncodingFailure::Invalid(format!(
                        "recursive binding {name:?} captures a different environment"
                    )));
                }
                Ok((name, self.encode_closure(&value, 1)?))
            })
            .collect::<Result<_, CapsuleEncodingFailure>>()?;
        self.claim_collection(environment.opens.borrow().len())?;
        let opens = environment
            .opens
            .borrow()
            .iter()
            .map(|opened| self.encode_fields(opened.fields(), 1))
            .collect::<Result<_, _>>()?;
        self.claim_collection(environment.type_substitutions.borrow().len())?;
        let type_substitutions = environment
            .type_substitutions
            .borrow()
            .iter()
            .map(|(variable, value)| Ok((*variable, self.encode_value(value, 1)?)))
            .collect::<Result<_, CapsuleEncodingFailure>>()?;
        self.environments[id as usize] = Some(CapsuleEnvironment {
            parent,
            names,
            recursive_names,
            opens,
            type_substitutions,
        });
        Ok(())
    }

    fn encode_fields(
        &mut self,
        fields: &OrderedFields,
        depth: usize,
    ) -> Result<Vec<(String, CapsuleValue)>, CapsuleEncodingFailure> {
        self.claim_collection(fields.len())?;
        fields
            .iter()
            .map(|(name, value)| {
                self.claim_bytes(name.len())?;
                Ok((name.clone(), self.encode_value(value, depth)?))
            })
            .collect()
    }

    fn encode_values(
        &mut self,
        values: &[Value],
        depth: usize,
    ) -> Result<Vec<CapsuleValue>, CapsuleEncodingFailure> {
        self.claim_collection(values.len())?;
        values
            .iter()
            .map(|value| self.encode_value(value, depth))
            .collect()
    }

    fn encode_value(
        &mut self,
        value: &Value,
        depth: usize,
    ) -> Result<CapsuleValue, CapsuleEncodingFailure> {
        self.claim_node(depth)?;
        Ok(match value {
            Value::Int(value) => {
                self.claim_allocation(value.bits().div_ceil(8))?;
                CapsuleValue::Int(value.clone())
            }
            Value::Float(value) => CapsuleValue::Float(*value),
            Value::Float32(value) => CapsuleValue::Float32(*value),
            Value::Vector(value) => CapsuleValue::Vector(*value),
            Value::VectorMask(value) => CapsuleValue::VectorMask(*value),
            Value::IntegerVector { bits, lanes } => {
                self.claim_collection(lanes.len())?;
                CapsuleValue::IntegerVector {
                    bits: *bits,
                    lanes: lanes.clone(),
                }
            }
            Value::IntegerVectorMask { bits, lanes } => {
                self.claim_collection(lanes.len())?;
                CapsuleValue::IntegerVectorMask {
                    bits: *bits,
                    lanes: lanes.clone(),
                }
            }
            Value::Text(value) => {
                self.claim_bytes(value.len())?;
                CapsuleValue::Text(value.clone())
            }
            Value::Unit => CapsuleValue::Unit,
            Value::Shape(fields) => CapsuleValue::Shape(self.encode_fields(fields, depth + 1)?),
            Value::Array(values) => CapsuleValue::Array(self.encode_values(values, depth + 1)?),
            Value::RegionType(element) => {
                CapsuleValue::RegionType(Box::new(self.encode_value(element, depth + 1)?))
            }
            Value::ScratchType(element) => {
                CapsuleValue::ScratchType(Box::new(self.encode_value(element, depth + 1)?))
            }
            Value::DeferredScratch { capacity } => CapsuleValue::DeferredScratch {
                capacity: Box::new(self.encode_value(capacity, depth + 1)?),
            },
            Value::EmptyArray { element } => CapsuleValue::EmptyArray {
                element: Box::new(self.encode_value(element, depth + 1)?),
            },
            Value::Tag { name, payload } => {
                self.claim_bytes(name.len())?;
                CapsuleValue::Tag {
                    name: name.clone(),
                    payload: payload
                        .as_deref()
                        .map(|payload| self.encode_value(payload, depth + 1).map(Box::new))
                        .transpose()?,
                }
            }
            Value::Closure { environment, .. } => CapsuleValue::Closure {
                closure: self.encode_closure(value, depth + 1)?,
                environment: self.encode_environment(environment)?,
            },
            Value::ModuleClosure { module } => CapsuleValue::ModuleClosure {
                module: self.encode_module(module)?,
            },
            Value::IndexedStep { elements } => CapsuleValue::IndexedStep {
                elements: self.encode_values(elements, depth + 1)?,
            },
            Value::Primitive {
                name,
                arity,
                applied,
            } => {
                self.claim_bytes(name.len())?;
                CapsuleValue::Primitive {
                    name: name.clone(),
                    arity: u32::try_from(*arity).map_err(|_| {
                        CapsuleEncodingFailure::Invalid(format!(
                            "primitive {name} arity {arity} exceeds u32"
                        ))
                    })?,
                    applied: self.encode_values(applied, depth + 1)?,
                }
            }
            Value::Range { low, high, domain } => CapsuleValue::Range {
                low: Box::new(self.encode_value(low, depth + 1)?),
                high: Box::new(self.encode_value(high, depth + 1)?),
                domain: domain.map(encode_domain),
            },
            Value::Union(values) => CapsuleValue::Union(self.encode_values(values, depth + 1)?),
            Value::Unbounded => CapsuleValue::Unbounded,
            Value::Arrow {
                deferred,
                domain,
                codomain,
                effects,
                effect_tail,
            } => CapsuleValue::Arrow {
                deferred: *deferred,
                domain: Box::new(self.encode_value(domain, depth + 1)?),
                codomain: Box::new(self.encode_value(codomain, depth + 1)?),
                effects: self.encode_values(effects, depth + 1)?,
                effect_tail: *effect_tail,
            },
            Value::TypeVariable(variable) => CapsuleValue::TypeVariable(*variable),
            Value::Forall { variable, body } => CapsuleValue::Forall {
                variable: *variable,
                body: Box::new(self.encode_value(body, depth + 1)?),
            },
            Value::Extended { inner, members } => CapsuleValue::Extended {
                inner: Box::new(self.encode_value(inner, depth + 1)?),
                members: self.encode_fields(members, depth + 1)?,
            },
            Value::Sealed { name, inner } => {
                self.claim_bytes(name.len())?;
                CapsuleValue::Sealed {
                    name: name.clone(),
                    inner: Box::new(self.encode_value(inner, depth + 1)?),
                }
            }
            Value::OpaqueType(name) if name.starts_with("Effect:") => {
                return Err(CapsuleEncodingFailure::Ineligible);
            }
            Value::OpaqueType(name) => {
                self.claim_bytes(name.len())?;
                CapsuleValue::OpaqueType(name.clone())
            }
            Value::Scratch { .. }
            | Value::Region { .. }
            | Value::RegionRejoin { .. }
            | Value::Deferred { .. }
            | Value::ClosureChoice { .. }
            | Value::Effect { .. }
            | Value::Operation { .. }
            | Value::Runtime(_)
            | Value::Continuation { .. } => {
                return Err(CapsuleEncodingFailure::Ineligible);
            }
        })
    }

    fn encode_closure(
        &mut self,
        value: &Value,
        depth: usize,
    ) -> Result<CapsuleClosure, CapsuleEncodingFailure> {
        self.claim_node(depth)?;
        let Value::Closure {
            module,
            module_instances,
            effect_scope,
            parameter,
            body,
            self_name,
            imports,
            reuse_assertion,
            deferred,
            ..
        } = value
        else {
            return Err(CapsuleEncodingFailure::Invalid(
                "value capsule expected a closure".to_owned(),
            ));
        };
        if let Some(self_name) = self_name {
            self.claim_bytes(self_name.len())?;
        }
        if let Some(imports) = imports {
            self.claim_collection(imports.len())?;
            for (name, path) in imports {
                self.claim_bytes(name.len())?;
                self.claim_bytes(path.len())?;
            }
        }
        Ok(CapsuleClosure {
            module: self.encode_module(module)?,
            module_instances: self.encode_module_instances(module_instances, depth + 1)?,
            effect_scope: self.encode_effect_scope(effect_scope, depth + 1)?,
            parameter: *parameter,
            body: *body,
            self_name: self_name.clone(),
            imports: imports.clone(),
            reuse_assertion: *reuse_assertion,
            deferred: *deferred,
        })
    }

    fn encode_effect_scope(
        &mut self,
        effect_scope: &Rc<EffectScope>,
        depth: usize,
    ) -> Result<u32, CapsuleEncodingFailure> {
        let identity = Rc::as_ptr(effect_scope) as usize;
        if let Some(id) = self.effect_scope_ids.get(&identity) {
            return Ok(*id);
        }
        self.claim_node(depth)?;
        let id = u32::try_from(self.effect_scopes.len()).map_err(|_| {
            CapsuleEncodingFailure::Invalid(
                "value capsule exhausted u32 effect-scope identities".to_owned(),
            )
        })?;
        self.effect_scope_ids.insert(identity, id);
        self.effect_scopes.push(None);
        self.claim_collection(effect_scope.len())?;
        let mut encoded = Vec::with_capacity(effect_scope.len());
        for frame in effect_scope.iter() {
            self.claim_node(depth + 1)?;
            encoded.push(CapsuleClosureApplication {
                application: self.encode_application_site(&frame.application, depth + 2)?,
                creation_scope: self.encode_effect_scope(&frame.creation_scope, depth + 2)?,
            });
        }
        self.effect_scopes[id as usize] = Some(encoded);
        Ok(id)
    }

    fn encode_module_instances(
        &mut self,
        module_instances: &ModuleInstanceScope,
        depth: usize,
    ) -> Result<Vec<CapsuleModuleInstanceSite>, CapsuleEncodingFailure> {
        self.claim_collection(module_instances.len())?;
        module_instances
            .iter()
            .map(|site| {
                self.claim_node(depth)?;
                self.require_local_revision(&site.imported)?;
                Ok(CapsuleModuleInstanceSite {
                    application: self.encode_application_site(&site.application, depth + 1)?,
                })
            })
            .collect()
    }

    fn encode_application_site(
        &mut self,
        application: &ApplicationSite,
        depth: usize,
    ) -> Result<CapsuleApplicationSite, CapsuleEncodingFailure> {
        self.claim_node(depth)?;
        let root = match &application.root {
            ApplicationRoot::Expression {
                revision,
                expression,
            } => {
                self.require_local_revision(revision)?;
                CapsuleApplicationRoot::Expression(*expression)
            }
            ApplicationRoot::Declaration {
                revision,
                declaration,
            } => {
                self.require_local_revision(revision)?;
                CapsuleApplicationRoot::Declaration(*declaration)
            }
        };
        self.claim_collection(application.compiler_steps.len())?;
        let compiler_steps = application
            .compiler_steps
            .iter()
            .map(|step| self.encode_compiler_application(step, depth + 1))
            .collect::<Result<_, _>>()?;
        Ok(CapsuleApplicationSite {
            root,
            compiler_steps,
        })
    }

    fn encode_compiler_application(
        &mut self,
        application: &CompilerApplication,
        depth: usize,
    ) -> Result<CapsuleCompilerApplication, CapsuleEncodingFailure> {
        self.claim_node(depth)?;
        Ok(match application {
            CompilerApplication::ForceEffectDeclaration => {
                CapsuleCompilerApplication::ForceEffectDeclaration
            }
            CompilerApplication::ForallBody => CapsuleCompilerApplication::ForallBody,
            CompilerApplication::IncludeParser => CapsuleCompilerApplication::IncludeParser,
            CompilerApplication::HandleThunk => CapsuleCompilerApplication::HandleThunk,
            CompilerApplication::HandleReturn => CapsuleCompilerApplication::HandleReturn,
            CompilerApplication::HandleOperation { operation, request } => {
                self.claim_bytes(operation.len())?;
                CapsuleCompilerApplication::HandleOperation {
                    operation: operation.clone(),
                    request: Box::new(self.encode_application_site(request, depth + 1)?),
                }
            }
            CompilerApplication::RequirementPredicate => {
                CapsuleCompilerApplication::RequirementPredicate
            }
            CompilerApplication::RecognitionArgument { probe, position } => {
                CapsuleCompilerApplication::RecognitionArgument {
                    probe: encode_recognition_probe(*probe),
                    position: *position,
                }
            }
            CompilerApplication::RuntimeExportParameter(parameter) => {
                CapsuleCompilerApplication::RuntimeExportParameter(*parameter)
            }
        })
    }

    fn require_local_revision(
        &self,
        revision: &ModuleRevision,
    ) -> Result<(), CapsuleEncodingFailure> {
        if revision == &self.module_revision {
            return Ok(());
        }
        Err(CapsuleEncodingFailure::Ineligible)
    }

    fn encode_module(&self, module: &str) -> Result<CapsuleModule, CapsuleEncodingFailure> {
        if module == self.module_path {
            return Ok(CapsuleModule::Local);
        }
        Err(CapsuleEncodingFailure::Ineligible)
    }
}

fn encode_recognition_probe(probe: RecognitionProbe) -> CapsuleRecognitionProbe {
    match probe {
        RecognitionProbe::Integer { left, right } => {
            CapsuleRecognitionProbe::Integer { left, right }
        }
        RecognitionProbe::Boolean { left, right } => {
            CapsuleRecognitionProbe::Boolean { left, right }
        }
        RecognitionProbe::BooleanUnary { argument } => {
            CapsuleRecognitionProbe::BooleanUnary { argument }
        }
    }
}

fn decode_effect_scopes(
    encoded: &[Vec<CapsuleClosureApplication>],
    module_path: &str,
    module: &Module,
    module_revision: &ModuleRevision,
    base_effect_scope: &Rc<EffectScope>,
) -> Result<Vec<Rc<EffectScope>>, String> {
    let mut decoded = vec![None; encoded.len()];
    let mut visiting = HashSet::new();
    let mut decoder = EffectScopeDecoder {
        encoded,
        module_path,
        module,
        module_revision,
        base_effect_scope,
        decoded: &mut decoded,
        visiting: &mut visiting,
    };
    for id in 0..encoded.len() {
        decoder.decode(
            u32::try_from(id)
                .map_err(|_| "value capsule has more than u32 effect scopes".to_owned())?,
        )?;
    }
    decoded
        .into_iter()
        .enumerate()
        .map(|(id, effect_scope)| {
            effect_scope.ok_or_else(|| format!("value capsule omitted decoded effect scope {id}"))
        })
        .collect()
}

struct EffectScopeDecoder<'a> {
    encoded: &'a [Vec<CapsuleClosureApplication>],
    module_path: &'a str,
    module: &'a Module,
    module_revision: &'a ModuleRevision,
    base_effect_scope: &'a Rc<EffectScope>,
    decoded: &'a mut [Option<Rc<EffectScope>>],
    visiting: &'a mut HashSet<u32>,
}

impl EffectScopeDecoder<'_> {
    fn decode(&mut self, id: u32) -> Result<Rc<EffectScope>, String> {
        if let Some(effect_scope) = self.decoded.get(id as usize).and_then(Option::as_ref) {
            return Ok(effect_scope.clone());
        }
        if !self.visiting.insert(id) {
            return Err(format!("value capsule effect scope {id} is cyclic"));
        }
        let frame_count = self
            .encoded
            .get(id as usize)
            .ok_or_else(|| format!("value capsule references missing effect scope {id}"))?
            .len();
        if frame_count == 0 {
            self.visiting.remove(&id);
            self.decoded[id as usize] = Some(self.base_effect_scope.clone());
            return Ok(self.base_effect_scope.clone());
        }
        let mut effect_scope = Vec::with_capacity(self.base_effect_scope.len() + frame_count);
        effect_scope.extend(self.base_effect_scope.iter().cloned());
        for frame_index in 0..frame_count {
            let (application, creation_scope) = {
                let frame = &self.encoded[id as usize][frame_index];
                (
                    decode_application_site(
                        &frame.application,
                        self.module_path,
                        self.module,
                        self.module_revision,
                    )?,
                    frame.creation_scope,
                )
            };
            effect_scope.push(ClosureApplication {
                application,
                creation_scope: self.decode(creation_scope)?,
            });
        }
        self.visiting.remove(&id);
        let effect_scope = Rc::new(effect_scope);
        self.decoded[id as usize] = Some(effect_scope.clone());
        Ok(effect_scope)
    }
}

fn decode_module_instances(
    encoded: &[CapsuleModuleInstanceSite],
    module_path: &str,
    module: &Module,
    module_revision: &ModuleRevision,
    base_module_instances: &ModuleInstanceScope,
) -> Result<ModuleInstanceScope, String> {
    let mut module_instances = Vec::with_capacity(base_module_instances.len() + encoded.len());
    module_instances.extend(base_module_instances.iter().cloned());
    for site in encoded {
        module_instances.push(ModuleInstanceSite {
            application: decode_application_site(
                &site.application,
                module_path,
                module,
                module_revision,
            )?,
            imported: module_revision.clone(),
        });
    }
    Ok(module_instances)
}

fn decode_application_site(
    encoded: &CapsuleApplicationSite,
    module_path: &str,
    module: &Module,
    module_revision: &ModuleRevision,
) -> Result<ApplicationSite, String> {
    let root = match encoded.root {
        CapsuleApplicationRoot::Expression(expression) => {
            if expression.0 as usize >= module.arena.expressions.len() {
                return Err(format!(
                    "value capsule application in {module_path} references missing expression {}",
                    expression.0
                ));
            }
            ApplicationRoot::Expression {
                revision: module_revision.clone(),
                expression,
            }
        }
        CapsuleApplicationRoot::Declaration(declaration) => {
            if declaration.0 as usize >= module.arena.declarations.len() {
                return Err(format!(
                    "value capsule application in {module_path} references missing declaration {}",
                    declaration.0
                ));
            }
            ApplicationRoot::Declaration {
                revision: module_revision.clone(),
                declaration,
            }
        }
    };
    let compiler_steps = encoded
        .compiler_steps
        .iter()
        .map(|step| decode_compiler_application(step, module_path, module, module_revision))
        .collect::<Result<_, _>>()?;
    Ok(ApplicationSite {
        root,
        compiler_steps,
    })
}

fn decode_compiler_application(
    encoded: &CapsuleCompilerApplication,
    module_path: &str,
    module: &Module,
    module_revision: &ModuleRevision,
) -> Result<CompilerApplication, String> {
    Ok(match encoded {
        CapsuleCompilerApplication::ForceEffectDeclaration => {
            CompilerApplication::ForceEffectDeclaration
        }
        CapsuleCompilerApplication::ForallBody => CompilerApplication::ForallBody,
        CapsuleCompilerApplication::IncludeParser => CompilerApplication::IncludeParser,
        CapsuleCompilerApplication::HandleThunk => CompilerApplication::HandleThunk,
        CapsuleCompilerApplication::HandleReturn => CompilerApplication::HandleReturn,
        CapsuleCompilerApplication::HandleOperation { operation, request } => {
            CompilerApplication::HandleOperation {
                operation: operation.clone(),
                request: Box::new(decode_application_site(
                    request,
                    module_path,
                    module,
                    module_revision,
                )?),
            }
        }
        CapsuleCompilerApplication::RequirementPredicate => {
            CompilerApplication::RequirementPredicate
        }
        CapsuleCompilerApplication::RecognitionArgument { probe, position } => {
            CompilerApplication::RecognitionArgument {
                probe: decode_recognition_probe(probe),
                position: *position,
            }
        }
        CapsuleCompilerApplication::RuntimeExportParameter(parameter) => {
            CompilerApplication::RuntimeExportParameter(*parameter)
        }
    })
}

fn decode_recognition_probe(probe: &CapsuleRecognitionProbe) -> RecognitionProbe {
    match probe {
        CapsuleRecognitionProbe::Integer { left, right } => RecognitionProbe::Integer {
            left: *left,
            right: *right,
        },
        CapsuleRecognitionProbe::Boolean { left, right } => RecognitionProbe::Boolean {
            left: *left,
            right: *right,
        },
        CapsuleRecognitionProbe::BooleanUnary { argument } => RecognitionProbe::BooleanUnary {
            argument: *argument,
        },
    }
}

fn decode_fields(
    fields: &[(String, CapsuleValue)],
    environments: &[Environment],
    provenance: &CapsuleDecodeProvenance,
    module_path: &str,
    module: &Module,
    context: &Context,
) -> Result<OrderedFields, String> {
    fields
        .iter()
        .map(|(name, value)| {
            Ok((
                name.clone(),
                decode_value(
                    value,
                    environments,
                    provenance,
                    module_path,
                    module,
                    context,
                )?,
            ))
        })
        .collect()
}

fn decode_values(
    values: &[CapsuleValue],
    environments: &[Environment],
    provenance: &CapsuleDecodeProvenance,
    module_path: &str,
    module: &Module,
    context: &Context,
) -> Result<Vec<Value>, String> {
    values
        .iter()
        .map(|value| {
            decode_value(
                value,
                environments,
                provenance,
                module_path,
                module,
                context,
            )
        })
        .collect()
}

fn decode_value(
    value: &CapsuleValue,
    environments: &[Environment],
    provenance: &CapsuleDecodeProvenance,
    module_path: &str,
    module: &Module,
    context: &Context,
) -> Result<Value, String> {
    Ok(match value {
        CapsuleValue::Int(value) => Value::Int(value.clone()),
        CapsuleValue::Float(value) => Value::Float(*value),
        CapsuleValue::Float32(value) => Value::Float32(*value),
        CapsuleValue::Vector(value) => Value::Vector(*value),
        CapsuleValue::VectorMask(value) => Value::VectorMask(*value),
        CapsuleValue::IntegerVector { bits, lanes } => Value::IntegerVector {
            bits: *bits,
            lanes: lanes.clone(),
        },
        CapsuleValue::IntegerVectorMask { bits, lanes } => Value::IntegerVectorMask {
            bits: *bits,
            lanes: lanes.clone(),
        },
        CapsuleValue::Text(value) => Value::Text(value.clone()),
        CapsuleValue::Unit => Value::Unit,
        CapsuleValue::Shape(fields) => Value::Shape(decode_fields(
            fields,
            environments,
            provenance,
            module_path,
            module,
            context,
        )?),
        CapsuleValue::Array(values) => Value::Array(
            decode_values(
                values,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?
            .into(),
        ),
        CapsuleValue::RegionType(element) => Value::RegionType(Box::new(decode_value(
            element,
            environments,
            provenance,
            module_path,
            module,
            context,
        )?)),
        CapsuleValue::ScratchType(element) => Value::ScratchType(Box::new(decode_value(
            element,
            environments,
            provenance,
            module_path,
            module,
            context,
        )?)),
        CapsuleValue::DeferredScratch { capacity } => Value::DeferredScratch {
            capacity: Box::new(decode_value(
                capacity,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?),
        },
        CapsuleValue::EmptyArray { element } => Value::EmptyArray {
            element: Box::new(decode_value(
                element,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?),
        },
        CapsuleValue::Tag { name, payload } => Value::Tag {
            name: name.clone(),
            payload: payload
                .as_deref()
                .map(|payload| {
                    decode_value(
                        payload,
                        environments,
                        provenance,
                        module_path,
                        module,
                        context,
                    )
                    .map(Box::new)
                })
                .transpose()?,
        },
        CapsuleValue::Closure {
            closure,
            environment,
        } => {
            let environment = environments
                .get(*environment as usize)
                .cloned()
                .ok_or_else(|| {
                    format!(
                        "value capsule closure #{} references missing environment {environment}",
                        closure.body.0
                    )
                })?;
            decode_closure(
                closure,
                environment,
                provenance,
                module_path,
                module,
                context,
            )?
        }
        CapsuleValue::ModuleClosure {
            module: encoded_module,
        } => Value::ModuleClosure {
            module: decode_module(encoded_module, module_path)?,
        },
        CapsuleValue::IndexedStep { elements } => Value::IndexedStep {
            elements: decode_values(
                elements,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?,
        },
        CapsuleValue::Primitive {
            name,
            arity,
            applied,
        } => Value::Primitive {
            name: name.clone(),
            arity: usize::try_from(*arity)
                .map_err(|_| format!("primitive {name} arity {arity} exceeds usize"))?,
            applied: decode_values(
                applied,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?,
        },
        CapsuleValue::Range { low, high, domain } => Value::Range {
            low: Box::new(decode_value(
                low,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?),
            high: Box::new(decode_value(
                high,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?),
            domain: domain.map(decode_domain).transpose()?,
        },
        CapsuleValue::Union(values) => Value::Union(decode_values(
            values,
            environments,
            provenance,
            module_path,
            module,
            context,
        )?),
        CapsuleValue::Unbounded => Value::Unbounded,
        CapsuleValue::Arrow {
            deferred,
            domain,
            codomain,
            effects,
            effect_tail,
        } => Value::Arrow {
            deferred: *deferred,
            domain: Box::new(decode_value(
                domain,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?),
            codomain: Box::new(decode_value(
                codomain,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?),
            effects: decode_values(
                effects,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?,
            effect_tail: *effect_tail,
        },
        CapsuleValue::TypeVariable(variable) => Value::TypeVariable(*variable),
        CapsuleValue::Forall { variable, body } => Value::Forall {
            variable: *variable,
            body: Box::new(decode_value(
                body,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?),
        },
        CapsuleValue::Extended { inner, members } => Value::Extended {
            inner: Box::new(decode_value(
                inner,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?),
            members: decode_fields(
                members,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?,
        },
        CapsuleValue::Sealed { name, inner } => Value::Sealed {
            name: name.clone(),
            inner: Box::new(decode_value(
                inner,
                environments,
                provenance,
                module_path,
                module,
                context,
            )?),
        },
        CapsuleValue::OpaqueType(name) if name.starts_with("Effect:") => {
            return Err(format!(
                "value capsule contains generative effect type {name}"
            ));
        }
        CapsuleValue::OpaqueType(name) => Value::OpaqueType(name.clone()),
    })
}

fn decode_closure(
    closure: &CapsuleClosure,
    environment: Environment,
    provenance: &CapsuleDecodeProvenance,
    module_path: &str,
    module: &Module,
    context: &Context,
) -> Result<Value, String> {
    let closure_module = decode_module(&closure.module, module_path)?;
    validate_closure(
        module_path,
        provenance.source_closures,
        closure.parameter,
        closure.body,
        closure.deferred,
    )?;
    capture_env(&environment);
    Ok(Value::Closure {
        module: Rc::new(closure_module.clone()),
        module_instances: Rc::new(decode_module_instances(
            &closure.module_instances,
            module_path,
            module,
            provenance.module_revision,
            provenance.module_instances,
        )?),
        effect_scope: provenance
            .effect_scopes
            .get(closure.effect_scope as usize)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "value capsule closure {closure_module}#{} references missing effect scope {}",
                    closure.body.0, closure.effect_scope
                )
            })?,
        parameter: closure.parameter,
        body: closure.body,
        environment,
        self_name: closure.self_name.clone(),
        imports: closure.imports.clone(),
        signature: context
            .closure_signature(&closure_module, closure.body)
            .map(Box::new),
        reuse_assertion: closure.reuse_assertion,
        deferred: closure.deferred,
    })
}

fn decode_module(module: &CapsuleModule, module_path: &str) -> Result<String, String> {
    match module {
        CapsuleModule::Local => Ok(module_path.to_owned()),
        CapsuleModule::External(module) => Err(format!(
            "value capsule for dependency-free module {module_path} references external module {module}"
        )),
    }
}

fn validate_closure(
    module_path: &str,
    source_closures: &HashSet<CapsuleClosureIdentity>,
    parameter: PatternId,
    body: ExpressionId,
    deferred: bool,
) -> Result<(), String> {
    if source_closures.contains(&CapsuleClosureIdentity {
        parameter,
        body,
        deferred,
    }) {
        return Ok(());
    }
    Err(format!(
        "value capsule closure {module_path}#{} has no matching source lambda for parameter {}",
        body.0, parameter.0
    ))
}

fn encode_domain(domain: Domain) -> u8 {
    match domain {
        Domain::Int => 0,
        Domain::Text => 1,
        Domain::Float => 2,
        Domain::Float32 => 3,
    }
}

fn decode_domain(domain: u8) -> Result<Domain, String> {
    match domain {
        0 => Ok(Domain::Int),
        1 => Ok(Domain::Text),
        2 => Ok(Domain::Float),
        3 => Ok(Domain::Float32),
        _ => Err(format!("value capsule has unknown domain {domain}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_module(path: &str) -> (Module, ModuleRevision) {
        let span = Span { start: 0, end: 0 };
        let mut arena = crate::ast::AstArena::default();
        let result = arena.expression(Expression::Unit { span });
        let module = Module {
            parameter: None,
            declarations: Vec::new(),
            result,
            result_effects: crate::ast::ResultEffects::Pure,
            span,
            arena,
        };
        let loaded = crate::eval::LoadedModule::new(
            path,
            Rc::new(module.clone()),
            BTreeMap::new(),
            BTreeMap::new(),
        );
        (module, loaded.revision())
    }

    fn application(revision: &ModuleRevision, expression: ExpressionId) -> ApplicationSite {
        ApplicationSite {
            root: ApplicationRoot::Expression {
                revision: revision.clone(),
                expression,
            },
            compiler_steps: Vec::new(),
        }
    }

    fn capsule_closure(self_name: Option<&str>) -> CapsuleClosure {
        CapsuleClosure {
            module: CapsuleModule::Local,
            module_instances: Vec::new(),
            effect_scope: 0,
            parameter: PatternId(0),
            body: ExpressionId(0),
            self_name: self_name.map(str::to_owned),
            imports: None,
            reuse_assertion: None,
            deferred: false,
        }
    }

    fn closure(environment: u32) -> CapsuleValue {
        CapsuleValue::Closure {
            closure: capsule_closure(None),
            environment,
        }
    }

    fn environment(parent: Option<u32>) -> CapsuleEnvironment {
        CapsuleEnvironment {
            parent,
            names: BTreeMap::new(),
            recursive_names: BTreeMap::new(),
            opens: Vec::new(),
            type_substitutions: BTreeMap::new(),
        }
    }

    #[test]
    fn environment_parent_graph_depth_is_bounded_during_iterative_encoding() {
        const PATH: &str = "environment-depth.blot";
        let (module, revision) = test_module(PATH);
        let mut at_limit = child_env(None);
        for _ in 0..VALUE_CAPSULE_MAX_ENVIRONMENT_GRAPH_DEPTH {
            at_limit = child_env(Some(at_limit));
        }
        assert!(
            ValueCapsule::encode(&at_limit, PATH, &module, &revision)
                .expect("an environment at the graph depth limit should encode")
                .is_some()
        );

        let over_limit = child_env(Some(at_limit));
        assert!(
            ValueCapsule::encode(&over_limit, PATH, &module, &revision)
                .expect("a deep environment is cache-ineligible, not invalid source")
                .is_none()
        );
    }

    #[test]
    fn closure_environment_edges_are_encoded_by_the_environment_worklist() {
        std::thread::Builder::new()
            .name("capsule-closure-environment-depth".to_owned())
            .stack_size(64 * 1024)
            .spawn(|| {
                const PATH: &str = "environment-closure-depth.blot";
                const CAPTURE_DEPTH: usize = 300;
                let (module, revision) = test_module(PATH);
                let mut environment = child_env(None);
                for index in 0..CAPTURE_DEPTH {
                    let parent = child_env(None);
                    parent.names.borrow_mut().insert(
                        format!("closure{index}"),
                        Value::Closure {
                            module: Rc::new(PATH.to_owned()),
                            module_instances: Rc::new(Vec::new()),
                            effect_scope: Rc::new(Vec::new()),
                            parameter: PatternId(0),
                            body: module.result,
                            environment,
                            self_name: None,
                            imports: None,
                            signature: None,
                            reuse_assertion: None,
                            deferred: false,
                        },
                    );
                    environment = parent;
                }

                let encoded = ValueCapsule::encode(&environment, PATH, &module, &revision)
                    .expect("closure environment worklist should remain valid");
                assert!(encoded.is_some());

                // Recursive destruction of the synthetic capture chain would test
                // `Env` drop behavior rather than the capsule encoder.
                let mut remaining = Some(environment);
                while let Some(environment) = remaining {
                    remaining = environment.names.borrow_mut().pop_first().and_then(
                        |(_, value)| match value {
                            Value::Closure { environment, .. } => Some(environment),
                            _ => None,
                        },
                    );
                }
            })
            .expect("small-stack closure environment test thread should start")
            .join()
            .expect("small-stack closure environment test thread should finish");
    }

    #[test]
    fn nested_value_depth_is_bounded_before_recursive_encoding() {
        const PATH: &str = "value-depth.blot";
        let (module, revision) = test_module(PATH);
        let mut value = Value::Unit;
        for index in 0..VALUE_CAPSULE_MAX_DEPTH {
            value = Value::Sealed {
                name: format!("Layer{index}"),
                inner: Box::new(value),
            };
        }
        let environment = child_env(None);
        environment
            .names
            .borrow_mut()
            .insert("deep".to_owned(), value);

        assert!(
            ValueCapsule::encode(&environment, PATH, &module, &revision)
                .expect("a deep value is cache-ineligible, not invalid source")
                .is_none()
        );
    }

    #[test]
    fn effect_scope_depth_is_bounded_before_recursive_encoding() {
        const PATH: &str = "effect-scope-depth.blot";
        let (module, revision) = test_module(PATH);
        let mut effect_scope = Rc::new(Vec::new());
        for _ in 0..VALUE_CAPSULE_MAX_DEPTH {
            effect_scope = Rc::new(vec![ClosureApplication {
                application: application(&revision, module.result),
                creation_scope: effect_scope,
            }]);
        }
        let environment = child_env(None);
        environment.names.borrow_mut().insert(
            "deep".to_owned(),
            Value::Closure {
                module: Rc::new(PATH.to_owned()),
                module_instances: Rc::new(Vec::new()),
                effect_scope,
                parameter: PatternId(0),
                body: module.result,
                environment: child_env(None),
                self_name: None,
                imports: None,
                signature: None,
                reuse_assertion: None,
                deferred: false,
            },
        );

        assert!(
            ValueCapsule::encode(&environment, PATH, &module, &revision)
                .expect("deep effect provenance is cache-ineligible, not invalid source")
                .is_none()
        );
    }

    #[test]
    fn application_provenance_depth_is_bounded_before_recursive_encoding() {
        const PATH: &str = "application-depth.blot";
        let (module, revision) = test_module(PATH);
        let mut provenance = application(&revision, module.result);
        for _ in 0..VALUE_CAPSULE_MAX_DEPTH {
            provenance = ApplicationSite {
                root: ApplicationRoot::Expression {
                    revision: revision.clone(),
                    expression: module.result,
                },
                compiler_steps: vec![CompilerApplication::HandleOperation {
                    operation: "request".to_owned(),
                    request: Box::new(provenance),
                }],
            };
        }
        let environment = child_env(None);
        environment.names.borrow_mut().insert(
            "deep".to_owned(),
            Value::Closure {
                module: Rc::new(PATH.to_owned()),
                module_instances: Rc::new(vec![ModuleInstanceSite {
                    application: provenance,
                    imported: revision.clone(),
                }]),
                effect_scope: Rc::new(Vec::new()),
                parameter: PatternId(0),
                body: module.result,
                environment: child_env(None),
                self_name: None,
                imports: None,
                signature: None,
                reuse_assertion: None,
                deferred: false,
            },
        );

        assert!(
            ValueCapsule::encode(&environment, PATH, &module, &revision)
                .expect("deep application provenance is cache-ineligible, not invalid source")
                .is_none()
        );
    }

    #[test]
    fn decoded_nested_values_are_bounded_before_recursive_validation() {
        let mut value = CapsuleValue::Unit;
        for index in 0..=VALUE_CAPSULE_MAX_DEPTH {
            value = CapsuleValue::Sealed {
                name: format!("Layer{index}"),
                inner: Box::new(value),
            };
        }
        let mut root = environment(None);
        root.names.insert("deep".to_owned(), value);
        let capsule = ValueCapsule {
            schema: VALUE_CAPSULE_SCHEMA,
            environments: vec![root],
            effect_scopes: Vec::new(),
            root: 0,
        };

        let error = capsule
            .validate_structural_budget()
            .expect_err("decoded values beyond the structural limit must be rejected");

        assert!(error.contains("maximum structural depth"), "{error}");
    }

    #[test]
    fn decoded_effect_scope_graphs_are_bounded_before_reconstruction() {
        let scope_count = VALUE_CAPSULE_MAX_DEPTH + 2;
        let effect_scopes = (0..scope_count)
            .map(|id| {
                if id + 1 == scope_count {
                    return Vec::new();
                }
                vec![CapsuleClosureApplication {
                    application: CapsuleApplicationSite {
                        root: CapsuleApplicationRoot::Expression(ExpressionId(0)),
                        compiler_steps: Vec::new(),
                    },
                    creation_scope: u32::try_from(id + 1).unwrap(),
                }]
            })
            .collect();
        let capsule = ValueCapsule {
            schema: VALUE_CAPSULE_SCHEMA,
            environments: vec![environment(None)],
            effect_scopes,
            root: 0,
        };

        let error = capsule
            .validate_effect_scope_graph()
            .expect_err("deep effect-scope graphs must be rejected");

        assert!(error.contains("maximum depth"), "{error}");
    }

    #[test]
    fn cyclic_effect_scope_graphs_are_rejected_before_publication() {
        let capsule = ValueCapsule {
            schema: VALUE_CAPSULE_SCHEMA,
            environments: vec![environment(None)],
            effect_scopes: vec![vec![CapsuleClosureApplication {
                application: CapsuleApplicationSite {
                    root: CapsuleApplicationRoot::Expression(ExpressionId(0)),
                    compiler_steps: Vec::new(),
                },
                creation_scope: 0,
            }]],
            root: 0,
        };

        let error = capsule
            .validate_effect_scope_graph()
            .expect_err("cyclic effect provenance must not be published");

        assert!(error.contains("contain a cycle"), "{error}");
    }

    #[test]
    fn reconstruction_budget_counts_each_caller_prefix_copy() {
        let mut root = environment(None);
        root.names.insert("first".to_owned(), closure(0));
        root.names.insert(
            "nested".to_owned(),
            CapsuleValue::Shape(vec![("second".to_owned(), closure(0))]),
        );
        let frame = || CapsuleClosureApplication {
            application: CapsuleApplicationSite {
                root: CapsuleApplicationRoot::Expression(ExpressionId(0)),
                compiler_steps: Vec::new(),
            },
            creation_scope: 0,
        };
        let capsule = ValueCapsule {
            schema: VALUE_CAPSULE_SCHEMA,
            environments: vec![root],
            effect_scopes: vec![vec![frame()], vec![frame()]],
            root: 0,
        };
        let base = capsule
            .structural_budget()
            .expect("test capsule should fit its structural budget")
            .allocation_bytes;
        let module_instance_prefix = 3;
        let effect_scope_prefix = 4;
        let copied_entries = module_instance_prefix * 3 + effect_scope_prefix * 2;
        let exact_limit = base + copied_entries * CAPSULE_COLLECTION_ENTRY_BYTES;
        take_structural_budget_scan_count();

        assert!(
            capsule
                .admit_reconstruction_with_allocation_limit(
                    module_instance_prefix as usize,
                    effect_scope_prefix as usize,
                    exact_limit,
                )
                .expect("the valid capsule should be admitted at its exact allocation limit")
                .is_some()
        );
        assert_eq!(take_structural_budget_scan_count(), 1);
        assert!(
            capsule
                .admit_reconstruction_with_allocation_limit(
                    module_instance_prefix as usize,
                    effect_scope_prefix as usize,
                    exact_limit - 1,
                )
                .expect("the valid capsule should remain valid below its allocation requirement")
                .is_none()
        );
        assert_eq!(take_structural_budget_scan_count(), 1);
    }

    #[test]
    fn reconstruction_admission_rejects_an_invalid_schema_before_scanning() {
        let capsule = ValueCapsule {
            schema: VALUE_CAPSULE_SCHEMA + 1,
            environments: vec![environment(None)],
            effect_scopes: Vec::new(),
            root: 0,
        };
        take_structural_budget_scan_count();

        let error = match capsule.admit_reconstruction(0, 0) {
            Err(error) => error,
            Ok(_) => panic!("an invalid schema must not produce reconstruction admission"),
        };

        assert!(error.contains("expected"), "{error}");
        assert_eq!(take_structural_budget_scan_count(), 0);
    }

    #[test]
    fn reconstruction_admission_reports_an_invalid_structural_budget() {
        let mut value = CapsuleValue::Unit;
        for index in 0..=VALUE_CAPSULE_MAX_DEPTH {
            value = CapsuleValue::Sealed {
                name: format!("Layer{index}"),
                inner: Box::new(value),
            };
        }
        let mut root = environment(None);
        root.names.insert("deep".to_owned(), value);
        let capsule = ValueCapsule {
            schema: VALUE_CAPSULE_SCHEMA,
            environments: vec![root],
            effect_scopes: Vec::new(),
            root: 0,
        };
        take_structural_budget_scan_count();

        let error = match capsule.admit_reconstruction(0, 0) {
            Err(error) => error,
            Ok(_) => panic!("an invalid structure must not become declaration replay"),
        };

        assert!(error.contains("maximum structural depth"), "{error}");
        assert_eq!(take_structural_budget_scan_count(), 1);
    }

    #[test]
    fn admitted_reconstruction_keeps_graph_validation_without_rescanning() {
        const PATH: &str = "admitted-graph-validation.blot";
        let (module, revision) = test_module(PATH);
        let mut root = environment(None);
        root.opens.push(vec![("read".to_owned(), closure(7))]);
        let capsule = ValueCapsule {
            schema: VALUE_CAPSULE_SCHEMA,
            environments: vec![root],
            effect_scopes: Vec::new(),
            root: 0,
        };
        let context = Context::default();
        let module_instances = Vec::new();
        let effect_scope = Rc::new(Vec::new());
        take_structural_budget_scan_count();
        let reconstruction = match capsule.admit_reconstruction(0, 0) {
            Ok(Some(reconstruction)) => reconstruction,
            Ok(None) => panic!("the small capsule should fit its reconstruction allocation"),
            Err(error) => panic!("the structurally valid capsule should be admitted: {error}"),
        };
        assert_eq!(take_structural_budget_scan_count(), 1);

        let error = reconstruction
            .decode(
                PATH,
                &module,
                &revision,
                &context,
                &module_instances,
                &effect_scope,
            )
            .expect_err("admission must not bypass environment graph validation");

        assert!(error.contains("missing environment 7"), "{error}");
        assert_eq!(take_structural_budget_scan_count(), 0);
    }

    #[test]
    fn decoded_application_provenance_is_bounded_before_reconstruction() {
        let mut request = CapsuleApplicationSite {
            root: CapsuleApplicationRoot::Expression(ExpressionId(0)),
            compiler_steps: Vec::new(),
        };
        for _ in 0..=VALUE_CAPSULE_MAX_DEPTH {
            request = CapsuleApplicationSite {
                root: CapsuleApplicationRoot::Expression(ExpressionId(0)),
                compiler_steps: vec![CapsuleCompilerApplication::HandleOperation {
                    operation: "request".to_owned(),
                    request: Box::new(request),
                }],
            };
        }
        let capsule = ValueCapsule {
            schema: VALUE_CAPSULE_SCHEMA,
            environments: vec![environment(None)],
            effect_scopes: vec![vec![CapsuleClosureApplication {
                application: request,
                creation_scope: 0,
            }]],
            root: 0,
        };

        let error = capsule
            .validate_structural_budget()
            .expect_err("deep application provenance must be rejected");

        assert!(error.contains("maximum structural depth"), "{error}");
    }

    #[test]
    fn message_pack_preflight_accepts_every_marker_family() {
        let values = [
            vec![0x00],
            vec![0xe0],
            vec![0xc0],
            vec![0xc2],
            vec![0xc3],
            vec![0x81, 0x00, 0x01],
            vec![0x91, 0x00],
            vec![0xa1, b'a'],
            vec![0xc4, 1, 0],
            vec![0xc5, 0, 1, 0],
            vec![0xc6, 0, 0, 0, 1, 0],
            vec![0xc7, 1, 0, 0],
            vec![0xc8, 0, 1, 0, 0],
            vec![0xc9, 0, 0, 0, 1, 0, 0],
            vec![0xca, 0, 0, 0, 0],
            vec![0xcb, 0, 0, 0, 0, 0, 0, 0, 0],
            vec![0xcc, 0],
            vec![0xcd, 0, 0],
            vec![0xce, 0, 0, 0, 0],
            vec![0xcf, 0, 0, 0, 0, 0, 0, 0, 0],
            vec![0xd0, 0],
            vec![0xd1, 0, 0],
            vec![0xd2, 0, 0, 0, 0],
            vec![0xd3, 0, 0, 0, 0, 0, 0, 0, 0],
            vec![0xd4, 0, 0],
            vec![0xd5, 0, 0, 0],
            vec![0xd6, 0, 0, 0, 0, 0],
            vec![0xd7, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            vec![0xd8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            vec![0xd9, 1, b'a'],
            vec![0xda, 0, 1, b'a'],
            vec![0xdb, 0, 0, 0, 1, b'a'],
            vec![0xdc, 0, 0],
            vec![0xdd, 0, 0, 0, 0],
            vec![0xde, 0, 0],
            vec![0xdf, 0, 0, 0, 0],
        ];
        let mut encoded = vec![0xdc, 0, u8::try_from(values.len()).unwrap()];
        for value in values {
            encoded.extend(value);
        }

        scan_message_pack(&encoded, VALUE_CAPSULE_LIMITS)
            .expect("all MessagePack marker families should pass preflight");
    }

    #[test]
    fn message_pack_preflight_enforces_exact_shape_and_resource_limits() {
        let limited = CapsuleLimits {
            depth: 2,
            nodes: 8,
            allocation_bytes: 256,
            serialized_bytes: 8,
        };
        assert!(scan_message_pack(&[0x91, 0x91, 0xc0], limited).is_ok());
        assert!(
            scan_message_pack(&[0x91, 0x91, 0x91, 0xc0], limited)
                .unwrap_err()
                .contains("maximum structural depth")
        );
        let node_limited = CapsuleLimits {
            nodes: 2,
            ..limited
        };
        assert!(
            scan_message_pack(&[0x92, 0xc0, 0xc0], node_limited)
                .unwrap_err()
                .contains("maximum structural node count")
        );
        assert!(
            scan_message_pack(&[0xc1], limited)
                .unwrap_err()
                .contains("0xc1")
        );
        assert!(
            scan_message_pack(&[], limited)
                .unwrap_err()
                .contains("ended before value marker")
        );
        assert!(
            scan_message_pack(&[0xdf, 0xff, 0xff, 0xff, 0xff], VALUE_CAPSULE_LIMITS)
                .unwrap_err()
                .contains("maximum structural node count")
        );
        assert!(
            scan_message_pack(&[0xc0, 0xc0], limited)
                .unwrap_err()
                .contains("trailing bytes")
        );
        assert!(
            scan_message_pack(&[0xd9, 2, b'a'], limited)
                .unwrap_err()
                .contains("ended inside")
        );
        let truncation_limits = CapsuleLimits {
            depth: 2,
            nodes: 4,
            allocation_bytes: u64::MAX,
            serialized_bytes: usize::MAX,
        };
        assert!(
            scan_message_pack(&[0xc6, 0xff, 0xff, 0xff, 0xff], truncation_limits)
                .unwrap_err()
                .contains("ended inside bin32 payload")
        );
        assert!(
            scan_message_pack(&[0xc9, 0xff, 0xff, 0xff, 0xff], truncation_limits)
                .unwrap_err()
                .contains("ended inside ext32 type")
        );

        let allocation_limited = CapsuleLimits {
            depth: 2,
            nodes: 4,
            allocation_bytes: CAPSULE_COLLECTION_ENTRY_BYTES + 1,
            serialized_bytes: 8,
        };
        assert!(
            scan_message_pack(&[0xa2, b'a', b'b'], allocation_limited)
                .unwrap_err()
                .contains("maximum estimated allocation")
        );
        let byte_limited = CapsuleLimits {
            serialized_bytes: 1,
            ..limited
        };
        assert!(
            scan_message_pack(&[0xcc, 0], byte_limited)
                .unwrap_err()
                .contains("maximum encoded size")
        );
    }

    #[test]
    fn message_pack_preflight_rejects_extreme_nesting_on_a_small_stack() {
        std::thread::Builder::new()
            .name("message-pack-preflight-depth".to_owned())
            .stack_size(64 * 1024)
            .spawn(|| {
                let mut encoded = vec![0x91; 20_000];
                encoded.push(0xc0);

                let error = scan_message_pack(&encoded, VALUE_CAPSULE_LIMITS)
                    .expect_err("extreme MessagePack depth must be rejected iteratively");

                assert!(error.contains("maximum structural depth"), "{error}");
            })
            .expect("small-stack preflight test thread should start")
            .join()
            .expect("small-stack preflight test thread should finish");
    }

    #[test]
    fn generated_prelude_snapshot_has_resource_headroom() {
        let bytes = include_bytes!("../../generated/compiler/prelude.snapshot");
        let budget = scan_message_pack(bytes, VALUE_CAPSULE_LIMITS)
            .expect("the generated prelude snapshot must pass installation preflight");

        assert!(bytes.len() < MODULE_SNAPSHOT_MAX_BYTES / 2);
        assert!(budget.nodes < VALUE_CAPSULE_MAX_NODES / 2);
        assert!(budget.allocation_bytes < VALUE_CAPSULE_MAX_ALLOCATION_BYTES / 2);
        assert!(budget.maximum_depth < VALUE_CAPSULE_MAX_DEPTH / 2);
    }

    #[test]
    fn encoder_rejects_a_closure_cycle_before_publication() {
        let span = Span { start: 0, end: 0 };
        let mut arena = crate::ast::AstArena::default();
        let result = arena.expression(Expression::Unit { span });
        let module = Module {
            parameter: None,
            declarations: Vec::new(),
            result,
            result_effects: crate::ast::ResultEffects::Pure,
            span,
            arena,
        };
        let loaded = crate::eval::LoadedModule::new(
            "cycle.blot",
            Rc::new(module.clone()),
            BTreeMap::new(),
            BTreeMap::new(),
        );
        let environment = child_env(None);
        environment.names.borrow_mut().insert(
            "read".to_owned(),
            Value::Closure {
                module: Rc::new("cycle.blot".to_owned()),
                module_instances: Rc::new(Vec::new()),
                effect_scope: Rc::new(Vec::new()),
                parameter: PatternId(0),
                body: result,
                environment: environment.clone(),
                self_name: None,
                imports: None,
                signature: None,
                reuse_assertion: None,
                deferred: false,
            },
        );

        let encoded = ValueCapsule::encode(&environment, "cycle.blot", &module, &loaded.revision());
        environment.names.borrow_mut().clear();
        let error = match encoded {
            Ok(_) => panic!("a capsule encoder must reject strong cycles"),
            Err(error) => error,
        };

        assert!(error.contains("strong-reference cycle"), "{error}");
    }

    #[test]
    fn nested_closure_environment_edges_must_be_acyclic() {
        let mut root = environment(None);
        root.names.insert(
            "nested".to_owned(),
            CapsuleValue::Shape(vec![("read".to_owned(), closure(0))]),
        );
        let capsule = ValueCapsule {
            schema: VALUE_CAPSULE_SCHEMA,
            environments: vec![root],
            effect_scopes: Vec::new(),
            root: 0,
        };

        let error = capsule
            .validate_environment_graph()
            .expect_err("a nested closure must not retain its containing environment");

        assert!(error.contains("strong-reference cycle"), "{error}");
    }

    #[test]
    fn nested_closures_must_reference_an_existing_environment() {
        let mut root = environment(None);
        root.opens.push(vec![("read".to_owned(), closure(7))]);
        let capsule = ValueCapsule {
            schema: VALUE_CAPSULE_SCHEMA,
            environments: vec![root],
            effect_scopes: Vec::new(),
            root: 0,
        };

        let error = capsule
            .validate_environment_graph()
            .expect_err("a nested closure must reference an encoded environment");

        assert!(error.contains("missing environment 7"), "{error}");
    }

    #[test]
    fn recursive_members_must_match_one_complete_source_group() {
        let mut root = environment(None);
        root.recursive_names
            .insert("invented".to_owned(), capsule_closure(Some("invented")));
        let capsule = ValueCapsule {
            schema: VALUE_CAPSULE_SCHEMA,
            environments: vec![root],
            effect_scopes: Vec::new(),
            root: 0,
        };
        let source_groups = [BTreeMap::from([(
            "loop".to_owned(),
            CapsuleClosureIdentity {
                parameter: PatternId(0),
                body: ExpressionId(0),
                deferred: false,
            },
        )])];

        let error = capsule
            .validate_recursive_groups("test.blot", &source_groups)
            .expect_err("a capsule must not invent recursive peers");

        assert!(error.contains("no matching source group"), "{error}");
    }

    #[test]
    fn recursive_members_cannot_be_masked_by_an_ordinary_name() {
        let mut root = environment(None);
        root.names.insert("loop".to_owned(), CapsuleValue::Unit);
        root.recursive_names
            .insert("loop".to_owned(), capsule_closure(Some("loop")));
        let capsule = ValueCapsule {
            schema: VALUE_CAPSULE_SCHEMA,
            environments: vec![root],
            effect_scopes: Vec::new(),
            root: 0,
        };
        let source_groups = [BTreeMap::from([(
            "loop".to_owned(),
            CapsuleClosureIdentity {
                parameter: PatternId(0),
                body: ExpressionId(0),
                deferred: false,
            },
        )])];

        let error = capsule
            .validate_recursive_groups("test.blot", &source_groups)
            .expect_err("an ordinary name must not mask a recursive member");

        assert!(
            error.contains("both an ordinary and recursive name"),
            "{error}"
        );
    }
}
