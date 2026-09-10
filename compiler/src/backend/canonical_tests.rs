use super::*;
use crate::continuation::{Definition, Graph};
use crate::hir::{RuntimeCase, RuntimeField, RuntimeSignature, RuntimeSpan};

fn module() -> RuntimeModule {
    let span = RuntimeSpan {
        file: "canonical-adapters.blot".to_owned(),
        start: 1,
        end: 2,
    };
    let types = vec![
        RuntimeType::Unit,
        RuntimeType::SignedInteger64,
        RuntimeType::Text,
        RuntimeType::Store { element_type: 2 },
        RuntimeType::Store { element_type: 3 },
        RuntimeType::Product {
            name: "OutOfOrder".to_owned(),
            fields: vec![
                RuntimeField {
                    name: "z".to_owned(),
                    type_id: 2,
                },
                RuntimeField {
                    name: "a".to_owned(),
                    type_id: 1,
                },
            ],
        },
        RuntimeType::Sum {
            name: "OutOfOrder".to_owned(),
            cases: vec![
                RuntimeCase {
                    name: "Zed".to_owned(),
                    payload_type: 2,
                },
                RuntimeCase {
                    name: "Alpha".to_owned(),
                    payload_type: 0,
                },
            ],
        },
        RuntimeType::Sealed {
            name: "Wrapped".to_owned(),
            representation_type: 5,
        },
        RuntimeType::Callback {
            function: 0,
            signature: 0,
            environment_type: 5,
        },
        RuntimeType::Store { element_type: 5 },
        RuntimeType::Store { element_type: 6 },
        RuntimeType::Resource {
            name: "Opaque".to_owned(),
            payload_type: 5,
        },
        RuntimeType::Store { element_type: 0 },
        RuntimeType::Store { element_type: 11 },
    ];
    let parameters = vec![4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    RuntimeModule {
        format: "blot-runtime-hir",
        schema_version: crate::protocol::RUNTIME_HIR_SCHEMA,
        source: span.file.clone(),
        types,
        signatures: vec![RuntimeSignature {
            parameters: parameters.clone(),
            result: 4,
            effects: vec![],
        }],
        static_stores: vec![],
        capabilities: vec![],
        links: vec![],
        exports: vec![RuntimeExport::Runtime {
            source_name: "run".to_owned(),
            phase: "runtime",
            wasm_name: "run".to_owned(),
            function: 0,
            signature: 0,
            ownership: "plain",
        }],
        graph: Graph {
            functions: vec![RuntimeFunction {
                id: FunctionId(0),
                name: "run".to_owned(),
                signature: SignatureId(0),
                entry: ContinuationId(0),
                suspends: false,
                framed: false,
                reuse: None,
                span: span.clone(),
                continuations: vec![RuntimeContinuation {
                    id: ContinuationId(0),
                    parameters: parameters
                        .iter()
                        .enumerate()
                        .map(|(index, type_id)| Definition {
                            value: ValueId(index),
                            type_id: TypeId(*type_id),
                            ownership: "plain",
                            span: span.clone(),
                        })
                        .collect(),
                    captures: vec![],
                    instructions: vec![],
                    transition: RuntimeTransition::Return { value: ValueId(0) },
                    span,
                }],
            }],
        },
    }
}

fn artifact(module: &RuntimeModule) -> Vec<u8> {
    let layouts = RuntimeTypeLayouts::new(module).expect("private layouts initialize");
    let mut types = FunctionTypes::new();
    let mut functions = FunctionSection::new();
    let allocator = allocation::Functions::declare(&mut types, &mut functions, 0);
    let managed = managed::ManagedValues::declare(module, &layouts, &mut types, &mut functions, 0)
        .expect("managed values declare");
    let canonical = CanonicalAdapters::declare(module, &layouts, &mut types, &mut functions, 0)
        .expect("canonical adapters declare");
    let mut globals = GlobalSection::new();
    add_i32_global(&mut globals, 1024, true);
    let allocation_globals = allocation::Globals::append(&mut globals, 0);
    let mut code = CodeSection::new();
    let mut hints = BranchHints::new();
    allocator
        .emit(
            &mut code,
            &mut hints,
            allocation_globals,
            1024,
            managed.drop_children,
        )
        .expect("allocator emits");
    managed
        .emit(module, &layouts, allocator, &mut code, &mut hints)
        .expect("managed values emit");
    canonical
        .emit(
            module,
            &layouts,
            allocator,
            allocation_globals,
            &mut code,
            &mut hints,
        )
        .expect("canonical adapters emit");
    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 1,
        maximum: None,
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    let mut exports = ExportSection::new();
    exports.export("memory", ExportKind::Memory, 0);
    for (name, index) in [
        ("enter", allocator.enter),
        ("leave", allocator.leave),
        ("select", allocator.select),
        ("realloc", allocator.realloc),
        ("clear_temporaries", allocator.clear_temporaries),
        ("live_bytes", allocator.live_bytes),
        ("live_allocations", allocator.live_allocations),
        ("release", allocator.release),
    ] {
        exports.export(name, ExportKind::Func, index);
    }
    for (type_id, adapters) in &canonical.types {
        exports.export(
            &format!("lower_{type_id}"),
            ExportKind::Func,
            adapters.lower,
        );
        exports.export(
            &format!("upper_{type_id}"),
            ExportKind::Func,
            adapters.upper,
        );
        exports.export(
            &format!("release_{type_id}"),
            ExportKind::Func,
            managed.values[type_id].release,
        );
    }
    let mut wasm = Module::new();
    wasm.section(&types.section)
        .section(&functions)
        .section(&memories)
        .section(&globals)
        .section(&exports)
        .section(&code);
    wasm.finish()
}

#[test]
fn canonical_adapters_validate_nested_and_reordered_boundary_values() {
    let artifact = artifact(&module());
    wasmparser::Validator::new()
        .validate_all(&artifact)
        .expect("canonical adapters validate");
    if let Ok(path) = std::env::var("BLOT_CANONICAL_TEST_ARTIFACT") {
        std::fs::write(path, artifact).expect("write requested canonical adapter artifact");
    }
}

#[test]
fn resource_payloads_do_not_require_value_adapters() {
    let mut module = module();
    module.types.push(RuntimeType::Product {
        name: "ResourceOnly".to_owned(),
        fields: vec![RuntimeField {
            name: "label".to_owned(),
            type_id: 2,
        }],
    });
    let payload = module.types.len() - 1;
    module.types[11] = RuntimeType::Resource {
        name: "Opaque".to_owned(),
        payload_type: payload,
    };
    let layouts = RuntimeTypeLayouts::new(&module).expect("private layouts initialize");
    let adapters = CanonicalAdapters::declare(
        &module,
        &layouts,
        &mut FunctionTypes::new(),
        &mut FunctionSection::new(),
        0,
    )
    .expect("resource boundary declares");
    assert!(!adapters.types.contains_key(&payload));
}
