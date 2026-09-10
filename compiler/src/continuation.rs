use std::collections::{BTreeMap, BTreeSet};

use crate::hir::{RuntimeCapability, RuntimeLink, RuntimeSignature, RuntimeStaticStore};
use serde::{Deserialize, Serialize};

use crate::hir::{
    RuntimeSpan, RuntimeType, StagedBlockParameter, StagedFunction, StagedModule, StagedOperation,
    StagedTerminator, WireConstant,
};

#[cfg(test)]
#[path = "continuation_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "continuation_interpreter.rs"]
pub(crate) mod interpreter;

#[path = "continuation_validation.rs"]
mod validation;
pub(crate) use validation::constant_matches;

macro_rules! reference {
    ($name:ident) => {
        #[derive(
            Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub(crate) struct $name(pub(crate) usize);
        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(formatter)
            }
        }
    };
}

pub(crate) struct Tables<'a> {
    pub(crate) types: &'a [RuntimeType],
    pub(crate) signatures: &'a [RuntimeSignature],
    pub(crate) static_stores: &'a [RuntimeStaticStore],
    pub(crate) capabilities: &'a [RuntimeCapability],
    pub(crate) links: &'a [RuntimeLink],
}

reference!(FunctionId);
reference!(ContinuationId);
reference!(ValueId);
reference!(TypeId);
reference!(SignatureId);

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Definition {
    pub(crate) value: ValueId,
    #[serde(rename = "type")]
    pub(crate) type_id: TypeId,
    #[serde(deserialize_with = "crate::hir::residual_cache::word")]
    pub(crate) ownership: crate::hir::RuntimeWord,
    pub(crate) span: RuntimeSpan,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Instruction {
    pub(crate) definition: Definition,
    pub(crate) operands: Vec<ValueId>,
    pub(crate) operation: Operation,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Operation {
    #[serde(deserialize_with = "crate::hir::residual_cache::word")]
    pub(crate) kind: crate::hir::RuntimeWord,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) value: Option<WireConstant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(
        default,
        deserialize_with = "crate::hir::residual_cache::optional_word"
    )]
    pub(crate) update: Option<crate::hir::RuntimeWord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) case: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(
        default,
        deserialize_with = "crate::hir::residual_cache::optional_word"
    )]
    pub(crate) operator: Option<crate::hir::RuntimeWord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(
        default,
        deserialize_with = "crate::hir::residual_cache::optional_word"
    )]
    pub(crate) conversion: Option<crate::hir::RuntimeWord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) lane: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) field: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) function: Option<FunctionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) signature: Option<SignatureId>,
    #[serde(rename = "staticStore", skip_serializing_if = "Option::is_none")]
    pub(crate) static_store: Option<usize>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "kebab-case")]
