// Elements fit, but the independently allocated reusable-slot freelist does not.
fn main() {
    reusable var pool: u8[>..] = [];
    for i in 20000 { pool.push(1); }
    for i in 10000 { pool.free(i * 2); }
    print("unreachable");
}
