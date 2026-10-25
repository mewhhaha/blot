fn main() {
    var values: f64[>..] = [1.25];
    var bytes: u8[>..] = [];
    bytes.resize(65532, 120);
    format(bytes, values[0]);
    assert(bytes[65532] == '1' && bytes[65535] == '5');
    print(bytes.len);
}
