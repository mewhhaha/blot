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

Deno.test("closing a document stops its overlay from shadowing disk", async () => {
  const directory = await Deno.makeTempDir();
  const dependencyPath = join(directory, "dependency.blot");
  const dependencyUri = toFileUrl(dependencyPath).href;
  const consumerPath = join(directory, "consumer.blot");
  const consumerUri = toFileUrl(consumerPath).href;
  const consumerSource = `const dependency = import "./dependency.blot"
return dependency
`;
  await Deno.writeTextFile(dependencyPath, "return 1\n");
  await Deno.writeTextFile(consumerPath, consumerSource);
  const service = new LanguageService();
  try {
    service.open(dependencyUri, "return missing\n", 1);
    const overlayDiagnostics = await service.diagnostics(dependencyUri);
    assert(
      overlayDiagnostics.some((diagnostic) =>
        diagnostic.code === "BLOT_UNBOUND"
      ),
    );

    await service.close(dependencyUri);
    service.open(consumerUri, consumerSource, 1);
    assertEquals(await service.diagnostics(consumerUri), []);
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
let answer :: _
let answer = add 20 22
return answer
`;
  try {
    service.open(uri, source, 1);
    const completion = await service.completion(uri, {
      line: 5,
      character: 7,
    });
    assert(completion.some((item) => item.label === "add"));
    assert(completion.some((item) => item.label === "answer"));
    for (const keyword of ["const", "fn", "for", "open", "rec"]) {
      assert(
        completion.some((item) => item.label === keyword),
        `completion omitted current keyword ${keyword}`,
      );
    }

    const signature = await service.signatureHelp(uri, {
      line: 4,
      character: 21,
    });
    assert(signature !== null);
    assertStringIncludes(signature.signatures[0].label, "Int -> Int -> Int");

    const hints = await service.inlayHints(uri);
    assertEquals(hints, [{
      position: { line: 3, character: 15 },
      label: ": Int",
      kind: 1,
      tooltip: "Compiler-inferred signature hole",
    }]);

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

Deno.test("an unsigned value offers a matching signature-hole action", async () => {
  const service = new LanguageService();
  const uri = "untitled:add-signature.blot";
  const source = `let unsigned = 42
let signed :: _
let signed = unsigned
return signed
`;
  try {
    service.open(uri, source, 7);
    const actions = await service.codeActions(uri, {
      start: { line: 0, character: 4 },
      end: { line: 0, character: 12 },
    });
    const action = actions.find((candidate) =>
      candidate.title === "Add inferred signature hole for `unsigned`"
    );
    assertEquals(action?.edit.documentChanges[0].edits, [{
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      newText: "let unsigned :: _\n",
    }]);

    const signedActions = await service.codeActions(uri, {
      start: { line: 2, character: 4 },
      end: { line: 2, character: 10 },
    });
    assertEquals(
      signedActions.some((candidate) =>
        candidate.title === "Add inferred signature hole for `signed`"
      ),
      false,
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("each signature hole receives its inferred type", async () => {
  const service = new LanguageService();
  const uri = "untitled:signature-hole-hints.blot";
  const source = `open import "blot:prelude"
let increment :: _ -> _
let increment = fn value => value + 1
return increment
`;
  try {
    service.open(uri, source, 1);
    assertEquals(await service.inlayHints(uri), [{
      position: { line: 1, character: 18 },
      label: ": Int",
      kind: 1,
      tooltip: "Compiler-inferred signature hole",
    }, {
      position: { line: 1, character: 23 },
      label: ": Int",
      kind: 1,
      tooltip: "Compiler-inferred signature hole",
    }]);
  } finally {
    await service.destroy();
  }
});

Deno.test("a recursive value receives a recursive signature header", async () => {
  const service = new LanguageService();
  const uri = "untitled:add-recursive-signature.blot";
  const source = `let rec identity = fn value => value
return identity
  `;
  try {
    service.open(uri, source, 1);
    const actions = await service.codeActions(uri, {
      start: { line: 0, character: 8 },
      end: { line: 0, character: 16 },
    });
    const action = actions.find((candidate) =>
      candidate.title === "Add inferred signature hole for `identity`"
    );
    assertEquals(
      action?.edit.documentChanges[0].edits[0]?.newText,
      "let rec identity :: _\n",
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("a signature kind is corrected to match its binding", async () => {
  const service = new LanguageService();
  const uri = "untitled:correct-signature-kind.blot";
  const source = `const answer :: _
let answer = 42
return answer
`;
  try {
    service.open(uri, source, 1);
    const actions = await service.codeActions(uri, {
      start: { line: 0, character: 0 },
      end: { line: 1, character: 15 },
    });
    const correction = actions.find((candidate) =>
      candidate.title === "Match signature header to `let answer`"
    );
    assertEquals(correction?.edit.documentChanges[0].edits, [{
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 13 },
      },
      newText: "let answer ",
    }]);
    assertEquals(
      actions.some((candidate) =>
        candidate.title === "Add inferred signature hole for `answer`"
      ),
      false,
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("a signature recursion marker is corrected to match its binding", async () => {
  const service = new LanguageService();
  const uri = "untitled:correct-signature-recursion.blot";
  const source = `let rec identity :: _
let identity = fn value => value
return identity
`;
  try {
    service.open(uri, source, 1);
    const actions = await service.codeActions(uri, {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 21 },
    });
    const correction = actions.find((candidate) =>
      candidate.title === "Match signature header to `let identity`"
    );
    assertEquals(correction?.edit.documentChanges[0].edits[0], {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 17 },
      },
      newText: "let identity ",
    });
  } finally {
    await service.destroy();
  }
});

Deno.test("a signature name is corrected to match its binding", async () => {
  const service = new LanguageService();
  const uri = "untitled:correct-signature-name.blot";
  const source = `let result :: _
let answer = 42
return answer
`;
  try {
    service.open(uri, source, 1);
    const actions = await service.codeActions(uri, {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 15 },
    });
    const correction = actions.find((candidate) =>
      candidate.title === "Match signature header to `let answer`"
    );
    assertEquals(correction?.edit.documentChanges[0].edits[0], {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 11 },
      },
      newText: "let answer ",
    });
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

Deno.test("definition follows a local field to its shape member", async () => {
  const service = new LanguageService();
  const uri = "untitled:local-field-definition.blot";
  const source = `let record = { .answer = 42; }
return record.answer
`;
  try {
    service.open(uri, source, 1);
    assertEquals(
      await service.definition(uri, { line: 1, character: 15 }),
      {
        uri,
        range: {
          start: { line: 0, character: 16 },
          end: { line: 0, character: 22 },
        },
      },
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("type definition follows the explicit signature type value", async () => {
  const service = new LanguageService();
  const uri = "untitled:type-definition.blot";
  const source = `const Point = { .x = Number; }
let point :: Point
let point = { .x = 42; }
return point
`;
  try {
    service.open(uri, source, 1);
    const expected = [{
      uri,
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 11 },
      },
    }];
    assertEquals(
      await service.typeDefinition(uri, { line: 3, character: 8 }),
      expected,
    );
    assertEquals(
      await service.typeDefinition(uri, { line: 1, character: 15 }),
      expected,
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("type definition follows a qualified type value across an import", async () => {
  const directory = await Deno.makeTempDir();
  const libraryPath = join(directory, "types.blot");
  const mainPath = join(directory, "main.blot");
  const librarySource = `const Point = { .x = Number; }
return { .Point = Point; }
`;
  const mainSource = `const Types = import "./types.blot"
let point :: Types.Point
let point = { .x = 42; }
return point
`;
  await Deno.writeTextFile(libraryPath, librarySource);
  await Deno.writeTextFile(mainPath, mainSource);
  const libraryUri = toFileUrl(libraryPath).href;
  const mainUri = toFileUrl(mainPath).href;
  const service = new LanguageService();
  try {
    service.open(libraryUri, librarySource, 1);
    service.open(mainUri, mainSource, 1);
    assertEquals(
      await service.typeDefinition(mainUri, { line: 3, character: 8 }),
      [{
        uri: libraryUri,
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
      }],
    );
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

Deno.test("idiom and array-cost rewrites preserve the checked interface", async () => {
  const service = new LanguageService();
  const uri = "untitled:idiom-rewrites.blot";
  const source = `open import "blot:prelude"
let identity :: Bool -> Bool
let identity = fn flag => do:
  if flag:
    return #True
  else:
    return #False
let same :: Bool -> Int
let same = fn flag => do:
  if flag:
    return 1
  else:
    return 1
let pushed :: [Int]
let pushed = Array.append [1] [2]
let unchanged :: [Int]
let unchanged = Array.append [1] []
return (identity #True, same #True, pushed, unchanged)
`;
  try {
    service.open(uri, source, 1);
    const actions = await service.codeActions(uri, {
      start: { line: 0, character: 0 },
      end: { line: 18, character: 56 },
    });
    assertEquals(actions.map((action) => action.title), [
      "Return the Boolean condition directly",
      "Replace identical branches with their value",
      "Replace singleton append with `Array.push`",
      "Remove empty array append",
    ]);
  } finally {
    await service.destroy();
  }
});

Deno.test("control-flow flattening actions preserve the checked interface", async () => {
  const service = new LanguageService();
  const uri = "untitled:control-flow-lints.blot";
  const source = `open import "blot:prelude"
let increment :: Int -> Int
let increment = fn value => do:
  return value + 1
let label :: Int -> Text
let label = fn value => do:
  if value == 0:
    return "zero"
  else:
    return "other"
return (increment, label)
`;
  try {
    service.open(uri, source, 1);
    const actions = await service.codeActions(uri, {
      start: { line: 0, character: 0 },
      end: { line: 10, character: 25 },
    });
    const redundantDo = actions.find((action) =>
      action.title === "Remove redundant `do:` block"
    );
    assertEquals(
      redundantDo?.edit.documentChanges[0].edits[0]?.newText,
      "(value + 1)\n",
    );
    const redundantElse = actions.find((action) =>
      action.title === "Remove redundant terminal `else`"
    );
    assertEquals(
      redundantElse?.edit.documentChanges[0].edits[0]?.newText,
      `if value == 0:
    return "zero"
  return "other"
`,
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("compiler readability facts publish checked source actions", async () => {
  const service = new LanguageService();
  const uri = "untitled:readability-facts.blot";
  const source = `const run = fn () => 1
let direct = fn () => do:
  use value <- run ()
  return value
const Arrays = { .empty = @array.empty; }
let empty = Arrays.empty
let count = 0
let initial = count
let count = @int.add initial 1
let source = { .first = 1; .second = 2; .third = 3; }
let rebuilt = {
  .first = source.first;
  .second = count;
  .third = source.third;
}
const First = { .chosen = 1; .other = 2; }
const Second = { .chosen = 3; }
open First
open Second
let selected = chosen
open { .ignored = 4; }
return (direct, empty, initial, rebuilt, selected)
`;
  try {
    service.open(uri, source, 1);
    const diagnostics = await service.diagnostics(uri);
    assert(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "BLOT_LINT_OPEN_SHADOW"
      ),
      "missing compiler-proved open-shadow diagnostic",
    );
    const actions = await service.codeActions(uri, {
      start: { line: 0, character: 0 },
      end: { line: 22, character: 53 },
    });
    const titles = actions.map((action) => action.title);
    for (
      const title of [
        "Return computation directly",
        "Replace with empty array literal",
        "Rebind `count` with `:=`",
        "Spread `source` instead of copying its fields",
      ]
    ) {
      assert(titles.includes(title), `missing readability action: ${title}`);
    }
    assertEquals(
      titles.filter((title) => title === "Remove unused `open`").length,
      2,
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("runtime loop fields publish no stale readability actions", async () => {
  const service = new LanguageService();
  const uri = "untitled:runtime-readability-provenance.blot";
  const source = `open import "blot:prelude"
let state = {
  .items = [];
  .source = { .first = 0; .second = 0; };
}
for value in Iter.items [1, 2]:
  state := {
    .items = [...state.items, value];
    .source = { .second = value; .first = value; };
  }
let rebuilt = { .first = state.source.first; .second = state.source.second; }
return (state.items, rebuilt)
`;
  try {
    service.open(uri, source, 1);
    const actions = await service.codeActions(uri, {
      start: { line: 0, character: 0 },
      end: { line: 11, character: 29 },
    });
    const titles = actions.map((action) => action.title);
    assertEquals(titles.includes("Replace with empty array literal"), false);
    assertEquals(
      titles.some((title) => title.startsWith("Spread `state.source`")),
      false,
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("conjoined equality checks publish a checked decision-matrix rewrite", async () => {
  const service = new LanguageService();
  const uri = "untitled:conjoined-equality-case.blot";
  const source = `open import "blot:prelude"
const Host = @effect.host {
  .x = Unit -> Int;
  .y = Unit -> Int;
}
use x <- Host.x ()
use y <- Host.y ()
return case x == 0 && y == 0 of
  #True => "origin"
  #False => "elsewhere"
`;
  try {
    service.open(uri, source, 1);
    const actions = await service.codeActions(uri, {
      start: { line: 7, character: 0 },
      end: { line: 9, character: 24 },
    });
    const action = actions.find((candidate) =>
      candidate.title === "Match the compared values directly"
    );
    assertEquals(
      action?.edit.documentChanges[0].edits[0]?.newText,
      `case x, y of
  0, 0 => "origin"
  _, _ => "elsewhere"`,
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("a shadowed equality spelling publishes no decision-matrix rewrite", async () => {
  const service = new LanguageService();
  const uri = "untitled:shadowed-equality-case.blot";
  const source =
    `const not_greater = fn left => fn right => case @int.cmp left right of
  #Less => #True
  #Equal => #True
  #Greater => #False
const Int = { .eq = not_greater; }
let classify = fn value => case value == 0 of
  #True => "not greater"
  #False => "greater"
return classify
`;
  try {
    service.open(uri, source, 1);
    const actions = await service.codeActions(uri, {
      start: { line: 6, character: 0 },
      end: { line: 8, character: 21 },
    });
    assertEquals(
      actions.some((action) =>
        action.title === "Match the compared values directly"
      ),
      false,
    );
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

Deno.test("an unproved array lookup does not publish a direct access hint", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "unproved-lookup.blot");
  const source = `open import "blot:prelude"
let at = fn (values, index) => case Array.get (values, index) of
  #Some value => value
  #None => 0
return at
`;
  await Deno.writeTextFile(path, source);
  const uri = toFileUrl(path).href;
  const service = new LanguageService();
  try {
    service.open(uri, source, 1);
    const diagnostics = await service.diagnostics(uri);
    assert(
      !diagnostics.some((diagnostic) =>
        diagnostic.code === "BLOT_LINT_PROVED_ARRAY_LOOKUP"
      ),
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
  use ignored <- perform_work ()
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
    assertEquals(action?.edit.documentChanges[0].edits[0]?.newText, "");
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
