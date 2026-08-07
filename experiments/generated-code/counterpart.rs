#[link(wasm_import_module = "blot:host/Benchmark")]
unsafe extern "C" {
    fn input() -> i64;
}

fn scalar_mix(input: i64) -> i64 {
    let mut state = input;
    for increment in 1..=16 {
        state = (state * 48_271 + increment) % 2_147_483_647;
    }
    state
}

fn branch_mix(input: i64) -> i64 {
    if input % 2 == 0 {
        (input * 3 + 1) % 2_147_483_647
    } else if input % 3 == 0 {
        (input * 5 + 2) % 2_147_483_647
    } else if input % 5 == 0 {
        (input * 7 + 3) % 2_147_483_647
    } else if input % 7 == 0 {
        (input * 11 + 4) % 2_147_483_647
    } else if input % 11 == 0 {
        (input * 13 + 5) % 2_147_483_647
    } else if input % 13 == 0 {
        (input * 17 + 6) % 2_147_483_647
    } else {
        (input * 19 + 7) % 2_147_483_647
    }
}

#[inline(never)]
fn call_step(value: i64) -> i64 {
    (value * 48_271 + 1) % 2_147_483_647
}

fn function_chain(input: i64) -> i64 {
    let mut state = input;
    for _ in 0..16 {
        state = call_step(state);
    }
    state
}

fn array_pipeline(input: i64) -> i64 {
    let mut values = Vec::new();
    for increment in 1..=8 {
        values.push(input + increment);
    }
    values.into_iter().sum()
}

fn sum_to(remaining: i64, total: i64) -> i64 {
    if remaining <= 0 {
        return total;
    }
    sum_to(remaining - 1, total + remaining)
}

fn loop_mix(remaining: i64, state: i64) -> i64 {
    if remaining <= 0 {
        return state;
    }
    let next = (state * 48_271 + remaining) % 2_147_483_647;
    loop_mix(remaining - 1, next)
}

fn construct(count: i64) -> i64 {
    let mut values = Vec::new();
    for value in (1..=count).rev() {
        values.push(value);
    }
    values.len() as i64
}

fn fold(count: i64) -> i64 {
    (1..=count).sum()
}

fn retained_updates(count: i64) -> i64 {
    let mut values = Vec::new();
    let mut observed = 0_i64;
    for remaining in (1..=count).rev() {
        let mut next = values.clone();
        next.push(remaining);
        observed += values.len() as i64;
        values = next;
    }
    observed
}

fn arena_list(count: i64) -> i64 {
    let mut nodes = vec![(0_i64, 0_usize)];
    let mut head = 0_usize;
    for value in (1..=count).rev() {
        let next = nodes.len();
        nodes.push((value, head));
        head = next;
    }
    let mut total = 0_i64;
    while head != 0 {
        let node = nodes[head];
        total += node.0;
        head = node.1;
    }
    total
}

enum RecursiveList {
    Nil,
    Cons(i64, Box<RecursiveList>),
}

fn recursive_list_build(count: i64) -> RecursiveList {
    if count == 0 {
        return RecursiveList::Nil;
    }
    RecursiveList::Cons(count, Box::new(recursive_list_build(count - 1)))
}

fn recursive_list_total(list: &RecursiveList) -> i64 {
    match list {
        RecursiveList::Nil => 0,
        RecursiveList::Cons(value, tail) => value + recursive_list_total(tail),
    }
}

fn recursive_list(count: i64) -> i64 {
    recursive_list_total(&recursive_list_build(count))
}

fn benchmark_input() -> i64 {
    // SAFETY: the benchmark harness supplies the import with the declared
    // signature for the lifetime of the instance.
    unsafe { input() }
}

#[cfg(workload_host_roundtrip)]
#[unsafe(export_name = "blot:default")]
pub extern "C" fn run_host_roundtrip() -> i64 {
    benchmark_input()
}

#[cfg(workload_identity)]
#[unsafe(export_name = "blot:identity")]
pub extern "C" fn run_identity(value: i64) -> i64 {
    value
}

#[cfg(workload_scalar_mix)]
#[unsafe(export_name = "blot:default")]
pub extern "C" fn run_scalar_mix() -> i64 {
    scalar_mix(benchmark_input())
}

#[cfg(workload_branch_mix)]
#[unsafe(export_name = "blot:default")]
pub extern "C" fn run_branch_mix() -> i64 {
    branch_mix(benchmark_input())
}

#[cfg(workload_function_chain)]
#[unsafe(export_name = "blot:default")]
pub extern "C" fn run_function_chain() -> i64 {
    function_chain(benchmark_input())
}

#[cfg(workload_fixed_array)]
#[unsafe(export_name = "blot:default")]
pub extern "C" fn run_fixed_array() -> i64 {
    array_pipeline(benchmark_input())
}

#[cfg(workload_tail_recursion)]
#[unsafe(export_name = "blot:sum_to")]
pub extern "C" fn run_tail_recursion(count: i64) -> i64 {
    sum_to(count, 0)
}

#[cfg(workload_loop_mix)]
#[unsafe(export_name = "blot:mix")]
pub extern "C" fn run_loop_mix(count: i64) -> i64 {
    loop_mix(count, 1)
}

#[cfg(workload_array_construction)]
#[unsafe(export_name = "blot:construct")]
pub extern "C" fn run_array_construction(count: i64) -> i64 {
    construct(count)
}

#[cfg(workload_range_fold)]
#[unsafe(export_name = "blot:fold")]
pub extern "C" fn run_range_fold(count: i64) -> i64 {
    fold(count)
}

#[cfg(workload_surface_iteration)]
#[unsafe(export_name = "blot:sum_to")]
pub extern "C" fn run_surface_iteration(count: i64) -> i64 {
    (0..count).sum()
}

#[cfg(workload_retained_updates)]
#[unsafe(export_name = "blot:retained_updates")]
pub extern "C" fn run_retained_updates(count: i64) -> i64 {
    retained_updates(count)
}

#[cfg(workload_arena_list)]
#[unsafe(export_name = "blot:arena_list")]
pub extern "C" fn run_arena_list(count: i64) -> i64 {
    arena_list(count)
}

#[cfg(workload_recursive_list)]
#[unsafe(export_name = "blot:recursive_list")]
pub extern "C" fn run_recursive_list(count: i64) -> i64 {
    recursive_list(count)
}
