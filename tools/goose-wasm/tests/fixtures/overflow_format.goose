fn main() {
    var values: i64[>..] = [-123];
    var bytes: u8[>..] = [];
    bytes.resize(65535, 120);
    format(bytes, values[0]);
    print("unreachable");
}
