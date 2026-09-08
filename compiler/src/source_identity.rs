//! Lexical addresses for development links. Source offsets remain diagnostics,
//! while named declarations and fields keep their address across body edits.

use std::collections::HashMap;

use crate::ast::{
    Declaration, DeclarationId, Expression, ExpressionId, Module, Pattern, ShapeMember,
};

pub(crate) fn expression_addresses(module: &Module) -> HashMap<ExpressionId, String> {
    let mut addresses = Addresses {
        module,
        paths: HashMap::new(),
    };
    addresses.block(&module.declarations, module.result, &[]);
    addresses.paths
}

pub(crate) fn expression_subtree(module: &Module, root: ExpressionId) -> Vec<ExpressionId> {
    let mut addresses = Addresses {
        module,
        paths: HashMap::new(),
    };
    addresses.expression(root, &[]);
    addresses.paths.into_keys().collect()
}

struct Addresses<'a> {
    module: &'a Module,
    paths: HashMap<ExpressionId, String>,
}

impl Addresses<'_> {
    fn block(&mut self, declarations: &[DeclarationId], result: ExpressionId, path: &[String]) {
        let mut occurrences = HashMap::<String, usize>::new();
        for id in declarations {
            let declaration = &self.module.arena.declarations[id.0 as usize];
            let (label, value) = match declaration {
                Declaration::Signature { name, value, .. } => (format!("signature:{name}"), *value),
                Declaration::Shadow { name, value, .. } => (format!("shadow:{name}"), *value),
                Declaration::Open { value, .. } => ("open".to_owned(), *value),
                Declaration::Binding { pattern, value, .. } => {
                    let label = match &self.module.arena.patterns[pattern.0 as usize] {
                        Pattern::Name { name, .. } => format!("binding:{name}"),
                        _ => "destructure".to_owned(),
                    };
                    (label, *value)
                }
            };
            let occurrence = occurrences.entry(label.clone()).or_default();
            let mut child = path.to_vec();
            child.extend([label, occurrence.to_string()]);
            *occurrence += 1;
            if let Declaration::Binding { tags, .. } = declaration {
                for (index, tag) in tags.iter().enumerate() {
                    self.child(tag.descriptor, &child, format!("tag:{index}"));
                }
            }
            self.expression(value, &child);
        }
        self.child(result, path, "result");
    }

    fn child(&mut self, id: ExpressionId, path: &[String], label: impl Into<String>) {
        let mut child = path.to_vec();
        child.push(label.into());
        self.expression(id, &child);
    }

    fn expression(&mut self, id: ExpressionId, path: &[String]) {
        // The lowered AST may share expressions. The first lexical occurrence
        // is deterministic and also prevents revisiting a shared subtree.
        if self.paths.contains_key(&id) {
            return;
        }
        self.paths.insert(
            id,
            serde_json::to_string(path).expect("lexical address serialization"),
        );
        match &self.module.arena.expressions[id.0 as usize] {
            Expression::Apply {
                function, argument, ..
            } => {
                self.child(*function, path, "function");
                self.child(*argument, path, "argument");
            }
            Expression::Lambda { body, .. } => self.child(*body, path, "body"),
            Expression::Rec { lambda, .. } => self.child(*lambda, path, "rec"),
            Expression::Field { target, .. } => self.child(*target, path, "target"),
            Expression::Tuple { elements, .. } => {
                for (index, element) in elements.iter().enumerate() {
                    self.child(*element, path, index.to_string());
                }
            }
            Expression::Array { elements, .. } => {
                for (index, element) in elements.iter().enumerate() {
                    self.child(element.value, path, index.to_string());
                }
            }
            Expression::Shape { members, .. } => {
                let mut occurrences = HashMap::<String, usize>::new();
                for member in members {
                    let (label, value) = match member {
                        ShapeMember::Field { name, value } => (format!("field:{name}"), *value),
                        ShapeMember::Computed { value, .. } => ("computed".to_owned(), *value),
                        ShapeMember::Spread { value } => ("spread".to_owned(), *value),
                    };
                    let occurrence = occurrences.entry(label.clone()).or_default();
                    let mut child = path.to_vec();
                    child.extend([label, occurrence.to_string()]);
                    *occurrence += 1;
                    if let ShapeMember::Computed { name, .. } = member {
                        self.child(*name, &child, "name");
                    }
                    self.child(value, &child, "value");
                }
            }
            Expression::If {
                branches, fallback, ..
            } => {
                for (index, branch) in branches.iter().enumerate() {
                    self.child(branch.condition, path, format!("condition:{index}"));
                    self.child(branch.consequence, path, format!("consequence:{index}"));
                }
                if let Some(fallback) = fallback {
                    self.child(*fallback, path, "fallback");
                }
            }
            Expression::Case { target, arms, .. } => {
                self.child(*target, path, "target");
                for (index, arm) in arms.iter().enumerate() {
                    self.child(arm.body, path, format!("arm:{index}"));
                }
            }
            Expression::Block {
                declarations,
                result,
                ..
            } => self.block(declarations, *result, path),
            Expression::Var { .. }
            | Expression::Int { .. }
            | Expression::Float { .. }
            | Expression::Text { .. }
            | Expression::Unit { .. }
            | Expression::Intrinsic { .. }
            | Expression::Tag { .. } => {}
        }
    }
}
