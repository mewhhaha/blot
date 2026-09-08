use std::collections::{BTreeMap, BTreeSet};

use crate::hir::{RuntimeFunction, RuntimeModule};
use crate::value::Suspension;

/// A segment ends before control leaves the current activation. Ordinary
/// operations stay together; resuming never replays an earlier operation.
pub(crate) struct ResumeSegment {
    pub(crate) block: usize,
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) host_result: Option<usize>,
}

pub(crate) struct ResumableFunction {
    pub(crate) segments: Vec<ResumeSegment>,
    pub(crate) block_entries: BTreeMap<usize, usize>,
}

pub(crate) struct SuspensionPlan {
    pub(crate) functions: BTreeMap<usize, ResumableFunction>,
}

impl SuspensionPlan {
    pub(crate) fn new(module: &RuntimeModule) -> Result<Self, String> {
        let suspending_operations = module
            .capabilities
            .iter()
            .flat_map(|capability| {
                capability.operations.iter().filter_map(|operation| {
                    if operation.contract.suspension == Suspension::MaySuspend {
                        Some((capability.name.as_str(), operation.name.as_str()))
                    } else {
                        None
                    }
                })
            })
            .collect::<BTreeSet<_>>();
        let mut functions = BTreeSet::new();
        let mut callers = BTreeMap::<usize, Vec<usize>>::new();
        for function in &module.functions {
            for operation in function.blocks.iter().flat_map(|block| &block.operations) {
                match operation.kind {
                    "host.call" => {
                        if suspending_operations.contains(&(
                            operation
                                .capability
                                .as_deref()
                                .ok_or("host call omitted capability")?,
                            operation
                                .operation
                                .as_deref()
                                .ok_or("host call omitted operation")?,
                        )) {
                            functions.insert(function.id);
                        }
                    }
                    "call.direct" => {
                        callers
                            .entry(operation.function.ok_or("direct call omitted function")?)
                            .or_default()
                            .push(function.id);
                    }
                    _ => {}
                }
            }
        }
        let mut pending = functions.iter().copied().collect::<Vec<_>>();
        while let Some(callee) = pending.pop() {
            for caller in callers.get(&callee).into_iter().flatten() {
                if functions.insert(*caller) {
                    pending.push(*caller);
                }
            }
        }
        let mut planned = BTreeMap::new();
        for function in &module.functions {
            if !functions.contains(&function.id) {
                continue;
            }
            let mut segments = Vec::new();
            let mut block_entries = BTreeMap::new();
            for block in &function.blocks {
                block_entries.insert(block.id, segments.len());
                let mut start = 0;
                let mut host_result = None;
                for (index, operation) in block.operations.iter().enumerate() {
                    let suspends = match operation.kind {
                        "host.call" => suspending_operations.contains(&(
                            operation
                                .capability
                                .as_deref()
                                .ok_or("host call omitted capability")?,
                            operation
                                .operation
                                .as_deref()
                                .ok_or("host call omitted operation")?,
                        )),
                        "call.direct" => functions
                            .contains(&operation.function.ok_or("direct call omitted function")?),
                        _ => false,
                    };
                    if suspends {
                        segments.push(ResumeSegment {
                            block: block.id,
                            start,
                            end: index,
                            host_result,
                        });
                        start = index + 1;
                        host_result = if operation.kind == "host.call" {
                            Some(index)
                        } else {
                            None
                        };
                    }
                }
                segments.push(ResumeSegment {
                    block: block.id,
                    start,
                    end: block.operations.len(),
                    host_result,
                });
            }
            planned.insert(
                function.id,
                ResumableFunction {
                    segments,
                    block_entries,
                },
            );
        }
        Ok(Self { functions: planned })
    }

    pub(crate) fn contains(&self, function: &RuntimeFunction) -> bool {
        self.functions.contains_key(&function.id)
    }
}
