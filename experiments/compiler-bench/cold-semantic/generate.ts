// Cold-semantic fixture generator: emits Blot source only, never parses it.
//
// Usage:
//   deno run --allow-write generate.ts --components 8 --systems 8 --stages 2 \
//     --sink full --out full.blot [--framework ./framework.blot]
//   node --import tsx generate.ts ... (same flags; no runtime imports)
//
// Sinks:
//   identity      one build, identity schedule, no union (fast prefix recipe)
//   build-only    three builds, identity schedules, no union
//   schedule-only one build, three schedule compilations, no union
//   union-only    three builds plus union, identity schedules
//   full          three builds, three schedules, union, Loop.run-like runs

interface ComponentKind {
  readonly typeExpr: string;
  readonly seedExpr: string;
  readonly rowExpr: (index: string, offset: string) => string;
  readonly workExpr: (field: string) => string;
  readonly intExpr: (row: string) => string;
}

const KINDS: readonly ComponentKind[] = [
  {
    // Plain scalar counter.
    typeExpr: "Int",
    seedExpr: "0",
    rowExpr: (index, offset) => `${index} + ${offset}`,
    workExpr: (field) => `{ .${field} = read.${field} + 1; }`,
    intExpr: (row) => `${row}`,
  },
  {
    // Small record shape with two integer lanes.
    typeExpr: "{ .x = Int; .y = Int; }",
    seedExpr: "{ .x = 0; .y = 0; }",
    rowExpr: (index, offset) => `{ .x = ${index}; .y = ${index} + ${offset}; }`,
    workExpr: (field) =>
      `{ .${field} = { .x = read.${field}.x + read.${field}.y; .y = read.${field}.x - read.${field}.y; }; }`,
    intExpr: (row) => `${row}.x * 5 + ${row}.y * 7`,
  },
  {
    // Text lane observed through its length.
    typeExpr: "Text",
    seedExpr: '"seed"',
    rowExpr: (index) => `"r" <> Text.of_int ${index}`,
    workExpr: (field) => `{ .${field} = read.${field} <> "!"; }`,
    intExpr: (row) => `Text.length ${row}`,
  },
  {
    // Boolean flag observed through an exhaustive case helper.
    typeExpr: "Bool",
    seedExpr: "False",
    rowExpr: (index, offset) => `${index} == ${offset}`,
    workExpr: (field) => `{ .${field} = not (read.${field}); }`,
    intExpr: (row) => `flag_value ${row}`,
  },
];

const WORLD_TAGS = ["a", "b", "c"] as const;

type Sink = "identity" | "build-only" | "schedule-only" | "union-only" | "full";

interface Options {
  readonly components: number;
  readonly systems: number;
  readonly stages: number;
  readonly sink: Sink;
  readonly out: string;
  readonly framework: string;
}

function usage(): never {
  throw new Error(
    "usage: generate.ts --components C --systems S --stages K --sink NAME --out PATH [--framework PATH]",
  );
}

