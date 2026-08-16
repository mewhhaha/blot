import { assertEquals } from "@std/assert";
import { parse } from "../syntax/parse.ts";
import { formatSource } from "./formatter.ts";

Deno.test("formatting indents nested conditionals within calls", async () => {
  const source = `const remove_residence = fn tile =>
  present <- Residences.has tile
  if present > 0:
    burning <- ResidenceBurning.get_or (tile, 0)
    population <- Population.get_or (editor_entity, 0)
    burning_count <- BurningCount.get_or (editor_entity, 0)
    <- Population.set (
      editor_entity,
      case population > 0 of
        #True => population - 1
        #False => 0
    )
    <- BurningCount.set (
      editor_entity,
      case burning > 0 of
        #True => case burning_count > 0 of
          #True => burning_count - 1
          #False => 0
        #False => burning_count
    )
    <- Residences.remove tile

  return ()
export remove_residence
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    `const remove_residence = fn tile =>
  present <- Residences.has tile
  if present > 0:
    burning <- ResidenceBurning.get_or (tile, 0)
    population <- Population.get_or (editor_entity, 0)
    burning_count <- BurningCount.get_or (editor_entity, 0)
    <- Population.set (
        editor_entity,
        case population > 0 of
          #True => population - 1
          #False => 0
      )
    <- BurningCount.set (
        editor_entity,
        case burning > 0 of
          #True => case burning_count > 0 of
            #True => burning_count - 1
            #False => 0
          #False => burning_count
      )
    <- Residences.remove tile

  return ()
export remove_residence
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
export World
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
export World
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
export components
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    `let components =
  [Terrain, Construction]
export components
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
    `${lambdaPrefix}${fittingLambdaBody}\nexport choose\n`,
    `${lambdaPrefix}${fittingLambdaBody}\nexport choose\n`,
  );
  await assertStableFormatting(
    `${lambdaPrefix}${overflowingLambdaBody}\nexport choose\n`,
    `const choose =
  fn value => ${overflowingLambdaBody}
export choose
`,
  );

  const arrayPrefix = "let values = ";
  const fittingElement = "x".repeat(
    80 - arrayPrefix.length - "[]".length,
  );
  const overflowingElement = `${fittingElement}x`;
  await assertStableFormatting(
    `${arrayPrefix}[${fittingElement}]\nexport values\n`,
    `${arrayPrefix}[${fittingElement}]\nexport values\n`,
  );
  await assertStableFormatting(
    `${arrayPrefix}[${overflowingElement}]\nexport values\n`,
    `let values =
  [${overflowingElement}]
export values
`,
  );

  const exportPrefix = "export ";
  const fittingExportValue = "x".repeat(
    80 - exportPrefix.length,
  );
  const overflowingExportValue = `${fittingExportValue}x`;
  await assertStableFormatting(
    `${exportPrefix}${fittingExportValue}\n`,
    `${exportPrefix}${fittingExportValue}\n`,
  );
  await assertStableFormatting(
    `${exportPrefix}${overflowingExportValue}\n`,
    `export
  ${overflowingExportValue}
`,
  );
});

Deno.test("formatting indents a separated return inside a colon block", async () => {
  const returnedValue = "x".repeat(70);
  const source = `let choose = fn ready =>
  if ready:
    return ${returnedValue}
  return fallback
export choose
`;
  const expected = `let choose = fn ready =>
  if ready:
    return
      ${returnedValue}

  return fallback
export choose
`;
  await assertStableFormatting(source, expected);
});

Deno.test("formatting keeps nested arrays and spreads structurally clear", async () => {
  const source = `let empty = []
let singleton = [only]
let values = [firstComponent, [secondComponent, thirdComponent], ...remainingComponents, fourthComponent, fifthComponent]
export (empty, singleton, values)
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
export (empty, singleton, values)
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
export (values, pair)
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
export (values, pair)
`,
  );
});

Deno.test("formatting removes parentheses around a tuple lambda argument", async () => {
  const source = `let load = fn count =>
  store <- fold (
  upto (0, count),
  @array.empty,
  (fn (store, id) =>
    return append (store, id)
  )
  )
  return store
export load
`;

  await assertStableFormatting(
    source,
    `let load = fn count =>
  store <- fold (
      upto (0, count),
      @array.empty,
      fn (store, id) =>
        return append (store, id)
    )
  return store
export load
`,
  );
});

Deno.test("formatting staggers adjacent vertical delimiters", async () => {
  const source = `let draw = fn values =>
  <- each (
  values,
  (fn value =>
    <- visit value
  )
  )
export draw
`;

  await assertStableFormatting(
    source,
    `let draw = fn values =>
  <- each (
      values,
      fn value =>
        <- visit value
    )
export draw
`,
  );
});

Deno.test("formatting closes a vertical record outside its fields", async () => {
  await assertStableFormatting(
    `const Namespace = {
  .empty = [];
  .append = fn left => fn right => left;
  }
export Namespace
`,
    `const Namespace =
  {
    .empty = [];
    .append = fn left => fn right => left;
  }
export Namespace
`,
  );
});

Deno.test("formatting closes an operator section outside its declarations", async () => {
  await assertStableFormatting(
    `operators {
  infix 30 (!=) = Eq.ne;
  }

open import "blot:prelude"
export 1 != 2
`,
    `operators {
  infix 30 (!=) = Eq.ne;
}

open import "blot:prelude"
export 1 != 2
`,
  );
});

Deno.test("formatting separates a completed statement suite", async () => {
  await assertStableFormatting(
    `let update = fn generation =>
  current <- Generation.current ()
  if current != generation:
    transforms <- load_transforms ()
    models <- load_models ()
    generation := current
  transforms := advance transforms
  return transforms
export update
`,
    `let update = fn generation =>
  current <- Generation.current ()
  if current != generation:
    transforms <- load_transforms ()
    models <- load_models ()
    generation := current

  transforms := advance transforms
  return transforms
export update
`,
  );
});

Deno.test("formatting attaches a dedented comment to the following statement", async () => {
  await assertStableFormatting(
    `let update = fn generation =>
  if current != generation:
    generation := current
    // Advance the current generation.
  transforms := advance transforms
  return transforms
export update
`,
    `let update = fn generation =>
  if current != generation:
    generation := current

  // Advance the current generation.
  transforms := advance transforms
  return transforms
export update
`,
  );
});

Deno.test("formatting normalizes line endings and trailing whitespace", async () => {
  await assertStableFormatting(
    "let value = [first, second]  \r\nexport value\t\r\n\r\n",
    `let value = [first, second]
export value
`,
  );
});

Deno.test("formatting prefers leading discard sequencing", async () => {
  const sugared = `<- perform_work ()
export ()
`;
  const explicit = `_ <- perform_work ()
export ()
`;
  assertEquals(
    semanticTree(await parse(sugared)),
    semanticTree(await parse(explicit)),
  );
  assertEquals(await formatSource(sugared), { ok: true, source: sugared });
  assertEquals(await formatSource(explicit), { ok: true, source: sugared });
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

Deno.test("formatting refuses source the compiler cannot parse", async () => {
  const formatted = await formatSource(`let value = 1
`);
  if (formatted.ok) throw new Error("invalid source formatted successfully");
  assertEquals(formatted.diagnostics[0]?.code, "BLOT_MISSING_EXPORT");
});

Deno.test("formatting removes only precedence-redundant parentheses", async () => {
  const source = `let imported = import "module"
let atom = (1)
let left = (apply 1) 2
let right = apply (apply 1)
let grouped = (1 + 2) * 3
export (imported, atom, left, right, grouped)
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
export (imported, atom, left, right, grouped)
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
export (nested, called)
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(formatted.source, source);
});

Deno.test("formatting indents scoped returns as statements", async () => {
  const source = `let result =
 if 1 == 1:
  return 1
 return 2
export result
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(
    formatted.source,
    `let result =
  if 1 == 1:
    return 1

  return 2
export result
`,
  );
});

Deno.test("formatting joins a short layout-significant continuation", async () => {
  const source = `const sum = fn (left, right) => left
  + right
if sum (1, 2) == 3:
  <- effect ()

export ()
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(
    formatted.source,
    `const sum = fn (left, right) => left + right
if sum (1, 2) == 3:
  <- effect ()

export ()
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
});

Deno.test("formatting does not extend a nested function over following statements", async () => {
  const source = `let outer = fn values =>
  let inner = fn () =>
    return ()
  for value in values:
    let selected = value
  return inner
export outer
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(
    formatted.source,
    `let outer = fn values =>
  let inner = fn () =>
    return ()
  for value in values:
    let selected = value

  return inner
export outer
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
export value
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid do block did not format");
  assertEquals(
    formatted.source,
    `let value = do:
  let local = 1
  return local
export value
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
});
