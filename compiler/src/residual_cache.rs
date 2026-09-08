//! Resident memoization of closed scalar graphs at development boundaries.
//! Admission retains exact arena prefixes; a changed demand conservatively misses.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::rc::Rc;

use super::{
    ResidualTrace, RuntimeFunction, RuntimeSignature, RuntimeTerminator, RuntimeType, WireConstant,
};
use crate::eval::Context;

const RESIDENT_LIMIT: usize = 64 * 1024 * 1024;

pub(super) fn word<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<&'static str, D::Error> {
    let value = String::deserialize(decoder)?;
    cache_word(&value).ok_or_else(|| {
        serde::de::Error::custom(format!("unsupported cached runtime word {value:?}"))
    })
}

pub(super) fn optional_word<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> Result<Option<&'static str>, D::Error> {
    Option::<String>::deserialize(decoder)?
        .map(|value| {
            cache_word(&value).ok_or_else(|| {
                serde::de::Error::custom(format!("unsupported cached runtime word {value:?}"))
            })
        })
        .transpose()
}

fn cache_word(value: &str) -> Option<&'static str> {
    const WORDS: &[&str] = &[
        "plain",
        "owned",
        "borrowed",
        "checked",
        "integer-8",
        "integer-16",
        "integer-32",
        "float-32",
        "constant",
        "scalar",
        "scalar.unary",
        "convert",
        "call.direct",
        "add",
        "subtract",
        "multiply",
        "divide",
        "remainder",
        "equal",
        "not-equal",
        "less-than",
        "less-than-or-equal",
        "greater-than",
        "greater-than-or-equal",
        "negate",
        "square-root",
        "float-32-to-float-64",
        "float-64-to-float-32",
        "float-64-to-signed-integer-64",
        "signed-integer-32-to-signed-integer-64",
        "signed-integer-64-to-signed-integer-32",
        "signed-integer-64-to-float-32",
        "signed-integer-64-to-float-64",
    ];
    WORDS.iter().copied().find(|candidate| *candidate == value)
}

#[derive(Default)]
pub(crate) struct ResidualCache {
    pub(super) registry: Option<super::residual_identity::RegistryMemo>,
    entries: HashMap<Rc<Vec<u8>>, Rc<Entry>>,
    order: VecDeque<Rc<Vec<u8>>>,
    bytes: usize,
    pending: Vec<Rc<Vec<u8>>>,
    disabled: bool,
}

pub(super) struct Request {
    pub(super) context: Rc<Context>,
    pub(super) key: Vec<u8>,
    effect_stamp: (u32, u64),
    types: Vec<RuntimeType>,
    type_ids: BTreeMap<String, usize>,
    signatures: Vec<RuntimeSignature>,
    function: usize,
    signature: RuntimeSignature,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    prefix_types: Vec<RuntimeType>,
    prefix_type_ids: BTreeMap<String, usize>,
    prefix_signatures: Vec<RuntimeSignature>,
    types: Vec<RuntimeType>,
    type_ids: BTreeMap<String, usize>,
    signatures: Vec<RuntimeSignature>,
    functions: Vec<RuntimeFunction>,
    prerequisites: Vec<(usize, Vec<u8>)>,
    function: usize,
    next_function: usize,
    bytes: usize,
}

impl Entry {
    fn validate(&self) -> Result<(), String> {
        let invalid = || "invalid closed scalar graph in development cache".to_owned();
        if !self.types.starts_with(&self.prefix_types)
            || !self.signatures.starts_with(&self.prefix_signatures)
            || self
                .prefix_type_ids
                .iter()
                .any(|(key, id)| self.type_ids.get(key) != Some(id))
            || self.type_ids.values().any(|id| *id >= self.types.len())
            || self.signatures.iter().any(|signature| {
                signature
                    .parameters
                    .iter()
                    .chain(std::iter::once(&signature.result))
                    .any(|id| *id >= self.types.len())
            })
            || self.function >= self.next_function
            || self.functions.len() != self.next_function - self.function
            || self.signatures.len() != self.prefix_signatures.len() + self.functions.len()
        {
            return Err(invalid());
        }
        for (index, type_) in self.types.iter().enumerate().skip(self.prefix_types.len()) {
            let key = scalar_name(type_).ok_or_else(invalid)?;
            if self.type_ids.get(key) != Some(&index) {
                return Err(invalid());
            }
        }
        for (key, index) in &self.type_ids {
            if !self.prefix_type_ids.contains_key(key)
                && scalar_name(&self.types[*index]) != Some(key.as_str())
            {
                return Err(invalid());
            }
        }
        let mut callees = HashMap::new();
        for (id, bytes) in &self.prerequisites {
            let function: RuntimeFunction = rmp_serde::from_slice(bytes).map_err(|_| invalid())?;
            if *id >= self.function
                || function.id != *id
                || function.signature >= self.signatures.len()
                || callees.insert(*id, function.signature).is_some()
            {
                return Err(invalid());
            }
        }
        for (offset, function) in self.functions.iter().enumerate() {
            if function.id != self.function + offset
                || function.signature != self.prefix_signatures.len() + offset
                || function.signature >= self.signatures.len()
                || function.reuse.is_some()
                || function.entry_block != 0
                || function.blocks.is_empty()
                || function.span.start > function.span.end
            {
                return Err(invalid());
            }
            callees.insert(function.id, function.signature);
        }
        let root = &self.functions[0];
        if root.signature != self.prefix_signatures.len() {
            return Err(invalid());
        }
        for function in &self.functions {
            self.validate_function(function, &callees)?;
        }
        Ok(())
    }

