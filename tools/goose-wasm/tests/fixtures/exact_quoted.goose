fn main() {
    var source: u8[>..] = ['\n'];
    let values: (u8[:])[1] = [source];
    var bytes: u8[>..] = [];
    bytes.resize(65530, 120);
    format(bytes, values);
    assert(bytes[65530] == '[' && bytes[65535] == ']');
    print(bytes.len);
}
