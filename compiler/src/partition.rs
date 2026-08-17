//! Structure-independent partition proof manipulation.
//!
//! Ownership flow decides whether proof values are consumed. A registered
//! family decides what its parts mean and how compatible parts compose. This
//! module owns exact witness matching and associative proof-tree rotation.

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PartitionWitness<Family, Part> {
    pub(crate) family: Family,
    pub(crate) parent: Part,
    pub(crate) left: Part,
    pub(crate) right: Part,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Direction {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PartitionError {
    FamilyMismatch,
    LeftMismatch,
    RightMismatch,
    InnerParentMismatch,
    CompositionRefused,
}

pub(crate) fn combine_partition<Family, Part>(
    family: &Family,
    witness: &PartitionWitness<Family, Part>,
    left: &Part,
    right: &Part,
) -> Result<Part, PartitionError>
where
    Family: PartialEq,
    Part: Clone + PartialEq,
{
    if family != &witness.family {
        return Err(PartitionError::FamilyMismatch);
    }
    if left != &witness.left {
        return Err(PartitionError::LeftMismatch);
    }
    if right != &witness.right {
        return Err(PartitionError::RightMismatch);
    }
    Ok(witness.parent.clone())
}

pub(crate) fn reassociate_partition<Family, Part>(
    direction: Direction,
    outer: &PartitionWitness<Family, Part>,
    inner: &PartitionWitness<Family, Part>,
    compose: impl FnOnce(&Family, &Part, &Part) -> Option<Part>,
) -> Result<
    (
        PartitionWitness<Family, Part>,
        PartitionWitness<Family, Part>,
    ),
    PartitionError,
>
where
    Family: Clone + PartialEq,
    Part: Clone + PartialEq,
{
    if outer.family != inner.family {
        return Err(PartitionError::FamilyMismatch);
    }
    match direction {
        Direction::Left => {
            if outer.right != inner.parent {
                return Err(PartitionError::InnerParentMismatch);
            }
            let Some(joined) = compose(&outer.family, &outer.left, &inner.left) else {
                return Err(PartitionError::CompositionRefused);
            };
            Ok((
                PartitionWitness {
                    family: outer.family.clone(),
                    parent: outer.parent.clone(),
                    left: joined.clone(),
                    right: inner.right.clone(),
                },
                PartitionWitness {
                    family: outer.family.clone(),
                    parent: joined,
                    left: outer.left.clone(),
                    right: inner.left.clone(),
                },
            ))
        }
        Direction::Right => {
            if outer.left != inner.parent {
                return Err(PartitionError::InnerParentMismatch);
            }
            let Some(joined) = compose(&outer.family, &inner.right, &outer.right) else {
                return Err(PartitionError::CompositionRefused);
            };
            Ok((
                PartitionWitness {
                    family: outer.family.clone(),
                    parent: outer.parent.clone(),
                    left: inner.left.clone(),
                    right: joined.clone(),
                },
                PartitionWitness {
                    family: outer.family.clone(),
                    parent: joined,
                    left: inner.right.clone(),
                    right: outer.right.clone(),
                },
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::{
        Direction, PartitionError, PartitionWitness, combine_partition, reassociate_partition,
    };

    #[derive(Clone, Debug, Eq, PartialEq)]
    struct Interval {
        root: &'static str,
        low: u32,
        high: u32,
    }

    fn interval(root: &'static str, low: u32, high: u32) -> Interval {
        Interval { root, low, high }
    }

    fn compose_interval(_: &&str, left: &Interval, right: &Interval) -> Option<Interval> {
        if left.root != right.root || left.high != right.low {
            return None;
        }
        Some(interval(left.root, left.low, right.high))
    }

    #[test]
    fn exact_children_are_required_to_combine() {
        let proof = PartitionWitness {
            family: "array-interval",
            parent: interval("store", 0, 8),
            left: interval("store", 0, 3),
            right: interval("store", 3, 8),
        };
        assert_eq!(
            combine_partition(&"array-interval", &proof, &proof.left, &proof.right),
            Ok(proof.parent.clone())
        );
        assert_eq!(
            combine_partition(&"array-interval", &proof, &proof.right, &proof.left),
            Err(PartitionError::LeftMismatch)
        );
    }

    #[test]
    fn interval_reassociation_roundtrips() {
        let a = interval("store", 0, 2);
        let b = interval("store", 2, 5);
        let c = interval("store", 5, 8);
        let bc = interval("store", 2, 8);
        let abc = interval("store", 0, 8);
        let outer = PartitionWitness {
            family: "array-interval",
            parent: abc,
            left: a,
            right: bc.clone(),
        };
        let inner = PartitionWitness {
            family: "array-interval",
            parent: bc,
            left: b,
            right: c,
        };
        let rotated = reassociate_partition(Direction::Left, &outer, &inner, compose_interval)
            .expect("related witnesses should rotate");
        let restored =
            reassociate_partition(Direction::Right, &rotated.0, &rotated.1, compose_interval)
                .expect("the rotation should be invertible");
        assert_eq!(restored, (outer, inner));
    }

    #[test]
    fn bounded_intervals_satisfy_unit_associativity_and_coherence() {
        let family = "array-interval";
        let root = "bounded-store";
        for low in 0..=4 {
            for high in low..=4 {
                let part = interval(root, low, high);
                assert_eq!(
                    compose_interval(&family, &interval(root, low, low), &part),
                    Some(part.clone())
                );
                assert_eq!(
                    compose_interval(&family, &part, &interval(root, high, high)),
                    Some(part)
                );
            }
        }

        for a in 0..=4 {
            for b in a..=4 {
                for c in b..=4 {
                    for d in c..=4 {
                        let first = interval(root, a, b);
                        let second = interval(root, b, c);
                        let third = interval(root, c, d);
                        let first_second = compose_interval(&family, &first, &second)
                            .expect("adjacent intervals must compose");
                        let second_third = compose_interval(&family, &second, &third)
                            .expect("adjacent intervals must compose");
                        assert_eq!(
                            compose_interval(&family, &first_second, &third),
                            compose_interval(&family, &first, &second_third)
                        );

                        let whole = interval(root, a, d);
                        let outer = PartitionWitness {
                            family,
                            parent: whole,
                            left: first,
                            right: second_third.clone(),
                        };
                        let inner = PartitionWitness {
                            family,
                            parent: second_third,
                            left: second,
                            right: third,
                        };
                        let rotated = reassociate_partition(
                            Direction::Left,
                            &outer,
                            &inner,
                            compose_interval,
                        )
                        .expect("related witnesses should rotate");
                        let restored = reassociate_partition(
                            Direction::Right,
                            &rotated.0,
                            &rotated.1,
                            compose_interval,
                        )
                        .expect("rotation must be invertible");
                        assert_eq!(restored, (outer, inner));
                    }
                }
            }
        }
    }

    #[test]
    fn interval_composition_refuses_gaps_and_foreign_roots() {
        let family = "array-interval";
        assert_eq!(
            compose_interval(&family, &interval("store", 0, 1), &interval("store", 2, 3)),
            None
        );
        assert_eq!(
            compose_interval(
                &family,
                &interval("left-store", 0, 1),
                &interval("right-store", 1, 2)
            ),
            None
        );
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    struct KeySet {
        root: &'static str,
        keys: BTreeSet<&'static str>,
    }

    fn keys(root: &'static str, values: &[&'static str]) -> KeySet {
        KeySet {
            root,
            keys: values.iter().copied().collect(),
        }
    }

    fn compose_keys(_: &&str, left: &KeySet, right: &KeySet) -> Option<KeySet> {
        if left.root != right.root || !left.keys.is_disjoint(&right.keys) {
            return None;
        }
        Some(KeySet {
            root: left.root,
            keys: left.keys.union(&right.keys).copied().collect(),
        })
    }

    #[test]
    fn the_same_core_rotates_map_key_set_proofs() {
        let a = keys("map", &["a"]);
        let b = keys("map", &["b"]);
        let c = keys("map", &["c"]);
        let bc = keys("map", &["b", "c"]);
        let outer = PartitionWitness {
            family: "map-key-set",
            parent: keys("map", &["a", "b", "c"]),
            left: a,
            right: bc.clone(),
        };
        let inner = PartitionWitness {
            family: "map-key-set",
            parent: bc,
            left: b,
            right: c,
        };
        let rotated = reassociate_partition(Direction::Left, &outer, &inner, compose_keys)
            .expect("disjoint key sets should rotate");
        assert_eq!(rotated.0.left, keys("map", &["a", "b"]));
    }

    #[test]
    fn family_identity_rejects_structurally_equal_foreign_proofs() {
        let proof = PartitionWitness {
            family: "list-segment",
            parent: interval("root", 0, 2),
            left: interval("root", 0, 1),
            right: interval("root", 1, 2),
        };
        assert_eq!(
            combine_partition(&"array-interval", &proof, &proof.left, &proof.right),
            Err(PartitionError::FamilyMismatch)
        );
    }
}
