import type {
  BlotAbiFunction,
  BlotAbiType,
} from "./compiler/backend/runtime/abi.ts";
import { flattenedAbiType } from "./compiler/backend/runtime/abi.ts";
import type {
  DevelopmentBuild,
  RetainedDevelopmentUnit,
} from "./development.ts";
import type { DevelopmentUnitArtifact } from "./compiler/session.ts";
import { developmentRevision } from "./development_identity.ts";

type WasmValue = number | bigint;
type Reallocate = (
  previousPointer: number,
  previousSize: number,
  alignment: number,
  newSize: number,
) => number;

interface DevelopmentManifest {
  readonly source: string;
  readonly abi: {
    readonly memoryExport: "memory";
  };
  readonly exports: readonly {
    readonly name: string | null;
    readonly function: BlotAbiFunction | null;
    readonly postReturn: string | null;
  }[];
  readonly links: readonly {
    readonly unit: string;
    readonly name: string;
    readonly module: string;
    readonly function: BlotAbiFunction;
  }[];
}

interface UnitActivation {
  readonly artifact: DevelopmentUnitArtifact;
  readonly manifest: DevelopmentManifest;
  readonly module: WebAssembly.Module;
  readonly instance: WebAssembly.Instance;
}

interface PreparedDevelopmentUnit {
  readonly artifact: DevelopmentUnitArtifact;
  readonly manifest: DevelopmentManifest;
  readonly module: WebAssembly.Module;
}

const developmentActivationBrand: unique symbol = Symbol(
  "DevelopmentActivation",
);

export interface DevelopmentActivation {
  readonly [developmentActivationBrand]: true;
  readonly revision: string;
}

interface PendingDevelopmentActivation {
  readonly activation: DevelopmentActivation;
  readonly units: Map<string, UnitActivation>;
  readonly build: ValidatedDevelopmentBuild;
}

interface ValidatedDevelopmentBuild {
  readonly baseRevision: string | undefined;
  readonly revision: string;
  readonly entryUnit: string;
  readonly changedUnits: readonly DevelopmentUnitArtifact[];
  readonly retainedUnits: readonly RetainedDevelopmentUnit[];
  readonly removedUnits: readonly string[];
  readonly edges: DevelopmentBuild["edges"];
  readonly durationMilliseconds: number;
}

type DevelopmentRuntimeState =
  | { readonly tag: "ready" }
  | { readonly tag: "preparing" }
  | {
    readonly tag: "pending";
    readonly candidate: PendingDevelopmentActivation;
  };

interface Allocation {
  readonly pointer: number;
  readonly size: number;
  readonly alignment: number;
}

export interface DevelopmentRuntimeContext {
  readonly unit: string;
  memory(): WebAssembly.Memory;
}

export type DevelopmentRuntimeImports = (
  context: DevelopmentRuntimeContext,
) => WebAssembly.Imports | Promise<WebAssembly.Imports>;

export class DevelopmentRuntime {
  readonly #imports: DevelopmentRuntimeImports;
  #units = new Map<string, UnitActivation>();
  #entryUnit: string | undefined;
  #revision: string | undefined;
  #state: DevelopmentRuntimeState = { tag: "ready" };

  constructor(imports: DevelopmentRuntimeImports = () => ({})) {
    this.#imports = imports;
  }

  get revision(): string | undefined {
    return this.#revision;
  }

