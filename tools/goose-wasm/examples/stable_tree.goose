// Stable references and relative links survive every push. The complete
// tree can be saved as one contiguous image and checked when it is loaded.
struct Node { value: i32, previous: Node&<u32>? }

fn main() {
    var tree: Node[>..] = [];
    let first .= tree.push(Node { value: 7 });
    for i in 1..4096 {
        tree.push(Node { value: i as i32, previous: tree[i - 1] });
    }
    first.value = 42;
    assert(tree[0].value == 42);
    var image = tree.to_bytes();
    var restored, ok = from_bytes<Node[>..]>(image);
    assert(ok && restored.len == tree.len);
    var at .= restored[restored.len - 1];
    var total: i64 = 0;
    loop {
        total += at.value;
        let previous = at.previous;
        guard previous else { break; }
        at .= previous;
    }
    print("nodes=", restored.len, " first=", restored[0].value, " sum=", total);
}
