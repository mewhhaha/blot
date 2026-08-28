import { assertEquals } from "@std/assert";
import { parse } from "../syntax/parse.ts";
import { formatSource } from "./formatter.ts";

Deno.test("formatting preserves computed shape fields", async () => {
  const source = `const name = "count"
return { .[name] = 1; }
`;
  assertEquals(await formatSource(source), { ok: true, source });
});

Deno.test("formatting indents nested conditionals within calls", async () => {
  const source = `const remove_residence = fn tile => do:
  use present <- Residences.has tile
  if present > 0:
    use burning <- ResidenceBurning.get_or (tile, 0)
    use population <- Population.get_or (editor_entity, 0)
    use burning_count <- BurningCount.get_or (editor_entity, 0)
    use Population.set (
      editor_entity,
      case population > 0 of
        #True => population - 1
        #False => 0
    )
    use BurningCount.set (
      editor_entity,
      case burning > 0 of
        #True => case burning_count > 0 of
          #True => burning_count - 1
          #False => 0

        #False => burning_count
    )
    use Residences.remove tile

  return ()
return remove_residence
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    `const remove_residence = fn tile => do:
  use present <- Residences.has tile
  if present > 0:
    use burning <- ResidenceBurning.get_or (tile, 0)
    use population <- Population.get_or (editor_entity, 0)
    use burning_count <- BurningCount.get_or (editor_entity, 0)
    use Population.set (
      editor_entity,
      case population > 0 of
        #True => population - 1
        #False => 0
    )
    use BurningCount.set (
      editor_entity,
      case burning > 0 of
        #True => case burning_count > 0 of
          #True => burning_count - 1
          #False => 0

        #False => burning_count
    )
    use Residences.remove tile

  return ()
return remove_residence
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
  assertEquals(
    semanticTree(await parse(formatted.source)),
    semanticTree(await parse(source)),
  );
});

Deno.test("formatting places each long array element on its own line", async () => {
  const source = `const World = Ecs.indexed_world {
  .base = 0;
  .capacity = MapScene.tile_count + unit_capacity + 1;
  .components = [Terrain, Construction, Residence, UnitMovement, UnitActivity,
    EditorState, SimulationClock, SimulationCursors, CityStats,
  CityInfrastructure];
}
return World
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    `const World =
  Ecs.indexed_world {
    .base = 0;
    .capacity = MapScene.tile_count + unit_capacity + 1;
    .components = [
      Terrain,
      Construction,
      Residence,
      UnitMovement,
      UnitActivity,
      EditorState,
      SimulationClock,
      SimulationCursors,
      CityStats,
      CityInfrastructure
    ];
  }
return World
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
  assertEquals(
    semanticTree(await parse(formatted.source)),
    semanticTree(await parse(source)),
  );
});

Deno.test("formatting moves an existing multiline array into its value scope", async () => {
  const source = `let components = [Terrain,
  Construction]
return components
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    `let components =
  [Terrain, Construction]
return components
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
  assertEquals(
    semanticTree(await parse(formatted.source)),
    semanticTree(await parse(source)),
  );
});

Deno.test("formatting changes layout only after the 80-column boundary", async () => {
  const lambdaPrefix = "const choose = fn value => ";
  const fittingLambdaBody = "x".repeat(80 - lambdaPrefix.length);
  const overflowingLambdaBody = `${fittingLambdaBody}x`;

  await assertStableFormatting(
    `${lambdaPrefix}${fittingLambdaBody}\nreturn choose\n`,
    `${lambdaPrefix}${fittingLambdaBody}\nreturn choose\n`,
  );
  await assertStableFormatting(
    `${lambdaPrefix}${overflowingLambdaBody}\nreturn choose\n`,
    `const choose =
  fn value => ${overflowingLambdaBody}
return choose
`,
  );

  const arrayPrefix = "let values = ";
  const fittingElement = "x".repeat(
    80 - arrayPrefix.length - "[]".length,
  );
  const overflowingElement = `${fittingElement}x`;
  await assertStableFormatting(
    `${arrayPrefix}[${fittingElement}]\nreturn values\n`,
    `${arrayPrefix}[${fittingElement}]\nreturn values\n`,
  );
  await assertStableFormatting(
    `${arrayPrefix}[${overflowingElement}]\nreturn values\n`,
    `let values =
  [${overflowingElement}]
return values
`,
  );

  const returnPrefix = "return ";
  const fittingReturnValue = "x".repeat(
    80 - returnPrefix.length,
  );
  const overflowingReturnValue = `${fittingReturnValue}x`;
  await assertStableFormatting(
    `${returnPrefix}${fittingReturnValue}\n`,
    `${returnPrefix}${fittingReturnValue}\n`,
  );
  await assertStableFormatting(
    `${returnPrefix}${overflowingReturnValue}\n`,
    `return
  ${overflowingReturnValue}
`,
  );
});

