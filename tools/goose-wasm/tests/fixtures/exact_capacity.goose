// The length metadata lives outside the elements' data stack. Exactly
// 64 KiB of elements must fit in a 64 KiB partition, including cached tops.
fn main() {
    var bytes: u8[>..] = [];
    for i in 65536 { bytes.push((i % 251) as u8); }
    assert(bytes.len == 65536);
    assert(bytes[0] == 0 && bytes[65535] == 24);
    print(bytes.len);
}