function parseOptions(args: readonly string[]): Options {
  let components = 0;
  let systems = 0;
  let stages = 0;
  let sink: Sink | null = null;
  let out: string | null = null;
  let framework = "./framework.blot";
  for (const arg of args) {
    if (arg.startsWith("--components=")) {
      components = Number(arg.slice("--components=".length));
    } else if (arg.startsWith("--systems=")) {
      systems = Number(arg.slice("--systems=".length));
    } else if (arg.startsWith("--stages=")) {
      stages = Number(arg.slice("--stages=".length));
    } else if (arg.startsWith("--sink=")) {
      const name = arg.slice("--sink=".length);
      if (
        name === "identity" || name === "build-only" ||
        name === "schedule-only" || name === "union-only" || name === "full"
      ) {
        sink = name;
      } else {
        usage();
      }
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    } else if (arg.startsWith("--framework=")) {
      framework = arg.slice("--framework=".length);
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  if (
    !Number.isSafeInteger(components) || components < 1 || components > 64 ||
    !Number.isSafeInteger(systems) || systems < 1 || systems > 64 ||
    !Number.isSafeInteger(stages) || stages < 1 || stages > systems ||
    sink === null || out === null || out.length === 0
  ) {
    usage();
  }
  return { components, systems, stages, sink, out, framework };
}

function componentName(index: number): string {
  return `C${index}`;
}

function systemName(index: number): string {
  return `s${index}`;
}

function worldSuffix(tag: string): string {
  return `_${tag}`;
}

// Split system indices into `stages` contiguous segments.
function segments(systems: number, stages: number): number[][] {
  const out: number[][] = [];
  const base = Math.floor(systems / stages);
  let extra = systems % stages;
  let next = 0;
  for (let stage = 0; stage < stages; stage += 1) {
    const size = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
    const group: number[] = [];
    for (let i = 0; i < size; i += 1) group.push(next + i);
    next += size;
    out.push(group);
  }
  return out.filter((group) => group.length > 0);
}

// A dependency chain over singleton groups: then(s0, then(s1, ...)).
function chainExpr(systems: readonly number[]): string {
  let expr = `PlanGroup ["${systemName(systems[systems.length - 1]!)}"]`;
  for (let i = systems.length - 2; i >= 0; i -= 1) {
    expr = `PlanThen (PlanGroup ["${systemName(systems[i]!)}"], ${expr})`;
  }
  return expr;
}

// Staged graph: then-chains per segment separated by barrier cuts.
function stagedGraphExpr(systems: number, stages: number): string {
  const parts: string[] = [];
  const segs = segments(systems, stages);
  segs.forEach((group, stage) => {
    parts.push(`(${chainExpr(group)})`);
    if (stage < segs.length - 1) parts.push(`(PlanBarrier "cut${stage}")`);
  });
  let expr = parts[parts.length - 1]!;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    expr = `PlanThen (${parts[i]!}, ${expr})`;
  }
  return expr;
}

function allGroupExpr(systems: number): string {
  const names = Array.from(
    { length: systems },
    (_, i) => `"${systemName(i)}"`,
  ).join(", ");
  return `PlanGroup [${names}]`;
}

function generate(options: Options): string {
  const { components, systems, stages, sink } = options;
  const worlds = sink === "identity" || sink === "schedule-only"
    ? [WORLD_TAGS[0]!]
    : [WORLD_TAGS[0]!, WORLD_TAGS[1]!, WORLD_TAGS[2]!];
  const withSchedules = sink === "schedule-only" || sink === "full";
  const withUnion = sink === "union-only" || sink === "full";

  const lines: string[] = [];
  lines.push(
    `// Generated by generate.ts --components=${components} --systems=${systems} --stages=${stages} --sink=${sink}.`,
    `// Do not hand-edit: regenerate with the recorded parameters instead.`,
    `open import "blot:prelude"`,
    `const Framework = import "${options.framework}"`,
    ``,
    `// Bind-then-apply: framework functions are bound to local consts before`,
    `// application (direct application through an import record projection`,
    `// mis-checks polymorphic definitions; see cold-semantic README).`,
    `// Functions applied to distinct row types are projected once per world:`,
    `// a single projection binding does not generalize across type arguments.`,
    `const AppNew = Framework.App.new`,
    `const AppAddPlugin = Framework.App.add_plugin`,
    `const AppAddComponent = Framework.App.add_component`,
    `const AppAddSystem = Framework.App.add_system`,
    `const PlanGroup = Framework.Plan.group`,
    `const PlanBarrier = Framework.Plan.barrier`,
    `const PlanThen = Framework.Plan.then`,
    `const PlanBefore = Framework.Plan.before`,
    `const ForceUnite = Framework.Force.unite`,
    ``,
    `const flag_value = fn flag => case flag of`,
    `  #True => 1`,
    `  #False => 0`,
    ``,
  );

  // App record pipeline: two plugins, C components, S systems.
  let app = "app0";
  lines.push(`const app0 = AppNew ()`);
  let step = 1;
  const plugins = [
    `{ .name = "core"; .priority = 0; }`,
    `{ .name = "telemetry"; .priority = 1; .labels = ["cold", "semantic"]; }`,
  ];
  for (const plugin of plugins) {
    lines.push(`const app${step} = AppAddPlugin (${app}, ${plugin})`);
    app = `app${step}`;
    step += 1;
  }
  for (let c = 0; c < components; c += 1) {
    const kind = KINDS[c % KINDS.length]!;
    lines.push(
      `const app${step} = AppAddComponent (${app}, { .name = "${
        componentName(c)
      }"; .Type = ${kind.typeExpr}; .seed = ${kind.seedExpr}; })`,
    );
    app = `app${step}`;
    step += 1;
  }
  for (let s = 0; s < systems; s += 1) {
    const field = componentName(s % components);
    const kind = KINDS[(s % components) % KINDS.length]!;
    lines.push(
      `const app${step} = AppAddSystem (${app}, { .name = "${
        systemName(s)
      }"; .read = "${field}"; .write = "${field}"; .read_type = ${kind.typeExpr}; .write_type = ${kind.typeExpr}; })`,
    );
    app = `app${step}`;
    step += 1;
  }
  lines.push(``);

  // One world build per tag, each with its own framework projections.
  for (const tag of worlds) {
    const suffix = worldSuffix(tag);
    lines.push(
      `const BuildRow${suffix} = Framework.Build.row`,
      `const SystemsFn${suffix} = Framework.Systems`,
      `const PlanCompile${suffix} = Framework.Plan.compile`,
      `const SchedFn${suffix} = Framework.Schedule`,
      `const ForceForWorld${suffix} = Framework.Force.for_world`,
      `const world${suffix} = BuildRow${suffix} (${app}, "${tag}")`,
      `const Row${suffix} = world${suffix}.Row`,
      ``,
    );
  }

  // Per-world systems, schedules, seeds, checksums, and runs.
  for (const tag of worlds) {
    const suffix = worldSuffix(tag);
    const row = `Row${suffix}`;
    lines.push(`const Systems${suffix} = SystemsFn${suffix} ${row}`);
    lines.push(`const registry${suffix} = {`);
    for (let s = 0; s < systems; s += 1) {
      const field = componentName(s % components);
      const kind = KINDS[(s % components) % KINDS.length]!;
      lines.push(
        `  .${systemName(s)} = Systems${suffix}.define (`,
        `    { .reads = [{ .name = "${field}"; .Type = ${kind.typeExpr}; }]; .writes = [{ .name = "${field}"; .Type = ${kind.typeExpr}; }]; },`,
        `    fn read => ${kind.workExpr(field)}`,
        `  );`,
      );
    }
    lines.push(`}`, ``);

    if (sink === "schedule-only") {
      // Three schedule compilations over one build: a staged chain, one
      // flat group, and before-pair chains (duplicate + distinct shapes).
      lines.push(
        `const graph${suffix}_staged = ${stagedGraphExpr(systems, stages)}`,
      );
      lines.push(`const graph${suffix}_flat = ${allGroupExpr(systems)}`);
      const pairs: string[] = [];
      for (let s = 0; s + 1 < systems; s += 2) {
        pairs.push(`(PlanBefore ("${systemName(s)}", "${systemName(s + 1)}"))`);
      }
      if (systems % 2 === 1) {
        pairs.push(`(PlanGroup ["${systemName(systems - 1)}"])`);
      }
      let pairExpr = pairs[pairs.length - 1]!;
      for (let i = pairs.length - 2; i >= 0; i -= 1) {
        pairExpr = `PlanThen (${pairs[i]!}, ${pairExpr})`;
      }
      lines.push(`const graph${suffix}_pairs = ${pairExpr}`);
      lines.push(
        `const plan${suffix}_staged = PlanCompile${suffix} (${row}, registry${suffix}, graph${suffix}_staged)`,
        `const plan${suffix}_flat = PlanCompile${suffix} (${row}, registry${suffix}, graph${suffix}_flat)`,
        `const plan${suffix}_pairs = PlanCompile${suffix} (${row}, registry${suffix}, graph${suffix}_pairs)`,
        ``,
      );
    } else if (withSchedules) {
      lines.push(`const graph${suffix} = ${stagedGraphExpr(systems, stages)}`);
      lines.push(
        `const plan${suffix} = PlanCompile${suffix} (${row}, registry${suffix}, graph${suffix})`,
        ``,
      );
    }

    // Concrete seed rows with the world's tag literal.
    lines.push(
      `const seed${suffix}: (Int, Int) -> [${row}]`,
      `const seed${suffix} = fn (count, offset) => Iter.collect (Iter.map (`,
      `  Iter.range (0, count),`,
      `  fn index => {`,
    );
    lines.push(`    .which = "${tag}";`);
    for (let c = 0; c < components; c += 1) {
      const kind = KINDS[c % KINDS.length]!;
      lines.push(
        `    .${componentName(c)} = ${kind.rowExpr("index", "offset")};`,
      );
    }
    lines.push(`  }`, `))`, ``);

    // Single-row integer projection shared by the checksum and the render.
    const terms: string[] = [];
    for (let c = 0; c < components; c += 1) {
      const kind = KINDS[c % KINDS.length]!;
      terms.push(kind.intExpr(`row.${componentName(c)}`));
    }
    lines.push(
      `const render${suffix} = fn row => ${terms.join(" + ")}`,
      `const checksum${suffix}: [${row}] -> Int`,
      `const checksum${suffix} = fn rows => fold (rows, 0, fn (total, row) => total + render${suffix} row)`,
      ``,
    );

    // Single-row composed step over every system (nested merges).
    const stepRefs = Array.from(
      { length: systems },
      (_, s) => `registry${suffix}.${systemName(s)}.step`,
    );
    let tick = stepRefs[stepRefs.length - 1]!;
    lines.push(`const Sched${suffix} = SchedFn${suffix} ${row}`);
    if (stepRefs.length === 1) {
      lines.push(`const tick1${suffix} = ${tick}`);
    } else {
      for (let i = stepRefs.length - 2; i >= 0; i -= 1) {
        tick = `Sched${suffix}.merge (${stepRefs[i]!}, ${tick})`;
      }
      lines.push(`const tick1${suffix} = ${tick}`);
    }
    lines.push(``);

    // Loop.run-like application over the world's row type.
    const initialFields = [`    .which = "${tag}";`];
    for (let c = 0; c < components; c += 1) {
      const kind = KINDS[c % KINDS.length]!;
      initialFields.push(`    .${componentName(c)} = ${kind.seedExpr};`);
    }
    lines.push(
      `const Loop${suffix} = ForceForWorld${suffix} ${row}`,
      `const initial${suffix}: Unit -> ${row}`,
      `const initial${suffix} = fn () => {`,
      ...initialFields,
      `  }`,
      `const game${suffix} = {`,
      `  .initial = initial${suffix};`,
      `  .update = fn (row, step) => tick1${suffix} row;`,
      `  .render = render${suffix};`,
      `}`,
      `const run${suffix} = Loop${suffix}.run game${suffix}`,
      ``,
    );
  }

  if (withUnion) {
    const rows = worlds.map((tag) => `Row${worldSuffix(tag)}`).join(", ");
    lines.push(
      `const World = ForceUnite [${rows}]`,
      ``,
    );
  }

  // Demanded export: one bounded tick plus checksum per world.
  const runTerms: string[] = [];
  for (const tag of worlds) {
    const suffix = worldSuffix(tag);
    if (sink === "identity" || sink === "build-only" || sink === "union-only") {
      lines.push(
        `const tick${suffix} = Sched${suffix}.each Sched${suffix}.empty`,
      );
      runTerms.push(
        `checksum${suffix} (tick${suffix} (seed${suffix} (count, 0)))`,
      );
    } else if (sink === "schedule-only") {
      runTerms.push(
        `checksum${suffix} (plan${suffix}_pairs.each (plan${suffix}_flat.each (plan${suffix}_staged.each (seed${suffix} (count, 0)))))`,
      );
    } else {
      runTerms.push(`run${suffix} count`);
    }
  }
  if (
    runTerms.length > 1 &&
    (sink === "identity" || sink === "build-only" || sink === "union-only")
  ) {
    lines.push(``);
  }
  lines.push(
    `const run: Int -> Int`,
    `const run = fn (count: Int) -> Int => ${runTerms.join(" + ")}`,
    ``,
    `return { .run; }`,
    ``,
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const globals = globalThis as unknown as {
    Deno?: { args: readonly string[] };
    process?: { argv: readonly string[] };
  };
  const raw: readonly string[] = globals.Deno?.args ??
    globals.process?.argv.slice(2) ?? [];
  const options = parseOptions(raw);
  const source = generate(options);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(options.out, source);
}

await main();
