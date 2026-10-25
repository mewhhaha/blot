// The payload fits, but expanding the variable-width length prefix does not.
fn make() -> u8[varint] {
    var bytes: u8[>..] = [];
    bytes.resize(65534, 97);
    return bytes;
}

fn main() {
    let bytes: u8[varint] = make();
    print("unreachable ", bytes.len);
}
