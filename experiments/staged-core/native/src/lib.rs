//! Separate research crate. Production Cargo configuration and exports are untouched.
//!
//! Import the exact existing Baba frontend implementation rather than copying or
//! reimplementing it. These shared modules expose additional internal APIs used
//! only by production; the dead-code allowance is restricted to those imports.
//! The experimental semantic core below has no lint exemptions.
#[allow(dead_code)]
#[path = "../../../../compiler/src/artifact_limits.rs"]
mod artifact_limits;
#[allow(dead_code)]
#[path = "../../../../compiler/src/ast.rs"]
mod ast;
#[allow(dead_code)]
#[path = "../../../../compiler/src/cst.rs"]
mod cst;
#[allow(dead_code)]
#[path = "../../../../compiler/src/diagnostic.rs"]
mod diagnostic;
#[allow(dead_code)]
#[path = "../../../../compiler/src/fixity.rs"]
mod fixity;
#[allow(dead_code)]
#[path = "../../../../compiler/src/frontend.rs"]
mod frontend;
#[allow(dead_code)]
#[path = "../../../../compiler/src/integer.rs"]
mod integer;
#[allow(dead_code)]
#[path = "../../../../compiler/src/layout.rs"]
mod layout;
#[allow(dead_code)]
#[path = "../../../../compiler/src/lower.rs"]
mod lower;
#[allow(dead_code)]
#[path = "../../../../compiler/src/rebinding.rs"]
mod rebinding;
#[allow(dead_code)]
#[path = "../../../../compiler/src/source.rs"]
mod source;

#[path = "../../../../compiler/src/staged/mod.rs"]
pub mod staged;
