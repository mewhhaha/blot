import { join } from "@std/path";

/** Every helper participates in the exported runtime call graph. */
export async function writeActiveDevelopmentWorkload(options: {
  readonly directory: string;
  readonly unitCount: number;
  readonly helpersPerUnit: number;
}) {
  for (
    const [name, value] of Object.entries({
      unitCount: options.unitCount,
      helpersPerUnit: options.helpersPerUnit,
    })
  ) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer, received ${value}`);
    }
  }
  const units: Record<string, string> = { app: "./main.blot" };
  const imports: string[] = [];
  const calls: string[] = [];
  const providerSource = (increment: number) => {
    const helpers: string[] = [];
    for (let index = 0; index < options.helpersPerUnit; index += 1) {
      let argument = "value";
      if (index > 0) argument = `step_${index - 1} value`;
      helpers.push(`const step_${index} :: Int -> Int
const step_${index} = fn value => (${argument}) + 1`);
    }
    return `open import "blot:prelude"
const identity = fn value => value
const rec countdown :: Int -> Int
const rec countdown = fn value => do:
  if value < 1:
    return 0
  return 1 + countdown (value - 1)
${helpers.join("\n")}
const run :: Int -> Int
const run = fn value => step_${
      options.helpersPerUnit - 1
    } (identity value) + countdown (value % 4) + ${increment}
const float_identity :: F32 -> F32
const float_identity = fn value => identity value
return { .run = run; .float_identity = float_identity; }
`;
  };
  for (let index = 0; index < options.unitCount; index += 1) {
    const name = `unit_${index}`;
    const file = `${name}.blot`;
    units[`unit-${index}`] = `./${file}`;
    imports.push(`const ${name} = import "./${file}"`);
    calls.push(`${name}.run value`);
    await Deno.writeTextFile(join(options.directory, file), providerSource(1));
  }
  await Deno.writeTextFile(
    join(options.directory, "main.blot"),
    `open import "blot:prelude"
${imports.join("\n")}
const run :: Int -> Int
const run = fn value => ${calls.join(" + ")}
const float_run :: F32 -> F32
const float_run = fn value => ${
      Array.from(
        { length: options.unitCount },
        (_, index) => `unit_${index}.float_identity value`,
      ).join(" + ")
    }
return { .run = run; .float_run = float_run; }
`,
  );
  const manifestPath = join(options.directory, "blot.json");
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "app",
      units,
    }),
  );
  return {
    manifestPath,
    editedProviderPath: join(options.directory, "unit_0.blot"),
    providerSource,
    expectedInteger(argument: bigint, increment: number) {
      let countdown = argument % 4n;
      if (countdown < 0n) countdown = 0n;
      return BigInt(options.unitCount) *
          (argument + BigInt(options.helpersPerUnit) + countdown + 1n) +
        BigInt(increment - 1);
    },
  };
}
