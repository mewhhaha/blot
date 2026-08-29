import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "@std/path";

export const PROJECT_SCHEMA = "blot-project";
export const PROJECT_FORMAT_VERSION = 1;

export type DevelopmentUnitName = string & {
  readonly __brand: "DevelopmentUnitName";
};

export interface ProjectManifest {
  readonly schema: typeof PROJECT_SCHEMA;
  readonly version: typeof PROJECT_FORMAT_VERSION;
  readonly path: string;
  readonly entryUnit: DevelopmentUnitName;
  readonly units: ReadonlyMap<DevelopmentUnitName, string>;
}

export class ProjectManifestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectManifestError";
  }
}

export async function readProjectManifest(
  manifestPath: string,
): Promise<ProjectManifest> {
  const absoluteManifest = resolve(manifestPath);
  let source: string;
  try {
    source = await readFile(absoluteManifest, "utf8");
  } catch (cause) {
    throw new ProjectManifestError(
      `could not read Blot project manifest ${
        JSON.stringify(absoluteManifest)
      }`,
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new ProjectManifestError(
      `Blot project manifest ${
        JSON.stringify(absoluteManifest)
      } is not valid JSON`,
      { cause },
    );
  }

  const manifest = record(
    parsed,
    `Blot project manifest ${absoluteManifest}`,
  );
  if (manifest.schema !== PROJECT_SCHEMA) {
    throw new ProjectManifestError(
      `Blot project manifest ${JSON.stringify(absoluteManifest)} has schema ${
        JSON.stringify(manifest.schema)
      }, expected ${JSON.stringify(PROJECT_SCHEMA)}`,
    );
  }
  if (manifest.version !== PROJECT_FORMAT_VERSION) {
    throw new ProjectManifestError(
      `Blot project manifest ${JSON.stringify(absoluteManifest)} has version ${
        JSON.stringify(manifest.version)
      }, expected ${PROJECT_FORMAT_VERSION}`,
    );
  }

  const encodedUnits = record(
    manifest.units,
    `units in Blot project manifest ${absoluteManifest}`,
  );
  const projectRoot = dirname(absoluteManifest);
  const units = new Map<DevelopmentUnitName, string>();
  const roots = new Map<string, DevelopmentUnitName>();
  for (const [encodedName, encodedSource] of Object.entries(encodedUnits)) {
    const name = developmentUnitName(encodedName, absoluteManifest);
    if (typeof encodedSource !== "string") {
      throw new ProjectManifestError(
        `unit ${JSON.stringify(encodedName)} in ${
          JSON.stringify(absoluteManifest)
        } has non-text source ${JSON.stringify(encodedSource)}`,
      );
    }
    if (!encodedSource.endsWith(".blot")) {
      throw new ProjectManifestError(
        `unit ${JSON.stringify(encodedName)} in ${
          JSON.stringify(absoluteManifest)
        } must name a .blot source, found ${JSON.stringify(encodedSource)}`,
      );
    }
    const sourcePath = confinedSource(
      projectRoot,
      encodedSource,
      absoluteManifest,
      name,
    );
    const previous = roots.get(sourcePath);
    if (previous !== undefined) {
      throw new ProjectManifestError(
        `units ${JSON.stringify(previous)} and ${JSON.stringify(name)} in ${
          JSON.stringify(absoluteManifest)
        } repeat source ${JSON.stringify(sourcePath)}`,
      );
    }
    roots.set(sourcePath, name);
    units.set(name, sourcePath);
  }
  if (units.size === 0) {
    throw new ProjectManifestError(
      `Blot project manifest ${JSON.stringify(absoluteManifest)} has no units`,
    );
  }

  if (typeof manifest.entryUnit !== "string") {
    throw new ProjectManifestError(
      `entryUnit in Blot project manifest ${
        JSON.stringify(absoluteManifest)
      } must be text, found ${JSON.stringify(manifest.entryUnit)}`,
    );
  }
  const entryUnit = developmentUnitName(
    manifest.entryUnit,
    absoluteManifest,
  );
  if (!units.has(entryUnit)) {
    throw new ProjectManifestError(
      `entry unit ${JSON.stringify(entryUnit)} is absent from ${
        JSON.stringify(absoluteManifest)
      }`,
    );
  }

  return {
    schema: PROJECT_SCHEMA,
    version: PROJECT_FORMAT_VERSION,
    path: absoluteManifest,
    entryUnit,
    units,
  };
}

function developmentUnitName(
  value: string,
  manifestPath: string,
): DevelopmentUnitName {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new ProjectManifestError(
      `Blot project manifest ${
        JSON.stringify(manifestPath)
      } has invalid unit name ${
        JSON.stringify(value)
      }; expected a lowercase name beginning with a letter`,
    );
  }
  return value as DevelopmentUnitName;
}

function confinedSource(
  projectRoot: string,
  target: string,
  manifestPath: string,
  unit: DevelopmentUnitName,
): string {
  if (isAbsolute(target)) {
    throw new ProjectManifestError(
      `unit ${JSON.stringify(unit)} in ${
        JSON.stringify(manifestPath)
      } uses absolute source ${JSON.stringify(target)}`,
    );
  }
  const source = resolve(projectRoot, target);
  const fromRoot = relative(projectRoot, source);
  if (
    fromRoot === ".." || fromRoot.startsWith(`..${separator(fromRoot)}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new ProjectManifestError(
      `unit ${JSON.stringify(unit)} in ${
        JSON.stringify(manifestPath)
      } escapes its project with source ${JSON.stringify(target)}`,
    );
  }
  return source;
}

function separator(path: string): string {
  if (path.includes("\\")) return "\\";
  return "/";
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProjectManifestError(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}
