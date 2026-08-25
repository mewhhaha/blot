use std::collections::BTreeMap;

use crate::eval::IncludedFile;
use crate::session::{AddSourceError, CompilerSession};

pub const FRAME_MAGIC: u32 = u32::from_le_bytes(*b"BLT3");
pub const FRAME_SCHEMA: u32 = 3;

const PAYLOAD_NONE: u32 = 0;
const PAYLOAD_SOURCE: u32 = 1;
const PAYLOAD_AST: u32 = 2;
const PAYLOAD_REMOVE: u32 = 3;
const MAX_RECORDS: usize = 1_000_000;

struct DeltaRecord {
    module_id: u32,
    payload: DeltaPayload,
    configuration: Option<DeltaConfiguration>,
}

enum DeltaPayload {
    None,
    Source(Vec<u8>),
    Ast(Vec<u8>),
    Remove,
}

struct DeltaConfiguration {
    imports: Vec<(String, u32)>,
    includes: Vec<(String, u32, Vec<u8>)>,
}

struct ResolvedDeltaRecord {
    module_id: u32,
    path: String,
    payload: DeltaPayload,
    configuration: Option<ResolvedConfiguration>,
}

struct ResolvedConfiguration {
    imports: BTreeMap<String, String>,
    includes: BTreeMap<String, IncludedFile>,
}

pub fn encode_response(result: Result<Vec<u8>, String>) -> Vec<u8> {
    let mut encoder = Encoder::default();
    encoder.u32(FRAME_MAGIC);
    encoder.u32(FRAME_SCHEMA);
    match result {
        Ok(payload) => {
            encoder.u32(1);
            encoder.bytes(&payload);
        }
        Err(message) => {
            encoder.u32(0);
            encoder.bytes(message.as_bytes());
        }
    }
    encoder.finish()
}

pub fn register_paths(session: &mut CompilerSession, frame: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = Decoder::frame(frame)?;
    let count = decoder.count("registered path")?;
    let mut paths = Vec::with_capacity(count);
    for _ in 0..count {
        paths.push(decoder.string("registered path")?);
    }
    decoder.finish()?;
    let ids = session.register_paths(paths)?;
    let mut encoder = Encoder::default();
    encoder.u32(ids.len() as u32);
    for id in ids {
        encoder.u32(id);
    }
    Ok(encoder.finish())
}

pub fn apply_delta(session: &mut CompilerSession, frame: &[u8]) -> Result<Vec<u8>, String> {
    let records = decode_delta(frame)?;
    let records = resolve_delta(session, records)?;
    let mut encoder = Encoder::default();
    encoder.u32(records.len() as u32);
    for record in records {
        let module_id = record.module_id;
        let result = apply_record(session, record);
        let bytes = serde_json::to_vec(&result)
            .map_err(|error| format!("compiler ABI delta result encoding failed: {error}"))?;
        encoder.u32(module_id);
        encoder.bytes(&bytes);
    }
    Ok(encoder.finish())
}

pub fn check_module(session: &CompilerSession, module_id: u32) -> Result<Vec<u8>, String> {
    let path = session.registered_path(module_id)?;
    let checked = session.check_module(path);
    let mut encoder = Encoder::default();
    if checked.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        let type_ = checked
            .get("type")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "successful compiler check omitted its type".to_owned())?;
        let effects = checked
            .get("effects")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "successful compiler check omitted its effects".to_owned())?;
        encoder.u32(1);
        encoder.string(type_);
        encoder.string(effects);
    } else {
        encoder.u32(0);
        encoder.bytes(
            &serde_json::to_vec(&checked)
                .map_err(|error| format!("compiler check failure encoding failed: {error}"))?,
        );
    }
    Ok(encoder.finish())
}

pub fn analyze_module(
    session: &CompilerSession,
    module_id: u32,
    _requested_fact_mask: u32,
) -> Result<Vec<u8>, String> {
    let path = session.registered_path(module_id)?;
    serde_json::to_vec(&session.analyze_module(path))
        .map_err(|error| format!("compiler analysis encoding failed: {error}"))
}

