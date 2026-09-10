use super::*;
use crate::continuation::interpreter::{Machine, Observation, Values};
use crate::hir::{RuntimeField, WireConstant};
use crate::session::CompilerSession;
use std::collections::BTreeMap;

fn session(app: &str, provider: &str, entries: &[Vec<u8>]) -> CompilerSession {
    let mut session = CompilerSession::default();
    for (path, source) in [("app.blot", app), ("lib.blot", provider)] {
        session
            .add_source(path.to_owned(), source.encode_utf16().collect())
            .expect("source should load");
    }
    session
        .configure_module(
            "app.blot",
            BTreeMap::from([("lib".to_owned(), "lib.blot".to_owned())]),
            BTreeMap::new(),
        )
        .expect("app should configure");
    session
        .configure_module("lib.blot", BTreeMap::new(), BTreeMap::new())
        .expect("provider should configure");
    for entry in entries {
        session
            .import_development_cache_entry(entry)
            .expect("persisted graph should decode");
    }
    session
}

fn build(session: &CompilerSession) -> crate::development::CompiledDevelopmentProgram {
    session
        .compile_development_program(
            "app.blot",
            "app",
            &BTreeMap::from([
                ("app".to_owned(), "app.blot".to_owned()),
                ("lib".to_owned(), "lib.blot".to_owned()),
            ]),
        )
        .expect("development graph should compile")
}

#[derive(Clone, Debug, PartialEq)]
enum Value {
    Int(i64),
    Bool(bool),
    Product(Vec<Value>),
}
impl Values for Value {
    fn condition(&self) -> Result<bool, String> {
        match self {
            Self::Bool(value) => Ok(*value),
            _ => Err("condition is not Boolean".to_owned()),
        }
    }
    fn matches(&self, constant: &WireConstant) -> bool {
        match (self, constant) {
            (Self::Int(left), WireConstant::SignedInteger64(right)) => left.to_string() == *right,
            (Self::Bool(left), WireConstant::Boolean(right)) => left == right,
            _ => false,
        }
    }
}

fn execute(entry: &Entry, arguments: Vec<Value>) -> Value {
    let mut machine =
        Machine::new(&entry.graph, entry.root, arguments).expect("graph entry should bind");
    loop {
        let result = machine
            .poll(1024, |instruction, operands| {
                let operation = &instruction.operation;
                match operation.kind {
                    "constant" => match &operation.value {
                        Some(WireConstant::SignedInteger64(value)) => {
                            Ok(Value::Int(value.parse().unwrap()))
                        }
                        Some(WireConstant::Boolean(value)) => Ok(Value::Bool(*value)),
                        _ => Err("unsupported test constant".to_owned()),
                    },
                    "scalar" => match (operation.operator, operands.as_slice()) {
                        (Some("add"), [Value::Int(left), Value::Int(right)]) => {
                            Ok(Value::Int(left + right))
                        }
                        (Some("subtract"), [Value::Int(left), Value::Int(right)]) => {
                            Ok(Value::Int(left - right))
                        }
                        (Some("equal"), [left, right]) => Ok(Value::Bool(left == right)),
                        _ => Err("unsupported test scalar".to_owned()),
                    },
                    "product.make" => Ok(Value::Product(operands)),
                    "product.project" => match operands.as_slice() {
                        [Value::Product(fields)] => Ok(fields[operation.field.unwrap()].clone()),
                        _ => Err("projection lacks its product".to_owned()),
                    },
                    _ => Err(format!("unsupported test instruction {}", operation.kind)),
                }
            })
            .expect("checked graph should execute");
        match result {
            Observation::Returned(value) => return value,
            Observation::Yielded => {}
            Observation::Trapped(message) => panic!("cached graph trapped: {message}"),
            Observation::Request { .. } => panic!("closed cache graph requested external work"),
        }
    }
}

const CAPTURE_APP: &str = "const lib = import \"lib\"\nconst run :: @type.int -> { .first = @type.int; .second = @type.int; }\nconst run = fn value => do:\n  let apply = lib.make value\n  return apply 2\nreturn { .run = run; }\n";
const CAPTURE_LIB: &str = "const make = fn captured => fn value => { .first = @int.add value captured; .second = captured; }\nreturn { .make = make; }\n";

