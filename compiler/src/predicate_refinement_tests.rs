use super::*;

fn interval(low: Option<i64>, high: Option<i64>) -> Interval {
    Interval {
        low: low.map(BigInt::from),
        high: high.map(BigInt::from),
    }
}

// Deliberately retain the simple Cartesian implementation as a test oracle.
fn reference_intersection(left: &[Interval], right: &[Interval]) -> Vec<Interval> {
    let mut result = Vec::new();
    for one in left {
        for other in right {
            result.push(Interval {
                low: maximum_low(&one.low, &other.low),
                high: minimum_high(&one.high, &other.high),
            });
        }
    }
    normalize(result)
}

#[test]
fn sweep_matches_cartesian_oracle_for_bounded_and_unbounded_sets() {
    let bounds = [None, Some(-2), Some(-1), Some(0), Some(1), Some(2)];
    let mut sets = vec![Vec::new()];
    for low in bounds {
        for high in bounds {
            sets.push(normalize(vec![interval(low, high)]));
            sets.push(normalize(vec![
                interval(low, high),
                interval(Some(-4), Some(-3)),
                interval(Some(3), Some(4)),
            ]));
        }
    }
    for left in &sets {
        for right in &sets {
            let actual = intersection(left, right);
            assert_eq!(actual, reference_intersection(left, right));
            assert_eq!(actual, intersection(right, left));
            assert_eq!(actual, normalize(actual.clone()));
        }
    }
}

#[test]
fn interleaved_disjoint_intervals_require_linear_work() {
    let size = 8192;
    let left = (0..size)
        .map(|index| interval(Some(index * 4), Some(index * 4 + 1)))
        .collect::<Vec<_>>();
    let right = (0..size)
        .map(|index| interval(Some(index * 4 + 2), Some(index * 4 + 3)))
        .collect::<Vec<_>>();
    INTERSECTION_STEPS.with(|steps| steps.set(0));
    assert!(intersection(&left, &right).is_empty());
    INTERSECTION_STEPS.with(|steps| assert_eq!(steps.get(), left.len() + right.len() - 1));
}

#[test]
fn a_long_interval_can_overlap_many_short_intervals() {
    let left = vec![interval(None, None)];
    let right = (0..4096)
        .map(|index| interval(Some(index * 2), Some(index * 2)))
        .collect::<Vec<_>>();
    INTERSECTION_STEPS.with(|steps| steps.set(0));
    assert_eq!(intersection(&left, &right), right);
    INTERSECTION_STEPS.with(|steps| assert_eq!(steps.get(), right.len()));
}

#[test]
fn integer_endpoints_do_not_overflow_or_close_a_gap() {
    let edges = vec![
        interval(Some(i64::MIN), Some(i64::MIN)),
        interval(Some(i64::MAX), Some(i64::MAX)),
    ];
    assert_eq!(intersection(&edges, &runtime_integer_domain()), edges);
    assert_eq!(
        intersection(&complement(&edges), &runtime_integer_domain()),
        vec![interval(Some(i64::MIN + 1), Some(i64::MAX - 1))]
    );
}

#[test]
fn nested_union_bases_are_normalized_once_and_shared_leaves_are_deduplicated() {
    let mut base = Value::Union(vec![Value::Int(4.into()), Value::Int(0.into())].into());
    // Only O(depth) nodes are allocated, but an un-memoized recursive walk
    // expands this diamond into more than a billion leaves.
    for _ in 0..30 {
        base = Value::Union(vec![base.clone(), base].into());
    }
    assert_eq!(
        base_intervals(&base, Span { start: 0, end: 1 }).unwrap(),
        vec![interval(Some(0), Some(0)), interval(Some(4), Some(4))]
    );
}

#[test]
fn base_ranges_are_sorted_coalesced_and_empty_ranges_removed() {
    let range = |low: i64, high: i64| Value::Range {
        low: Box::new(Value::Int(low.into())),
        high: Box::new(Value::Int(high.into())),
        domain: Some(Domain::Int),
    };
    let base = Value::Union(vec![range(5, 8), range(4, 1), range(0, 2), range(3, 4)].into());
    assert_eq!(
        base_intervals(&base, Span { start: 0, end: 1 }).unwrap(),
        vec![interval(Some(0), Some(8))]
    );
}
