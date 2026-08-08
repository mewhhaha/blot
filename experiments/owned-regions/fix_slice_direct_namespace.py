from pathlib import Path

path = Path("src/prelude/prelude.blot")
text = path.read_text()
old = '''const Slice =
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
'''
new = '''const Slice =
  {
    .claim = @region.array.claim;
    .length = @region.array.length;
    .get = @region.array.get;
    .set = @region.array.set;
    .swap = @region.array.swap;
    .split = @region.array.split;
    .join = @region.array.join;
    .freeze = @region.array.freeze;
  }
'''
count = text.count(old)
if count != 1:
    raise SystemExit(f"expected one Slice wrapper namespace, found {count}")
path.write_text(text.replace(old, new, 1))
print("made Slice a direct primitive namespace")
