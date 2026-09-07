export interface ScalingOptions<Family extends string> {
  readonly samples: number;
  readonly sizes: readonly number[];
  readonly families: readonly Family[];
}

export function parseScalingOptions<Family extends string>(
  args: readonly string[],
  availableFamilies: readonly Family[],
): ScalingOptions<Family> {
  let samples = 3;
  let sizes = [8, 16, 32, 64, 128, 256];
  const families: Family[] = [];
  const flags = new Set<string>();
  for (const argument of args) {
    if (argument === "--") continue;
    if (argument.startsWith("--samples=")) {
      if (flags.has("samples")) throw new Error("duplicate --samples option");
      flags.add("samples");
      samples = positiveInteger(argument.slice("--samples=".length), "samples");
      if (samples % 2 === 0) {
        throw new Error("type-scaling samples must be a positive odd integer");
      }
      continue;
    }
    if (argument.startsWith("--sizes=")) {
      if (flags.has("sizes")) throw new Error("duplicate --sizes option");
      flags.add("sizes");
      sizes = argument.slice("--sizes=".length).split(",").map((value) =>
        positiveInteger(value, "sizes")
      );
      for (let index = 1; index < sizes.length; index += 1) {
        if (sizes[index] <= sizes[index - 1]) {
          throw new Error("type-scaling sizes must be strictly increasing");
        }
      }
      continue;
    }
    const family = availableFamilies.find((value) => value === argument);
    if (family === undefined) {
      throw new Error(`unknown type-scaling family ${JSON.stringify(argument)}`);
    }
    if (families.includes(family)) {
      throw new Error(`duplicate type-scaling family ${JSON.stringify(family)}`);
    }
    families.push(family);
  }
  if (families.length === 0) families.push(...availableFamilies);
  return { samples, sizes, families };
}

function positiveInteger(text: string, label: string): number {
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`type-scaling ${label} must be positive decimal integers`);
  }
  return value;
}