  get entryInstance(): WebAssembly.Instance {
    if (this.#entryUnit === undefined) {
      throw new Error("development runtime has not activated a build");
    }
    return this.unitInstance(this.#entryUnit);
  }

  unitInstance(name: string): WebAssembly.Instance {
    const active = this.#units.get(name);
    if (active === undefined) {
      throw new Error(
        `development runtime has no active unit ${JSON.stringify(name)}`,
      );
    }
    return active.instance;
  }

  async prepareActivation(
    build: DevelopmentBuild,
  ): Promise<DevelopmentActivation> {
    this.#requireReady("prepare an activation");
    this.#state = { tag: "preparing" };
    try {
      const validated = validateBuildTransition(
        build,
        this.#units,
        this.#revision,
      );
      this.#requireRetainedUnits(validated.retainedUnits);
      const compiled = await Promise.all(
        validated.changedUnits.map(async (artifact) => {
          const manifest = decodeManifest(artifact);
          const interfaceDigest = await sha256(artifact.manifestBytes);
          if (interfaceDigest !== artifact.interfaceDigest) {
            throw new Error(
              `development unit ${
                JSON.stringify(artifact.name)
              } manifest digest ${interfaceDigest} differs from declared digest ${
                JSON.stringify(artifact.interfaceDigest)
              }`,
            );
          }
          const wasmDigest = await sha256(artifact.wasm);
          if (wasmDigest !== artifact.wasmDigest) {
            throw new Error(
              `development unit ${
                JSON.stringify(artifact.name)
              } Wasm digest ${wasmDigest} differs from declared digest ${
                JSON.stringify(artifact.wasmDigest)
              }`,
            );
          }
          const module = await WebAssembly.compile(
            Uint8Array.from(artifact.wasm),
          );
          requireEmbeddedManifest(module, artifact);
          return { artifact, manifest, module };
        }),
      );
      const finalUnits = new Map<string, PreparedDevelopmentUnit>(
        [...this.#units].map(([name, active]) =>
          [name, {
            artifact: active.artifact,
            manifest: active.manifest,
            module: active.module,
          }] as const
        ),
      );
      for (const removed of validated.removedUnits) finalUnits.delete(removed);
      for (const prepared of compiled) {
        finalUnits.set(prepared.artifact.name, prepared);
      }
      const resolvedLinks = new Map<
        string,
        readonly DevelopmentManifest["links"][number][]
      >();
      const moduleExports = new Map<
        string,
        readonly WebAssembly.ModuleExportDescriptor[]
      >();
      const derivedEdges: Array<DevelopmentBuild["edges"][number]> = [];
      for (const [consumer, unit] of finalUnits) {
        const consumerLinks: Array<DevelopmentManifest["links"][number]> = [];
        for (const link of unit.manifest.links) {
          const provider = finalUnits.get(link.unit);
          if (provider === undefined) {
            throw new Error(
              `development unit ${JSON.stringify(consumer)} links ${
                JSON.stringify(link.name)
              } to inactive provider ${JSON.stringify(link.unit)} in build ${
                JSON.stringify(validated.revision)
              }`,
            );
          }
          const exportName = `blot:dev:${link.name}`;
          const manifestExports = provider.manifest.exports.filter((
            candidate,
          ) => candidate.name === exportName);
          const exported = manifestExports[0];
          if (
            manifestExports.length !== 1 || exported === undefined ||
            exported.function === null || exported.name === null
          ) {
            throw new Error(
              `development provider ${
                JSON.stringify(link.unit)
              } has ${manifestExports.length} runtime exports ${
                JSON.stringify(exportName)
              } for consumer ${JSON.stringify(consumer)}, expected one`,
            );
          }
          if (
            JSON.stringify(exported.function) !== JSON.stringify(link.function)
          ) {
            throw new Error(
              `development link ${JSON.stringify(link.name)} from ${
                JSON.stringify(consumer)
              } disagrees with provider ${JSON.stringify(link.unit)}`,
            );
          }
          let wasmExports = moduleExports.get(link.unit);
          if (wasmExports === undefined) {
            wasmExports = WebAssembly.Module.exports(provider.module);
            moduleExports.set(link.unit, wasmExports);
          }
          const wasmEntries = wasmExports.filter((candidate) =>
            candidate.name === exportName
          );
          const wasmEntry = wasmEntries[0];
          if (
            wasmEntries.length !== 1 || wasmEntry === undefined ||
            wasmEntry.kind !== "function"
          ) {
            throw new Error(
              `development provider ${
                JSON.stringify(link.unit)
              } has Wasm export kinds ${
                JSON.stringify(wasmEntries.map((candidate) => candidate.kind))
              } under ${JSON.stringify(exportName)}, expected ["function"]`,
            );
          }
          if (exported.postReturn !== null) {
            const postReturns = wasmExports.filter((candidate) =>
              candidate.name === exported.postReturn
            );
            const postReturn = postReturns[0];
            if (
              postReturns.length !== 1 || postReturn === undefined ||
              postReturn.kind !== "function"
            ) {
              throw new Error(
                `development provider ${
                  JSON.stringify(link.unit)
                } has post-return Wasm export kinds ${
                  JSON.stringify(
                    postReturns.map((candidate) => candidate.kind),
                  )
                } under ${
                  JSON.stringify(exported.postReturn)
                }, expected ["function"]`,
              );
            }
          }
          consumerLinks.push(link);
          derivedEdges.push({
            consumer,
            provider: link.unit,
            name: link.name,
          });
        }
        resolvedLinks.set(consumer, consumerLinks);
      }
      derivedEdges.sort(compareDevelopmentEdges);
      const expectedEdgeIdentities = validated.edges.map(
        developmentEdgeIdentity,
      );
      const derivedEdgeIdentities = derivedEdges.map(developmentEdgeIdentity);
      if (
        JSON.stringify(expectedEdgeIdentities) !==
          JSON.stringify(derivedEdgeIdentities)
      ) {
        throw new Error(
          `development build ${
            JSON.stringify(validated.revision)
          } declares edges [${
            expectedEdgeIdentities.join(", ")
          }], but its final manifests derive [${
            derivedEdgeIdentities.join(", ")
          }]`,
        );
      }
      const revision = await developmentRevision(
        validated.entryUnit,
        [...finalUnits.values()].map((unit) => unit.artifact),
      );
      if (revision !== validated.revision) {
        throw new Error(
          `development build ${
            JSON.stringify(validated.revision)
          } has canonical revision ${JSON.stringify(revision)}`,
        );
      }
      const candidates = new Map<string, UnitActivation>();
      for (const prepared of compiled) {
        const links = resolvedLinks.get(prepared.artifact.name);
        if (links === undefined) {
          throw new Error(
            `development build ${
              JSON.stringify(validated.revision)
            } lost validated links for ${
              JSON.stringify(prepared.artifact.name)
            }`,
          );
        }
        const activation: { instance?: WebAssembly.Instance } = {};
        const context: DevelopmentRuntimeContext = {
          unit: prepared.artifact.name,
          memory: () => {
            if (activation.instance === undefined) {
              throw new Error(
                `unit ${
                  JSON.stringify(prepared.artifact.name)
                } used host memory during instantiation`,
              );
            }
            return requiredMemory(
              activation.instance,
              prepared.manifest,
              prepared.artifact.name,
            );
          },
        };
        const imports = await this.#imports(context);
        const linkedImports = this.#linkImports(
          prepared.artifact.name,
          prepared.manifest,
          links,
          imports,
          () => {
            if (activation.instance === undefined) {
              throw new Error(
                `unit ${
                  JSON.stringify(prepared.artifact.name)
                } called a development link during instantiation`,
              );
            }
            return activation.instance;
          },
        );
        activation.instance = await WebAssembly.instantiate(
          prepared.module,
          linkedImports,
        );
        candidates.set(prepared.artifact.name, {
          ...prepared,
          instance: activation.instance,
        });
      }

      if (candidates.size !== validated.changedUnits.length) {
        throw new Error(
          `development build ${
            JSON.stringify(validated.revision)
          } prepared ${candidates.size} changed units, expected ${validated.changedUnits.length}`,
        );
      }
      const nextUnits = new Map(this.#units);
      for (const removed of validated.removedUnits) nextUnits.delete(removed);
      for (const [name, active] of candidates) nextUnits.set(name, active);
      const activation: DevelopmentActivation = Object.freeze({
        [developmentActivationBrand]: true as const,
        revision: validated.revision,
      });
      this.#state = {
        tag: "pending",
        candidate: {
          activation,
          units: nextUnits,
          build: validated,
        },
      };
      return activation;
    } catch (error) {
      if (this.#state.tag === "preparing") this.#state = { tag: "ready" };
      throw error;
    }
  }

  commitActivation(activation: DevelopmentActivation): void {
    const pending = this.#pendingActivation(activation, "commit");
    this.#units = pending.units;
    this.#entryUnit = pending.build.entryUnit;
    this.#revision = pending.build.revision;
    this.#state = { tag: "ready" };
  }

  abortActivation(activation: DevelopmentActivation): void {
    this.#pendingActivation(activation, "abort");
    this.#state = { tag: "ready" };
  }

  #pendingActivation(
    activation: DevelopmentActivation,
    operation: "commit" | "abort",
  ): PendingDevelopmentActivation {
    if (
      this.#state.tag === "pending" &&
      this.#state.candidate.activation === activation
    ) {
      return this.#state.candidate;
    }
    let pendingRevision = "none";
    if (this.#state.tag === "pending") {
      pendingRevision = JSON.stringify(this.#state.candidate.build.revision);
    }
    throw new Error(
      `development runtime cannot ${operation} activation ${
        JSON.stringify(activation.revision)
      }; pending revision is ${pendingRevision}`,
    );
  }

  #requireReady(operation: string): void {
    if (this.#state.tag === "ready") return;
    if (this.#state.tag === "preparing") {
      throw new Error(
        `development runtime cannot ${operation} while preparing an activation`,
      );
    }
    throw new Error(
      `development runtime cannot ${operation} while activation ${
        JSON.stringify(this.#state.candidate.build.revision)
      } is pending`,
    );
  }

  #requireRetainedUnits(retained: readonly RetainedDevelopmentUnit[]): void {
    for (const expected of retained) {
      const active = this.#units.get(expected.name);
      if (active === undefined) {
        throw new Error(
          `development build retained inactive unit ${
            JSON.stringify(expected.name)
          }`,
        );
      }
      if (
        active.artifact.interfaceDigest !== expected.interfaceDigest ||
        active.artifact.implementationDigest !==
          expected.implementationDigest ||
        active.artifact.wasmDigest !== expected.wasmDigest
      ) {
        throw new Error(
          `development build retained stale unit ${
            JSON.stringify(expected.name)
          }`,
        );
      }
    }
  }

