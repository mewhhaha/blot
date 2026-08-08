use crate::ast::Module;
use crate::cst::{CompactCst, RULE_NAMES};
use crate::diagnostic::Diagnostic;
use crate::frontend::{FrontendState, ingest_incremental};

pub(crate) struct LoweredSource {
    pub(crate) module: Module,
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
) -> Result<LoweredSource, SourceError> {
    let layout = crate::layout::elaborate(source).map_err(SourceError::Diagnostics)?;
    let (program, frontend) = ingest_incremental(&layout.source, previous)
        .map_err(|diagnostics| SourceError::Diagnostics(layout.map_diagnostics(diagnostics)))?;
    let cst = CompactCst::new_mapped(
        &layout.source,
        &program.tokens,
        &program.nodes,
        &program.edges,
        RULE_NAMES,
        &layout.original_offsets,
    )
    .map_err(SourceError::Lowering)?;
    let rebinding = crate::rebinding::diagnostics(&cst).map_err(SourceError::Lowering)?;
    if !rebinding.is_empty() {
        return Err(SourceError::Diagnostics(rebinding));
    }
    let module = crate::lower::lower_module(&cst).map_err(SourceError::Lowering)?;
    Ok(LoweredSource { module, frontend })
}
