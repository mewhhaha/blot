mod ast;
mod backend;
mod cst;
mod diagnostic;
mod eval;
mod fixity;
mod frontend;
mod hir;
mod host_transport;
mod layout;
mod lower;
mod ownership;
mod partition;
mod predicate_refinement;
mod primitives;
mod protocol;
mod rebinding;
mod recognise;
mod relational;
mod safety;
mod session;
mod source;
mod typecheck;
mod value;
mod value_capsule;

use std::cell::RefCell;
use std::sync::{Mutex, OnceLock};

use session::{AddSourceError, CompilerSession, compiler_failure_json};

static LOWER_RESULT: OnceLock<Mutex<Vec<u8>>> = OnceLock::new();
thread_local! {
    static SESSIONS: RefCell<Vec<Option<CompilerSession>>> = const { RefCell::new(Vec::new()) };
    static COMPILED_MODULE: RefCell<Option<backend::CompiledModule>> = const { RefCell::new(None) };
    static MODULE_SNAPSHOT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Version of the JSON/binary transport consumed by `src/compiler/wasm.ts`.
#[unsafe(no_mangle)]
pub extern "C" fn compiler_host_abi_version() -> u32 {
    protocol::COMPILER_HOST_ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn allocate_words(word_count: u32) -> *mut i32 {
    let words = vec![0_i32; word_count as usize].into_boxed_slice();
    Box::into_raw(words) as *mut i32
}

#[unsafe(no_mangle)]
pub extern "C" fn allocate_bytes(byte_count: u32) -> *mut u8 {
    let bytes = vec![0_u8; byte_count as usize].into_boxed_slice();
    Box::into_raw(bytes) as *mut u8
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `pointer` must come from `allocate_bytes`, and `byte_count` must be the same
/// value passed to that allocation. The allocation must not have been freed.
pub unsafe extern "C" fn deallocate_bytes(pointer: *mut u8, byte_count: u32) {
    let slice = std::ptr::slice_from_raw_parts_mut(pointer, byte_count as usize);
    drop(unsafe { Box::from_raw(slice) });
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `pointer` must come from `allocate_words`, and `word_count` must be the same
/// value passed to that allocation. The allocation must not have been freed.
pub unsafe extern "C" fn deallocate_words(pointer: *mut i32, word_count: u32) {
    let slice = std::ptr::slice_from_raw_parts_mut(pointer, word_count as usize);
    drop(unsafe { Box::from_raw(slice) });
}

#[unsafe(no_mangle)]
/// Parses and lowers one Blot source module entirely inside Rust.
///
/// # Safety
///
/// `source_pointer` must address `source_unit_count` initialized `i32` words
/// in this module's linear memory for the duration of the call.
pub unsafe extern "C" fn lower_source(source_pointer: *const i32, source_unit_count: u32) -> u32 {
    let source_words =
        unsafe { std::slice::from_raw_parts(source_pointer, source_unit_count as usize) };
    let lowered = decode_source_words(source_words).map(|source| {
        match source::lower_incremental(&source, None) {
            Ok(lowered) => serde_json::json!({ "ok": true, "module": lowered.module }),
            Err(source::SourceError::Diagnostics(diagnostics)) => serde_json::json!({
                "ok": false,
                "diagnostics": diagnostics.iter().map(diagnostic_json).collect::<Vec<_>>(),
            }),
            Err(source::SourceError::Lowering(message)) => {
                serde_json::json!({ "ok": false, "message": message })
            }
        }
    });
    let result = match lowered {
        Ok(result) => result,
        Err(message) => serde_json::json!({ "ok": false, "message": message }),
    };
    write_result(serde_json::to_vec(&result).expect("source lowering result serialization failed"))
}

#[unsafe(no_mangle)]
pub extern "C" fn lower_result_pointer() -> *const u8 {
    LOWER_RESULT
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .expect("lower result mutex was poisoned")
        .as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn create_compiler_session() -> u32 {
    SESSIONS.with(|sessions| {
        let mut sessions = sessions.borrow_mut();
        if let Some((index, slot)) = sessions
            .iter_mut()
            .enumerate()
            .find(|(_, session)| session.is_none())
        {
            *slot = Some(CompilerSession::default());
            return index as u32 + 1;
        }
        sessions.push(Some(CompilerSession::default()));
        sessions.len() as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn destroy_compiler_session(handle: u32) -> i32 {
    let Ok(index) = session_index(handle) else {
        return 1;
    };
    SESSIONS.with(|sessions| {
        let mut sessions = sessions.borrow_mut();
        let Some(slot) = sessions.get_mut(index) else {
            return 1;
        };
        if slot.take().is_none() {
            return 1;
        }
        0
    })
}

#[unsafe(no_mangle)]
/// Registers UTF-8 module/include paths and returns stable session-local IDs.
///
/// # Safety
///
/// `frame_pointer` must address `frame_byte_count` initialized bytes in this
/// module's linear memory for the duration of the call.
pub unsafe extern "C" fn register_compiler_session_paths(
    handle: u32,
    frame_pointer: *const u8,
    frame_byte_count: u32,
) -> u32 {
    let frame = unsafe { std::slice::from_raw_parts(frame_pointer, frame_byte_count as usize) };
    let result = session_index(handle).and_then(|index| {
        SESSIONS.with(|sessions| {
            let mut sessions = sessions.borrow_mut();
            let session = sessions
                .get_mut(index)
                .and_then(Option::as_mut)
                .ok_or_else(|| format!("unknown compiler session {handle}"))?;
            host_transport::register_paths(session, frame)
        })
    });
    write_result(host_transport::encode_response(result))
}

#[unsafe(no_mangle)]
/// Applies a validated ABI-2 binary graph delta in one guest call.
///
/// # Safety
///
/// `frame_pointer` must address `frame_byte_count` initialized bytes in this
/// module's linear memory for the duration of the call.
pub unsafe extern "C" fn apply_compiler_session_delta(
    handle: u32,
    frame_pointer: *const u8,
    frame_byte_count: u32,
) -> u32 {
    let frame = unsafe { std::slice::from_raw_parts(frame_pointer, frame_byte_count as usize) };
    let result = session_index(handle).and_then(|index| {
        SESSIONS.with(|sessions| {
            let mut sessions = sessions.borrow_mut();
            let session = sessions
                .get_mut(index)
                .and_then(Option::as_mut)
                .ok_or_else(|| format!("unknown compiler session {handle}"))?;
            host_transport::apply_delta(session, frame)
        })
    });
    write_result(host_transport::encode_response(result))
}

#[unsafe(no_mangle)]
pub extern "C" fn check_compiler_session_module_v2(handle: u32, module_id: u32) -> u32 {
    let result = session_index(handle).and_then(|index| {
        SESSIONS.with(|sessions| {
            let sessions = sessions.borrow();
            let session = sessions
                .get(index)
                .and_then(Option::as_ref)
                .ok_or_else(|| format!("unknown compiler session {handle}"))?;
            host_transport::check_module(session, module_id)
        })
    });
    write_result(host_transport::encode_response(result))
}

#[unsafe(no_mangle)]
pub extern "C" fn analyze_compiler_session_module_v2(
    handle: u32,
    module_id: u32,
    requested_fact_mask: u32,
) -> u32 {
    let result = session_index(handle).and_then(|index| {
        SESSIONS.with(|sessions| {
            let sessions = sessions.borrow();
            let session = sessions
                .get(index)
                .and_then(Option::as_ref)
                .ok_or_else(|| format!("unknown compiler session {handle}"))?;
            host_transport::analyze_module(session, module_id, requested_fact_mask)
        })
    });
    write_result(host_transport::encode_response(result))
}

#[unsafe(no_mangle)]
/// Removes one resident module and all private state owned by its revision.
///
/// # Safety
///
/// `path_pointer` must address `path_unit_count` initialized `i32` words in
/// this module's linear memory for the duration of the call.
pub unsafe extern "C" fn remove_compiler_session_module(
    handle: u32,
    path_pointer: *const i32,
    path_unit_count: u32,
) -> u32 {
    let path_words = unsafe { std::slice::from_raw_parts(path_pointer, path_unit_count as usize) };
    let removed = decode_utf16_words(path_words, "module path").and_then(|path| {
        let index = session_index(handle)?;
        SESSIONS.with(|sessions| {
            let mut sessions = sessions.borrow_mut();
            let session = sessions
                .get_mut(index)
                .and_then(Option::as_mut)
                .ok_or_else(|| format!("unknown compiler session {handle}"))?;
            Ok(session.remove_module(&path))
        })
    });
    let result = match removed {
        Ok(removed) => serde_json::json!({ "ok": true, "removed": removed }),
        Err(message) => serde_json::json!({ "ok": false, "message": message }),
    };
    write_result(serde_json::to_vec(&result).expect("module removal serialization failed"))
}

#[unsafe(no_mangle)]
/// Parses, lowers, and adds or replaces one resident source module.
///
/// # Safety
///
/// Both pointers must address their declared number of initialized `i32`
/// words in this module's linear memory for the duration of the call.
pub unsafe extern "C" fn add_compiler_session_source(
    handle: u32,
    path_pointer: *const i32,
    path_unit_count: u32,
    source_pointer: *const i32,
    source_unit_count: u32,
) -> u32 {
    let path_words = unsafe { std::slice::from_raw_parts(path_pointer, path_unit_count as usize) };
    let source_words =
        unsafe { std::slice::from_raw_parts(source_pointer, source_unit_count as usize) };
    let added = decode_utf16_words(path_words, "module path")
        .and_then(|path| decode_source_words(source_words).map(|source| (path, source)));
    let result = match added {
        Ok((path, source)) => add_session_source(handle, path, source),
        Err(message) => serde_json::json!({ "ok": false, "message": message }),
    };
    write_result(serde_json::to_vec(&result).expect("session source result serialization failed"))
}

#[unsafe(no_mangle)]
/// Validates and adds or replaces one resident portable-AST module.
///
/// # Safety
///
/// Both pointers must address their declared number of initialized `i32`
/// words in this module's linear memory for the duration of the call.
pub unsafe extern "C" fn add_compiler_session_ast(
    handle: u32,
    path_pointer: *const i32,
    path_unit_count: u32,
    ast_pointer: *const i32,
    ast_unit_count: u32,
) -> u32 {
    let path_words = unsafe { std::slice::from_raw_parts(path_pointer, path_unit_count as usize) };
    let ast_words = unsafe { std::slice::from_raw_parts(ast_pointer, ast_unit_count as usize) };
    let added = decode_utf16_words(path_words, "module path")
        .and_then(|path| decode_utf16_words(ast_words, "portable AST").map(|ast| (path, ast)))
        .and_then(|(path, encoded)| {
            serde_json::from_str::<ast::Module>(&encoded)
                .map_err(|error| format!("portable AST is not valid JSON: {error}"))
                .map(|module| (path, module))
        });
    let result = match added {
        Ok((path, module)) => add_session_module(handle, path, module),
        Err(message) => serde_json::json!({ "ok": false, "message": message }),
    };
    write_result(serde_json::to_vec(&result).expect("session AST result serialization failed"))
}

#[unsafe(no_mangle)]
/// Configures the resolved dependency graph for one resident module.
///
/// # Safety
///
/// Both pointers must address their declared number of initialized `i32`
/// words in this module's linear memory for the duration of the call.
pub unsafe extern "C" fn configure_compiler_session_module(
    handle: u32,
    path_pointer: *const i32,
    path_unit_count: u32,
    configuration_pointer: *const i32,
    configuration_unit_count: u32,
) -> u32 {
    let path_words = unsafe { std::slice::from_raw_parts(path_pointer, path_unit_count as usize) };
    let configuration_words = unsafe {
        std::slice::from_raw_parts(configuration_pointer, configuration_unit_count as usize)
    };
    let configured = decode_utf16_words(path_words, "module path")
        .and_then(|path| {
            decode_utf16_words(configuration_words, "module configuration").map(|json| (path, json))
        })
        .and_then(|(path, json)| {
            let configuration: serde_json::Value = serde_json::from_str(&json)
                .map_err(|error| format!("module configuration is not JSON: {error}"))?;
            let imports = configuration
                .get("imports")
                .and_then(serde_json::Value::as_object)
                .ok_or_else(|| "module configuration has no imports object".to_owned())?
                .iter()
                .map(|(specifier, path)| {
                    path.as_str()
                        .map(|path| (specifier.clone(), path.to_owned()))
                        .ok_or_else(|| format!("import {specifier} does not name a path"))
                })
                .collect::<Result<std::collections::BTreeMap<_, _>, _>>()?;
            let includes = configuration
                .get("includes")
                .and_then(serde_json::Value::as_object)
                .ok_or_else(|| "module configuration has no includes object".to_owned())?
                .iter()
                .map(|(specifier, included)| {
                    let path = included
                        .get("path")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| format!("include {specifier} has no path"))?;
                    let text = included
                        .get("text")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| format!("include {specifier} has no text"))?;
                    Ok((
                        specifier.clone(),
                        eval::IncludedFile {
                            path: path.to_owned(),
                            text: text.to_owned(),
                        },
                    ))
                })
                .collect::<Result<std::collections::BTreeMap<_, _>, String>>()?;
            let index = session_index(handle)?;
            SESSIONS.with(|sessions| {
                sessions
                    .borrow_mut()
                    .get_mut(index)
                    .and_then(Option::as_mut)
                    .ok_or_else(|| format!("unknown compiler session {handle}"))?
                    .configure_module(&path, imports, includes)
            })
        });
    let result = match configured {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(message) => serde_json::json!({ "ok": false, "message": message }),
    };
    write_result(serde_json::to_vec(&result).expect("configuration result serialization failed"))
}

#[unsafe(no_mangle)]
/// Evaluates one fully configured resident module.
///
/// # Safety
///
/// `path_pointer` must address `path_unit_count` initialized `i32` words in
/// this module's linear memory for the duration of the call.
pub unsafe extern "C" fn evaluate_compiler_session_module(
    handle: u32,
    path_pointer: *const i32,
    path_unit_count: u32,
) -> u32 {
    let path_words = unsafe { std::slice::from_raw_parts(path_pointer, path_unit_count as usize) };
    let evaluated = decode_utf16_words(path_words, "module path").and_then(|path| {
        let index = session_index(handle)?;
        SESSIONS.with(|sessions| {
            let sessions = sessions.borrow();
            let session = sessions
                .get(index)
                .and_then(Option::as_ref)
                .ok_or_else(|| format!("unknown compiler session {handle}"))?;
            Ok(session.evaluate_module(&path))
        })
    });
    let result = match evaluated {
        Ok(result) => result,
        Err(message) => serde_json::json!({ "ok": false, "message": message }),
    };
    write_result(serde_json::to_vec(&result).expect("evaluation result serialization failed"))
}

#[unsafe(no_mangle)]
/// Checks one fully configured resident module.
///
/// # Safety
///
/// `path_pointer` must address `path_unit_count` initialized `i32` words in
/// this module's linear memory for the duration of the call.
pub unsafe extern "C" fn check_compiler_session_module(
    handle: u32,
    path_pointer: *const i32,
    path_unit_count: u32,
) -> u32 {
    let path_words = unsafe { std::slice::from_raw_parts(path_pointer, path_unit_count as usize) };
    let checked = decode_utf16_words(path_words, "module path").and_then(|path| {
        let index = session_index(handle)?;
        SESSIONS.with(|sessions| {
            let sessions = sessions.borrow();
            let session = sessions
                .get(index)
                .and_then(Option::as_ref)
                .ok_or_else(|| format!("unknown compiler session {handle}"))?;
            Ok(session.check_module(&path))
        })
    });
    let result = match checked {
        Ok(result) => result,
        Err(message) => serde_json::json!({ "ok": false, "message": message }),
    };
    write_result(serde_json::to_vec(&result).expect("check result serialization failed"))
}

#[unsafe(no_mangle)]
/// Returns request-local semantic facts for editor and tool hosts.
///
/// # Safety
///
/// `path_pointer` must address `path_unit_count` initialized `i32` words in
/// this module's linear memory for the duration of the call.
pub unsafe extern "C" fn analyze_compiler_session_module(
    handle: u32,
    path_pointer: *const i32,
    path_unit_count: u32,
) -> u32 {
    let path_words = unsafe { std::slice::from_raw_parts(path_pointer, path_unit_count as usize) };
    let analyzed = decode_utf16_words(path_words, "module path").and_then(|path| {
        let index = session_index(handle)?;
        SESSIONS.with(|sessions| {
            let sessions = sessions.borrow();
            let session = sessions
                .get(index)
                .and_then(Option::as_ref)
                .ok_or_else(|| format!("unknown compiler session {handle}"))?;
            Ok(session.analyze_module(&path))
        })
    });
    let result = match analyzed {
        Ok(result) => result,
        Err(message) => serde_json::json!({ "ok": false, "message": message }),
    };
    write_result(serde_json::to_vec(&result).expect("analysis result serialization failed"))
}

#[unsafe(no_mangle)]
/// Exports the canonical portable AST owned by the Rust frontend.
///
/// # Safety
///
/// `path_pointer` must address `path_unit_count` initialized `i32` words in
/// this module's linear memory for the duration of the call.
pub unsafe extern "C" fn export_compiler_session_module_ast(
    handle: u32,
    path_pointer: *const i32,
    path_unit_count: u32,
) -> u32 {
    let path_words = unsafe { std::slice::from_raw_parts(path_pointer, path_unit_count as usize) };
    let exported = decode_utf16_words(path_words, "module path").and_then(|path| {
        let index = session_index(handle)?;
        SESSIONS.with(|sessions| {
            let sessions = sessions.borrow();
            sessions
                .get(index)
                .and_then(Option::as_ref)
                .ok_or_else(|| format!("unknown compiler session {handle}"))?
                .module_ast(&path)
        })
    });
    let result = match exported {
        Ok(ast) => serde_json::json!({ "ok": true, "ast": ast }),
        Err(message) => serde_json::json!({ "ok": false, "message": message }),
    };
    write_result(serde_json::to_vec(&result).expect("portable AST result serialization failed"))
}

#[unsafe(no_mangle)]
/// Discovers and executes declaration-tag tests in one configured module.
///
/// # Safety
///
/// `path_pointer` must address `path_unit_count` initialized `i32` words in
/// this module's linear memory for the duration of the call.
pub unsafe extern "C" fn test_compiler_session_module(
    handle: u32,
    path_pointer: *const i32,
    path_unit_count: u32,
) -> u32 {
    let path_words = unsafe { std::slice::from_raw_parts(path_pointer, path_unit_count as usize) };
    let tested = decode_utf16_words(path_words, "module path").and_then(|path| {
        let index = session_index(handle)?;
        SESSIONS.with(|sessions| {
            let mut sessions = sessions.borrow_mut();
            let session = sessions
                .get_mut(index)
                .and_then(Option::as_mut)
                .ok_or_else(|| format!("unknown compiler session {handle}"))?;
            Ok(session.test_module(&path))
        })
    });
    let result = match tested {
        Ok(result) => result,
        Err(message) => serde_json::json!({ "ok": false, "message": message }),
    };
    write_result(serde_json::to_vec(&result).expect("test result serialization failed"))
}

#[unsafe(no_mangle)]
/// Exports a binary AST and closed checked interface for one resident module.
///
/// # Safety
///
/// `path_pointer` must address `path_unit_count` initialized `i32` words in
/// this module's linear memory for the duration of the call.
pub unsafe extern "C" fn export_compiler_session_module_snapshot(
    handle: u32,
    path_pointer: *const i32,
    path_unit_count: u32,
) -> u32 {
    let path_words = unsafe { std::slice::from_raw_parts(path_pointer, path_unit_count as usize) };
    let snapshot = decode_utf16_words(path_words, "module path").and_then(|path| {
        let index = session_index(handle)?;
        SESSIONS.with(|sessions| {
            let sessions = sessions.borrow();
            let session = sessions
                .get(index)
                .and_then(Option::as_ref)
                .ok_or_else(|| format!("unknown compiler session {handle}"))?;
            session.module_snapshot(&path)
        })
    });
    let result = match snapshot {
        Ok(snapshot) => {
            MODULE_SNAPSHOT.with(|slot| *slot.borrow_mut() = snapshot);
            serde_json::json!({ "ok": true })
        }
        Err(message) => {
            MODULE_SNAPSHOT.with(|slot| slot.borrow_mut().clear());
            serde_json::json!({ "ok": false, "message": message })
        }
    };
    write_result(serde_json::to_vec(&result).expect("module snapshot result serialization failed"))
}

#[unsafe(no_mangle)]
/// Installs a dependency-free binary module snapshot in one session.
///
/// # Safety
///
/// `path_pointer` must address `path_unit_count` initialized `i32` words and
/// `snapshot_pointer` must address `snapshot_byte_count` initialized bytes in
/// this module's linear memory for the duration of the call.
pub unsafe extern "C" fn install_compiler_session_module_snapshot(
    handle: u32,
    path_pointer: *const i32,
    path_unit_count: u32,
    snapshot_pointer: *const u8,
    snapshot_byte_count: u32,
) -> u32 {
    let path_words = unsafe { std::slice::from_raw_parts(path_pointer, path_unit_count as usize) };
    let snapshot =
        unsafe { std::slice::from_raw_parts(snapshot_pointer, snapshot_byte_count as usize) };
    let installed = decode_utf16_words(path_words, "module path").and_then(|path| {
        let index = session_index(handle)?;
        SESSIONS.with(|sessions| {
            let mut sessions = sessions.borrow_mut();
            let session = sessions
                .get_mut(index)
                .and_then(Option::as_mut)
                .ok_or_else(|| format!("unknown compiler session {handle}"))?;
            session.install_module_snapshot(&path, snapshot)
        })
    });
    let result = match installed {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(message) => serde_json::json!({ "ok": false, "message": message }),
    };
    write_result(serde_json::to_vec(&result).expect("module snapshot result serialization failed"))
}

#[unsafe(no_mangle)]
pub extern "C" fn module_snapshot_pointer() -> *const u8 {
    MODULE_SNAPSHOT.with(|slot| slot.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn module_snapshot_length() -> u32 {
    MODULE_SNAPSHOT.with(|slot| slot.borrow().len() as u32)
}

#[unsafe(no_mangle)]
/// Prepares schema-1 Blot Runtime HIR for one fully configured resident module.
///
/// # Safety
///
/// `path_pointer` must address `path_unit_count` initialized `i32` words in
/// this module's linear memory for the duration of the call.
pub unsafe extern "C" fn prepare_compiler_session_runtime_hir(
    handle: u32,
    path_pointer: *const i32,
    path_unit_count: u32,
) -> u32 {
    let path_words = unsafe { std::slice::from_raw_parts(path_pointer, path_unit_count as usize) };
    let prepared = decode_utf16_words(path_words, "module path").and_then(|path| {
        let index = session_index(handle)?;
        SESSIONS.with(|sessions| {
            let sessions = sessions.borrow();
            let session = sessions
                .get(index)
                .and_then(Option::as_ref)
                .ok_or_else(|| format!("unknown compiler session {handle}"))?;
            Ok(session.prepare_runtime_hir(&path))
        })
    });
    let result = match prepared {
        Ok(result) => result,
        Err(message) => serde_json::json!({ "ok": false, "message": message }),
    };
    write_result(serde_json::to_vec(&result).expect("Runtime HIR result serialization failed"))
}

#[unsafe(no_mangle)]
/// Compiles one configured resident module to its caller-facing Wasm artifact.
///
/// # Safety
///
/// `path_pointer` must address `path_unit_count` initialized `i32` words in
/// this module's linear memory for the duration of the call.
pub unsafe extern "C" fn compile_compiler_session_module(
    handle: u32,
    path_pointer: *const i32,
    path_unit_count: u32,
) -> u32 {
    let path_words = unsafe { std::slice::from_raw_parts(path_pointer, path_unit_count as usize) };
    let compiled = decode_utf16_words(path_words, "module path").and_then(|path| {
        let index = session_index(handle)?;
        SESSIONS.with(|sessions| {
            let sessions = sessions.borrow();
            let session = sessions
                .get(index)
                .and_then(Option::as_ref)
                .ok_or_else(|| format!("unknown compiler session {handle}"))?;
            session.compile_module(&path).map_err(|diagnostic| {
                serde_json::to_string(&compiler_failure_json(diagnostic, "backend emission"))
                    .expect("backend failure serialization failed")
            })
        })
    });
    let result = match compiled {
        Ok(compiled) => {
            let capabilities = compiled.capabilities.clone();
            COMPILED_MODULE.with(|slot| *slot.borrow_mut() = Some(compiled));
            serde_json::json!({ "ok": true, "capabilities": capabilities })
        }
        Err(message) => {
            COMPILED_MODULE.with(|slot| *slot.borrow_mut() = None);
            if let Ok(failure) = serde_json::from_str::<serde_json::Value>(&message) {
                failure
            } else {
                serde_json::json!({ "ok": false, "message": message })
            }
        }
    };
    write_result(serde_json::to_vec(&result).expect("compile result serialization failed"))
}

#[unsafe(no_mangle)]
pub extern "C" fn compiled_wasm_pointer() -> *const u8 {
    COMPILED_MODULE.with(|slot| {
        slot.borrow()
            .as_ref()
            .map_or(std::ptr::null(), |compiled| compiled.wasm.as_ptr())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn compiled_wasm_length() -> u32 {
    COMPILED_MODULE.with(|slot| {
        slot.borrow()
            .as_ref()
            .map_or(0, |compiled| compiled.wasm.len() as u32)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn compiled_manifest_pointer() -> *const u8 {
    COMPILED_MODULE.with(|slot| {
        slot.borrow()
            .as_ref()
            .map_or(std::ptr::null(), |compiled| compiled.manifest.as_ptr())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn compiled_manifest_length() -> u32 {
    COMPILED_MODULE.with(|slot| {
        slot.borrow()
            .as_ref()
            .map_or(0, |compiled| compiled.manifest.len() as u32)
    })
}

fn session_index(handle: u32) -> Result<usize, String> {
    let index = handle
        .checked_sub(1)
        .ok_or_else(|| "compiler session handle 0 is invalid".to_owned())?;
    Ok(index as usize)
}

fn add_session_source(handle: u32, path: String, source: Vec<u16>) -> serde_json::Value {
    let index = match session_index(handle) {
        Ok(index) => index,
        Err(message) => return serde_json::json!({ "ok": false, "message": message }),
    };
    SESSIONS.with(|sessions| {
        let mut sessions = sessions.borrow_mut();
        let Some(session) = sessions.get_mut(index).and_then(Option::as_mut) else {
            return serde_json::json!({
                "ok": false,
                "message": format!("unknown compiler session {handle}"),
            });
        };
        match session.add_source(path, source) {
            Ok(module) => serde_json::json!({ "ok": true, "module": module }),
            Err(AddSourceError::Diagnostics(diagnostics)) => serde_json::json!({
                "ok": false,
                "diagnostics": diagnostics.iter().map(diagnostic_json).collect::<Vec<_>>(),
            }),
            Err(AddSourceError::Lowering(message)) => {
                serde_json::json!({ "ok": false, "message": message })
            }
        }
    })
}

fn add_session_module(handle: u32, path: String, module: ast::Module) -> serde_json::Value {
    let index = match session_index(handle) {
        Ok(index) => index,
        Err(message) => return serde_json::json!({ "ok": false, "message": message }),
    };
    SESSIONS.with(|sessions| {
        let mut sessions = sessions.borrow_mut();
        let Some(session) = sessions.get_mut(index).and_then(Option::as_mut) else {
            return serde_json::json!({
                "ok": false,
                "message": format!("unknown compiler session {handle}"),
            });
        };
        match session.add_module(path, module) {
            Ok(module) => serde_json::json!({ "ok": true, "module": module }),
            Err(message) => serde_json::json!({ "ok": false, "message": message }),
        }
    })
}

fn diagnostic_json(diagnostic: &diagnostic::Diagnostic) -> serde_json::Value {
    serde_json::json!({
        "code": diagnostic.code,
        "message": diagnostic.message,
        "origin": diagnostic.origin,
        "span": {
            "start": diagnostic.span.start,
            "end": diagnostic.span.end,
        },
    })
}

fn decode_source_words(words: &[i32]) -> Result<Vec<u16>, String> {
    words
        .iter()
        .map(|word| u16::try_from(*word).map_err(|_| format!("invalid source UTF-16 unit {word}")))
        .collect()
}

fn decode_utf16_words(words: &[i32], label: &str) -> Result<String, String> {
    let units = words
        .iter()
        .map(|word| u16::try_from(*word).map_err(|_| format!("invalid {label} UTF-16 unit {word}")))
        .collect::<Result<Vec<_>, _>>()?;
    String::from_utf16(&units).map_err(|error| format!("{label} is not valid UTF-16: {error}"))
}

fn write_result(result: Vec<u8>) -> u32 {
    let mut bytes = LOWER_RESULT
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .expect("lower result mutex was poisoned");
    *bytes = result;
    bytes.len() as u32
}
