import { assertEquals } from "@std/assert";
import { parseConcrete } from "../syntax/parse.ts";
import { formatSource } from "./formatter.ts";

Deno.test("formatting applies structural indentation without losing comments", async () => {
  const source = `// choose a label
let choose = fn n => if n == 1 : "one"
else: "other"
return choose 1
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    `// choose a label
let choose = fn n =>
  if n == 1:
    return "one"
  else:
    return "other"
return choose 1
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
  assertEquals(
    await formatterTree(formatted.source),
    await formatterTree(source),
  );
});

Deno.test("formatting writes a short conditional vertically", async () => {
  const source = `const minimum = fn (left, right) => if left < right : left
else: right
return minimum
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    `const minimum = fn (left, right) =>
  if left < right:
    return left
  else:
    return right
return minimum
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
  assertEquals(
    await formatterTree(formatted.source),
    await formatterTree(source),
  );
});

Deno.test("formatting removes a redundant return around a terminal conditional", async () => {
  const source = `let choose = fn ready =>
  let fallback = 2
  return if ready:
    let selected = 1
    return selected
  else:
    return fallback
return choose
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    `let choose = fn ready =>
  let fallback = 2
  if ready:
    let selected = 1
    return selected
  else:
    return fallback
return choose
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
  assertEquals(
    await formatterTree(formatted.source),
    await formatterTree(source),
  );
});

Deno.test("formatting keeps following comments outside value branches", async () => {
  const source = `let choose = fn n => if n == 1: case n of
  1 => "one"
else: case n of
  _ => "other"

// This documents the next binding.
let selected = choose 1
return selected
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    `let choose = fn n => if n == 1:
  return case n of
    1 => "one"
else:
  return case n of
    _ => "other"

// This documents the next binding.
let selected = choose 1
return selected
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
  assertEquals(
    await formatterTree(formatted.source),
    await formatterTree(source),
  );
});

Deno.test("formatting expands a long lambda conditional by scope", async () => {
  const source =
    `const chooseMinimum = fn (veryLongLeftValue, veryLongRightValue) => if veryLongLeftValue < veryLongRightValue : veryLongLeftValue else: veryLongRightValue
return chooseMinimum
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    `const chooseMinimum =
  fn (veryLongLeftValue, veryLongRightValue) =>
    if veryLongLeftValue < veryLongRightValue:
      return veryLongLeftValue
    else:
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
    await formatterTree(formatted.source),
    await formatterTree(source),
  );
});

