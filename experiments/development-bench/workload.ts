import { join } from "@std/path";

export const developmentBenchmarkUnitCount = 20;
export const developmentBenchmarkTargetBytes = 5 * 1024 * 1024;

export interface DevelopmentBenchmarkWorkload {
  readonly manifestPath: string;
  readonly editedProviderPath: string;
  readonly sourceBytes: number;
  readonly editedProviderBytes: number;
  readonly unitCount: number;
  readonly voxelDeclarations: number;
  editedProviderSource(increment: number): string;
  expectedObservation(increment: number): bigint;
}

export async function writeDevelopmentBenchmarkWorkload(options: {
  readonly directory: string;
  readonly targetSourceBytes: number;
  readonly unitCount: number;
}): Promise<DevelopmentBenchmarkWorkload> {
  if (!Number.isSafeInteger(options.unitCount) || options.unitCount < 2) {
    throw new Error(
      `development benchmark unit count must be at least 2, received ${options.unitCount}`,
    );
  }
  if (
    !Number.isSafeInteger(options.targetSourceBytes) ||
    options.targetSourceBytes < 1
  ) {
    throw new Error(
      `development benchmark target bytes must be positive, received ${options.targetSourceBytes}`,
    );
  }
  const providerCount = options.unitCount - 1;
  const units: Record<string, string> = { game: "./main.blot" };
  const imports: string[] = [];
  const calls: string[] = [];
  const voxelSources = Array.from(
    { length: providerCount },
    (): string[] => [],
  );

  for (let index = 1; index <= providerCount; index += 1) {
    const unitName = `unit-${index}`;
    const bindingName = `unit_${index}`;
    const fileName = `${bindingName}.blot`;
    units[unitName] = `./${fileName}`;
    imports.push(`const ${bindingName} = import "./${fileName}"`);
    calls.push(`${bindingName}.add value`);
  }

  const entrySource = `open import "blot:prelude"

${imports.join("\n")}
const Source = @effect.host { .value = Unit -> Int; }
use value <- Source.value ()
return ${calls.join(" + ")}
`;
  const providerOverhead = Array.from(
    { length: providerCount },
    (_, index) => providerSource([], initialIncrement(index + 1)),
  ).reduce((total, source) => total + source.length, 0);
  let sourceBytes = entrySource.length + providerOverhead;
  let voxelDeclarations = 0;
  let catalogProviderOffset = 1;
  if (providerCount === 1) catalogProviderOffset = 0;
  const catalogProviderCount = providerCount - catalogProviderOffset;
  while (sourceBytes < options.targetSourceBytes) {
    const providerIndex = catalogProviderOffset +
      voxelDeclarations % catalogProviderCount;
    const declaration = voxelSource(providerIndex + 1, voxelDeclarations);
    voxelSources[providerIndex].push(declaration);
    voxelDeclarations += 1;
    sourceBytes += declaration.length;
  }

  await Deno.writeTextFile(join(options.directory, "main.blot"), entrySource);
  const completeProviderSources: string[] = [];
  for (let index = 1; index <= providerCount; index += 1) {
    const source = providerSource(
      voxelSources[index - 1],
      initialIncrement(index),
    );
    completeProviderSources.push(source);
    await Deno.writeTextFile(
      join(options.directory, `unit_${index}.blot`),
      source,
    );
  }
  const manifestPath = join(options.directory, "blot.json");
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-project",
      version: 1,
      entryUnit: "game",
      units,
    }),
  );

  const actualSourceBytes = entrySource.length + completeProviderSources.reduce(
    (total, source) => total + source.length,
    0,
  );
  const editedProviderPath = join(options.directory, "unit_1.blot");
  return {
    manifestPath,
    editedProviderPath,
    sourceBytes: actualSourceBytes,
    editedProviderBytes: completeProviderSources[0].length,
    unitCount: options.unitCount,
    voxelDeclarations,
    editedProviderSource: (increment) =>
      providerSource(voxelSources[0], increment),
    expectedObservation: (increment) => {
      let result = BigInt(providerCount * 10 + increment);
      for (let index = 2; index <= providerCount; index += 1) {
        result += BigInt(initialIncrement(index));
      }
      return result;
    },
  };
}

function providerSource(
  voxels: readonly string[],
  increment: number,
): string {
  return `open import "blot:prelude"

const Voxel = {
  .kind = #Voxel;
  .name = Text;
  .position = { .x = Int; .y = Int; .z = Int; };
  .color = { .red = Int; .green = Int; .blue = Int; };
  .flags = [#Solid | #Shadow];
}
let voxel_catalog :: [Voxel]
let voxel_catalog = [${voxels.join(",")}]
let add :: Int -> Int
let add = fn value => value + ${increment}
return { .add = add; }
`;
}

function voxelSource(providerIndex: number, voxelIndex: number): string {
  const x = voxelIndex % 97;
  const y = Math.floor(voxelIndex / 97) % 97;
  const z = Math.floor(voxelIndex / (97 * 97)) % 97;
  const red = (providerIndex * 17 + voxelIndex) % 256;
  const green = (providerIndex * 29 + voxelIndex * 3) % 256;
  const blue = (providerIndex * 43 + voxelIndex * 7) % 256;
  return `{ .kind = #Voxel; .name = "shrubbery_${providerIndex}_${voxelIndex}"; .position = { .x = ${x}; .y = ${y}; .z = ${z}; }; .color = { .red = ${red}; .green = ${green}; .blue = ${blue}; }; .flags = [#Solid, #Shadow]; }`;
}

function initialIncrement(providerIndex: number): number {
  return 100 + providerIndex;
}