Deno.test("formatting preserves a reuse assertion tag", async () => {
  await assertStableFormatting(
    `@[assert.reuse]
const clear = fn values => @array.set values 0 0
return clear
`,
    `@[assert.reuse]
const clear = fn values => @array.set values 0 0
return clear
`,
  );
});

Deno.test("formatting aligns a recursive signature with its binding", async () => {
  await assertStableFormatting(
    `let rec factorial ::
  Int -> Int
let rec factorial = fn value => value
return factorial
`,
    `let rec factorial :: Int -> Int
let rec factorial = fn value => value

return factorial
`,
  );
});

Deno.test("formatting moves a multiline signature into its value scope", async () => {
  await assertStableFormatting(
    `const fold :: @forall (fn T => @forall (fn S => do:
    return ([T], S, (S, T) -> S) -> S
  ))
const fold = fn values => values
return fold
`,
    `const fold ::
  @forall (fn T => @forall (fn S => do:
    return ([T], S, (S, T) -> S) -> S
  ))
const fold = fn values => values
return fold
`,
  );
});

Deno.test("formatting normalizes a signature's nested scope", async () => {
  await assertStableFormatting(
    `const fold ::
  @forall (fn T => @forall (fn S => do:
      return ([T], S, (S, T) -> S) -> S
    ))
const fold = fn values => values
return fold
`,
    `const fold ::
  @forall (fn T => @forall (fn S => do:
    return ([T], S, (S, T) -> S) -> S
  ))
const fold = fn values => values
return fold
`,
  );
});

Deno.test("formatting indents a signature's expression continuation", async () => {
  await assertStableFormatting(
    `const replace ::
  @forall (fn T => do:
      return T ->
          (#Replaced T |
           #Missing)
    )
const replace = fn value => value
return replace
`,
    `const replace ::
  @forall (fn T => do:
    return T ->
      (#Replaced T |
        #Missing)
  )
const replace = fn value => value
return replace
`,
  );
});

Deno.test("formatting aligns a closing delimiter before an expression suffix", async () => {
  await assertStableFormatting(
    `const consume :: ({
    .value = Int;
    } -> Unit)
const consume = fn value => ()
return consume
`,
    `const consume ::
  ({
    .value = Int;
  } -> Unit)
const consume = fn value => ()
return consume
`,
  );
});

Deno.test("formatting keeps a signature attached to its binding", async () => {
  await assertStableFormatting(
    `let value :: Int

let value = 1
return value
`,
    `let value :: Int
let value = 1
return value
`,
  );
});

Deno.test("formatting separates a recursive group from its following declaration", async () => {
  await assertStableFormatting(
    `let rec even :: Int -> Bool
let rec even = fn value => odd value

let rec odd :: Int -> Bool
let rec odd = fn value => even value
let answer = even 0
return answer
`,
    `let rec even :: Int -> Bool
let rec even = fn value => odd value
let rec odd :: Int -> Bool
let rec odd = fn value => even value

let answer = even 0
return answer
`,
  );
});

Deno.test("formatting indents a separated return inside a colon block", async () => {
  const returnedValue = "x".repeat(70);
  const source = `let choose = fn ready => do:
  if ready:
    return ${returnedValue}
  return fallback
return choose
`;
  const expected = `let choose = fn ready => do:
  if ready:
    return
      ${returnedValue}

  return fallback
return choose
`;
  await assertStableFormatting(source, expected);
});

Deno.test("formatting keeps nested arrays and spreads structurally clear", async () => {
  const source = `let empty = []
let singleton = [only]
let values = [firstComponent, [secondComponent, thirdComponent], ...remainingComponents, fourthComponent, fifthComponent]
return (empty, singleton, values)
`;

  await assertStableFormatting(
    source,
    `let empty = []
let singleton = [only]
let values =
  [
    firstComponent,
    [secondComponent, thirdComponent],
    ...remainingComponents,
    fourthComponent,
    fifthComponent
  ]
return (empty, singleton, values)
`,
  );
});

