//! Conservative result intervals for the actual integer primitives.
//!
//! This transfer is independent of fixities and member names. It runs only
//! after the primitive's ordinary argument constraints have succeeded.

use super::*;
use num_traits::Signed;

pub(super) const ARITHMETIC: &[(&str, usize)] = &[
    ("@int.add", 2),
    ("@int.sub", 2),
    ("@int.mul", 2),
    ("@int.div", 2),
    ("@int.rem", 2),
    ("@int.neg", 1),
];

pub(super) fn primitive_result(checker: &Checker, name: &str, arguments: &[Type]) -> Option<Type> {
    let (_, arity) = ARITHMETIC
        .iter()
        .find(|(primitive, _)| *primitive == name)?;
    if arguments.len() != *arity {
        return None;
    }
    let mut inputs = Vec::new();
    for argument in arguments {
        // A primitive has already constrained this pending literal to Int. Read
        // its singleton without committing unrelated literals elsewhere.
        let literal = match argument {
            Type::Variable(id) => checker.numeric_literals.borrow().get(id).cloned(),
            _ => None,
        };
        if let Some(NumericLiteralFact {
            kind: NumericLiteralKind::Integer(value),
            ..
        }) = literal
        {
            inputs.push(IntegerInterval {
                low: Some(value.clone()),
                high: Some(value),
            });
            continue;
        }
        // Lower bounds of an open variable are only accumulated evidence;
        // recursive/loop uses may add more inhabitants later. A range proof
        // must use its upper bound, not freeze the current lower approximation.
        let settled = checker.settle(argument.clone(), !matches!(argument, Type::Variable(_)));
        let intervals = integer_intervals(&settled)?;
        if intervals.is_empty() {
            return None;
        }
        // A hull avoids a Cartesian explosion for unions. Losing a gap loses
        // precision, never inhabitants of a possible result.
        let low = intervals
            .iter()
            .map(|interval| interval.low.clone())
            .collect::<Option<Vec<_>>>()
            .and_then(|bounds| bounds.into_iter().min());
        let high = intervals
            .iter()
            .map(|interval| interval.high.clone())
            .collect::<Option<Vec<_>>>()
            .and_then(|bounds| bounds.into_iter().max());
        inputs.push(IntegerInterval { low, high });
    }
    let result = transfer(name, &inputs)?;
    Some(Type::Range {
        domain: Domain::Int,
        low: result.low.map(Scalar::Int),
        high: result.high.map(Scalar::Int),
    })
}

fn transfer(name: &str, inputs: &[IntegerInterval]) -> Option<IntegerInterval> {
    let left = inputs.first()?;
    let result = if name == "@int.neg" {
        IntegerInterval {
            low: left.high.as_ref().map(|value| -value),
            high: left.low.as_ref().map(|value| -value),
        }
    } else {
        let right = inputs.get(1)?;
        match name {
            "@int.add" => IntegerInterval {
                low: left
                    .low
                    .as_ref()
                    .zip(right.low.as_ref())
                    .map(|(a, b)| a + b),
                high: left
                    .high
                    .as_ref()
                    .zip(right.high.as_ref())
                    .map(|(a, b)| a + b),
            },
            "@int.sub" => IntegerInterval {
                low: left
                    .low
                    .as_ref()
                    .zip(right.high.as_ref())
                    .map(|(a, b)| a - b),
                high: left
                    .high
                    .as_ref()
                    .zip(right.low.as_ref())
                    .map(|(a, b)| a - b),
            },
            "@int.mul" | "@int.div" | "@int.rem" => {
                let (a, b) = (left.low.as_ref()?, left.high.as_ref()?);
                let (c, d) = (right.low.as_ref()?, right.high.as_ref()?);
                if name != "@int.mul" && c <= &BigInt::from(0) && d >= &BigInt::from(0) {
                    return None;
                }
                if name == "@int.rem" {
                    if a == b && c == d {
                        let value = a % c;
                        IntegerInterval {
                            low: Some(value.clone()),
                            high: Some(value),
                        }
                    } else {
                        let magnitude = c.abs().max(d.abs()) - 1;
                        let low = if a < &BigInt::from(0) {
                            a.clone().max(-&magnitude)
                        } else {
                            BigInt::from(0)
                        };
                        let high = if b > &BigInt::from(0) {
                            b.clone().min(magnitude)
                        } else {
                            BigInt::from(0)
                        };
                        IntegerInterval {
                            low: Some(low),
                            high: Some(high),
                        }
                    }
                } else {
                    let values = if name == "@int.mul" {
                        vec![a * c, a * d, b * c, b * d]
                    } else {
                        vec![a / c, a / d, b / c, b / d]
                    };
                    IntegerInterval {
                        low: values.iter().min().cloned(),
                        high: values.into_iter().max(),
                    }
                }
            }
            _ => return None,
        }
    };
    // Runtime Int traps instead of wrapping. Do not invent a narrower storage
    // type when the interval crosses the runtime boundary. The existing broad
    // Int contract and overflow checks remain authoritative in that case.
    let minimum = BigInt::from(i64::MIN);
    let maximum = BigInt::from(i64::MAX);
    if result
        .low
        .as_ref()
        .is_some_and(|value| value < &minimum || value > &maximum)
        || result
            .high
            .as_ref()
            .is_some_and(|value| value < &minimum || value > &maximum)
    {
        return None;
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_result_intervals_enclose_every_small_operand_pair() {
        for (name, arity) in ARITHMETIC {
            for low in -4..=4_i64 {
                for high in low..=4_i64 {
                    let left = IntegerInterval {
                        low: Some(low.into()),
                        high: Some(high.into()),
                    };
                    if *arity == 1 {
                        let result =
                            transfer(name, &[left]).expect("small negation has an interval");
                        assert_eq!(result.low, Some((-high).into()));
                        assert_eq!(result.high, Some((-low).into()));
                        continue;
                    }
                    for right_low in -4..=4_i64 {
                        for right_high in right_low..=4_i64 {
                            let inputs = [
                                IntegerInterval {
                                    low: Some(low.into()),
                                    high: Some(high.into()),
                                },
                                IntegerInterval {
                                    low: Some(right_low.into()),
                                    high: Some(right_high.into()),
                                },
                            ];
                            let Some(result) = transfer(name, &inputs) else {
                                assert!(
                                    matches!(*name, "@int.div" | "@int.rem")
                                        && right_low <= 0
                                        && right_high >= 0
                                );
                                continue;
                            };
                            for a in low..=high {
                                for b in right_low..=right_high {
                                    let value = BigInt::from(match *name {
                                        "@int.add" => a + b,
                                        "@int.sub" => a - b,
                                        "@int.mul" => a * b,
                                        "@int.div" => a / b,
                                        "@int.rem" => a % b,
                                        _ => unreachable!(),
                                    });
                                    assert!(
                                        result.low.as_ref().is_none_or(|low| low <= &value),
                                        "{name}: lower bound"
                                    );
                                    assert!(
                                        result.high.as_ref().is_none_or(|high| &value <= high),
                                        "{name}: upper bound"
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn integer_result_overflow_does_not_create_a_wrapped_refinement() {
        let maximum = IntegerInterval {
            low: Some(i64::MAX.into()),
            high: Some(i64::MAX.into()),
        };
        let one = IntegerInterval {
            low: Some(1.into()),
            high: Some(1.into()),
        };
        assert!(transfer("@int.add", &[maximum, one]).is_none());
        let minimum = IntegerInterval {
            low: Some(i64::MIN.into()),
            high: Some(i64::MIN.into()),
        };
        assert!(transfer("@int.neg", &[minimum]).is_none());
    }
}
