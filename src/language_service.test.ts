import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { LanguageService } from "./language_service.ts";

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

Deno.test("value hover shows its inferred signature, compact definition, and documentation", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "hover-value.blot");
  const source = `open @import "blot:prelude" ()

/// Adds two integers without changing either input.
sig add = Int -> Int -> Int
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
    assertStringIncludes(hover.contents.value, "sig add = Int -> Int -> Int");
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
    assertStringIncludes(parameter.contents.value, "sig left = Int");
  } finally {
    await service.destroy();
  }
});

Deno.test("token hover documents keywords and resolved operators", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "hover-token.blot");
  const source = `open @import "blot:prelude" ()
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
      "**Related value:** `Num.add`",
    );
    assertStringIncludes(operator.contents.value, "left + right");
    const overloaded = await service.hover(uri, { line: 2, character: 15 });
    assert(overloaded !== null);
    assertStringIncludes(overloaded.contents.value, "`Num.sub`");
    assertStringIncludes(overloaded.contents.value, "left - right");
    assertStringIncludes(overloaded.contents.value, "`Num.negate`");
    assertStringIncludes(overloaded.contents.value, "-value");
    const field = await service.hover(uri, { line: 3, character: 19 });
    assert(field !== null);
    assertStringIncludes(
      field.contents.value,
      "sig Array.length = ['a] -> Int",
    );
    const keyword = await service.hover(uri, { line: 4, character: 1 });
    assert(keyword !== null);
    assertStringIncludes(keyword.contents.value, "nearest module");
  } finally {
    await service.destroy();
  }
});

Deno.test("shape and attached member hover keeps the selected member", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "hover-member.blot");
  const source = `open @import "blot:prelude" ()
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
    assertStringIncludes(shapeMember.contents.value, "sig hello = 42");
    assertStringIncludes(
      shapeMember.contents.value,
      ".hello = Point.fields",
    );
    assertEquals(
      shapeMember.contents.value.includes("sig Point.fields"),
      false,
    );

    const attachedMember = await service.hover(uri, {
      line: 8,
      character: 19,
    });
    assert(attachedMember !== null);
    assertStringIncludes(
      attachedMember.contents.value,
      "sig Point.new = ⊤",
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
  const source = `open @import "blot:prelude" ()
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
  const source = `let run = fn () =>
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
  const source = `open @import "blot:prelude" ()
sig unwrap = Option Unit -> Unit
let unwrap = fn option =>
  return case option of
    #None =>
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