Deno.test("formatting preserves comments inside arrays and tuples", async () => {
  const source = `let values = [
 // the first component must remain first
 firstComponent,
 secondComponent
]
let pair = (
 firstComponent, // retained on the left
 secondComponent
)
return (values, pair)
`;

  await assertStableFormatting(
    source,
    `let values =
  [
    // the first component must remain first
    firstComponent,
    secondComponent
  ]
let pair =
  (
    firstComponent, // retained on the left
    secondComponent
  )
return (values, pair)
`,
  );
});

Deno.test("formatting removes parentheses around a tuple lambda argument", async () => {
  const source = `let load = fn count => do:
  use store <- fold (
  upto (0, count),
  @array.empty,
  (fn (store, id) => do:
    return append (store, id)
  )
  )
  return store
return load
`;

  await assertStableFormatting(
    source,
    `let load = fn count => do:
  use store <- fold (
    upto (0, count),
    @array.empty,
    fn (store, id) => do:
      return append (store, id)
  )
  return store
return load
`,
  );
});

Deno.test("formatting aligns a vertical call delimiter with its expression", async () => {
  const source = `let draw = fn values => do:
  use each (
  values,
  (fn value => do:
    use visit value
  )
  )
return draw
`;

  await assertStableFormatting(
    source,
    `let draw = fn values => do:
  use each (
    values,
    fn value => do:
      use visit value
  )
return draw
`,
  );
});

Deno.test("formatting separates a multiline case arm from the next arm", async () => {
  await assertStableFormatting(
    `let unwrap = fn candidate => case candidate of
  #Some value => do:
    let selected = value
    return selected
  #None => 0
return unwrap
`,
    `let unwrap = fn candidate => case candidate of
  #Some value => do:
    let selected = value
    return selected

  #None => 0
return unwrap
`,
  );
});

Deno.test("formatting preserves multi-subject case columns", async () => {
  await assertStableFormatting(
    `return case first, second of
  #True, _ => 1
  #False, value => value
`,
    `return case first, second of
  #True, _ => 1
  #False, value => value
`,
  );
});

Deno.test("formatting closes a vertical record outside its fields", async () => {
  await assertStableFormatting(
    `const Namespace = {
  .empty = [];
  .append = fn left => fn right => left;
  }
return Namespace
`,
    `const Namespace =
  {
    .empty = [];
    .append = fn left => fn right => left;
  }
return Namespace
`,
  );
});

Deno.test("formatting reports the removed operator section", async () => {
  const formatted = await formatSource(`operators {
  infix 30 (!=) = Int.ne;
}

open import "blot:prelude"
return 1 != 2
`);
  if (formatted.ok) throw new Error("removed syntax formatted successfully");
  assertEquals(formatted.diagnostics[0]?.code, "BLOT_REMOVED_OPERATOR_SECTION");
});

Deno.test("formatting separates a completed statement suite", async () => {
  await assertStableFormatting(
    `let update = fn generation => do:
  use current <- Generation.current ()
  if current != generation:
    use transforms <- load_transforms ()
    use models <- load_models ()
    generation := current
  transforms := advance transforms
  return transforms
return update
`,
    `let update = fn generation => do:
  use current <- Generation.current ()
  if current != generation:
    use transforms <- load_transforms ()
    use models <- load_models ()
    generation := current

  transforms := advance transforms
  return transforms
return update
`,
  );
});

Deno.test("formatting attaches a dedented comment to the following statement", async () => {
  await assertStableFormatting(
    `let update = fn generation => do:
  if current != generation:
    generation := current
    // Advance the current generation.
  transforms := advance transforms
  return transforms
return update
`,
    `let update = fn generation => do:
  if current != generation:
    generation := current

  // Advance the current generation.
  transforms := advance transforms
  return transforms
return update
`,
  );
});

Deno.test("formatting normalizes line endings and trailing whitespace", async () => {
  await assertStableFormatting(
    "let value = [first, second]  \r\nreturn value\t\r\n\r\n",
    `let value = [first, second]
return value
`,
  );
});

Deno.test("formatting prefers use without a discarded binding", async () => {
  const canonical = `use perform_work ()
return ()
`;
  const explicit = `use _ <- perform_work ()
return ()
`;
  assertEquals(
    semanticTree(await parse(canonical)),
    semanticTree(await parse(explicit)),
  );
  assertEquals(await formatSource(canonical), { ok: true, source: canonical });
  assertEquals(await formatSource(explicit), { ok: true, source: canonical });
});