  #linkImports(
    consumerName: string,
    consumerManifest: DevelopmentManifest,
    links: DevelopmentManifest["links"],
    hostImports: WebAssembly.Imports,
    consumerInstance: () => WebAssembly.Instance,
  ): WebAssembly.Imports {
    const imports: Record<string, WebAssembly.ModuleImports> = {
      ...hostImports,
    };
    const developmentModules = new Map<
      string,
      WebAssembly.ModuleImports
    >();
    for (const link of links) {
      const exportName = `blot:dev:${link.name}`;
      let moduleImports = developmentModules.get(link.module);
      if (moduleImports === undefined) {
        if (Object.hasOwn(hostImports, link.module)) {
          throw new Error(
            `host imports for unit ${
              JSON.stringify(consumerName)
            } collide with development module ${JSON.stringify(link.module)}`,
          );
        }
        moduleImports = {};
        developmentModules.set(link.module, moduleImports);
        imports[link.module] = moduleImports;
      }
      if (Object.hasOwn(moduleImports, exportName)) {
        throw new Error(
          `development unit ${JSON.stringify(consumerName)} repeats import ${
            JSON.stringify(exportName)
          } from ${JSON.stringify(link.module)}`,
        );
      }
      moduleImports[exportName] = (...arguments_: WasmValue[]) => {
        const consumer = consumerInstance();
        const provider = this.#units.get(link.unit);
        if (provider === undefined) {
          throw new Error(
            `unit ${JSON.stringify(consumerName)} called inactive provider ${
              JSON.stringify(link.unit)
            }`,
          );
        }
        return invokeLink(
          consumerName,
          consumer,
          consumerManifest,
          link.function,
          provider,
          link.name,
          arguments_,
        );
      };
    }
    return imports;
  }
}

function decodeManifest(
  artifact: DevelopmentUnitArtifact,
): DevelopmentManifest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(artifact.manifestBytes));
  } catch (cause) {
    throw new TypeError(
      `development unit ${
        JSON.stringify(artifact.name)
      } has an invalid ABI manifest`,
      { cause },
    );
  }
  const position = `development unit ${JSON.stringify(artifact.name)} manifest`;
  if (!isRecord(decoded) || decoded.format !== "blot-core-wasm") {
    throw new TypeError(
      `development unit ${
        JSON.stringify(artifact.name)
      } has an unknown ABI manifest format`,
    );
  }
  const abi = requireRecord(decoded.abi, `${position}.abi`);
  if (
    abi.major !== 2 || abi.minor !== 0 || abi.memory !== "memory32" ||
    abi.stringEncoding !== "utf-8" || abi.maximumFlatParameters !== 16 ||
    abi.maximumFlatResults !== 1 || abi.memoryExport !== "memory" ||
    abi.reallocExport !== "cabi_realloc"
  ) {
    throw new TypeError(
      `development unit ${
        JSON.stringify(artifact.name)
      } has an incompatible ABI manifest`,
    );
  }
  const source = requireString(decoded.source, `${position}.source`);
  if (source !== artifact.root) {
    throw new TypeError(
      `${position} names source ${JSON.stringify(source)}, expected ${
        JSON.stringify(artifact.root)
      }`,
    );
  }
  const exports = requireArray(decoded.exports, `${position}.exports`).map(
    (value, index) => parseExport(value, `${position}.exports[${index}]`),
  );
  requireArray(decoded.imports, `${position}.imports`);
  let links: DevelopmentManifest["links"] = [];
  if (decoded.links !== undefined) {
    links = requireArray(decoded.links, `${position}.links`).map(
      (value, index) => parseLink(value, `${position}.links[${index}]`),
    );
  }
  return { source, abi: { memoryExport: "memory" }, exports, links };
}

