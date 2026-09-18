use std::rc::Rc;

use crate::ast::Module;
use crate::cst::{CompactCst, RULE_NAMES};
use crate::diagnostic::Diagnostic;
use crate::frontend::{FrontendState, ingest_incremental};

pub(crate) struct LoweredSource {
    pub(crate) module: Rc<Module>,
    pub(crate) frontend: FrontendState,
}

#[derive(Debug)]
pub(crate) enum SourceError {
    Diagnostics(Vec<Diagnostic>),
    Lowering(String),
}

pub(crate) fn lower_incremental(
    source: &[u16],
    previous: Option<&FrontendState>,
    previous_module: Option<&Rc<Module>>,
) -> Result<LoweredSource, SourceError> {
    let layout = crate::layout::elaborate(source).map_err(SourceError::Diagnostics)?;
    let (program, frontend) = ingest_incremental(&layout.source, previous)
        .map_err(|diagnostics| SourceError::Diagnostics(layout.map_diagnostics(diagnostics)))?;
    if frontend.semantic_input_unchanged()
        && let Some(module) = previous_module
    {
        return Ok(LoweredSource {
            module: module.clone(),
            frontend,
        });
    }
    let cst = CompactCst::new_mapped(
        &layout.source,
        &program.tokens,
        &program.nodes,
        &program.edges,
        RULE_NAMES,
        &layout.original_offsets,
    )
    .map_err(SourceError::Lowering)?;
    let mut diagnostics = crate::rebinding::diagnostics(&cst).map_err(SourceError::Lowering)?;
    diagnostics
        .extend(crate::lower::reachability_diagnostics(&cst).map_err(SourceError::Lowering)?);
    if !diagnostics.is_empty() {
        return Err(SourceError::Diagnostics(diagnostics));
    }
    let module = Rc::new(crate::lower::lower_module(&cst).map_err(SourceError::Lowering)?);
    Ok(LoweredSource { module, frontend })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relocated_grammar_relowers_fresh_asts_for_payload_width_names_trivia_and_layout() {
        let programs = [
            "const value = 111\nreturn value\n",
            "const f = fn value => (value, 111)\nreturn f\n",
            "const f = fn (value, other) => { .left = value; .right = 111; }\nreturn f\n",
            "const f = fn value => do:\n  let other = 111\n  return (value, other)\nreturn f\n",
            "const f = fn value => case value of\n  #Some other => (other, 111)\n  #None => (0, 111)\nreturn f\n",
            "const value = [111, 222]\nreturn value\n",
        ];
        let mut comparisons = 0;
        for original in programs {
            let old = lower_incremental(&original.encode_utf16().collect::<Vec<_>>(), None, None)
                .unwrap_or_else(|e| panic!("{original}: {e:?}"));
            for replacement in ["1", "99999999", "-777", "(111)"] {
                for prefix in ["", "// 😀 heading\n", "\n\n"] {
                    let changed = format!(
                        "{prefix}{}",
                        original
                            .replace("111", replacement)
                            .replace("value", "renamed_value")
                    );
                    let units = changed.encode_utf16().collect::<Vec<_>>();
                    let incremental =
                        lower_incremental(&units, Some(&old.frontend), Some(&old.module)).unwrap();
                    let fresh = lower_incremental(&units, None, None).unwrap();
                    assert_eq!(incremental.module, fresh.module, "{changed}");
                    assert!(!Rc::ptr_eq(&incremental.module, &old.module));
                    comparisons += 1;
                }
            }
        }
        assert_eq!(comparisons, 72);
    }

    #[test]
    fn relocated_syntax_cannot_reuse_a_stale_binding_or_diagnostic_span() {
        let original = "const value = 1\nreturn value\n"
            .encode_utf16()
            .collect::<Vec<_>>();
        let old = lower_incremental(&original, None, None).unwrap();
        // The token sequence is unchanged but the use no longer binds to its
        // declaration. This must publish the new AST, not old checked evidence.
        let changed = "// shifted 😀\nconst longer = 123456\nreturn value\n"
            .encode_utf16()
            .collect::<Vec<_>>();
        let incremental =
            lower_incremental(&changed, Some(&old.frontend), Some(&old.module)).unwrap();
        let fresh = lower_incremental(&changed, None, None).unwrap();
        assert!(!incremental.frontend.semantic_input_unchanged());
        assert_eq!(incremental.module, fresh.module);
        let invalid = "// shifted 😀\nconst longer = 123456\nreturn (value]\n"
            .encode_utf16()
            .collect::<Vec<_>>();
        let a = lower_incremental(
            &invalid,
            Some(&incremental.frontend),
            Some(&incremental.module),
        );
        let b = lower_incremental(&invalid, None, None);
        let (Err(SourceError::Diagnostics(a)), Err(SourceError::Diagnostics(b))) = (a, b) else {
            panic!("both must reject invalid syntax");
        };
        assert_eq!(
            serde_json::to_value(a).unwrap(),
            serde_json::to_value(b).unwrap()
        );
    }
}
