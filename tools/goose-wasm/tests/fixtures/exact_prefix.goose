fn make() -> u8[varint] {
    var bytes: u8[>..] = [];
    bytes.resize(65533, 97);
    return bytes;
}

fn main() {
    let bytes: u8[varint] = make();
    assert(bytes.len == 65533 && bytes[65532] == 97);
    print(bytes.len + 3);
}