function validateBuildTransition(
  build: DevelopmentBuild,
  activeUnits: ReadonlyMap<string, UnitActivation>,
  activeRevision: string | undefined,
): ValidatedDevelopmentBuild {
  if (!isRecord(build)) {
    throw new TypeError("development build must be an object");
  }
  const revision = requireString(build.revision, "development build revision");
  let baseRevision: string | undefined;
  if (build.baseRevision !== undefined) {
    baseRevision = requireString(
      build.baseRevision,
      `development build ${JSON.stringify(revision)} base revision`,
    );
  }
  if (baseRevision !== activeRevision) {
    throw new Error(
      `development build ${JSON.stringify(revision)} starts from revision ${
        JSON.stringify(baseRevision)
      }, but the runtime has revision ${JSON.stringify(activeRevision)}`,
    );
  }
  const entryUnit = requireString(
    build.entryUnit,
    `development build ${JSON.stringify(revision)} entry unit`,
  );
  const changedValues = requireArray(
    build.changedUnits,
    `development build ${JSON.stringify(revision)} changed units`,
  );
  const retainedValues = requireArray(
    build.retainedUnits,
    `development build ${JSON.stringify(revision)} retained units`,
  );
  const removedValues = requireArray(
    build.removedUnits,
    `development build ${JSON.stringify(revision)} removed units`,
  );
  const edgeValues = requireArray(
    build.edges,
    `development build ${JSON.stringify(revision)} edges`,
  );
  const durationMilliseconds = build.durationMilliseconds;
  if (
    typeof durationMilliseconds !== "number" ||
    !Number.isFinite(durationMilliseconds) ||
    durationMilliseconds < 0
  ) {
    throw new TypeError(
      `development build ${JSON.stringify(revision)} has invalid duration ${
        String(durationMilliseconds)
      }`,
    );
  }

  const classifications = new Map<
    string,
    "changed" | "retained" | "removed"
  >();
  const classify = (
    name: unknown,
    classification: "changed" | "retained" | "removed",
  ): string => {
    const unitName = requireString(
      name,
      `${classification} unit in development build ${JSON.stringify(revision)}`,
    );
    const previous = classifications.get(unitName);
    if (previous !== undefined) {
      throw new TypeError(
        `development build ${JSON.stringify(revision)} classifies unit ${
          JSON.stringify(unitName)
        } as both ${previous} and ${classification}`,
      );
    }
    classifications.set(unitName, classification);
    return unitName;
  };

  const changedUnits: DevelopmentUnitArtifact[] = [];
  for (const value of changedValues) {
    if (!isRecord(value)) {
      throw new TypeError(
        `changed unit in development build ${
          JSON.stringify(revision)
        } must be an object`,
      );
    }
    const name = classify(value.name, "changed");
    const root = requireString(
      value.root,
      `root for changed unit ${JSON.stringify(name)}`,
    );
    const interfaceDigest = requireString(
      value.interfaceDigest,
      `interface digest for changed unit ${JSON.stringify(name)}`,
    );
    const implementationDigest = requireString(
      value.implementationDigest,
      `implementation digest for changed unit ${JSON.stringify(name)}`,
    );
    const wasmDigest = requireString(
      value.wasmDigest,
      `Wasm digest for changed unit ${JSON.stringify(name)}`,
    );
    if (
      !(value.wasm instanceof Uint8Array) ||
      !(value.manifestBytes instanceof Uint8Array)
    ) {
      throw new TypeError(
        `changed unit ${JSON.stringify(name)} has non-binary artifacts`,
      );
    }
    const capabilities = requireArray(
      value.capabilities,
      `capabilities for changed unit ${JSON.stringify(name)}`,
    ).map((capability, index) =>
      requireString(
        capability,
        `capability ${index} for changed unit ${JSON.stringify(name)}`,
      )
    );
    const artifactSource = value.artifactSource;
    if (artifactSource !== "compiled" && artifactSource !== "unit-cache") {
      throw new TypeError(
        `artifact source for changed unit ${JSON.stringify(name)} is ${
          JSON.stringify(artifactSource)
        }`,
      );
    }
    changedUnits.push({
      name,
      root,
      wasm: value.wasm.slice(),
      manifestBytes: value.manifestBytes.slice(),
      capabilities,
      interfaceDigest,
      implementationDigest,
      wasmDigest,
      artifactSource,
    });
  }
  const retainedUnits: RetainedDevelopmentUnit[] = [];
  for (const value of retainedValues) {
    if (!isRecord(value)) {
      throw new TypeError(
        `retained unit in development build ${
          JSON.stringify(revision)
        } must be an object`,
      );
    }
    const name = classify(value.name, "retained");
    if (!activeUnits.has(name)) {
      throw new Error(
        `development build ${JSON.stringify(revision)} retains inactive unit ${
          JSON.stringify(name)
        }`,
      );
    }
    const interfaceDigest = requireString(
      value.interfaceDigest,
      `interface digest for retained unit ${JSON.stringify(name)}`,
    );
    const implementationDigest = requireString(
      value.implementationDigest,
      `implementation digest for retained unit ${JSON.stringify(name)}`,
    );
    const wasmDigest = requireString(
      value.wasmDigest,
      `Wasm digest for retained unit ${JSON.stringify(name)}`,
    );
    retainedUnits.push({
      name,
      interfaceDigest,
      implementationDigest,
      wasmDigest,
    });
  }
  const removedUnits: string[] = [];
  for (const value of removedValues) {
    const name = classify(value, "removed");
    if (!activeUnits.has(name)) {
      throw new Error(
        `development build ${JSON.stringify(revision)} removes inactive unit ${
          JSON.stringify(name)
        }`,
      );
    }
    removedUnits.push(name);
  }
  for (const active of activeUnits.keys()) {
    if (classifications.has(active)) continue;
    throw new Error(
      `development build ${JSON.stringify(revision)} omits active unit ${
        JSON.stringify(active)
      } from its delta`,
    );
  }

  const finalUnits = new Set(activeUnits.keys());
  for (const removed of removedUnits) finalUnits.delete(removed);
  for (const changed of changedUnits) finalUnits.add(changed.name);
  if (!finalUnits.has(entryUnit)) {
    throw new Error(
      `development build ${JSON.stringify(revision)} omitted entry unit ${
        JSON.stringify(entryUnit)
      }`,
    );
  }
  const edgeIdentities = new Set<string>();
  const edges: Array<DevelopmentBuild["edges"][number]> = [];
  for (const value of edgeValues) {
    if (!isRecord(value)) {
      throw new TypeError(
        `development edge in build ${
          JSON.stringify(revision)
        } must be an object`,
      );
    }
    const consumer = requireString(
      value.consumer,
      `development edge consumer in build ${JSON.stringify(revision)}`,
    );
    const provider = requireString(
      value.provider,
      `development edge provider in build ${JSON.stringify(revision)}`,
    );
    const name = requireString(
      value.name,
      `development edge name in build ${JSON.stringify(revision)}`,
    );
    if (!finalUnits.has(consumer) || !finalUnits.has(provider)) {
      throw new Error(
        `development edge ${JSON.stringify(name)} in build ${
          JSON.stringify(revision)
        } connects ${JSON.stringify(consumer)} to ${
          JSON.stringify(provider)
        }, but the final units are [${[...finalUnits].sort().join(", ")}]`,
      );
    }
    const edge = { consumer, provider, name };
    const identity = developmentEdgeIdentity(edge);
    if (edgeIdentities.has(identity)) {
      throw new Error(
        `development build ${JSON.stringify(revision)} repeats edge ${
          JSON.stringify(name)
        } from ${JSON.stringify(consumer)} to ${JSON.stringify(provider)}`,
      );
    }
    edgeIdentities.add(identity);
    edges.push(edge);
  }
  edges.sort(compareDevelopmentEdges);
  return {
    baseRevision,
    revision,
    entryUnit,
    changedUnits,
    retainedUnits,
    removedUnits,
    edges,
    durationMilliseconds,
  };
}

