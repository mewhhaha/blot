// Reserve the actual formatted length, not a pessimistic 20-byte maximum.
fn main() {
    var values: i64[>..] = [-123];
    var bytes: u8[>..] = [];
    bytes.resize(65532, 120);
    format(bytes, values[0]);
    assert(bytes[65532] == '-' && bytes[65535] == '3');
    print(bytes.len);
}
