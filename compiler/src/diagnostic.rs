use crate::ast::Span;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Diagnostic {
    pub code: &'static str,
    pub message: String,
    pub span: Span,
    pub origin: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FailureClass {
    Source,
    Limit,
    TargetRefusal,
    Invariant,
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

    pub fn failure_class(&self) -> FailureClass {
        match self.code {
            "BLOT_EVALUATION_LIMIT" => FailureClass::Limit,
            "BLOT_TARGET_REFUSAL" | "BLOT_UNSUPPORTED_LOWERING" | "BLOT_DEFERRED_AT_RUNTIME" => {
                FailureClass::TargetRefusal
            }
            "BLOT_BACKEND_ERROR" | "BLOT_RUST_INVARIANT" => FailureClass::Invariant,
            _ => FailureClass::Source,
        }
    }

    pub fn failure_json(self, phase: &str) -> serde_json::Value {
        match self.failure_class() {
            FailureClass::Source => serde_json::json!({
                "ok": false,
                "diagnostic": {
                    "code": self.code,
                    "message": self.message,
                    "origin": self.origin,
                    "span": {
                        "start": self.span.start,
                        "end": self.span.end,
                    },
                },
            }),
            FailureClass::Limit => serde_json::json!({
                "ok": false,
                "limitDiagnostic": {
                    "code": self.code,
                    "message": self.message,
                },
            }),
            FailureClass::TargetRefusal => serde_json::json!({
                "ok": false,
                "targetRefusal": {
                    "code": self.code,
                    "message": self.message,
                },
            }),
            FailureClass::Invariant => serde_json::json!({
                "ok": false,
                "invariantFailure": {
                    "code": "BLOT_COMPILER_INVARIANT",
                    "phase": phase,
                    "message": self.message,
                },
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiler_failures_use_distinct_transport_payloads() {
        let span = Span { start: 3, end: 8 };
        let cases = [
            ("BLOT_TYPE_ERROR", "diagnostic"),
            ("BLOT_EVALUATION_LIMIT", "limitDiagnostic"),
            ("BLOT_UNSUPPORTED_LOWERING", "targetRefusal"),
            ("BLOT_RUST_INVARIANT", "invariantFailure"),
        ];
        for (code, payload) in cases {
            let failure = Diagnostic::new(code, "failure", span).failure_json("checking");
            assert_eq!(failure["ok"], false);
            assert!(failure.get(payload).is_some(), "{code} must use {payload}");
            assert_eq!(
                failure.as_object().expect("failure object").len(),
                2,
                "{code} must not also appear as another failure class"
            );
        }
    }
}