function developmentEdgeIdentity(
  edge: DevelopmentBuild["edges"][number],
): string {
  return JSON.stringify([edge.consumer, edge.provider, edge.name]);
}

function compareDevelopmentEdges(
  left: DevelopmentBuild["edges"][number],
  right: DevelopmentBuild["edges"][number],
): number {
  const leftIdentity = developmentEdgeIdentity(left);
  const rightIdentity = developmentEdgeIdentity(right);
  if (leftIdentity < rightIdentity) return -1;
  if (leftIdentity > rightIdentity) return 1;
  return 0;
}

function parseExport(
  value: unknown,
  position: string,
): DevelopmentManifest["exports"][number] {
  const encoded = requireRecord(value, position);
  const phase = requireString(encoded.phase, `${position}.phase`);
  if (phase === "comptime") {
    if (
      encoded.name !== null || encoded.function !== null ||
      encoded.postReturn !== null
    ) {
      throw new TypeError(
        `${position} has runtime fields for a comptime export`,
      );
    }
    return { name: null, function: null, postReturn: null };
  }
  if (phase !== "runtime") {
    throw new TypeError(`${position}.phase is ${JSON.stringify(phase)}`);
  }
  const name = requireString(encoded.name, `${position}.name`);
  const function_ = parseFunction(encoded.function, `${position}.function`);
  let postReturn: string | null = null;
  if (encoded.postReturn !== null) {
    postReturn = requireString(encoded.postReturn, `${position}.postReturn`);
  }
  return { name, function: function_, postReturn };
}

function parseLink(
  value: unknown,
  position: string,
): DevelopmentManifest["links"][number] {
  const encoded = requireRecord(value, position);
  const unit = requireString(encoded.unit, `${position}.unit`);
  const name = requireString(encoded.name, `${position}.name`);
  const module = requireString(encoded.module, `${position}.module`);
  if (module !== `blot:dev/${unit}`) {
    throw new TypeError(
      `${position}.module is ${JSON.stringify(module)}, expected ${
        JSON.stringify(`blot:dev/${unit}`)
      }`,
    );
  }
  return {
    unit,
    name,
    module,
    function: parseFunction(encoded.function, `${position}.function`),
  };
}

function parseFunction(value: unknown, position: string): BlotAbiFunction {
  const encoded = requireRecord(value, position);
  return {
    parameters: requireArray(encoded.parameters, `${position}.parameters`).map(
      (parameter, index) =>
        parseAbiType(parameter, `${position}.parameters[${index}]`, 0),
    ),
    result: parseAbiType(encoded.result, `${position}.result`, 0),
  };
}

function parseAbiType(
  value: unknown,
  position: string,
  depth: number,
): BlotAbiType {
  if (depth > 64) {
    throw new TypeError(`${position} exceeds 64 nested ABI types`);
  }
  const encoded = requireRecord(value, position);
  const kind = requireString(encoded.kind, `${position}.kind`);
  if (kind === "unit") return { kind: "unit" };
  if (kind === "signed-integer-64") return { kind: "signed-integer-64" };
  if (kind === "float-32") return { kind: "float-32" };
  if (kind === "float-64") return { kind: "float-64" };
  if (kind === "boolean") return { kind: "boolean" };
  if (kind === "text") return { kind: "text" };
  if (kind === "array") {
    return {
      kind: "array",
      element: parseAbiType(encoded.element, `${position}.element`, depth + 1),
    };
  }
  if (kind === "sealed") {
    return {
      kind: "sealed",
      name: requireString(encoded.name, `${position}.name`),
      inner: parseAbiType(encoded.inner, `${position}.inner`, depth + 1),
    };
  }
  if (kind === "record") {
    let previousName: string | undefined;
    const fields = requireArray(encoded.fields, `${position}.fields`).map(
      (field, index) => {
        const fieldPosition = `${position}.fields[${index}]`;
        const encodedField = requireRecord(field, fieldPosition);
        const name = requireString(encodedField.name, `${fieldPosition}.name`);
        if (previousName !== undefined && previousName >= name) {
          throw new TypeError(
            `${position} fields are not in unique canonical order at ${
              JSON.stringify(name)
            }`,
          );
        }
        previousName = name;
        return {
          name,
          type: parseAbiType(
            encodedField.type,
            `${fieldPosition}.type`,
            depth + 1,
          ),
        };
      },
    );
    return { kind: "record", fields };
  }
  if (kind === "variant") {
    let previousName: string | undefined;
    const cases = requireArray(encoded.cases, `${position}.cases`).map(
      (case_, index) => {
        const casePosition = `${position}.cases[${index}]`;
        const encodedCase = requireRecord(case_, casePosition);
        const name = requireString(encodedCase.name, `${casePosition}.name`);
        if (previousName !== undefined && previousName >= name) {
          throw new TypeError(
            `${position} cases are not in unique canonical order at ${
              JSON.stringify(name)
            }`,
          );
        }
        previousName = name;
        if (!Object.hasOwn(encodedCase, "payload")) return { name };
        return {
          name,
          payload: parseAbiType(
            encodedCase.payload,
            `${casePosition}.payload`,
            depth + 1,
          ),
        };
      },
    );
    if (cases.length === 0) {
      throw new TypeError(`${position} has no variant cases`);
    }
    return { kind: "variant", cases };
  }
  throw new TypeError(
    `${position}.kind is unsupported ${JSON.stringify(kind)}`,
  );
}