#[test]
fn aggregate_capture_graphs_survive_restart_and_relocate_arenas() {
    let cold = session(CAPTURE_APP, CAPTURE_LIB, &[]);
    let compiled = build(&cold);
    let cold_keys = compiled
        .units
        .iter()
        .map(|unit| (unit.name.clone(), unit.implementation_key.clone()))
        .collect::<BTreeMap<_, _>>();
    assert!(compiled.work.reused_functions.is_empty());
    assert_eq!(
        compiled.work.graph_cache.get(&GraphCacheOutcome::Miss),
        Some(&1)
    );
    let entries = cold.take_development_cache_entries();
    assert_eq!(entries.len(), 1);
    let (_, (key, entry)): (u32, (Vec<u8>, Entry)) = rmp_serde::from_slice(&entries[0]).unwrap();
    assert_eq!(
        execute(&entry, vec![Value::Int(2), Value::Int(7)]),
        Value::Product(vec![Value::Int(9), Value::Int(7)])
    );
    let restarted = session(CAPTURE_APP, CAPTURE_LIB, &entries);
    let compiled = build(&restarted);
    assert_eq!(
        compiled
            .units
            .iter()
            .map(|unit| (unit.name.clone(), unit.implementation_key.clone()))
            .collect::<BTreeMap<_, _>>(),
        cold_keys
    );
    assert_eq!(compiled.work.reused_functions.get("lib.blot"), Some(&1));
    assert_eq!(
        compiled.work.graph_cache.get(&GraphCacheOutcome::Hit),
        Some(&1)
    );
    assert!(!compiled.work.specialized_functions.contains_key("lib.blot"));
    for unit in compiled.units {
        let wasm = &unit
            .artifact
            .compiled()
            .expect("restart emits each unit")
            .wasm;
        wasmparser::Validator::new().validate_all(wasm).unwrap();
    }

    let context = Rc::new(Context::default());
    context
        .residual_cache
        .borrow_mut()
        .import(&entries[0])
        .unwrap();
    let mut trace = ResidualTrace::new("different-order.blot");
    trace.next_function = 27;
    trace.types.push(RuntimeType::Float64);
    let integer = trace.types.len();
    trace.types.push(RuntimeType::SignedInteger64);
    let product = trace.types.len();
    trace.types.push(RuntimeType::Product {
        name: "new-arena-name".to_owned(),
        fields: vec![
            RuntimeField {
                name: "first".to_owned(),
                type_id: integer,
            },
            RuntimeField {
                name: "second".to_owned(),
                type_id: integer,
            },
        ],
    });
    let signature = RuntimeSignature {
        parameters: vec![integer, integer],
        result: product,
        effects: Vec::new(),
    };
    let request = Request {
        context,
        key,
        effect_stamp: (0, 0),
        function: 27,
        signature,
    };
    let restored = request
        .restore(&mut trace)
        .expect("arena relocation should reuse the graph");
    assert_eq!(restored.function, 27);
    assert!(
        trace.functions.is_empty(),
        "restoration must never reconstruct staged blocks"
    );
    assert_eq!(trace.checked_functions.len(), 1);
    assert_eq!(
        trace.signatures[restored.signature].parameters,
        vec![integer, integer]
    );
    assert_eq!(trace.signatures[restored.signature].result, product);
}

#[test]
fn recursive_function_components_restore_together() {
    let app = "const lib = import \"lib\"\nconst run :: @type.int -> @type.int\nconst run = fn value => lib.count value\nreturn { .run = run; }\n";
    let provider = "let rec even :: @type.int -> @type.int = fn value => case value of\n  0 => 0\n  _ => @int.add 1 (odd (@int.sub value 1))\nlet rec odd :: @type.int -> @type.int = fn value => case value of\n  0 => 0\n  _ => @int.add 2 (even (@int.sub value 1))\nreturn { .count = even; }\n";
    let cold = session(app, provider, &[]);
    build(&cold);
    let entries = cold.take_development_cache_entries();
    assert!(!entries.is_empty());
    let (_, (_, entry)): (u32, (Vec<u8>, Entry)) = rmp_serde::from_slice(&entries[0]).unwrap();
    assert!(entry.components.iter().any(|members| members.len() == 2));
    assert_eq!(execute(&entry, vec![Value::Int(4)]), Value::Int(6));
    let warm = session(app, provider, &entries);
    let compiled = build(&warm);
    assert_eq!(compiled.work.reused_functions.get("lib.blot"), Some(&2));
}

#[test]
fn cache_rejects_graph_corruption_and_changed_source_evidence() {
    let cold = session(CAPTURE_APP, CAPTURE_LIB, &[]);
    build(&cold);
    let entries = cold.take_development_cache_entries();
    let (schema, (key, mut entry)): (u32, (Vec<u8>, Entry)) =
        rmp_serde::from_slice(&entries[0]).unwrap();
    entry.components.clear();
    let corrupted = rmp_serde::to_vec_named(&(schema, (&key, &entry))).unwrap();
    let mut cache = ResidualCache::default();
    assert!(cache.import(&corrupted).unwrap_err().contains("components"));
    assert!(cache.entries.is_empty());
    let changed = session(
        CAPTURE_APP,
        &CAPTURE_LIB.replace("@int.add", "@int.sub"),
        &entries,
    );
    let compiled = build(&changed);
    assert!(compiled.work.reused_functions.is_empty());
    assert!(compiled.work.specialized_functions.contains_key("lib.blot"));
}

