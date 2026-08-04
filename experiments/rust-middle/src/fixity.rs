use std::collections::HashMap;

use crate::ast::{Associativity, AstArena, Expression, ExpressionId, Fixity, Span};

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
    pub fn new(declared: &[Fixity]) -> Self {
        let mut infix = HashMap::new();
        let mut prefix = HashMap::new();
        for fixity in defaults().into_iter().chain(declared.iter().cloned()) {
            if fixity.associativity == Associativity::Prefix {
                prefix.insert(fixity.operator.clone(), fixity);
            } else {
                infix.insert(fixity.operator.clone(), fixity);
            }
        }
        Self { infix, prefix }
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

fn defaults() -> Vec<Fixity> {
    [
        ("$", Associativity::Right, 10, "Fn.apply"),
        ("|>", Associativity::Left, 20, "Fn.pipe"),
        ("~", Associativity::Left, 21, "@type.performs"),
        ("||", Associativity::Right, 22, "Logic.or"),
        ("&&", Associativity::Right, 24, "Logic.and"),
        ("->", Associativity::Right, 25, "@type.arrow"),
        ("==", Associativity::None, 30, "Eq.eq"),
        ("/=", Associativity::None, 30, "Eq.ne"),
        ("<", Associativity::None, 30, "Ord.lt"),
        ("<=", Associativity::None, 30, "Ord.le"),
        (">", Associativity::None, 30, "Ord.gt"),
        (">=", Associativity::None, 30, "Ord.ge"),
        ("|", Associativity::Left, 40, "Set.union"),
        ("\\", Associativity::Left, 40, "Set.diff"),
        ("&", Associativity::Left, 45, "Set.intersect"),
        ("<+", Associativity::Left, 50, "attach"),
        ("<>", Associativity::Right, 55, "Semigroup.append"),
        ("+", Associativity::Left, 60, "Num.add"),
        ("-", Associativity::Left, 60, "Num.sub"),
        ("*", Associativity::Left, 70, "Num.mul"),
        ("/", Associativity::Left, 70, "Num.div"),
        ("%", Associativity::Left, 70, "Num.rem"),
        ("-", Associativity::Prefix, 90, "Num.negate"),
        ("!", Associativity::Prefix, 90, "@linear.own"),
        ("?", Associativity::Prefix, 90, "@linear.maybe"),
        ("&", Associativity::Prefix, 90, "@linear.borrow"),
    ]
    .into_iter()
    .map(|(operator, associativity, precedence, target)| Fixity {
        operator: operator.to_owned(),
        associativity,
        precedence,
        target: if target.starts_with('@') {
            vec![target.to_owned()]
        } else {
            target.split('.').map(str::to_owned).collect()
        },
        span: Span { start: 0, end: 0 },
    })
    .collect()
}