fn decode_delta(frame: &[u8]) -> Result<Vec<DeltaRecord>, String> {
    let mut decoder = Decoder::frame(frame)?;
    let count = decoder.count("delta record")?;
    let mut records = Vec::with_capacity(count);
    for _ in 0..count {
        let module_id = decoder.u32("delta module ID")?;
        let payload_tag = decoder.u32("delta payload tag")?;
        let payload_bytes = decoder.bytes("delta payload")?.to_vec();
        let payload = match payload_tag {
            PAYLOAD_NONE => {
                if !payload_bytes.is_empty() {
                    return Err("empty compiler ABI payload tag carried bytes".to_owned());
                }
                DeltaPayload::None
            }
            PAYLOAD_SOURCE => DeltaPayload::Source(payload_bytes),
            PAYLOAD_AST => DeltaPayload::Ast(payload_bytes),
            PAYLOAD_REMOVE => {
                if !payload_bytes.is_empty() {
                    return Err("remove compiler ABI payload carried bytes".to_owned());
                }
                DeltaPayload::Remove
            }
            unknown => return Err(format!("unknown compiler ABI payload tag {unknown}")),
        };
        let has_configuration = decoder.u32("configuration flag")?;
        let configuration = match has_configuration {
            0 => None,
            1 => {
                let import_count = decoder.count("import edge")?;
                let mut imports = Vec::with_capacity(import_count);
                for _ in 0..import_count {
                    imports.push((
                        decoder.string("import specifier")?,
                        decoder.u32("import target module ID")?,
                    ));
                }
                let include_count = decoder.count("include edge")?;
                let mut includes = Vec::with_capacity(include_count);
                for _ in 0..include_count {
                    includes.push((
                        decoder.string("include specifier")?,
                        decoder.u32("include path module ID")?,
                        decoder.bytes("include text")?.to_vec(),
                    ));
                }
                Some(DeltaConfiguration { imports, includes })
            }
            unknown => return Err(format!("invalid compiler ABI configuration flag {unknown}")),
        };
        if matches!(payload, DeltaPayload::Remove) && configuration.is_some() {
            return Err("removed compiler ABI module cannot also be configured".to_owned());
        }
        records.push(DeltaRecord {
            module_id,
            payload,
            configuration,
        });
    }
    decoder.finish()?;
    Ok(records)
}

fn resolve_delta(
    session: &CompilerSession,
    records: Vec<DeltaRecord>,
) -> Result<Vec<ResolvedDeltaRecord>, String> {
    records
        .into_iter()
        .map(|record| {
            let path = session.registered_path(record.module_id)?.to_owned();
            let configuration = record
                .configuration
                .map(|configuration| {
                    let imports = configuration
                        .imports
                        .into_iter()
                        .map(|(specifier, target)| {
                            Ok((specifier, session.registered_path(target)?.to_owned()))
                        })
                        .collect::<Result<BTreeMap<_, _>, String>>()?;
                    let includes = configuration
                        .includes
                        .into_iter()
                        .map(|(specifier, path_id, text)| {
                            let path = session.registered_path(path_id)?.to_owned();
                            let text = String::from_utf8(text)
                                .map_err(|error| format!("include text is not UTF-8: {error}"))?;
                            Ok((specifier, IncludedFile { path, text }))
                        })
                        .collect::<Result<BTreeMap<_, _>, String>>()?;
                    Ok::<ResolvedConfiguration, String>(ResolvedConfiguration { imports, includes })
                })
                .transpose()?;
            Ok(ResolvedDeltaRecord {
                module_id: record.module_id,
                path,
                payload: record.payload,
                configuration,
            })
        })
        .collect()
}

fn apply_record(session: &mut CompilerSession, record: ResolvedDeltaRecord) -> serde_json::Value {
    let mut result = match record.payload {
        DeltaPayload::None => serde_json::json!({ "ok": true }),
        DeltaPayload::Source(bytes) => match String::from_utf8(bytes) {
            Ok(source) => {
                match session.add_source(record.path.clone(), source.encode_utf16().collect()) {
                    Ok(module) => serde_json::json!({ "ok": true, "module": module }),
                    Err(AddSourceError::Diagnostics(diagnostics)) => {
                        serde_json::json!({ "ok": false, "diagnostics": diagnostics })
                    }
                    Err(AddSourceError::Lowering(message)) => {
                        serde_json::json!({ "ok": false, "message": message })
                    }
                }
            }
            Err(error) => serde_json::json!({
                "ok": false,
                "message": format!("module source is not UTF-8: {error}"),
            }),
        },
        DeltaPayload::Ast(bytes) => match String::from_utf8(bytes) {
            Ok(encoded) => match serde_json::from_str(&encoded) {
                Ok(module) => match session.add_module(record.path.clone(), module) {
                    Ok(module) => serde_json::json!({ "ok": true, "module": module }),
                    Err(message) => serde_json::json!({ "ok": false, "message": message }),
                },
                Err(error) => serde_json::json!({
                    "ok": false,
                    "message": format!("portable AST is not valid JSON: {error}"),
                }),
            },
            Err(error) => serde_json::json!({
                "ok": false,
                "message": format!("portable AST is not UTF-8: {error}"),
            }),
        },
        DeltaPayload::Remove => {
            serde_json::json!({ "ok": true, "removed": session.remove_module(&record.path) })
        }
    };
    if result.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
        && let Some(configuration) = record.configuration
        && let Err(message) =
            session.configure_module(&record.path, configuration.imports, configuration.includes)
    {
        result = serde_json::json!({ "ok": false, "message": message });
    }
    result
}

#[derive(Default)]
struct Encoder {
    bytes: Vec<u8>,
}

impl Encoder {
    fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn bytes(&mut self, value: &[u8]) {
        self.u32(value.len() as u32);
        self.bytes.extend_from_slice(value);
    }

