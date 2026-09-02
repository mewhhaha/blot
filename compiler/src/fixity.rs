use std::collections::{HashMap, HashSet};

use crate::ast::{
    AstArena, Declaration, DeclarationKind, Expression, ExpressionId, FIXITY_INTERMEDIATE_PREFIX,
    Pattern, Qualifier, ResultEffects, Span,
};

const MAX_DIRECT_OPERATOR_CHAIN: usize = 64;

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum Associativity {
    Left,
    Right,
    None,
    Prefix,
}

#[derive(Clone, Copy)]
enum GeneratedAssociativity {
    Left,
    Right,
    None,
    Prefix,
}

struct GeneratedFixity {
    operator: &'static str,
    associativity: GeneratedAssociativity,
    precedence: u32,
    target: &'static str,
}

include!("fixities_generated.rs");

#[derive(Clone)]
pub(crate) struct Fixity {
    pub(crate) operator: String,
    pub(crate) associativity: Associativity,
    pub(crate) precedence: u32,
    pub(crate) target: Vec<String>,
    pub(crate) span: Span,
}

pub struct FixityTable {
    infix: HashMap<String, Fixity>,
    prefix: HashMap<String, Fixity>,
}

pub struct ChainStep {
    pub operator: String,
    pub right: ExpressionId,
    pub span: Span,
}

impl FixityTable {
    pub fn new(declared: &[Fixity]) -> Result<Self, String> {
        let mut declared_keys = HashSet::new();
        for fixity in declared {
            let form = if fixity.associativity == Associativity::Prefix {
                "prefix"
            } else {
                "infix"
            };
            if !declared_keys.insert((form, fixity.operator.as_str())) {
                return Err(format!(
                    "BLOT_DUPLICATE_FIXITY: the {form} operator `{}` is declared more than once at {}..{}",
                    fixity.operator, fixity.span.start, fixity.span.end
                ));
            }
        }

        let mut infix = HashMap::new();
        let mut prefix = HashMap::new();
        for fixity in standard_source_fixities()
            .into_iter()
            .chain(declared.iter().cloned())
        {
            if fixity.associativity == Associativity::Prefix {
                prefix.insert(fixity.operator.clone(), fixity);
            } else {
                infix.insert(fixity.operator.clone(), fixity);
            }
        }
        Ok(Self { infix, prefix })
    }

    pub fn prefix(&self, operator: &str) -> Option<&Fixity> {
        self.prefix.get(operator)
    }

    pub fn fold_chain(
        &self,
        first: ExpressionId,
        steps: &[ChainStep],
        arena: &mut AstArena,
    ) -> Result<ExpressionId, String> {
        if steps.len() >= MAX_DIRECT_OPERATOR_CHAIN {
            let mut precedence = None;
            let mut flat_left_chain = true;
            for step in steps {
                let fixity = self.infix(step)?;
                if fixity.associativity != Associativity::Left {
                    flat_left_chain = false;
                }
                if let Some(precedence) = precedence {
                    if fixity.precedence != precedence {
                        flat_left_chain = false;
                    }
                } else {
                    precedence = Some(fixity.precedence);
                }
            }
            if flat_left_chain {
                let mut declarations = Vec::with_capacity(steps.len());
                let mut result = first;
                for (index, step) in steps.iter().enumerate() {
                    let fixity = self.infix(step)?;
                    let span = Span {
                        start: arena.expression_span(result).start,
                        end: arena.expression_span(step.right).end,
                    };
                    let callee = target_expression(fixity, step.span, arena)?;
                    let applied_left = arena.expression(Expression::Apply {
                        function: callee,
                        argument: result,
                        span,
                    });
                    let value = arena.expression(Expression::Apply {
                        function: applied_left,
                        argument: step.right,
                        span,
                    });
                    let name = format!(
                        "{FIXITY_INTERMEDIATE_PREFIX}{}${}${index}",
                        span.start, span.end
                    );
                    let pattern = arena.pattern(Pattern::Name {
                        name: name.clone(),
                        qualifier: Qualifier::None,
                        span,
                    });
                    declarations.push(arena.declaration(Declaration::Binding {
                        kind: DeclarationKind::Let,
                        tags: Vec::new(),
                        pattern,
                        value,
                        span,
                    }));
                    result = arena.expression(Expression::Var { name, span });
                }
                let span = Span {
                    start: arena.expression_span(first).start,
                    end: arena.expression_span(result).end,
                };
                return Ok(arena.expression(Expression::Block {
                    declarations,
                    result,
                    result_effects: ResultEffects::Ambient,
                    span,
                }));
            }
        }
        let mut position = 0;
        let folded = self.climb(first, steps, &mut position, 0, arena)?;
        if position != steps.len() {
            return Err("BLOT_UNRESOLVED_CHAIN: operator chain was not fully resolved".to_owned());
        }
        Ok(folded)
    }