function requireEmbeddedManifest(
  module: WebAssembly.Module,
  artifact: DevelopmentUnitArtifact,
): void {
  const sections = WebAssembly.Module.customSections(module, "blot:abi");
  if (sections.length !== 1) {
    throw new Error(
      `development unit ${
        JSON.stringify(artifact.name)
      } has ${sections.length} embedded ABI manifests, expected one`,
    );
  }
  const embedded = new Uint8Array(sections[0]);
  if (!equalBytes(embedded, artifact.manifestBytes)) {
    throw new Error(
      `development unit ${
        JSON.stringify(artifact.name)
      } sidecar and embedded ABI manifests differ`,
    );
  }
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function requireRecord(
  value: unknown,
  position: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${position} must be an object`);
  return value;
}

function requireArray(value: unknown, position: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${position} must be an array`);
  }
  return value;
}

function requireString(value: unknown, position: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `${position} must be non-empty text, found ${String(value)}`,
    );
  }
  return value;
}

function invokeLink(
  consumerName: string,
  consumer: WebAssembly.Instance,
  consumerManifest: DevelopmentManifest,
  function_: BlotAbiFunction,
  provider: UnitActivation,
  linkName: string,
  arguments_: readonly WasmValue[],
): WasmValue | undefined {
  const exportName = `blot:dev:${linkName}`;
  const exports = provider.manifest.exports.filter((candidate) =>
    candidate.name === exportName
  );
  const exported = exports[0];
  if (
    exports.length !== 1 || exported === undefined ||
    exported.function === null || exported.name === null
  ) {
    throw new Error(
      `active development provider ${
        JSON.stringify(provider.artifact.name)
      } lost validated export ${JSON.stringify(exportName)}`,
    );
  }
  const consumerMemory = requiredMemory(
    consumer,
    consumerManifest,
    consumerName,
  );
  const providerMemory = requiredMemory(
    provider.instance,
    provider.manifest,
    provider.artifact.name,
  );
  const providerReallocate = requiredReallocate(provider);
  const allocations: Allocation[] = [];
  const parameterWidth = function_.parameters.flatMap(flattenedAbiType).length;
  const resultWidth = flattenedAbiType(function_.result).length;
  let expectedArguments = parameterWidth;
  if (resultWidth > 1) expectedArguments += 1;
  if (arguments_.length !== expectedArguments) {
    throw new Error(
      `development link ${
        JSON.stringify(exportName)
      } received ${arguments_.length} Wasm values, expected ${expectedArguments}`,
    );
  }

  let offset = 0;
  const providerArguments: WasmValue[] = [];
  for (const parameter of function_.parameters) {
    const width = flattenedAbiType(parameter).length;
    providerArguments.push(...copyFlatValue(
      parameter,
      arguments_.slice(offset, offset + width),
      consumerMemory,
      providerMemory,
      providerReallocate,
      allocations,
    ));
    offset += width;
  }

  const callable = requiredExportedFunction(provider.instance, exportName);
  let providerResultPointer: number | undefined;
  try {
    const raw = callable(...providerArguments);
    if (resultWidth === 0) return undefined;
    if (resultWidth === 1) {
      if (!isWasmValue(raw)) {
        throw new Error(
          `development export ${
            JSON.stringify(exportName)
          } returned an invalid direct value`,
        );
      }
      return copyFlatValue(
        function_.result,
        [raw],
        providerMemory,
        consumerMemory,
        requiredReallocateFromInstance(consumer, consumerName),
        [],
      )[0];
    }
    if (typeof raw !== "number") {
      throw new Error(
        `development export ${
          JSON.stringify(exportName)
        } omitted its result pointer`,
      );
    }
    providerResultPointer = raw;
    const resultPointer = arguments_[arguments_.length - 1];
    if (typeof resultPointer !== "number") {
      throw new Error(
        `development link ${
          JSON.stringify(exportName)
        } received an invalid caller result pointer`,
      );
    }
    copyMemoryValue(
      function_.result,
      providerMemory,
      raw,
      consumerMemory,
      resultPointer,
      requiredReallocateFromInstance(consumer, consumerName),
      [],
    );
    return undefined;
  } finally {
    if (exported.postReturn !== null && providerResultPointer !== undefined) {
      const postReturn = requiredExportedFunction(
        provider.instance,
        exported.postReturn,
      );
      postReturn(providerResultPointer);
    }
    for (const allocation of allocations.reverse()) {
      providerReallocate(
        allocation.pointer,
        allocation.size,
        allocation.alignment,
        0,
      );
    }
  }
}