    fn string(&mut self, value: &str) {
        self.bytes(value.as_bytes());
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

struct Decoder<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Decoder<'a> {
    fn frame(bytes: &'a [u8]) -> Result<Self, String> {
        let mut decoder = Self { bytes, offset: 0 };
        let magic = decoder.u32("frame magic")?;
        if magic != FRAME_MAGIC {
            return Err(format!("unknown compiler ABI frame magic {magic:#010x}"));
        }
        let schema = decoder.u32("frame schema")?;
        if schema != FRAME_SCHEMA {
            return Err(format!(
                "compiler ABI frame schema is {schema}, expected {FRAME_SCHEMA}"
            ));
        }
        Ok(decoder)
    }

    fn u32(&mut self, label: &str) -> Result<u32, String> {
        let end = self
            .offset
            .checked_add(4)
            .ok_or_else(|| format!("compiler ABI {label} offset overflow"))?;
        let bytes = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| format!("compiler ABI frame omitted {label}"))?;
        self.offset = end;
        Ok(u32::from_le_bytes(
            bytes.try_into().expect("four-byte slice has u32 width"),
        ))
    }

    fn count(&mut self, label: &str) -> Result<usize, String> {
        let count = self.u32(&format!("{label} count"))? as usize;
        if count > MAX_RECORDS {
            return Err(format!(
                "compiler ABI {label} count {count} exceeds the limit"
            ));
        }
        Ok(count)
    }

    fn bytes(&mut self, label: &str) -> Result<&'a [u8], String> {
        let length = self.u32(&format!("{label} byte length"))? as usize;
        let end = self
            .offset
            .checked_add(length)
            .ok_or_else(|| format!("compiler ABI {label} offset overflow"))?;
        let bytes = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| format!("compiler ABI frame truncated {label}"))?;
        self.offset = end;
        Ok(bytes)
    }

    fn string(&mut self, label: &str) -> Result<String, String> {
        String::from_utf8(self.bytes(label)?.to_vec())
            .map_err(|error| format!("compiler ABI {label} is not UTF-8: {error}"))
    }

    fn finish(self) -> Result<(), String> {
        if self.offset != self.bytes.len() {
            return Err(format!(
                "compiler ABI frame has {} trailing bytes",
                self.bytes.len() - self.offset
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_truncated_and_trailing_registration_frames() {
        let mut session = CompilerSession::default();
        assert!(register_paths(&mut session, b"BLT3").is_err());

        let mut frame = Encoder::default();
        frame.u32(FRAME_MAGIC);
        frame.u32(FRAME_SCHEMA);
        frame.u32(0);
        frame.u32(99);
        assert!(register_paths(&mut session, &frame.finish()).is_err());
    }

    #[test]
    fn registration_is_stable_and_utf8() {
        let mut session = CompilerSession::default();
        let mut frame = Encoder::default();
        frame.u32(FRAME_MAGIC);
        frame.u32(FRAME_SCHEMA);
        frame.u32(2);
        frame.string("/tmp/α.blot");
        frame.string("/tmp/β.blot");
        let first = register_paths(&mut session, &frame.finish()).expect("paths should register");

        let mut frame = Encoder::default();
        frame.u32(FRAME_MAGIC);
        frame.u32(FRAME_SCHEMA);
        frame.u32(1);
        frame.string("/tmp/α.blot");
        let second = register_paths(&mut session, &frame.finish()).expect("path should reuse");

        assert_eq!(u32::from_le_bytes(first[4..8].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(second[4..8].try_into().unwrap()), 1);
    }

    #[test]
    fn malformed_delta_does_not_mutate_the_session() {
        let mut session = CompilerSession::default();
        session
            .register_paths(vec!["/tmp/module.blot".to_owned()])
            .unwrap();
        let mut frame = Encoder::default();
        frame.u32(FRAME_MAGIC);
        frame.u32(FRAME_SCHEMA);
        frame.u32(1);
        frame.u32(1);
        frame.u32(PAYLOAD_SOURCE);
        frame.bytes(b"return 1");
        frame.u32(2);
        assert!(apply_delta(&mut session, &frame.finish()).is_err());
        assert!(!session.remove_module("/tmp/module.blot"));
    }

    #[test]
    fn graph_deltas_reject_snapshot_bytes() {
        let mut session = CompilerSession::default();
        session
            .register_paths(vec!["/tmp/module.blot".to_owned()])
            .unwrap();
        let mut frame = Encoder::default();
        frame.u32(FRAME_MAGIC);
        frame.u32(FRAME_SCHEMA);
        frame.u32(1);
        frame.u32(1);
        frame.u32(PAYLOAD_REMOVE);
        frame.bytes(b"snapshot bytes");
        frame.u32(0);

        let error = apply_delta(&mut session, &frame.finish())
            .expect_err("graph deltas must not accept trusted snapshot bytes");

        assert!(error.contains("remove compiler ABI payload carried bytes"));
        assert!(!session.remove_module("/tmp/module.blot"));
    }
}
