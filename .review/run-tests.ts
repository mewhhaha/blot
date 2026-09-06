
for (const [name, text] of [
  ["U+FEFF only", "\uFEFF"],
  ["leading U+FEFF", "\uFEFFhello"],
  ["repeated U+FEFF and an astral scalar", "\uFEFF\uFEFF🌳"],
  ["interior U+FEFF", "x\uFEFFy"],
] as const) {
  test(`run preserves ${name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "blot-text-scalars-"));
    const path = join(directory, "text.blot");
    const compiler = await Compiler.create();
    try {
      await writeFile(path, `return "${text}"\n`);
      const evaluated = await compiler.evaluate(path);
      assert.deepEqual(evaluated.value, { tag: "text", value: text });
      const artifact = await compiler.compile(path);
      assert.equal(JSON.parse(await runArtifact(artifact)), text);
      assert.equal(JSON.parse(await runArtifact(artifact)), text);
    } finally {
      compiler.destroy();
      await rm(directory, { recursive: true });
    }
  });
}

test("run preserves leading U+FEFF independently in nested Text fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-nested-text-"));
  const path = join(directory, "text.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(
      path,
      'return (["\uFEFFleft", "\uFEFFright"], #Some "\uFEFF")\n',
    );
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      '{ .0 = ["\uFEFFleft", "\uFEFFright"]; .1 = #Some "\uFEFF" }',
    );
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

test("run still rejects malformed UTF-8 after a leading U+FEFF", async () => {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, 8, true);
  view.setUint32(4, 5, true);
  data.set([0xef, 0xbb, 0xbf, 0xc0, 0xaf], 8);
  await assert.rejects(
    runArtifact(indirectResultFixture({ kind: "text" }, data)),
    TypeError,
  );
});
