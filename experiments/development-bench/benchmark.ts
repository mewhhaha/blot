import { join } from "@std/path";
import { DevelopmentProject } from "../../src/development.ts";

const unitCount = 20;
const measuredBuilds = 20;
const targetBytes = 5 * 1024 * 1024;
const directory = await Deno.makeTempDir({ prefix: "blot-development-bench-" });

try {
  const paddingLength = Math.ceil(targetBytes / (unitCount - 1));
  const padding = `// ${"x".repeat(paddingLength - 4)}\n`;
  const units: Record<string, string> = { game: "./main.blot" };
  const imports: string[] = [];
  const calls: string[] = [];
  for (let index = 1; index < unitCount; index += 1) {
    const name = `unit-${index}`;
    const fileName = `unit_${index}.blot`;
    units[name] = `./${fileName}`;
    imports.push(`const unit_${index} = import "./${fileName}"`);
    if (index === 1) calls.push(`unit_${index}.add value`);
    let unitPadding = padding;
    if (index === 1) unitPadding = "";
    await Deno.writeTextFile(
      join(directory, fileName),
      providerSource(unitPadding, index),
    );
  }
  await Deno.writeTextFile(
    join(directory, "main.blot"),
    `${padding}open import "blot:prelude"
${imports.join("\n")}
const Source = @effect.host { .value = Unit -> Int; }
use value <- Source.value ()
return ${calls.join(" + ")}
`,
  );
  const manifestPath = join(directory, "blot.json");
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "game",
      units,
    }),
  );

  const project = await DevelopmentProject.create(manifestPath);
  try {
    await project.build();
    const durations: number[] = [];
    for (let iteration = 0; iteration < measuredBuilds; iteration += 1) {
      let increment = 101;
      if (iteration % 2 === 1) increment = 102;
      await Deno.writeTextFile(
        join(directory, "unit_1.blot"),
        providerSource("", increment),
      );
      await project.markChanged(join(directory, "unit_1.blot"));
      const build = await project.build();
      const changed = build.changedUnits.map((unit) => unit.name);
      if (changed.length !== 1 || changed[0] !== "unit-1") {
        throw new Error(
          `development benchmark rebuilt [${
            changed.join(", ")
          }], expected only unit-1`,
        );
      }
      durations.push(build.durationMilliseconds);
    }
    durations.sort((left, right) => left - right);
    const p95Index = Math.ceil(durations.length * 0.95) - 1;
    const p95 = durations[p95Index];
    console.log(JSON.stringify(
      {
        sourceBytes: await projectBytes(directory),
        units: unitCount,
        samples: measuredBuilds,
        medianMilliseconds: durations[Math.floor(durations.length / 2)],
        p95Milliseconds: p95,
      },
      null,
      2,
    ));
    if (p95 >= 100) {
      throw new Error(
        `development rebuild p95 was ${
          p95.toFixed(1)
        } ms, expected less than 100 ms`,
      );
    }
  } finally {
    project.destroy();
  }
} finally {
  await Deno.remove(directory, { recursive: true });
}

function providerSource(padding: string, increment: number): string {
  return `${padding}open import "blot:prelude"
let add :: Int -> Int
let add = fn value => value + ${increment}
return { .add = add; }
`;
}

async function projectBytes(directory: string): Promise<number> {
  let total = 0;
  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile || !entry.name.endsWith(".blot")) continue;
    total += (await Deno.stat(join(directory, entry.name))).size;
  }
  return total;
}
