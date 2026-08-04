use crate::ast::Span;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Diagnostic {
    pub code: &'static str,
    pub message: String,
    pub span: Span,
    pub origin: Option<String>,
}

impl Diagnostic {
    pub fn new(code: &'static str, message: impl Into<String>, span: Span) -> Self {
        Self {
            code,
            message: message.into(),
            span,
            origin: None,
        }
    }

    pub fn at(mut self, path: &str) -> Self {
        if self.origin.is_none() {
            self.origin = Some(path.to_owned());
        }
        self
    }
}
