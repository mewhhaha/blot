import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { LanguageService } from "./language_service.ts";

Deno.test("ordered range changes update one editor revision", async () => {
  const service = new LanguageService();
  const uri = "untitled:range-sync.blot";
  try {
    service.open(uri, "return 10\n", 1);
    service.changeRanges(uri, [{
      range: {
        start: { line: 0, character: 8 },
        end: { line: 0, character: 9 },
      },
      rangeLength: 1,
      text: "2",
    }, {
      range: {
        start: { line: 0, character: 7 },
        end: { line: 0, character: 8 },
      },
      rangeLength: 1,
      text: "4",
    }], 2);
    assertEquals(service.version(uri), 2);
    const formatting = await service.formatting(uri);
    assertEquals(formatting, []);
    assertThrowsVersion(service, uri);
  } finally {
    await service.destroy();
  }
});

function assertThrowsVersion(service: LanguageService, uri: string): void {
  let thrown = false;
  try {
    service.change(uri, "return 1\n", 2);
  } catch {
    thrown = true;
  }
  assert(thrown);
}

Deno.test("language diagnostics check the open editor revision", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "revision.blot");
  await Deno.writeTextFile(
    path,
    `return 1
`,
  );
  const uri = toFileUrl(path).href;
  const service = new LanguageService();
  try {
    service.open(
      uri,
      `return missing
`,
      1,
    );
    const diagnostics = await service.diagnostics(uri);
    assert(
      diagnostics.some((diagnostic) => diagnostic.code === "BLOT_UNBOUND"),
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("language diagnostics report compiler target preflight refusals", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "target-refusal.blot");
  const source = `open import "blot:prelude"

let vector :: F32 -> F32x4
let vector = fn value => F32x4.splat value
return vector
`;
  const uri = toFileUrl(path).href;
  const service = new LanguageService();
  try {
    service.open(uri, source, 1);
    const diagnostics = await service.diagnostics(uri);
    const refusal = diagnostics.find((diagnostic) =>
      diagnostic.code === "BLOT_TARGET_REFUSAL"
    );
    assert(refusal !== undefined);
    assertStringIncludes(refusal.message, "SIMD");
  } finally {
    await service.destroy();
  }
});

