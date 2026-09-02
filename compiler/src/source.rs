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
