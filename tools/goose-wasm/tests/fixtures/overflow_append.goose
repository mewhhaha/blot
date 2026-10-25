fn main() {
    var bytes: u8[>..] = [];
    bytes.resize(65530, 1);
    bytes.append("1234567");
    print("unreachable");
}
