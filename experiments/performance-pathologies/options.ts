/** Operational bounds for this benchmark, not limits of the Blot language. */
export const MAX_RECORD_DEPTH = 64;
export const MAX_TEXT_SIZE = 131_072;
export const MAX_SAMPLES = 101;
export const MAX_VALUES = 16;

export interface BenchmarkOptions {
  depths: number[];
  sizes: number[];
  samples: number;
}

export function parseOptions(arguments_: readonly string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {
    depths: [4, 6, 8, 10],
    sizes: [4096, 8192, 16384, 32768],
    samples: 3,
  };
  const seen = new Set<string>();
  let argumentsToParse = arguments_;
  if (arguments_[0] === "--") argumentsToParse = arguments_.slice(1);
  for (const argument of argumentsToParse) {
    const match = /^--(depths|sizes|samples)=(.*)$/.exec(argument);
    if (match === null) throw new Error(`unknown argument ${argument}`);
    const [, name, encoded] = match;
    if (seen.has(name)) throw new Error(`duplicate option --${name}`);
    seen.add(name);
    const parts = encoded.split(",");
    if (parts.length > MAX_VALUES) {
      throw new Error(`${name} accepts at most ${MAX_VALUES} values`);
    }
    if (name === "samples" && parts.length !== 1) {
      throw new Error("samples takes one integer");
    }
    let maximum = MAX_TEXT_SIZE;
    if (name === "depths") maximum = MAX_RECORD_DEPTH;
    if (name === "samples") maximum = MAX_SAMPLES;
    const values = parts.map((part) => {
      if (!/^[1-9][0-9]*$/.test(part)) {
        throw new Error(`${name} requires positive decimal integers`);
      }
      const value = Number(part);
      if (!Number.isSafeInteger(value) || value > maximum) {
        throw new Error(`${name} values must be between 1 and ${maximum}`);
      }
      return value;
    });
    if (name === "depths") options.depths = values;
    if (name === "sizes") options.sizes = values;
    if (name === "samples") options.samples = values[0];
  }
  return options;
}
