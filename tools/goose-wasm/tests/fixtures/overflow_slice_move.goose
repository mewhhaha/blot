fn main() {
    reusable[] var pool: u8[>..] = [];
    let first = pool.alloc_slice(32768);
    let blocker = pool.alloc_slice(32000);
    let moved = pool.realloc_slice(first, 40000);
    print("unreachable ", moved.len, " ", blocker.len);
}
