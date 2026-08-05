import { assertEquals } from "@std/assert";
import { parse } from "../syntax/parse.ts";
import { formatSource } from "./formatter.ts";

Deno.test("formatting applies structural indentation without losing comments", async () => {
  const source = `// choose a label
let choose = fn n => if n == 1 then "one"
else "other"
return choose 1
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    `// choose a label
let choose = fn n => if n == 1 then "one" else "other"
return choose 1
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
  assertEquals(
    semanticTree(await parse(formatted.source)),
    semanticTree(await parse(source)),
  );
});

Deno.test("formatting keeps a conditional on one line within 80 columns", async () => {
  const source = `const minimum = fn (left, right) => if left < right then left
else right
return minimum
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    `const minimum = fn (left, right) => if left < right then left else right
return minimum
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
  assertEquals(
    semanticTree(await parse(formatted.source)),
    semanticTree(await parse(source)),
  );
});

Deno.test("formatting expands a long lambda conditional by scope", async () => {
  const source =
    `const chooseMinimum = fn (veryLongLeftValue, veryLongRightValue) => if veryLongLeftValue < veryLongRightValue then veryLongLeftValue else veryLongRightValue
return chooseMinimum
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    `const chooseMinimum = fn (veryLongLeftValue, veryLongRightValue) =>
  return if veryLongLeftValue < veryLongRightValue then
    return veryLongLeftValue
  else
    return veryLongRightValue
return chooseMinimum
`,
  );
  for (const line of formatted.source.split("\n")) {
    if (line.length > 80) {
      throw new Error(`formatted line is ${line.length} columns: ${line}`);
    }
  }
  assertEquals(await formatSource(formatted.source), formatted);
  assertEquals(
    semanticTree(await parse(formatted.source)),
    semanticTree(await parse(source)),
  );
});

Deno.test("formatting indents nested conditionals within calls", async () => {
  const source = `const remove_residence = fn tile =>
  present <- Residences.has tile
  if present > 0:
    burning <- ResidenceBurning.get_or (tile, 0)
    population <- Population.get_or (editor_entity, 0)
    burning_count <- BurningCount.get_or (editor_entity, 0)
    _ <- Population.set (editor_entity, if population > 0 then population - 1
    else 0)
    _ <- BurningCount.set (editor_entity, if burning > 0 then if burning_count > 0 then burning_count - 1
    else 0
    else burning_count)
    _ <- Residences.remove tile
  return ()
return remove_residence
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
    _ <- Population.set (
      editor_entity,
      if population > 0 then population - 1 else 0
    )
    _ <- BurningCount.set (
      editor_entity,
      if burning > 0 then
        return if burning_count > 0 then burning_count - 1 else 0
      else
        return burning_count
    )
    _ <- Residences.remove tile
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
    `const World = Ecs.indexed_world {
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

Deno.test("formatting keeps a complete short array on one line", async () => {
  const source = `let components = [Terrain,
  Construction]
return components
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    `let components = [Terrain, Construction]
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
    `const choose = fn value =>
  return ${overflowingLambdaBody}
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
    `let values = [
  ${overflowingElement}
]
return values
`,
  );
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
let values = [
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
    `let values = [
  // the first component must remain first
  firstComponent,
  secondComponent
]
let pair = (
  firstComponent, // retained on the left
  secondComponent
)
return (values, pair)
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
    const repeated = await formatSource(formatted.source);
    assertEquals(repeated, formatted, `${path} changed on a second format`);
  }
});

Deno.test("formatting refuses source the compiler cannot parse", async () => {
  const formatted = await formatSource(`let value = 1
`);
  if (formatted.ok) throw new Error("invalid source formatted successfully");
  assertEquals(formatted.diagnostics[0]?.code, "BLOT_MISSING_RESULT");
});

Deno.test("formatting removes only precedence-redundant parentheses", async () => {
  const source = `let imported = (@import "module") ()
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
    `let imported = @import "module" ()
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
return nested
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
return result
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(
    formatted.source,
    `let result =
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
  _ <- effect ()
return ()
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(
    formatted.source,
    `const sum = fn (left, right) => left + right
if sum (1, 2) == 3:
  _ <- effect ()
return ()
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
return outer
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(formatted.source, source);
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
    if (key !== "span") tree[key] = semanticTree(field);
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