Deno.test("language formatting returns one whole-document edit", async () => {
  const service = new LanguageService();
  const uri = "untitled:format.blot";
  try {
    service.open(
      uri,
      ` return 1
`,
      1,
    );
    const edits = await service.formatting(uri);
    assertEquals(edits.length, 1);
    assertEquals(
      edits[0]?.newText,
      `return 1
`,
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("inference-centered editor features share one resident revision", async () => {
  const service = new LanguageService();
  const uri = "untitled:inference-features.blot";
  const source = `open import "blot:prelude"
let add :: Int -> Int -> Int
let add = fn left => fn right => left
let answer = add 20 22
return answer
`;
  try {
    service.open(uri, source, 1);
    const completion = await service.completion(uri, {
      line: 4,
      character: 7,
    });
    assert(completion.some((item) => item.label === "add"));
    assert(completion.some((item) => item.label === "answer"));
    for (
      const keyword of ["compdo", "const", "fn", "for", "open", "rec"]
    ) {
      assert(
        completion.some((item) => item.label === keyword),
        `completion omitted current keyword ${keyword}`,
      );
    }

    const signature = await service.signatureHelp(uri, {
      line: 3,
      character: 21,
    });
    assert(signature !== null);
    assertStringIncludes(signature.signatures[0].label, "Int -> Int -> Int");

    const hints = await service.inlayHints(uri);
    assert(hints.some((hint) => hint.label.includes("Int")));

    const symbols = await service.documentSymbols(uri);
    assertEquals(symbols.map((symbol) => symbol.name), ["add", "answer"]);

    const references = await service.references(uri, {
      line: 2,
      character: 5,
    });
    assert(references.length >= 2);
    const rename = await service.rename(
      uri,
      { line: 2, character: 5 },
      "sum",
    );
    assert(rename !== null);
    assert(rename.changes[uri]?.every((edit) => edit.newText === "sum"));

    const workspace = await service.workspaceSymbols("ans");
    assertEquals(workspace.map((symbol) => symbol.name), ["answer"]);
  } finally {
    await service.destroy();
  }
});

Deno.test("definition follows an imported field to its exported source binding", async () => {
  const directory = await Deno.makeTempDir();
  const libraryPath = join(directory, "library.blot");
  const mainPath = join(directory, "main.blot");
  const librarySource = `let answer = 42
return { .answer = answer; }
`;
  const mainSource = `const Library = import "./library.blot"
return Library.answer
`;
  await Deno.writeTextFile(libraryPath, librarySource);
  await Deno.writeTextFile(mainPath, mainSource);
  const libraryUri = toFileUrl(libraryPath).href;
  const mainUri = toFileUrl(mainPath).href;
  const service = new LanguageService();
  try {
    service.open(libraryUri, librarySource, 1);
    service.open(mainUri, mainSource, 1);
    const definition = await service.definition(mainUri, {
      line: 1,
      character: 16,
    });
    assertEquals(definition, {
      uri: libraryUri,
      range: {
        start: { line: 0, character: 4 },
        end: { line: 0, character: 10 },
      },
    });
  } finally {
    await service.destroy();
  }
});

Deno.test("value hover shows its inferred signature, compact definition, and documentation", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "hover-value.blot");
  const source = `open import "blot:prelude"

/// Adds two integers without changing either input.
let add :: Int -> Int -> Int
let add = fn left => fn right => left + right
let answer = add 20 22
return answer
`;
  await Deno.writeTextFile(
    path,
    `return 0
`,
  );
  const uri = toFileUrl(path).href;
  const service = new LanguageService();
  try {
    service.open(uri, source, 1);
    const hover = await service.hover(uri, { line: 5, character: 14 });
    assert(hover !== null);
    assertStringIncludes(hover.contents.value, "let add :: Int -> Int -> Int");
    assertStringIncludes(
      hover.contents.value,
      "let add = fn left => fn right => body",
    );
    assertStringIncludes(
      hover.contents.value,
      "Adds two integers without changing either input.",
    );
    const parameter = await service.hover(uri, { line: 4, character: 14 });
    assert(parameter !== null);
    assertStringIncludes(parameter.contents.value, "let left :: Int");
  } finally {
    await service.destroy();
  }
});

Deno.test("token hover documents keywords and resolved operators", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "hover-token.blot");
  const source = `open import "blot:prelude"
let total = 20 + 22
let negative = -total
let count = Array.length [negative]
return count
`;
  await Deno.writeTextFile(path, source);
  const uri = toFileUrl(path).href;
  const service = new LanguageService();
  try {
    service.open(uri, source, 1);
    const operator = await service.hover(uri, { line: 1, character: 15 });
    assert(operator !== null);
    assertStringIncludes(operator.contents.value, "precedence 60");
    assertStringIncludes(
      operator.contents.value,
      "**Related value:** `Int.add`",
    );
    assertStringIncludes(operator.contents.value, "left + right");
    const overloaded = await service.hover(uri, { line: 2, character: 15 });
    assert(overloaded !== null);
    assertStringIncludes(overloaded.contents.value, "`Int.sub`");
    assertStringIncludes(overloaded.contents.value, "left - right");
    assertStringIncludes(overloaded.contents.value, "`Int.negate`");
    assertStringIncludes(overloaded.contents.value, "-value");
    const field = await service.hover(uri, { line: 3, character: 19 });
    assert(field !== null);
    assertStringIncludes(
      field.contents.value,
      "let Array.length :: ['a] -> Int",
    );
    const imported = await service.hover(uri, { line: 0, character: 7 });
    assert(imported !== null);
    assertStringIncludes(imported.contents.value, "Instantiates a module once");
    const returned = await service.hover(uri, { line: 4, character: 1 });
    assert(returned !== null);
    assertStringIncludes(
      returned.contents.value,
      "result of the nearest module",
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("shape and attached member hover keeps the selected member", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "hover-member.blot");
  const source = `open import "blot:prelude"
const Point = Int <+ {
  .fields = 42;
  .new = fn value => value + 0;
}
let reflected = {
  .hello = Point.fields;
}
let point = Point.new 1
return (reflected, point)
`;
  await Deno.writeTextFile(
    path,
    `return 0
`,
  );
  const uri = toFileUrl(path).href;
  const service = new LanguageService();
  try {
    service.open(uri, source, 1);
    const shapeMember = await service.hover(uri, {
      line: 6,
      character: 4,
    });
    assert(shapeMember !== null);
    assertStringIncludes(shapeMember.contents.value, "let hello :: 42");
    assertStringIncludes(
      shapeMember.contents.value,
      ".hello = Point.fields",
    );
    assertEquals(
      shapeMember.contents.value.includes("let Point.fields ::"),
      false,
    );

    const attachedMember = await service.hover(uri, {
      line: 8,
      character: 19,
    });
    assert(attachedMember !== null);
    assertEquals(
      attachedMember.contents.value.includes("let Point.new ::"),
      false,
    );
    assertStringIncludes(
      attachedMember.contents.value,
      ".new = fn value => body",
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("correctness lints are warnings", async () => {
  const service = new LanguageService();
  const uri = "untitled:unused-binding.blot";
  try {
    service.open(
      uri,
      `let forgotten = 1
return 2
`,
      1,
    );
    const diagnostics = await service.diagnostics(uri);
    const unused = diagnostics.find((diagnostic) =>
      diagnostic.code === "BLOT_LINT_UNUSED_BINDING"
    );
    assertEquals(unused?.severity, 2);
  } finally {
    await service.destroy();
  }
});

Deno.test("a direct array access action is published only after compiler proof", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "proved-lookup.blot");
  const source = `open import "blot:prelude"
return case Array.get ([1], 0) of
  #Some value => value
  #None => 0
`;
  await Deno.writeTextFile(path, source);
  const uri = toFileUrl(path).href;
  const service = new LanguageService();
  try {
    service.open(uri, source, 3);
    const diagnostics = await service.diagnostics(uri);
    assert(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "BLOT_LINT_PROVED_ARRAY_LOOKUP"
      ),
    );
    const actions = await service.codeActions(uri, {
      start: { line: 1, character: 0 },
      end: { line: 3, character: 12 },
    });
    const action = actions.find((candidate) =>
      candidate.title === "Replace proved lookup with direct indexed access"
    );
    assertEquals(
      action?.edit.documentChanges[0].edits[0]?.newText,
      "@array.get [1] 0",
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("a self rebinding that widens the public type is not a no-op", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "widening-rebinding.blot");
  const source = `let value = 1
value := value
return value
`;
  await Deno.writeTextFile(path, source);
  const uri = toFileUrl(path).href;
  const service = new LanguageService();
  try {
    service.open(uri, source, 1);
    const diagnostics = await service.diagnostics(uri);
    assert(
      !diagnostics.some((diagnostic) =>
        diagnostic.code === "BLOT_LINT_NOOP_REBINDING"
      ),
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("an unused effect result offers an explicit discard action", async () => {
  const service = new LanguageService();
  const uri = "untitled:unused-effect-result.blot";
  const source = `let run = fn () => do:
  ignored <- perform_work ()
  return ()
return run
`;
  try {
    service.open(uri, source, 4);
    const actions = await service.codeActions(uri, {
      start: { line: 1, character: 2 },
      end: { line: 1, character: 9 },
    });
    const action = actions.find((candidate) =>
      candidate.title === "Discard unused effect result explicitly"
    );
    assertEquals(action?.edit.documentChanges[0].edits[0]?.newText, "<-");
  } finally {
    await service.destroy();
  }
});

Deno.test("a terminal Option match offers a compiler-checked guard action", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "option-guard.blot");
  const source = `open import "blot:prelude"
let unwrap :: Option Unit -> Unit
let unwrap = fn option => do:
  return case option of
    #None => do:
      return ()
    #Some value => value
return unwrap
`;
  await Deno.writeTextFile(path, source);
  const uri = toFileUrl(path).href;
  const service = new LanguageService();
  try {
    service.open(uri, source, 2);
    const actions = await service.codeActions(uri, {
      start: { line: 3, character: 2 },
      end: { line: 6, character: 24 },
    });
    const action = actions.find((candidate) =>
      candidate.title === "Replace Option match with `if let` guard"
    );
    assert(
      action?.edit.documentChanges[0].edits[0]?.newText.includes(
        "if let #Some value = option else:",
      ) === true,
    );
  } finally {
    await service.destroy();
  }
});
