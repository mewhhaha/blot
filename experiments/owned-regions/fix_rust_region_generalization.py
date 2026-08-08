from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


path = "experiments/rust-middle/src/typecheck.rs"

# Region is parametric in exactly the same inference variable as Array, but it
# is invariant at the constraint boundary. Every generic-type traversal must
# still descend through its element or a generalized Region can retain a live
# inference variable after its sibling Array occurrence has been rigidified.
replace_once(
    path,
    '''            Type::Array(element) => Type::Array(Box::new(self.freshen(*element, level, fresh))),
            Type::Variant { cases, open } => Type::Variant {
''',
    '''            Type::Array(element) => Type::Array(Box::new(self.freshen(*element, level, fresh))),
            Type::Region(element) => {
                Type::Region(Box::new(self.freshen(*element, level, fresh)))
            }
            Type::Variant { cases, open } => Type::Variant {
''',
)

replace_once(
    path,
    '''            Type::Array(element) => self.level_of(element),
            Type::Union(members) => members
''',
    '''            Type::Array(element) | Type::Region(element) => self.level_of(element),
            Type::Union(members) => members
''',
)

replace_once(
    path,
    '''            Type::Array(element) => {
                Type::Array(Box::new(self.extrude(*element, polarity, level, copies)))
            }
            Type::Variant { cases, open } => Type::Variant {
''',
    '''            Type::Array(element) => {
                Type::Array(Box::new(self.extrude(*element, polarity, level, copies)))
            }
            Type::Region(element) => {
                Type::Region(Box::new(self.extrude(*element, polarity, level, copies)))
            }
            Type::Variant { cases, open } => Type::Variant {
''',
)

replace_once(
    path,
    '''            Type::Array(element) => Type::Array(Box::new(
                self.residual_signature_type(*element, seen, resolved, unresolved, recursive),
            )),
            Type::Variant { cases, open } => Type::Variant {
''',
    '''            Type::Array(element) => Type::Array(Box::new(
                self.residual_signature_type(*element, seen, resolved, unresolved, recursive),
            )),
            Type::Region(element) => Type::Region(Box::new(
                self.residual_signature_type(*element, seen, resolved, unresolved, recursive),
            )),
            Type::Variant { cases, open } => Type::Variant {
''',
)

replace_once(
    path,
    '''            Type::Array(element) => {
                Type::Array(Box::new(self.settle_seen(*element, positive, seen)))
            }
            Type::Variant { cases, open } => Type::Variant {
''',
    '''            Type::Array(element) => {
                Type::Array(Box::new(self.settle_seen(*element, positive, seen)))
            }
            Type::Region(element) => {
                Type::Region(Box::new(self.settle_seen(*element, positive, seen)))
            }
            Type::Variant { cases, open } => Type::Variant {
''',
)

replace_once(
    path,
    '''        Type::Array(element) => Type::Array(Box::new(substitute_rigid(*element, replacements))),
        Type::Variant { cases, open } => Type::Variant {
''',
    '''        Type::Array(element) => Type::Array(Box::new(substitute_rigid(*element, replacements))),
        Type::Region(element) => {
            Type::Region(Box::new(substitute_rigid(*element, replacements)))
        }
        Type::Variant { cases, open } => Type::Variant {
''',
)

# Region is invariant, so inferred forwarding closures and record fields may
# settle their input and output element bounds independently. Give every public
# Slice operation an explicit rank-N type: each call gets one fresh T shared by
# all Region/Array occurrences. Slice.of remains the Region type constructor for
# downstream annotations.
prelude = "src/prelude/prelude.blot"
replace_once(
    prelude,
    '''const Slice =
  {
    .claim = fn values => @region.array.claim values;
    .length = fn &region => @region.array.length (&region);
    .get = fn (&region, index) => @region.array.get (&region) index;
    .set = fn (!region, index, value) => @region.array.set (!region) index value;
    .swap = fn (!region, left, right) => @region.array.swap (!region) left right;
    .split = fn (!region, index) => @region.array.split (!region) index;
    .join = fn (!left, !right) => @region.array.join (!left) (!right);
    .freeze = fn !region => @region.array.freeze (!region);
  }
''',
    '''sig slice_claim = @forall (fn T => [T] -> (@region.array.type T))
const slice_claim = fn values => @region.array.claim values

sig slice_length = @forall (fn T => (@region.array.type T) -> @type.int)
const slice_length = fn &region => @region.array.length (&region)

sig slice_get = @forall (fn T => ((@region.array.type T), @type.int) -> (#Some T | #None))
const slice_get = fn (&region, index) => @region.array.get (&region) index

sig slice_set = @forall (fn T => ((@region.array.type T), @type.int, T) -> (#Updated (@region.array.type T) | #SetOutOfBounds (@region.array.type T)))
const slice_set = fn (!region, index, value) => @region.array.set (!region) index value

sig slice_swap = @forall (fn T => ((@region.array.type T), @type.int, @type.int) -> (#Updated (@region.array.type T) | #SwapOutOfBounds (@region.array.type T)))
const slice_swap = fn (!region, left, right) => @region.array.swap (!region) left right

sig slice_split = @forall (fn T => ((@region.array.type T), @type.int) -> (#Split ((@region.array.type T), (@region.array.type T)) | #SplitOutOfBounds (@region.array.type T)))
const slice_split = fn (!region, index) => @region.array.split (!region) index

sig slice_join = @forall (fn T => ((@region.array.type T), (@region.array.type T)) -> (@region.array.type T))
const slice_join = fn (!left, !right) => @region.array.join (!left) (!right)

sig slice_freeze = @forall (fn T => (@region.array.type T) -> [T])
const slice_freeze = fn !region => @region.array.freeze (!region)

const Slice =
  {
    .of = @region.array.type;
    .claim = slice_claim;
    .length = slice_length;
    .get = slice_get;
    .set = slice_set;
    .swap = slice_swap;
    .split = slice_split;
    .join = slice_join;
    .freeze = slice_freeze;
  }
''',
)

example = "examples/owned_slice_quicksort.blot"
replace_once(
    example,
    '''let keep_swap = fn (region, left, right) =>
''',
    '''sig keep_swap = ((Slice.of Int), Int, Int) -> (Slice.of Int)
let keep_swap = fn (region, left, right) =>
''',
)
replace_once(
    example,
    '''let partition =
''',
    '''sig partition = ((Slice.of Int), Int, Int, Int, Int) -> ((Slice.of Int), Int)
let partition =
''',
)
replace_once(
    example,
    '''let quicksort =
''',
    '''sig quicksort = (Slice.of Int) -> (Slice.of Int)
let quicksort =
''',
)
replace_once(
    example,
    '''let quicksort_parts =
''',
    '''sig quicksort_parts = ((Slice.of Int), Int) -> (Slice.of Int)
let quicksort_parts =
''',
)
replace_once(
    example,
    '''let quicksort_rest =
''',
    '''sig quicksort_rest = ((Slice.of Int), (Slice.of Int)) -> (Slice.of Int)
let quicksort_rest =
''',
)

print("fixed Rust Region generic traversals and typed every public Slice wrapper")
