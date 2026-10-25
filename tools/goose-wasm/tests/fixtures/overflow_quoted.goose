// Array rendering quotes and escapes its string elements. The input fits,
// while the escaped output needs more than one partition.
fn main() {
    var bytes: u8[>..] = [];
    bytes.resize(32768, '"');
    let values: (u8[:])[1] = [bytes];
    let rendered = str(values);
    print("unreachable ", rendered.len);
}
