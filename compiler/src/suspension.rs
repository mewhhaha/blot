use std::collections::{BTreeMap, BTreeSet};

use crate::hir::{RuntimeModule, RuntimeType};

#[derive(Clone)]
pub(crate) struct ResumeSegment {
    pub(crate) block: usize,
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) suspends: bool,
}

pub(crate) struct ResumableFunction {
    pub(crate) segments: Vec<ResumeSegment>,
    pub(crate) block_entries: BTreeMap<usize, usize>,
}

pub(crate) struct SuspensionPlan {
    pub(crate) suspending: BTreeSet<usize>,
    pub(crate) functions: BTreeMap<usize, ResumableFunction>,
}

impl SuspensionPlan {
    pub(crate) fn new(module: &RuntimeModule) -> Self {
        let operations = module
            .capabilities
            .iter()
            .flat_map(|capability| {
                capability.operations.iter().filter_map(|operation| {
                    if operation.contract.suspends {
                        Some((capability.name.as_str(), operation.name.as_str()))
                    } else {
                        None
                    }
                })
            })
            .collect::<BTreeSet<_>>();
        let links = module
            .links
            .iter()
            .filter(|link| link.suspends)
            .map(|link| (link.unit.as_str(), link.name.as_str()))
            .collect::<BTreeSet<_>>();
        let mut suspending = module
            .resumable_roots
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        let mut callers = BTreeMap::<usize, Vec<usize>>::new();
        let mut callees = BTreeMap::<usize, Vec<usize>>::new();
        let mut requests = BTreeSet::new();
        for function in &module.functions {
            for operation in function.blocks.iter().flat_map(|block| &block.operations) {
                match operation.kind {
                    "host.call" | "call.external" => {
                        let key = (
                            operation
                                .capability
                                .as_deref()
                                .expect("checked capability or unit"),
                            operation
                                .operation
                                .as_deref()
                                .expect("checked operation or link"),
                        );
                        let boundaries = if operation.kind == "host.call" {
                            &operations
                        } else {
                            &links
                        };
                        if boundaries.contains(&key) {
                            suspending.insert(function.id);
                            requests.insert((function.id, operation.result));
                        }
                    }
                    "call.direct" => {
                        let callee = operation.function.expect("checked direct call target");
                        callers.entry(callee).or_default().push(function.id);
                        callees.entry(function.id).or_default().push(callee);
                    }
                    _ => {}
                }
            }
        }
        let mut pending = suspending.iter().copied().collect::<Vec<_>>();
        while let Some(callee) = pending.pop() {
            for caller in callers.get(&callee).into_iter().flatten() {
                if suspending.insert(*caller) {
                    pending.push(*caller);
                }
            }
        }
        let mut framed = suspending.clone();
        framed.extend(module.types.iter().filter_map(|type_| {
            if let RuntimeType::Callback { function, .. } = type_ {
                Some(*function)
            } else {
                None
            }
        }));
        // Pure callback callees need frames for cooperative CPU checkpoints,
        // while their ordinary exports keep the direct calling convention.
        let mut pending = framed.iter().copied().collect::<Vec<_>>();
        while let Some(caller) = pending.pop() {
            for callee in callees.get(&caller).into_iter().flatten() {
                if framed.insert(*callee) {
                    pending.push(*callee);
                }
            }
        }
        let mut functions = BTreeMap::new();
        for function in &module.functions {
            if !framed.contains(&function.id) {
                continue;
            }
            let mut segments = Vec::new();
            let mut block_entries = BTreeMap::new();
            for block in &function.blocks {
                block_entries.insert(block.id, segments.len());
                let mut start = 0;
                for (index, operation) in block.operations.iter().enumerate() {
                    if requests.contains(&(function.id, operation.result))
                        || (operation.kind == "call.direct"
                            && framed
                                .contains(&operation.function.expect("checked direct call target")))
                    {
                        segments.push(ResumeSegment {
                            block: block.id,
                            start,
                            end: index + 1,
                            suspends: true,
                        });
                        start = index + 1;
                    }
                }
                segments.push(ResumeSegment {
                    block: block.id,
                    start,
                    end: block.operations.len(),
                    suspends: false,
                });
            }
            functions.insert(
                function.id,
                ResumableFunction {
                    segments,
                    block_entries,
                },
            );
        }
        Self {
            suspending,
            functions,
        }
    }
}
