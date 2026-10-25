// Nonadjacent free runs force the reusable-slice allocator to grow its tree.
fn main() {
    reusable[] var pool: u8[>..] = [];
    let all = pool.alloc_slice(12000);
    for i in 6000 { pool.free_slice(all[i * 2..i * 2 + 1]); }
    print("unreachable");
}
