fn main() {
    var bytes: u8[>..] = [];
    bytes.resize(65534, 1);
    let image = bytes.to_bytes();
    print("unreachable ", image.len);
}
