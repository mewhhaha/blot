
test("length-delimited UTF-8 preserves every U+FEFF as string data", () => {
  const strings = [
    "\uFEFF",
    "\uFEFFhello",
    "\uFEFF\uFEFF",
    "x\uFEFFy",
    "",
    "\uFEFF🌳\0",
  ];
  const encoder = new BinaryEncoder();
  for (const text of strings) encoder.string(text);
  const decoder = new BinaryDecoder(encoder.finish());
  // Compare with the original scalars, not a second default TextDecoder.
  for (const text of strings) assert.equal(decoder.string("text"), text);
  decoder.finish();
});