pub(crate) enum Argument {
    Value(ValueId),
    Result,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Edge {
    pub(crate) target: ContinuationId,
    pub(crate) arguments: Vec<Argument>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum CallTarget {
    Function {
        function: FunctionId,
    },
    Host {
        capability: String,
        operation: String,
    },
    Link {
        unit: String,
        name: String,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum Transition {
    Jump {
        edge: Edge,
    },
    Branch {
        condition: ValueId,
        consequent: Edge,
        alternate: Edge,
    },
    Switch {
        selector: ValueId,
        cases: Vec<(WireConstant, Edge)>,
        fallback: Edge,
    },
    Call {
        target: CallTarget,
        signature: SignatureId,
        arguments: Vec<ValueId>,
        next: Edge,
        suspends: bool,
    },
    Return {
        value: ValueId,
    },
    Trap {
        message: String,
    },
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Continuation {
    pub(crate) id: ContinuationId,
    pub(crate) parameters: Vec<Definition>,
    pub(crate) captures: Vec<Definition>,
    pub(crate) instructions: Vec<Instruction>,
    pub(crate) transition: Transition,
    pub(crate) span: RuntimeSpan,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Function {
    pub(crate) id: FunctionId,
    pub(crate) name: String,
    pub(crate) signature: SignatureId,
    pub(crate) entry: ContinuationId,
    pub(crate) continuations: Vec<Continuation>,
    pub(crate) suspends: bool,
    pub(crate) framed: bool,
    #[serde(
        default,
        deserialize_with = "crate::hir::residual_cache::optional_word"
    )]
    pub(crate) reuse: Option<crate::hir::RuntimeWord>,
    pub(crate) span: RuntimeSpan,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Graph {
    pub(crate) functions: Vec<Function>,
}

impl Graph {
    pub(crate) fn lower(module: &StagedModule) -> Result<Self, String> {
        let mut functions = module
            .functions
            .iter()
            .map(|function| lower_function(module, function))
            .collect::<Result<Vec<_>, _>>()?;
        functions.extend(module.checked_functions.iter().cloned());
        functions.sort_by_key(|function| function.id);
        let mut suspending = module
            .resumable_roots
            .iter()
            .copied()
            .map(FunctionId)
            .collect::<BTreeSet<_>>();
        let mut callers = BTreeMap::<FunctionId, BTreeSet<FunctionId>>::new();
        let mut callees = BTreeMap::<FunctionId, BTreeSet<FunctionId>>::new();
        for function in &functions {
            for continuation in &function.continuations {
                if let Transition::Call {
                    target, suspends, ..
                } = &continuation.transition
                {
                    if *suspends {
                        suspending.insert(function.id);
                    }
                    if let CallTarget::Function { function: callee } = target {
                        callers.entry(*callee).or_default().insert(function.id);
                        callees.entry(function.id).or_default().insert(*callee);
                    }
                }
            }
        }
        close_reachable(&mut suspending, &callers);
        let mut framed = suspending.clone();
        framed.extend(module.types.iter().filter_map(|type_| {
            if let RuntimeType::Callback { function, .. } = type_ {
                Some(FunctionId(*function))
            } else {
                None
            }
        }));
        close_reachable(&mut framed, &callees);
        for function in &mut functions {
            function.suspends = suspending.contains(&function.id);
            function.framed = framed.contains(&function.id);
            for continuation in &mut function.continuations {
                if let Transition::Call {
                    target: CallTarget::Function { function: callee },
                    suspends,
                    ..
                } = &mut continuation.transition
                {
                    *suspends = suspending.contains(callee);
                }
            }
            function.fill_captures()?;
        }
        let graph = Self { functions };
        graph.validate(module.tables())?;
        Ok(graph)
    }

    pub(crate) fn validate(&self, module: Tables<'_>) -> Result<(), String> {
        validation::validate_tables(self, &module)?;
        let mut ids = BTreeSet::new();
        for (ordinal, function) in self.functions.iter().enumerate() {
            if function.id.0 != ordinal {
                return Err(format!("function {} occupies slot {ordinal}", function.id));
            }
            if function.suspends && !function.framed {
                return Err(format!("suspending function {} has no frame", function.id));
            }
            if !ids.insert(function.id) {
                return Err(format!("repeated graph function {}", function.id.0));
            }
            let signature = module
                .signatures
                .get(function.signature.0)
                .ok_or_else(|| format!("function {} has an absent signature", function.id.0))?;
            let entry = function
                .continuations
                .get(function.entry.0)
                .ok_or_else(|| format!("function {} has an absent entry", function.id.0))?;
            if !entry.captures.is_empty()
                || entry
                    .parameters
                    .iter()
                    .map(|parameter| parameter.type_id.0)
                    .ne(signature.parameters.iter().copied())
            {
                return Err(format!(
                    "function {} entry disagrees with its signature",
                    function.id.0
                ));
            }
            let mut definitions = BTreeMap::new();
            for (ordinal, continuation) in function.continuations.iter().enumerate() {
                if continuation.id.0 != ordinal {
                    return Err(format!(
                        "continuation {} occupies slot {ordinal}",
                        continuation.id.0
                    ));
                }
                for definition in continuation.parameters.iter().chain(
                    continuation
                        .instructions
                        .iter()
                        .map(|instruction| &instruction.definition),
                ) {
                    if definition.type_id.0 >= module.types.len() {
                        return Err(format!(
                            "value {} has an absent representation",
                            definition.value.0
                        ));
                    }
                    if !matches!(definition.ownership, "plain" | "owned" | "borrowed") {
                        return Err(format!(
                            "value {} has unknown ownership {}",
                            definition.value.0, definition.ownership
                        ));
                    }
                    if definitions.insert(definition.value, definition).is_some() {
                        return Err(format!(
                            "function {} repeats value {}",
                            function.id.0, definition.value.0
                        ));
                    }
                }
            }
            let live = function.live_inputs()?;
            for continuation in &function.continuations {
                let parameters = continuation
                    .parameters
                    .iter()
                    .map(|parameter| parameter.value)
                    .collect::<BTreeSet<_>>();
                let expected = live[continuation.id.0]
                    .difference(&parameters)
                    .copied()
                    .collect::<Vec<_>>();
                if continuation
                    .captures
                    .iter()
                    .map(|capture| capture.value)
                    .ne(expected)
                {
                    return Err(format!(
                        "continuation {} has stale or unordered captures",
                        continuation.id.0
                    ));
                }
                let mut available = BTreeMap::new();
                for definition in continuation.parameters.iter().chain(&continuation.captures) {
                    let original = definitions.get(&definition.value).ok_or_else(|| {
                        format!("capture {} has no definition", definition.value.0)
                    })?;
                    if original.type_id != definition.type_id
                        || original.ownership != definition.ownership
                    {
                        return Err(format!(
                            "capture {} changed representation or ownership",
                            definition.value.0
                        ));
                    }
                    if available
                        .insert(definition.value, definition.type_id)
                        .is_some()
                    {
                        return Err(format!(
                            "continuation {} repeats an input",
                            continuation.id.0
                        ));
                    }
                }
                for instruction in &continuation.instructions {
                    if matches!(
                        instruction.operation.kind,
                        "call.direct" | "host.call" | "call.external"
                    ) {
                        return Err("a call remained inside continuation instructions".to_owned());
                    }
                    for value in &instruction.operands {
                        if !available.contains_key(value) {
                            return Err(format!("instruction reads unavailable value {}", value.0));
                        }
                    }
                    validation::validate_instruction(instruction, &available, function, &module)?;
                    available.insert(instruction.definition.value, instruction.definition.type_id);
                }
                for value in continuation.transition.uses() {
                    if !available.contains_key(&value) {
                        return Err(format!("transition reads unavailable value {}", value.0));
                    }
                }
                let result_type = match &continuation.transition {
                    Transition::Call {
                        target,
                        signature,
                        arguments,
                        suspends,
                        next,
                    } => {
                        if next
                            .arguments
                            .iter()
                            .filter(|argument| matches!(argument, Argument::Result))
                            .count()
                            != 1
                        {
                            return Err(
                                "call must transfer its result to exactly one parameter".to_owned()
                            );
                        }
                        if *suspends && !function.suspends {
                            return Err(
                                "suspending call appears in a synchronous function".to_owned()
                            );
                        }
                        let contract = module
                            .signatures
                            .get(signature.0)
                            .ok_or("call has an absent signature")?;
                        if arguments
                            .iter()
                            .map(|value| available[value].0)
                            .ne(contract.parameters.iter().copied())
                        {
                            return Err("call arguments disagree with its signature".to_owned());
                        }
                        match target {
                            CallTarget::Function { function: callee } => {
                                let callee = self
                                    .functions
                                    .iter()
                                    .find(|function| function.id == *callee)
                                    .ok_or("call targets an absent graph function")?;
                                if function.framed && !callee.framed {
                                    return Err(
                                        "framed call targets a function without a frame".to_owned()
                                    );
                                }
                                if callee.signature != *signature || callee.suspends != *suspends {
                                    return Err("call changed its callee's signature or suspension contract".to_owned());
                                }
                            }
                            CallTarget::Host {
                                capability,
                                operation,
                            } => {
                                let operation = module
                                    .capabilities
                                    .iter()
                                    .find(|candidate| candidate.name == *capability)
                                    .and_then(|capability| {
                                        capability
                                            .operations
                                            .iter()
                                            .find(|candidate| candidate.name == *operation)
                                    })
                                    .ok_or("request names an absent host operation")?;
                                if operation.signature != signature.0
                                    || operation.contract.suspends != *suspends
                                {
                                    return Err("request changed its host contract".to_owned());
                                }
                            }
                            CallTarget::Link { unit, name } => {
                                let link = module
                                    .links
                                    .iter()
                                    .find(|link| link.unit == *unit && link.name == *name)
                                    .ok_or("call names an absent development link")?;
                                if link.signature != signature.0 || link.suspends != *suspends {
                                    return Err(
                                        "call changed its development link contract".to_owned()
                                    );
                                }
                            }
                        }
                        Some(TypeId(contract.result))
                    }
                    Transition::Return { value } => {
                        if available[value].0 != signature.result {
                            return Err("return disagrees with its function signature".to_owned());
                        }
                        None
                    }
                    Transition::Branch { condition, .. } => {
                        if !matches!(module.types[available[condition].0], RuntimeType::Boolean) {
                            return Err("branch condition is not Boolean".to_owned());
                        }
                        None
                    }
                    Transition::Switch {
                        selector, cases, ..
                    } => {
                        let selector = &module.types[available[selector].0];
                        if !matches!(
                            selector,
                            RuntimeType::Integer32 | RuntimeType::SignedInteger64
                        ) {
                            return Err("switch selector is not an integer".to_owned());
                        }
                        let mut constants = BTreeSet::new();
                        for (constant, _) in cases {
                            if !validation::constant_matches(constant, selector) {
                                return Err("switch case disagrees with its selector".to_owned());
                            }
                            let integer = match constant {
                                WireConstant::SignedInteger32(value) => i64::from(*value),
                                WireConstant::SignedInteger64(value) => {
                                    value.parse::<i64>().expect("validated integer constant")
                                }
                                _ => unreachable!("validated integer switch case"),
                            };
                            if !constants.insert(integer) {
                                return Err("switch repeats a case".to_owned());
                            }
                        }
                        None
                    }
                    _ => None,
                };
                for edge in continuation.transition.edges() {
                    let successor = &function.continuations[edge.target.0];
                    for (argument, parameter) in edge.arguments.iter().zip(&successor.parameters) {
                        let type_id = match argument {
                            Argument::Value(value) => {
                                available.get(value).copied().ok_or_else(|| {
                                    format!("edge reads unavailable value {}", value.0)
                                })?
                            }
                            Argument::Result => {
                                result_type.ok_or("ordinary edge references a call result")?
                            }
                        };
                        if matches!(
                            continuation.transition,
                            Transition::Call { suspends: true, .. }
                        ) && matches!(argument, Argument::Value(value) if definitions[value].ownership == "borrowed")
                        {
                            return Err(
                                "suspending call retains a borrowed edge argument".to_owned()
                            );
                        }
                        if type_id != parameter.type_id {
                            return Err("edge argument disagrees with its continuation parameter"
                                .to_owned());
                        }
                    }
                    for capture in &successor.captures {
                        if available.get(&capture.value) != Some(&capture.type_id) {
                            return Err(format!("edge cannot provide capture {}", capture.value.0));
                        }
                        if matches!(
                            &continuation.transition,
                            Transition::Call { suspends: true, .. }
                        ) && capture.ownership == "borrowed"
                        {
                            return Err(format!(
                                "suspending call retains borrowed value {}",
                                capture.value.0
                            ));
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

fn close_reachable(
    reached: &mut BTreeSet<FunctionId>,
    edges: &BTreeMap<FunctionId, BTreeSet<FunctionId>>,
) {
    let mut pending = reached.iter().copied().collect::<Vec<_>>();
    while let Some(source) = pending.pop() {
        for target in edges.get(&source).into_iter().flatten() {
            if reached.insert(*target) {
                pending.push(*target);
            }
        }
    }
}

fn parameter(parameter: &StagedBlockParameter) -> Definition {
    Definition {
        value: ValueId(parameter.value),
        type_id: TypeId(parameter.type_id),
        ownership: parameter.ownership,
        span: parameter.span.clone(),
    }
}

fn definition(operation: &StagedOperation) -> Definition {
    Definition {
        value: ValueId(operation.result),
        type_id: TypeId(operation.type_id),
        ownership: operation.ownership,
        span: operation.span.clone(),
    }
}

pub(crate) fn lower_function(
    module: &StagedModule,
    function: &StagedFunction,
) -> Result<Function, String> {
    let mut entries = BTreeMap::new();
    let mut next = 0;
    for block in &function.blocks {
        if entries.insert(block.id, ContinuationId(next)).is_some() {
            return Err(format!(
                "function {} repeats block {}",
                function.id, block.id
            ));
        }
        next += 1 + block
            .operations
            .iter()
            .filter(|operation| is_call(operation))
            .count();
    }
    let entry = *entries
        .get(&function.entry_block)
        .ok_or_else(|| format!("function {} has no entry block", function.id))?;
    let mut continuations = Vec::with_capacity(next);
    for block in &function.blocks {
        let mut parameters = block.parameters.iter().map(parameter).collect();
        let mut instructions = Vec::new();
        for operation in &block.operations {
            if !is_call(operation) {
                instructions.push(Instruction {
                    definition: definition(operation),
                    operands: operation.operands.iter().copied().map(ValueId).collect(),
                    operation: Operation {
                        kind: operation.kind,
                        value: operation.value.clone(),
                        update: operation.update,
                        case: operation.case,
                        operator: operation.operator,
                        conversion: operation.conversion,
                        lane: operation.lane,
                        field: operation.field,
                        function: operation.function.map(FunctionId),
                        signature: operation.signature.map(SignatureId),
                        static_store: operation.static_store,
                    },
                });
                continue;
            }
            let (target, signature, suspends) = call_target(module, operation)?;
            continuations.push(Continuation {
                id: ContinuationId(continuations.len()),
                parameters,
                captures: Vec::new(),
                instructions,
                transition: Transition::Call {
                    target,
                    signature,
                    arguments: operation.operands.iter().copied().map(ValueId).collect(),
                    next: Edge {
                        target: ContinuationId(continuations.len() + 1),
                        arguments: vec![Argument::Result],
                    },
                    suspends,
                },
                span: operation.span.clone(),
            });
            parameters = vec![definition(operation)];
            instructions = Vec::new();
        }
        let edge = |target: &usize, arguments: &[usize]| -> Result<Edge, String> {
            Ok(Edge {
                target: *entries.get(target).ok_or_else(|| {
                    format!("function {} branches to absent block {target}", function.id)
                })?,
                arguments: arguments
                    .iter()
                    .copied()
                    .map(|value| Argument::Value(ValueId(value)))
                    .collect(),
            })
        };
        let (transition, span) = match &block.terminator {
            StagedTerminator::Branch {
                target,
                arguments,
                span,
            } => (
                Transition::Jump {
                    edge: edge(target, arguments)?,
                },
                span,
            ),
            StagedTerminator::Conditional {
                condition,
                consequent,
                consequent_arguments,
                alternate,
                alternate_arguments,
                span,
            } => (
                Transition::Branch {
                    condition: ValueId(*condition),
                    consequent: edge(consequent, consequent_arguments)?,
                    alternate: edge(alternate, alternate_arguments)?,
                },
                span,
            ),
            StagedTerminator::Switch {
                selector,
                cases,
                fallback,
                span,
            } => (
                Transition::Switch {
                    selector: ValueId(*selector),
                    cases: cases
                        .iter()
                        .map(|case| Ok((case.value.clone(), edge(&case.target, &[])?)))
                        .collect::<Result<_, String>>()?,
                    fallback: edge(fallback, &[])?,
                },
                span,
            ),
            StagedTerminator::Return { value, span } => (
                Transition::Return {
                    value: ValueId(*value),
                },
                span,
            ),
            StagedTerminator::Trap { message, span } => (
                Transition::Trap {
                    message: message.clone(),
                },
                span,
            ),
        };
        continuations.push(Continuation {
            id: ContinuationId(continuations.len()),
            parameters,
            captures: Vec::new(),
            instructions,
            transition,
            span: span.clone(),
        });
    }
    Ok(Function {
        id: FunctionId(function.id),
        name: function.name.clone(),
        signature: SignatureId(function.signature),
        entry,
        continuations,
        suspends: false,
        framed: false,
        reuse: function.reuse,
        span: function.span.clone(),
    })
}

fn is_call(operation: &StagedOperation) -> bool {
    matches!(
        operation.kind,
        "call.direct" | "host.call" | "call.external"
    )
}

fn call_target(
    module: &StagedModule,
    operation: &StagedOperation,
) -> Result<(CallTarget, SignatureId, bool), String> {
    if operation.kind == "call.direct" {
        let id = operation.function.ok_or("direct call has no function")?;
        let signature = module
            .functions
            .iter()
            .find(|function| function.id == id)
            .map(|function| SignatureId(function.signature))
            .or_else(|| {
                module
                    .checked_functions
                    .iter()
                    .find(|function| function.id.0 == id)
                    .map(|function| function.signature)
            })
            .ok_or_else(|| format!("direct call references absent function {id}"))?;
        return Ok((
            CallTarget::Function {
                function: FunctionId(id),
            },
            signature,
            false,
        ));
    }
    let capability = operation
        .capability
        .as_ref()
        .ok_or("request has no capability or unit")?;
    let name = operation
        .operation
        .as_ref()
        .ok_or("request has no operation or link name")?;
    if operation.kind == "host.call" {
        let target = module
            .capabilities
            .iter()
            .find(|candidate| &candidate.name == capability)
            .and_then(|capability| {
                capability
                    .operations
                    .iter()
                    .find(|candidate| &candidate.name == name)
            })
            .ok_or_else(|| format!("request names absent host operation {capability}.{name}"))?;
        return Ok((
            CallTarget::Host {
                capability: capability.clone(),
                operation: name.clone(),
            },
            SignatureId(target.signature),
            target.contract.suspends,
        ));
    }
    let target = module
        .links
        .iter()
        .find(|link| &link.unit == capability && &link.name == name)
        .ok_or_else(|| format!("call names absent development link {capability}.{name}"))?;
    Ok((
        CallTarget::Link {
            unit: capability.clone(),
            name: name.clone(),
        },
        SignatureId(target.signature),
        target.suspends,
    ))
}

impl Transition {
    pub(crate) fn edges_mut(&mut self) -> Vec<&mut Edge> {
        match self {
            Self::Jump { edge } => vec![edge],
            Self::Branch {
                consequent,
                alternate,
                ..
            } => vec![consequent, alternate],
            Self::Switch {
                cases, fallback, ..
            } => cases
                .iter_mut()
                .map(|(_, edge)| edge)
                .chain(std::iter::once(fallback))
                .collect(),
            Self::Call { next, .. } => vec![next],
            Self::Return { .. } | Self::Trap { .. } => Vec::new(),
        }
    }

    pub(crate) fn edges(&self) -> Vec<&Edge> {
        match self {
            Self::Jump { edge } => vec![edge],
            Self::Branch {
                consequent,
                alternate,
                ..
            } => vec![consequent, alternate],
            Self::Switch {
                cases, fallback, ..
            } => cases
                .iter()
                .map(|(_, edge)| edge)
                .chain(std::iter::once(fallback))
                .collect(),
            Self::Call { next, .. } => vec![next],
            Self::Return { .. } | Self::Trap { .. } => Vec::new(),
        }
    }

    pub(crate) fn uses(&self) -> Vec<ValueId> {
        match self {
            Self::Branch { condition, .. } => vec![*condition],
            Self::Switch { selector, .. } => vec![*selector],
            Self::Call { arguments, .. } => arguments.clone(),
            Self::Return { value } => vec![*value],
            Self::Jump { .. } | Self::Trap { .. } => Vec::new(),
        }
    }
}

impl Function {
    pub(crate) fn map_types(&mut self, mut map: impl FnMut(TypeId) -> TypeId) {
        for continuation in &mut self.continuations {
            for definition in continuation
                .parameters
                .iter_mut()
                .chain(&mut continuation.captures)
                .chain(
                    continuation
                        .instructions
                        .iter_mut()
                        .map(|instruction| &mut instruction.definition),
                )
            {
                definition.type_id = map(definition.type_id);
            }
        }
    }

    pub(crate) fn map_signatures(&mut self, mut map: impl FnMut(SignatureId) -> SignatureId) {
        self.signature = map(self.signature);
        for continuation in &mut self.continuations {
            for instruction in &mut continuation.instructions {
                if let Some(signature) = &mut instruction.operation.signature {
                    *signature = map(*signature);
                }
            }
            if let Transition::Call { signature, .. } = &mut continuation.transition {
                *signature = map(*signature);
            }
        }
    }

    pub(crate) fn map_functions(&mut self, mut map: impl FnMut(FunctionId) -> FunctionId) {
        self.id = map(self.id);
        for continuation in &mut self.continuations {
            for instruction in &mut continuation.instructions {
                if let Some(function) = &mut instruction.operation.function {
                    *function = map(*function);
                }
            }
            if let Transition::Call {
                target: CallTarget::Function { function },
                ..
            } = &mut continuation.transition
            {
                *function = map(*function);
            }
        }
    }

    pub(crate) fn returns_call_result(&self, next: &Edge) -> bool {
        let mut edge = next;
        let mut carried = None;
        let mut visited = BTreeSet::new();
        loop {
            if !visited.insert(edge.target) {
                return false;
            }
            let continuation = &self.continuations[edge.target.0];
            if !continuation.instructions.is_empty() {
                return false;
            }
            let parameter = continuation
                .parameters
                .iter()
                .zip(&edge.arguments)
                .find_map(|(parameter, argument)| {
                    let matches = match (argument, carried) {
                        (Argument::Result, None) => true,
                        (Argument::Value(value), Some(carried)) => *value == carried,
                        _ => false,
                    };
                    matches.then_some(parameter.value)
                });
            let Some(parameter) = parameter else {
                return false;
            };
            match &continuation.transition {
                Transition::Return { value } => return *value == parameter,
                Transition::Jump { edge: next } => {
                    carried = Some(parameter);
                    edge = next;
                }
                _ => return false,
            }
        }
    }

    fn live_inputs(&self) -> Result<Vec<BTreeSet<ValueId>>, String> {
        let mut live = vec![BTreeSet::new(); self.continuations.len()];
        loop {
            let mut changed = false;
            for continuation in self.continuations.iter().rev() {
                let mut needed = continuation
                    .transition
                    .uses()
                    .into_iter()
                    .collect::<BTreeSet<_>>();
                for edge in continuation.transition.edges() {
                    let successor = self
                        .continuations
                        .get(edge.target.0)
                        .ok_or_else(|| format!("absent continuation {}", edge.target.0))?;
                    if successor.parameters.len() != edge.arguments.len() {
                        return Err(format!(
                            "continuation {} expects {} arguments, received {}",
                            edge.target.0,
                            successor.parameters.len(),
                            edge.arguments.len()
                        ));
                    }
                    // Edge transfer is a use even when its destination parameter is
                    // dead. Keeping that use explicit preserves parallel copies.
                    needed.extend(edge.arguments.iter().filter_map(|argument| match argument {
                        Argument::Value(value) => Some(*value),
                        Argument::Result => None,
                    }));
                    for value in &live[edge.target.0] {
                        if let Some(index) = successor
                            .parameters
                            .iter()
                            .position(|parameter| parameter.value == *value)
                        {
                            if let Argument::Value(argument) = &edge.arguments[index] {
                                needed.insert(*argument);
                            }
                        } else {
                            needed.insert(*value);
                        }
                    }
                }
                for instruction in continuation.instructions.iter().rev() {
                    needed.remove(&instruction.definition.value);
                    needed.extend(&instruction.operands);
                }
                if live[continuation.id.0] != needed {
                    live[continuation.id.0] = needed;
                    changed = true;
                }
            }
            if !changed {
                return Ok(live);
            }
        }
    }

    pub(crate) fn fill_captures(&mut self) -> Result<(), String> {
        let live = self.live_inputs()?;
        let mut definitions = BTreeMap::new();
        for continuation in &self.continuations {
            for definition in continuation.parameters.iter().chain(
                continuation
                    .instructions
                    .iter()
                    .map(|instruction| &instruction.definition),
            ) {
                if definitions
                    .insert(definition.value, definition.clone())
                    .is_some()
                {
                    return Err(format!(
                        "function {} repeats value {}",
                        self.id.0, definition.value.0
                    ));
                }
            }
        }
        for continuation in &mut self.continuations {
            let parameters = continuation
                .parameters
                .iter()
                .map(|definition| definition.value)
                .collect::<BTreeSet<_>>();
            continuation.captures = live[continuation.id.0]
                .difference(&parameters)
                .map(|value| {
                    definitions.get(value).cloned().ok_or_else(|| {
                        format!("function {} uses absent value {}", self.id.0, value.0)
                    })
                })
                .collect::<Result<_, _>>()?;
        }
        if !self.continuations[self.entry.0].captures.is_empty() {
            return Err(format!(
                "function {} has free values at its entry",
                self.id.0
            ));
        }
        Ok(())
    }
}