Deno.test("formatting preserves sequencing patterns", async () => {
  const source = `use (left, right) <- read_pair ()
return left + right
`;
  assertEquals(await formatSource(source), { ok: true, source });
});

Deno.test("formatting the accepted corpus is idempotent", async () => {
  const pendingDirectories = ["examples", "src/prelude", "case-studies"];
  const sources: string[] = [];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    if (directory === undefined) break;
    for await (const entry of Deno.readDir(directory)) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory) {
        if (path !== "examples/rejected") pendingDirectories.push(path);
        continue;
      }
      if (entry.isFile && path.endsWith(".blot")) sources.push(path);
    }
  }
  if (sources.length === 0) throw new Error("accepted corpus has no sources");

  for (const path of sources.sort()) {
    const source = await Deno.readTextFile(path);
    const formatted = await formatSource(source);
    if (!formatted.ok) {
      const codes = formatted.diagnostics.map((diagnostic) => diagnostic.code);
      throw new Error(`${path} did not format: ${codes.join(", ")}`);
    }
    assertEquals(formatted.source, source, `${path} needs formatting`);
    const repeated = await formatSource(formatted.source);
    assertEquals(repeated, formatted, `${path} changed on a second format`);
  }
});

Deno.test("formatting accepts a module that falls through to unit", async () => {
  const formatted = await formatSource(`let value = 1
`);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(formatted.source, "let value = 1\n");
});

Deno.test("formatting keeps rec on the binding header", async () => {
  const source = `let rec factorial = fn n => factorial n
return factorial
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("recursive binding did not format");
  assertEquals(
    formatted.source,
    `let rec factorial = fn n => factorial n

return factorial
`,
  );
});

Deno.test("formatting removes only precedence-redundant parentheses", async () => {
  const source = `let imported = import "module"
let atom = (1)
let left = (apply 1) 2
let right = apply (apply 1)
let grouped = (1 + 2) * 3
return (imported, atom, left, right, grouped)
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(
    formatted.source,
    `let imported = import "module"
let atom = 1
let left = apply 1 2
let right = apply (apply 1)
let grouped = (1 + 2) * 3
return (imported, atom, left, right, grouped)
`,
  );
  assertEquals(
    semanticTree(await parse(formatted.source)),
    semanticTree(await parse(source)),
  );
});

Deno.test("formatting retains interacting parentheses when flattening changes application", async () => {
  const source = `let nested = apply ((apply 1))
let called = (fn value => value) 1
return (nested, called)
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(formatted.source, source);
});

Deno.test("formatting indents scoped returns as statements", async () => {
  const source = `let result = do:
 if 1 == 1:
  return 1
 return 2
return result
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(
    formatted.source,
    `let result = do:
  if 1 == 1:
    return 1

  return 2
return result
`,
  );
});

Deno.test("formatting joins a short layout-significant continuation", async () => {
  const source = `const sum = fn (left, right) => left
  + right
if sum (1, 2) == 3:
  use effect ()

return ()
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(
    formatted.source,
    `const sum = fn (left, right) => left + right
if sum (1, 2) == 3:
  use effect ()

return ()
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
});

Deno.test("formatting does not extend a nested function over following statements", async () => {
  const source = `let outer = fn values => do:
  let inner = fn () => do:
    return ()
  for value in values:
    let selected = value
  return inner
return outer
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(
    formatted.source,
    `let outer = fn values => do:
  let inner = fn () => do:
    return ()
  for value in values:
    let selected = value

  return inner
return outer
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
});

function semanticTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticTree);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === null) return value;

  const record = value as Record<string, unknown>;
  if (
    record.tag === "block" && Array.isArray(record.declarations) &&
    record.declarations.length === 0
  ) {
    return semanticTree(record.result);
  }

  const tree: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(record)) {
    if (key === "span") continue;
    if (key === "name" && typeof field === "string") {
      tree[key] = field.replace(/\$[0-9]+/g, "$span");
      continue;
    }
    tree[key] = semanticTree(field);
  }
  return tree;
}

async function assertStableFormatting(
  source: string,
  expected: string,
): Promise<void> {
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(formatted.source, expected);
  assertEquals(await formatSource(formatted.source), formatted);
  assertEquals(
    semanticTree(await parse(formatted.source)),
    semanticTree(await parse(source)),
  );
}

Deno.test("formatting preserves explicit do block scope", async () => {
  const source = `let value = do:
    let local = 1
    return local
return value
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid do block did not format");
  assertEquals(
    formatted.source,
    `let value = do:
  let local = 1
  return local
return value
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
});