    fn climb(
        &self,
        left: ExpressionId,
        steps: &[ChainStep],
        position: &mut usize,
        minimum: u32,
        arena: &mut AstArena,
    ) -> Result<ExpressionId, String> {
        let mut result = left;
        while *position < steps.len() {
            let step = &steps[*position];
            let fixity = self.infix(step)?;
            if fixity.precedence < minimum {
                break;
            }
            *position += 1;

            let mut right = step.right;
            while *position < steps.len() {
                let next = self.infix(&steps[*position])?;
                let binds_tighter = next.precedence > fixity.precedence
                    || (next.precedence == fixity.precedence
                        && next.associativity == Associativity::Right);
                if !binds_tighter {
                    break;
                }
                right = self.climb(right, steps, position, next.precedence, arena)?;
            }

            if fixity.associativity == Associativity::None && *position < steps.len() {
                let next = self.infix(&steps[*position])?;
                if next.precedence == fixity.precedence {
                    return Err(format!(
                        "BLOT_NON_ASSOCIATIVE_CHAIN: `{}` cannot be chained with `{}` at the same precedence",
                        step.operator, steps[*position].operator
                    ));
                }
            }

            let span = Span {
                start: arena.expression_span(result).start,
                end: arena.expression_span(right).end,
            };
            let callee = target_expression(fixity, step.span, arena)?;
            let applied_left = arena.expression(Expression::Apply {
                function: callee,
                argument: result,
                span,
            });
            result = arena.expression(Expression::Apply {
                function: applied_left,
                argument: right,
                span,
            });
        }
        Ok(result)
    }

    fn infix(&self, step: &ChainStep) -> Result<&Fixity, String> {
        self.infix.get(&step.operator).ok_or_else(|| {
            format!(
                "BLOT_UNKNOWN_OPERATOR: no fixity is declared for `{}`",
                step.operator
            )
        })
    }
}

pub fn target_expression(
    fixity: &Fixity,
    span: Span,
    arena: &mut AstArena,
) -> Result<ExpressionId, String> {
    let Some(root) = fixity.target.first() else {
        return Err(format!("fixity `{}` has an empty target", fixity.operator));
    };
    let mut result = if root.starts_with('@') {
        arena.expression(Expression::Intrinsic {
            name: root.clone(),
            span,
        })
    } else {
        arena.expression(Expression::Var {
            name: root.clone(),
            span,
        })
    };
    for name in fixity.target.iter().skip(1) {
        result = arena.expression(Expression::Field {
            target: result,
            name: name.clone(),
            span,
        });
    }
    Ok(result)
}

fn standard_source_fixities() -> Vec<Fixity> {
    GENERATED_FIXITIES
        .iter()
        .map(|generated| Fixity {
            operator: generated.operator.to_owned(),
            associativity: match generated.associativity {
                GeneratedAssociativity::Left => Associativity::Left,
                GeneratedAssociativity::Right => Associativity::Right,
                GeneratedAssociativity::None => Associativity::None,
                GeneratedAssociativity::Prefix => Associativity::Prefix,
            },
            precedence: generated.precedence,
            target: if generated.target.starts_with('@') {
                vec![generated.target.to_owned()]
            } else {
                generated.target.split('.').map(str::to_owned).collect()
            },
            span: Span { start: 0, end: 0 },
        })
        .collect()
}