Deno.test("formatting indents nested conditionals within calls", async () => {
  const source = `const remove_residence = fn tile =>
  present <- Residences.has tile
  if present > 0:
    burning <- ResidenceBurning.get_or (tile, 0)
    population <- Population.get_or (editor_entity, 0)
    burning_count <- BurningCount.get_or (editor_entity, 0)
    <- Population.set (editor_entity, if population > 0 : population - 1
    else: 0)
    <- BurningCount.set (editor_entity, if burning > 0 : if burning_count > 0 : burning_count - 1
    else: 0
    else: burning_count)
    <- Residences.remove tile

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
    <- Population.set (
        editor_entity,
        if population > 0:
          return population - 1
        else:
          return 0
      )
    <- BurningCount.set (
        editor_entity,
        if burning > 0:
          if burning_count > 0:
            return burning_count - 1
          else:
            return 0
        else:
          return burning_count
      )
    <- Residences.remove tile

  return ()
return remove_residence
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
  assertEquals(
    await formatterTree(formatted.source),
    await formatterTree(source),
  );
});

Deno.test("formatting separates delimiters after an element property conditional", async () => {
  const source = `let render = fn state =>
  <- <Object .material={material (color (180000, 850000, 1000000), if state == 3: 800000 else: 250000)} />
  return ()
return render
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    `let render = fn state =>
  <- <Object .material={material (
      color (180000, 850000, 1000000),
      if state == 3:
        return 800000
      else:
        return 250000
    )
  } />
  return ()
return render
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
  assertEquals(
    await formatterTree(formatted.source),
    await formatterTree(source),
  );
});

Deno.test("formatting indents suspended element children under their parent", async () => {
  const source = `let render = fn () =>
  viewport <- Viewport.current ()
  <- <Camera .projection={perspective} .zoom=1000000>
    <MeshResource .id=0 .url="/assets/cube.obj" />
    <DirectionalLight
      .color={color (1000000, 940000, 820000)}
      .intensity=850000
    />
    <Object
      .id=0
      .transform={transform (
        vec3 (0, 0, 0),
        uniform_scale 1100000
      )}
    />
  </Camera>
  return ()
return render
`;
  assertEquals(await formatSource(source), { ok: true, source });
});

Deno.test("formatting preserves inline stored effects as element children", async () => {
  const source = `let first = <A />
let second = <B />
let parent = <C>{first}{second}</C>
return parent
`;
  assertEquals(await formatSource(source), { ok: true, source });
});

Deno.test("formatting gives a multiline element binding its own value scope", async () => {
  const source = `let view = fn () =>
  let effect1 = <A />
  let effect2 = <B />
  let parent = <C>
    {effect1}
    {effect2}
  </C>
  return parent
return view
`;
  const expected = `let view = fn () =>
  let effect1 = <A />
  let effect2 = <B />
  let parent =
    <C>
      {effect1}
      {effect2}
    </C>
  return parent
return view
`;
  assertEquals(await formatSource(source), { ok: true, source: expected });
  assertEquals(await formatSource(expected), { ok: true, source: expected });
});

Deno.test("formatting aligns a tagged binding with its tag", async () => {
  const source = `@[tag ("identity", (), identity)]
  const factorial =
  rec (fn n =>
    if n == 0:
      return 1
    else:
      return n * factorial (n - 1)
  )
return factorial
`;

  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");

  assertEquals(
    formatted.source,
    `@[tag ("identity", (), identity)]
const factorial =
  rec (fn n =>
    if n == 0:
      return 1
    else:
      return n * factorial (n - 1)
  )
return factorial
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
  assertEquals(
    await formatterTree(formatted.source),
    await formatterTree(source),
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
    await formatterTree(formatted.source),
    await formatterTree(source),
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
    await formatterTree(formatted.source),
    await formatterTree(source),
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

Deno.test("formatting indents a separated return inside a colon block", async () => {
  const returnedValue = "x".repeat(70);
  const source = `let choose = fn ready =>
  if ready:
    return ${returnedValue}
  return fallback
return choose
`;
  const expected = `let choose = fn ready =>
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
  const source = `let load = fn count =>
  store <- fold (
  upto (0, count),
  @array.empty,
  (fn (store, id) =>
    return append (store, id)
  )
  )
  return store
return load
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
return load
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
return draw
`;

  await assertStableFormatting(
    source,
    `let draw = fn values =>
  <- each (
      values,
      fn value =>
        <- visit value
    )
return draw
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

Deno.test("formatting closes an operator section outside its declarations", async () => {
  await assertStableFormatting(
    `operators {
  infix 30 (!=) = Eq.ne;
  }

open @import "blot:prelude" ()
return 1 != 2
`,
    `operators {
  infix 30 (!=) = Eq.ne;
}

open @import "blot:prelude" ()
return 1 != 2
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
return update
`,
    `let update = fn generation =>
  current <- Generation.current ()
  if current != generation:
    transforms <- load_transforms ()
    models <- load_models ()
    generation := current

  transforms := advance transforms
  return transforms
return update
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
return update
`,
    `let update = fn generation =>
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

Deno.test("formatting prefers leading discard sequencing", async () => {
  const sugared = `<- perform_work ()
return ()
`;
  const explicit = `_ <- perform_work ()
return ()
`;
  assertEquals(
    await formatterTree(sugared),
    await formatterTree(explicit),
  );
  assertEquals(await formatSource(sugared), { ok: true, source: sugared });
  assertEquals(await formatSource(explicit), { ok: true, source: sugared });
});

Deno.test("formatting prefers leading discard in handler composition", async () => {
  const source = `let result = try program with
  _ <- @handle (Console, console_handler)
  @handle (Clock, clock_handler)
return result
`;
  const expected = `let result = try program with
  <- @handle (Console, console_handler)
  @handle (Clock, clock_handler)
return result
`;
  assertEquals(await formatSource(source), { ok: true, source: expected });
  assertEquals(
    await formatterTree(source),
    await formatterTree(expected),
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
    assertEquals(formatted.source, source, `${path} needs formatting`);
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
    await formatterTree(formatted.source),
    await formatterTree(source),
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
  <- effect ()

return ()
`;
  const formatted = await formatSource(source);
  if (!formatted.ok) throw new Error("valid source did not format");
  assertEquals(
    formatted.source,
    `const sum = fn (left, right) => left + right
if sum (1, 2) == 3:
  <- effect ()

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
  assertEquals(
    formatted.source,
    `let outer = fn values =>
  let inner = fn () =>
    return ()
  for value in values:
    let selected = value

  return inner
return outer
`,
  );
  assertEquals(await formatSource(formatted.source), formatted);
});

/**
 * The formatter accepts forms the language removed so it can migrate one, so
 * its semantic comparison parses concretely: `parse` rejects the very input
 * these cases are written over.
 */
async function formatterTree(source: string): Promise<unknown> {
  const parsed = await parseConcrete(source);
  if (!parsed.ok) return semanticTree(parsed);
  return semanticTree({ ok: true, module: parsed.module });
}

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
    await formatterTree(formatted.source),
    await formatterTree(source),
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