    fn validate_function(
        &self,
        function: &RuntimeFunction,
        callees: &HashMap<usize, usize>,
    ) -> Result<(), String> {
        let invalid = || format!("invalid cached scalar function {}", function.name);
        let signature = &self.signatures[function.signature];
        if !signature.effects.is_empty()
            || signature
                .parameters
                .iter()
                .chain(std::iter::once(&signature.result))
                .any(|id| scalar_name(&self.types[*id]).is_none())
        {
            return Err(invalid());
        }
        let mut definitions = HashMap::new();
        for (block_index, block) in function.blocks.iter().enumerate() {
            if block.id != block_index {
                return Err(invalid());
            }
            for parameter in &block.parameters {
                if parameter.ownership != "plain"
                    || self
                        .types
                        .get(parameter.type_id)
                        .and_then(scalar_name)
                        .is_none()
                    || definitions
                        .insert(parameter.value, (block_index, 0, parameter.type_id))
                        .is_some()
                {
                    return Err(invalid());
                }
            }
            for (index, operation) in block.operations.iter().enumerate() {
                if operation.ownership != "plain"
                    || self
                        .types
                        .get(operation.type_id)
                        .and_then(scalar_name)
                        .is_none()
                    || definitions
                        .insert(
                            operation.result,
                            (block_index, index + 1, operation.type_id),
                        )
                        .is_some()
                    || operation.update.is_some()
                    || operation.case.is_some()
                    || operation.capability.is_some()
                    || operation.operation.is_some()
                    || operation.lane.is_some()
                    || operation.field.is_some()
                    || operation.signature.is_some()
                    || operation.static_store.is_some()
                {
                    return Err(invalid());
                }
            }
        }
        if function.blocks[0]
            .parameters
            .iter()
            .map(|parameter| parameter.type_id)
            .collect::<Vec<_>>()
            != signature.parameters
        {
            return Err(invalid());
        }
        let value_type = |value: usize| {
            definitions
                .get(&value)
                .map(|definition| definition.2)
                .ok_or_else(invalid)
        };
        let mut predecessors = vec![std::collections::HashSet::new(); function.blocks.len()];
        for block in &function.blocks {
            let mut edge = |target: usize, arguments: &[usize]| -> Result<(), String> {
                let destination = function.blocks.get(target).ok_or_else(invalid)?;
                if arguments.len() != destination.parameters.len() {
                    return Err(invalid());
                }
                for (argument, parameter) in arguments.iter().zip(&destination.parameters) {
                    if value_type(*argument)? != parameter.type_id {
                        return Err(invalid());
                    }
                }
                predecessors[target].insert(block.id);
                Ok(())
            };
            match &block.terminator {
                RuntimeTerminator::Branch {
                    target, arguments, ..
                } => edge(*target, arguments)?,
                RuntimeTerminator::Conditional {
                    condition,
                    consequent,
                    consequent_arguments,
                    alternate,
                    alternate_arguments,
                    ..
                } => {
                    if self.types[value_type(*condition)?] != RuntimeType::Boolean {
                        return Err(invalid());
                    }
                    edge(*consequent, consequent_arguments)?;
                    edge(*alternate, alternate_arguments)?;
                }
                RuntimeTerminator::Return { value, .. } => {
                    if value_type(*value)? != signature.result {
                        return Err(invalid());
                    }
                }
                RuntimeTerminator::Trap { .. } => {}
                RuntimeTerminator::Switch { .. } => return Err(invalid()),
            }
        }
        let all = (0..function.blocks.len()).collect::<std::collections::HashSet<_>>();
        let mut dominators = vec![all; function.blocks.len()];
        dominators[0] = std::collections::HashSet::from([0]);
        loop {
            let mut changed = false;
            for block in 1..function.blocks.len() {
                let mut incoming = predecessors[block].iter();
                let first = incoming.next().ok_or_else(invalid)?;
                let mut next = dominators[*first].clone();
                for predecessor in incoming {
                    next.retain(|candidate| dominators[*predecessor].contains(candidate));
                }
                next.insert(block);
                if dominators[block] != next {
                    dominators[block] = next;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        for block in &function.blocks {
            let check_use = |value: usize, position: usize| -> Result<(), String> {
                let (definition, index, _) = definitions.get(&value).ok_or_else(invalid)?;
                if !dominators[block.id].contains(definition)
                    || (*definition == block.id && *index >= position)
                {
                    return Err(invalid());
                }
                Ok(())
            };
            for (index, operation) in block.operations.iter().enumerate() {
                for operand in &operation.operands {
                    check_use(*operand, index + 1)?;
                }
                let operands = operation
                    .operands
                    .iter()
                    .map(|value| value_type(*value))
                    .collect::<Result<Vec<_>, _>>()?;
                let result = &self.types[operation.type_id];
                match operation.kind {
                    "constant"
                        if operands.is_empty()
                            && operation.operator.is_none()
                            && operation.conversion.is_none()
                            && operation.function.is_none() =>
                    {
                        let matches = match (operation.value.as_ref(), result) {
                            (Some(WireConstant::Unit), RuntimeType::Unit)
                            | (Some(WireConstant::Boolean(_)), RuntimeType::Boolean)
                            | (Some(WireConstant::SignedInteger32(_)), RuntimeType::Integer32)
                            | (Some(WireConstant::Float32(_)), RuntimeType::Float32)
                            | (Some(WireConstant::Float64(_)), RuntimeType::Float64) => true,
                            (
                                Some(WireConstant::SignedInteger64(integer)),
                                RuntimeType::SignedInteger64,
                            ) => integer.parse::<i64>().is_ok(),
                            _ => false,
                        };
                        if !matches {
                            return Err(invalid());
                        }
                    }
                    "call.direct"
                        if operation.value.is_none()
                            && operation.operator.is_none()
                            && operation.conversion.is_none() =>
                    {
                        let target = callees
                            .get(&operation.function.ok_or_else(invalid)?)
                            .ok_or_else(invalid)?;
                        let called = &self.signatures[*target];
                        if !called.effects.is_empty()
                            || called.parameters != operands
                            || called.result != operation.type_id
                        {
                            return Err(invalid());
                        }
                    }
                    "scalar"
                        if operands.len() == 2
                            && operands[0] == operands[1]
                            && operation.value.is_none()
                            && operation.function.is_none()
                            && operation.conversion.is_none() =>
                    {
                        let operand = &self.types[operands[0]];
                        let comparison = matches!(
                            operation.operator,
                            Some(
                                "equal"
                                    | "not-equal"
                                    | "less-than"
                                    | "less-than-or-equal"
                                    | "greater-than"
                                    | "greater-than-or-equal"
                            )
                        );
                        if comparison {
                            if *result != RuntimeType::Boolean {
                                return Err(invalid());
                            }
                        } else if !matches!(
                            operation.operator,
                            Some("add" | "subtract" | "multiply" | "divide" | "remainder")
                        ) || result != operand
                        {
                            return Err(invalid());
                        }
                        if !matches!(
                            operand,
                            RuntimeType::Integer32
                                | RuntimeType::SignedInteger64
                                | RuntimeType::Float32
                                | RuntimeType::Float64
                                | RuntimeType::Boolean
                        ) {
                            return Err(invalid());
                        }
                    }
                    "scalar.unary"
                        if operands.len() == 1
                            && operation.type_id == operands[0]
                            && operation.value.is_none()
                            && operation.function.is_none()
                            && operation.conversion.is_none() =>
                    {
                        if !matches!(result, RuntimeType::Float32 | RuntimeType::Float64)
                            || !matches!(operation.operator, Some("negate" | "square-root"))
                        {
                            return Err(invalid());
                        }
                    }
                    "convert"
                        if operands.len() == 1
                            && operation.value.is_none()
                            && operation.function.is_none()
                            && operation.operator.is_none() =>
                    {
                        let expected = match (&self.types[operands[0]], result) {
                            (RuntimeType::Float32, RuntimeType::Float64) => "float-32-to-float-64",
                            (RuntimeType::Float64, RuntimeType::Float32) => "float-64-to-float-32",
                            (RuntimeType::Float64, RuntimeType::SignedInteger64) => {
                                "float-64-to-signed-integer-64"
                            }
                            (RuntimeType::Integer32, RuntimeType::SignedInteger64) => {
                                "signed-integer-32-to-signed-integer-64"
                            }
                            (RuntimeType::SignedInteger64, RuntimeType::Integer32) => {
                                "signed-integer-64-to-signed-integer-32"
                            }
                            (RuntimeType::SignedInteger64, RuntimeType::Float32) => {
                                "signed-integer-64-to-float-32"
                            }
                            (RuntimeType::SignedInteger64, RuntimeType::Float64) => {
                                "signed-integer-64-to-float-64"
                            }
                            _ => return Err(invalid()),
                        };
                        if operation.conversion != Some(expected) {
                            return Err(invalid());
                        }
                    }
                    _ => return Err(invalid()),
                }
            }
            let position = block.operations.len() + 1;
            match &block.terminator {
                RuntimeTerminator::Branch { arguments, .. } => {
                    for argument in arguments {
                        check_use(*argument, position)?;
                    }
                }
                RuntimeTerminator::Conditional {
                    condition,
                    consequent_arguments,
                    alternate_arguments,
                    ..
                } => {
                    check_use(*condition, position)?;
                    for argument in consequent_arguments.iter().chain(alternate_arguments) {
                        check_use(*argument, position)?;
                    }
                }
                RuntimeTerminator::Return { value, .. } => check_use(*value, position)?,
                RuntimeTerminator::Trap { .. } => {}
                RuntimeTerminator::Switch { .. } => return Err(invalid()),
            }
        }
        Ok(())
    }
}

fn scalar_name(type_: &RuntimeType) -> Option<&'static str> {
    match type_ {
        RuntimeType::Unit => Some("unit"),
        RuntimeType::Boolean => Some("boolean"),
        RuntimeType::Integer32 => Some("integer-32"),
        RuntimeType::SignedInteger64 => Some("signed-integer-64"),
        RuntimeType::Float32 => Some("float-32"),
        RuntimeType::Float64 => Some("float-64"),
        _ => None,
    }
}

impl Request {
    pub(super) fn new(
        context: &Rc<Context>,
        key: Vec<u8>,
        trace: &ResidualTrace,
        signature: RuntimeSignature,
    ) -> Self {
        Self {
            context: context.clone(),
            key,
            effect_stamp: context.residual_cache_effect_stamp(),
            types: trace.types.clone(),
            type_ids: trace
                .type_ids
                .iter()
                .map(|(name, id)| (name.clone(), *id))
                .collect(),
            signatures: trace.signatures.clone(),
            function: trace.next_function,
            signature,
        }
    }

    pub(super) fn restore(&self, trace: &mut ResidualTrace) -> bool {
        let mut cache = self.context.residual_cache.borrow_mut();
        let Some((key, entry)) = cache.entries.get_key_value(&self.key) else {
            return false;
        };
        let key = key.clone();
        let entry = entry.clone();
        if entry.function != trace.next_function
            || entry.signatures.get(entry.prefix_signatures.len()) != Some(&self.signature)
            || entry.prefix_types != trace.types
            || entry.prefix_type_ids.len() != trace.type_ids.len()
            || entry
                .prefix_type_ids
                .iter()
                .any(|(name, id)| trace.type_ids.get(name) != Some(id))
            || entry.prefix_signatures != trace.signatures
            || entry.prerequisites.iter().any(|(id, bytes)| {
                trace.functions.get(id).is_none_or(|function| {
                    rmp_serde::to_vec_named(function).expect("runtime function serialization")
                        != *bytes
                })
            })
        {
            return false;
        }
        cache.order.retain(|previous| *previous != key);
        cache.order.push_back(key);
        trace.types = entry.types.clone();
        trace.type_ids = entry
            .type_ids
            .iter()
            .map(|(name, id)| (name.clone(), *id))
            .collect();
        trace.signatures = entry.signatures.clone();
        for function in &entry.functions {
            trace.functions.insert(function.id, function.clone());
            *self
                .context
                .development_work
                .borrow_mut()
                .reused_functions
                .entry(function.span.file.clone())
                .or_default() += 1;
        }
        trace.next_function = entry.next_function;
        true
    }

    pub(super) fn store(self, trace: &ResidualTrace) {
        if self.effect_stamp != self.context.residual_cache_effect_stamp() {
            return;
        }
        let functions = trace
            .functions
            .range(self.function..)
            .map(|(_, function)| function.clone())
            .collect::<Vec<_>>();
        let mut prerequisites = std::collections::BTreeSet::new();
        let scalar = |id: usize| {
            matches!(
                trace.types.get(id),
                Some(
                    RuntimeType::Unit
                        | RuntimeType::Integer32
                        | RuntimeType::SignedInteger64
                        | RuntimeType::Float32
                        | RuntimeType::Float64
                        | RuntimeType::Boolean
                )
            )
        };
        for function in &functions {
            let signature = &trace.signatures[function.signature];
            if function.reuse.is_some()
                || !signature.effects.is_empty()
                || !signature.parameters.iter().copied().all(scalar)
                || !scalar(signature.result)
            {
                return;
            }
            for block in &function.blocks {
                if !block
                    .parameters
                    .iter()
                    .all(|parameter| scalar(parameter.type_id))
                {
                    return;
                }
                for operation in &block.operations {
                    if !scalar(operation.type_id)
                        || !matches!(
                            operation.kind,
                            "constant" | "scalar" | "scalar.unary" | "convert" | "call.direct"
                        )
                    {
                        return;
                    }
                    if let Some(target) = operation.function
                        && target < self.function
                    {
                        prerequisites.insert(target);
                    }
                }
            }
        }
        if functions.is_empty() {
            return;
        }
        let prerequisites = prerequisites
            .into_iter()
            .map(|id| {
                Some((
                    id,
                    rmp_serde::to_vec_named(trace.functions.get(&id)?)
                        .expect("runtime function serialization"),
                ))
            })
            .collect::<Option<Vec<_>>>();
        let Some(prerequisites) = prerequisites else {
            return;
        };
        let mut entry = Entry {
            prefix_types: self.types,
            prefix_type_ids: self.type_ids,
            prefix_signatures: self.signatures,
            types: trace.types.clone(),
            type_ids: trace
                .type_ids
                .iter()
                .map(|(name, id)| (name.clone(), *id))
                .collect(),
            signatures: trace.signatures.clone(),
            functions,
            prerequisites,
            function: self.function,
            next_function: trace.next_function,
            bytes: 0,
        };
        if entry.validate().is_err() {
            return;
        }
        // Reserve the largest MessagePack integer width for this accounting field.
        entry.bytes = rmp_serde::to_vec_named(&(1_u32, (&self.key, &entry)))
            .expect("residual graph serialization")
            .len()
            + 8;
        if entry.bytes > RESIDENT_LIMIT {
            return;
        }
        let mut cache = self.context.residual_cache.borrow_mut();
        let key = cache.insert(self.key, Rc::new(entry));
        cache.pending.push(key);
    }
}

impl ResidualCache {
    pub(crate) fn begin_request(&mut self) {
        self.registry = None;
    }

    pub(crate) fn enabled(&self) -> bool {
        !self.disabled
    }

    pub(crate) fn disable(&mut self) {
        *self = Self {
            disabled: true,
            ..Self::default()
        };
    }

    pub(crate) fn take_pending(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.pending)
            .into_iter()
            .filter_map(|key| {
                self.entries.get(&key).map(|entry| {
                    rmp_serde::to_vec_named(&(1_u32, (key, entry)))
                        .expect("residual cache serialization")
                })
            })
            .collect()
    }

    pub(crate) fn import(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > RESIDENT_LIMIT {
            return Err("residual cache entry exceeds 64 MiB".into());
        }
        let (version, (key, mut entry)): (u32, (Vec<u8>, Entry)) = rmp_serde::from_slice(bytes)
            .map_err(|error| format!("invalid residual cache entry: {error}"))?;
        if version != 1 {
            return Err(format!("unsupported residual cache schema {version}"));
        }
        entry.validate()?;
        entry.bytes = bytes.len();
        if !self.disabled {
            self.insert(key, Rc::new(entry));
        }
        Ok(())
    }

    fn insert(&mut self, key: Vec<u8>, entry: Rc<Entry>) -> Rc<Vec<u8>> {
        let key = Rc::new(key);
        let bytes = entry.bytes;
        let cache = self;
        if let Some(previous) = cache.entries.remove(&key) {
            cache.bytes -= previous.bytes;
        }
        cache.order.retain(|existing| *existing != key);
        cache.pending.retain(|existing| *existing != key);
        while cache.bytes + bytes > RESIDENT_LIMIT {
            let oldest = cache
                .order
                .pop_front()
                .expect("nonempty bounded residual cache");
            if let Some(previous) = cache.entries.remove(&oldest) {
                cache.bytes -= previous.bytes;
            }
            cache.pending.retain(|key| *key != oldest);
        }
        cache.bytes += bytes;
        cache.order.push_back(key.clone());
        cache.entries.insert(key.clone(), entry);
        key
    }
}