function copyFlatValue(
  type: BlotAbiType,
  values: readonly WasmValue[],
  sourceMemory: WebAssembly.Memory,
  targetMemory: WebAssembly.Memory,
  targetReallocate: Reallocate,
  allocations: Allocation[],
): WasmValue[] {
  if (type.kind === "unit") return [];
  if (
    type.kind === "signed-integer-64" || type.kind === "float-32" ||
    type.kind === "float-64" || type.kind === "boolean"
  ) return [requiredWasmValue(values[0], type.kind)];
  if (type.kind === "sealed") {
    return copyFlatValue(
      type.inner,
      values,
      sourceMemory,
      targetMemory,
      targetReallocate,
      allocations,
    );
  }
  if (type.kind === "text") {
    const pointer = requiredPointer(values[0], "text pointer");
    const length = requiredLength(values[1], "text length");
    const copied = copyBytes(
      sourceMemory,
      pointer,
      length,
      targetMemory,
      1,
      targetReallocate,
      allocations,
    );
    return [copied, length];
  }
  if (type.kind === "array") {
    const pointer = requiredPointer(values[0], "array pointer");
    const length = requiredLength(values[1], "array length");
    const element = memoryLayout(type.element);
    const size = checkedSize(length, element.size, "array allocation");
    const copied = allocate(
      targetReallocate,
      size,
      element.alignment,
      allocations,
    );
    for (let index = 0; index < length; index += 1) {
      copyMemoryValue(
        type.element,
        sourceMemory,
        pointer + index * element.size,
        targetMemory,
        copied + index * element.size,
        targetReallocate,
        allocations,
      );
    }
    return [copied, length];
  }
  if (type.kind === "record") {
    const copied: WasmValue[] = [];
    let offset = 0;
    for (const field of type.fields) {
      const width = flattenedAbiType(field.type).length;
      copied.push(...copyFlatValue(
        field.type,
        values.slice(offset, offset + width),
        sourceMemory,
        targetMemory,
        targetReallocate,
        allocations,
      ));
      offset += width;
    }
    return copied;
  }
  const tag = requiredLength(values[0], "variant tag");
  const selected = type.cases[tag];
  if (selected === undefined) {
    throw new RangeError(
      `variant tag ${tag} exceeds ${type.cases.length} cases`,
    );
  }
  const joined = flattenedAbiType(type).slice(1);
  const copied: WasmValue[] = [tag, ...joined.map(zeroWasmValue)];
  if (selected.payload === undefined) return copied;
  const width = flattenedAbiType(selected.payload).length;
  const payload = copyFlatValue(
    selected.payload,
    values.slice(1, 1 + width),
    sourceMemory,
    targetMemory,
    targetReallocate,
    allocations,
  );
  copied.splice(1, payload.length, ...payload);
  return copied;
}

function copyMemoryValue(
  type: BlotAbiType,
  sourceMemory: WebAssembly.Memory,
  sourcePointer: number,
  targetMemory: WebAssembly.Memory,
  targetPointer: number,
  targetReallocate: Reallocate,
  allocations: Allocation[],
): void {
  const layout = memoryLayout(type);
  requireMemoryRange(sourceMemory, sourcePointer, layout.size, "source value");
  requireMemoryRange(targetMemory, targetPointer, layout.size, "target value");
  if (type.kind === "unit") return;
  if (type.kind === "boolean") {
    writeView(targetMemory).setUint8(
      targetPointer,
      readView(sourceMemory).getUint8(sourcePointer),
    );
    return;
  }
  if (type.kind === "signed-integer-64") {
    writeView(targetMemory).setBigInt64(
      targetPointer,
      readView(sourceMemory).getBigInt64(sourcePointer, true),
      true,
    );
    return;
  }
  if (type.kind === "float-32") {
    writeView(targetMemory).setFloat32(
      targetPointer,
      readView(sourceMemory).getFloat32(sourcePointer, true),
      true,
    );
    return;
  }
  if (type.kind === "float-64") {
    writeView(targetMemory).setFloat64(
      targetPointer,
      readView(sourceMemory).getFloat64(sourcePointer, true),
      true,
    );
    return;
  }
  if (type.kind === "sealed") {
    copyMemoryValue(
      type.inner,
      sourceMemory,
      sourcePointer,
      targetMemory,
      targetPointer,
      targetReallocate,
      allocations,
    );
    return;
  }
  if (type.kind === "text") {
    const source = readView(sourceMemory);
    const pointer = source.getUint32(sourcePointer, true);
    const length = source.getUint32(sourcePointer + 4, true);
    const copied = copyBytes(
      sourceMemory,
      pointer,
      length,
      targetMemory,
      1,
      targetReallocate,
      allocations,
    );
    const target = writeView(targetMemory);
    target.setUint32(targetPointer, copied, true);
    target.setUint32(targetPointer + 4, length, true);
    return;
  }
  if (type.kind === "array") {
    const source = readView(sourceMemory);
    const pointer = source.getUint32(sourcePointer, true);
    const length = source.getUint32(sourcePointer + 4, true);
    const element = memoryLayout(type.element);
    const size = checkedSize(length, element.size, "array allocation");
    const copied = allocate(
      targetReallocate,
      size,
      element.alignment,
      allocations,
    );
    for (let index = 0; index < length; index += 1) {
      copyMemoryValue(
        type.element,
        sourceMemory,
        pointer + index * element.size,
        targetMemory,
        copied + index * element.size,
        targetReallocate,
        allocations,
      );
    }
    const target = writeView(targetMemory);
    target.setUint32(targetPointer, copied, true);
    target.setUint32(targetPointer + 4, length, true);
    return;
  }
  if (type.kind === "record") {
    for (const field of recordLayout(type)) {
      copyMemoryValue(
        field.type,
        sourceMemory,
        sourcePointer + field.offset,
        targetMemory,
        targetPointer + field.offset,
        targetReallocate,
        allocations,
      );
    }
    return;
  }
  const variant = variantLayout(type);
  const source = readView(sourceMemory);
  let tag: number;
  if (variant.discriminantSize === 1) tag = source.getUint8(sourcePointer);
  else if (variant.discriminantSize === 2) {
    tag = source.getUint16(sourcePointer, true);
  } else tag = source.getUint32(sourcePointer, true);
  const selected = type.cases[tag];
  if (selected === undefined) {
    throw new RangeError(
      `variant tag ${tag} exceeds ${type.cases.length} cases`,
    );
  }
  const target = writeView(targetMemory);
  if (variant.discriminantSize === 1) target.setUint8(targetPointer, tag);
  else if (variant.discriminantSize === 2) {
    target.setUint16(targetPointer, tag, true);
  } else target.setUint32(targetPointer, tag, true);
  if (selected.payload === undefined) return;
  copyMemoryValue(
    selected.payload,
    sourceMemory,
    sourcePointer + variant.payloadOffset,
    targetMemory,
    targetPointer + variant.payloadOffset,
    targetReallocate,
    allocations,
  );
}