#[test]
fn portable_layout_identity_ignores_arena_positions_and_keeps_aliases() {
    let original = vec![
        RuntimeType::SignedInteger64,
        RuntimeType::Product {
            name: "old".to_owned(),
            fields: vec![RuntimeField {
                name: "value".to_owned(),
                type_id: 0,
            }],
        },
    ];
    let shifted = vec![
        RuntimeType::Text,
        RuntimeType::SignedInteger64,
        RuntimeType::Product {
            name: "new".to_owned(),
            fields: vec![RuntimeField {
                name: "value".to_owned(),
                type_id: 1,
            }],
        },
    ];
    assert_eq!(
        type_identity(&original, &[1, 0]),
        type_identity(&shifted, &[2, 1])
    );
    assert_ne!(
        type_identity(&original, &[1, 0]),
        type_identity(&shifted, &[1, 2])
    );
}

#[test]
fn graph_cache_budget_evicts_payloads_and_pending_persistence_references() {
    let cold = session(CAPTURE_APP, CAPTURE_LIB, &[]);
    build(&cold);
    let encoded = cold.take_development_cache_entries().remove(0);
    let decode = || {
        let (_, (_, mut entry)): (u32, (Vec<u8>, Entry)) = rmp_serde::from_slice(&encoded).unwrap();
        entry.bytes = RESIDENT_LIMIT / 2 + 1;
        Rc::new(entry)
    };
    let mut cache = ResidualCache::default();
    let first = decode();
    let retained = Rc::downgrade(&first);
    let key = cache.insert(vec![1], first);
    cache.pending.push(key);
    let key = cache.insert(vec![2], decode());
    cache.pending.push(key.clone());
    assert_eq!(cache.entries.len(), 1);
    assert_eq!(cache.order.len(), 1);
    assert_eq!(cache.pending, vec![key]);
    assert_eq!(retained.strong_count(), 0);
    assert!(cache.bytes <= RESIDENT_LIMIT);
}

#[test]
fn generative_source_evidence_declines_graph_persistence() {
    let app = "const lib = import \"lib\"\nconst run :: @type.int -> @type.int\nconst run = fn value => lib.run value\nreturn { .run = run; }\n";
    let provider = "const run :: @type.int -> @type.int\nconst run = fn value => do:\n  const Effect = @effect { .request = @type.int -> @type.int; }\n  return @int.add value 1\nreturn { .run = run; }\n";
    let session = session(app, provider, &[]);
    let compiled = build(&session);
    assert!(session.take_development_cache_entries().is_empty());
    assert!(
        compiled
            .work
            .graph_cache
            .contains_key(&GraphCacheOutcome::UnsupportedIdentity)
    );
}
#[test]
fn cached_generic_graphs_preserve_unchanged_unit_identity_after_provider_edits() {
    let provider = |increment| {
        format!(
            "const identity = fn value => value\nconst rec countdown :: @type.int -> @type.int\nconst rec countdown = fn value => case value of\n  0 => 0\n  value => @int.add 1 (countdown (@int.sub value 1))\nconst step0 :: @type.int -> @type.int = fn value => @int.add value 1\nconst step1 :: @type.int -> @type.int = fn value => @int.add (step0 value) 1\nconst run :: @type.int -> @type.int = fn value => @int.add (@int.add (step1 (identity value)) (countdown (@int.rem value 4))) {increment}\nconst float_identity :: @type.float32 -> @type.float32 = fn value => identity value\nreturn {{ .run = run; .float_identity = float_identity; }}\n"
        )
    };
    let mut session = CompilerSession::default();
    let app = "const first = import \"first\"\nconst second = import \"second\"\nconst run :: @type.int -> @type.int = fn value => @int.add (first.run value) (second.run value)\nconst float_run :: @type.float32 -> @type.float32 = fn value => @f32.add (first.float_identity value) (second.float_identity value)\nreturn { .run = run; .float_run = float_run; }\n";
    session
        .add_source("app.blot".into(), app.encode_utf16().collect())
        .unwrap();
    session
        .configure_module(
            "app.blot",
            BTreeMap::from([
                ("first".into(), "first.blot".into()),
                ("second".into(), "second.blot".into()),
            ]),
            BTreeMap::new(),
        )
        .unwrap();
    for path in ["first.blot", "second.blot"] {
        session
            .add_source(path.into(), provider(1).encode_utf16().collect())
            .unwrap();
        session
            .configure_module(path, BTreeMap::new(), BTreeMap::new())
            .unwrap();
    }
    let units = BTreeMap::from([
        ("app".into(), "app.blot".into()),
        ("first".into(), "first.blot".into()),
        ("second".into(), "second.blot".into()),
    ]);
    let initial = session
        .compile_development_program("app.blot", "app", &units)
        .unwrap();
    session
        .commit_development_program(initial.transaction_id)
        .unwrap();
    session
        .add_source("first.blot".into(), provider(2).encode_utf16().collect())
        .unwrap();
    let changed = session
        .compile_development_program("app.blot", "app", &units)
        .unwrap();
    let changed_names = changed
        .units
        .iter()
        .filter(|unit| unit.artifact.compiled().is_some())
        .map(|unit| unit.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(changed_names, vec!["first"]);
    assert_eq!(changed.work.emitted_units, 1);
}