function copyBytes(
  sourceMemory: WebAssembly.Memory,
  sourcePointer: number,
  length: number,
  targetMemory: WebAssembly.Memory,
  alignment: number,
  targetReallocate: Reallocate,
  allocations: Allocation[],
): number {
  if (length === 0) return 0;
  requireMemoryRange(sourceMemory, sourcePointer, length, "byte sequence");
  const bytes = new Uint8Array(sourceMemory.buffer, sourcePointer, length)
    .slice();
  const pointer = allocate(targetReallocate, length, alignment, allocations);
  requireMemoryRange(targetMemory, pointer, length, "copied byte sequence");
  new Uint8Array(targetMemory.buffer, pointer, length).set(bytes);
  return pointer;
}

function allocate(
  reallocate: Reallocate,
  size: number,
  alignment: number,
  allocations: Allocation[],
): number {
  if (size === 0) return 0;
  const pointer = reallocate(0, 0, alignment, size);
  allocations.push({ pointer, size, alignment });
  return pointer;
}

function requiredMemory(
  instance: WebAssembly.Instance,
  manifest: DevelopmentManifest,
  unit: string,
): WebAssembly.Memory {
  const memory = instance.exports[manifest.abi.memoryExport];
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error(
      `development unit ${JSON.stringify(unit)} omitted memory export ${
        JSON.stringify(manifest.abi.memoryExport)
      }`,
    );
  }
  return memory;
}

function requiredReallocate(active: UnitActivation): Reallocate {
  return requiredReallocateFromInstance(active.instance, active.artifact.name);
}

function requiredReallocateFromInstance(
  instance: WebAssembly.Instance,
  unit: string,
): Reallocate {
  const value = instance.exports.cabi_realloc;
  if (typeof value !== "function") {
    throw new Error(
      `development unit ${JSON.stringify(unit)} omitted cabi_realloc`,
    );
  }
  return value as Reallocate;
}

function requiredExportedFunction(
  instance: WebAssembly.Instance,
  name: string,
): (...arguments_: WasmValue[]) => unknown {
  const value = instance.exports[name];
  if (typeof value !== "function") {
    throw new Error(
      `development provider omitted Wasm export ${JSON.stringify(name)}`,
    );
  }
  return value as (...arguments_: WasmValue[]) => unknown;
}

function memoryLayout(type: BlotAbiType): { alignment: number; size: number } {
  if (type.kind === "unit") return { alignment: 1, size: 0 };
  if (type.kind === "boolean") return { alignment: 1, size: 1 };
  if (type.kind === "float-32") return { alignment: 4, size: 4 };
  if (type.kind === "signed-integer-64" || type.kind === "float-64") {
    return { alignment: 8, size: 8 };
  }
  if (type.kind === "text" || type.kind === "array") {
    return { alignment: 4, size: 8 };
  }
  if (type.kind === "sealed") return memoryLayout(type.inner);
  if (type.kind === "record") {
    const fields = recordLayout(type);
    const alignment = fields.reduce(
      (maximum, field) => Math.max(maximum, memoryLayout(field.type).alignment),
      1,
    );
    const end = fields.reduce(
      (maximum, field) =>
        Math.max(
          maximum,
          field.offset + memoryLayout(field.type).size,
        ),
      0,
    );
    return { alignment, size: alignTo(end, alignment) };
  }
  const variant = variantLayout(type);
  return { alignment: variant.alignment, size: variant.size };
}

function recordLayout(type: Extract<BlotAbiType, { kind: "record" }>) {
  let offset = 0;
  return type.fields.map((field) => {
    const layout = memoryLayout(field.type);
    offset = alignTo(offset, layout.alignment);
    const result = { ...field, offset };
    offset += layout.size;
    return result;
  });
}

function variantLayout(type: Extract<BlotAbiType, { kind: "variant" }>) {
  let discriminantSize = 4;
  if (type.cases.length <= 65_536) discriminantSize = 2;
  if (type.cases.length <= 256) discriminantSize = 1;
  let payloadAlignment = 1;
  let payloadSize = 0;
  for (const case_ of type.cases) {
    if (case_.payload === undefined) continue;
    const layout = memoryLayout(case_.payload);
    payloadAlignment = Math.max(payloadAlignment, layout.alignment);
    payloadSize = Math.max(payloadSize, layout.size);
  }
  const alignment = Math.max(discriminantSize, payloadAlignment);
  const payloadOffset = alignTo(discriminantSize, payloadAlignment);
  return {
    discriminantSize,
    payloadOffset,
    alignment,
    size: alignTo(payloadOffset + payloadSize, alignment),
  };
}

function requiredPointer(
  value: WasmValue | undefined,
  position: string,
): number {
  const pointer = requiredLength(value, position);
  if (pointer > 0xffff_ffff) {
    throw new RangeError(`${position} ${pointer} exceeds memory32`);
  }
  return pointer;
}

function requiredLength(
  value: WasmValue | undefined,
  position: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `${position} is not a non-negative i32: ${String(value)}`,
    );
  }
  return value;
}

function requiredWasmValue(
  value: WasmValue | undefined,
  position: string,
): WasmValue {
  if (!isWasmValue(value)) {
    throw new TypeError(`${position} has invalid Wasm value ${String(value)}`);
  }
  return value;
}

function requireMemoryRange(
  memory: WebAssembly.Memory,
  pointer: number,
  length: number,
  position: string,
): void {
  if (
    !Number.isInteger(pointer) || !Number.isInteger(length) || pointer < 0 ||
    length < 0 || pointer + length > memory.buffer.byteLength
  ) {
    throw new RangeError(
      `${position} range ${pointer}..${
        pointer + length
      } exceeds ${memory.buffer.byteLength}-byte memory`,
    );
  }
}

function checkedSize(count: number, size: number, position: string): number {
  const result = count * size;
  if (!Number.isSafeInteger(result) || result > 0xffff_ffff) {
    throw new RangeError(`${position} ${count} * ${size} exceeds memory32`);
  }
  return result;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function readView(memory: WebAssembly.Memory): DataView {
  return new DataView(memory.buffer);
}

function writeView(memory: WebAssembly.Memory): DataView {
  return new DataView(memory.buffer);
}

function zeroWasmValue(type: "i32" | "i64" | "f32" | "f64"): WasmValue {
  if (type === "i64") return 0n;
  return 0;
}

function isWasmValue(value: unknown): value is WasmValue {
  return typeof value === "number" || typeof value === "bigint";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
