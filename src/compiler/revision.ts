import { createHash } from "node:crypto";
import { compareCodeUnits } from "../text_order.ts";
import type { Loaded } from "./frontend.ts";
import { encodePortableModule } from "../syntax/portable.ts";

const revisionKeyByLoaded = new WeakMap<Loaded, string>();
const payloadDigestByLoaded = new WeakMap<Loaded, string>();
const configurationDigestByLoaded = new WeakMap<Loaded, string>();

export type InstalledStorage = "source" | "ast" | "snapshot";

export interface InstalledModuleRevision {
  readonly payloadDigest: string;
  readonly configurationDigest: string;
  readonly storage: InstalledStorage;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Local payload identity; transitive dependency revisions deliberately do not enter. */
export function loadedPayloadDigest(loaded: Loaded): string {
  const cached = payloadDigestByLoaded.get(loaded);
  if (cached !== undefined) return cached;

  let payloadDigest: string;
  if (loaded.storage.tag === "source") {
    payloadDigest = digest({
      path: loaded.path,
      storage: "source",
      source: loaded.source,
    });
  } else if (loaded.storage.tag === "snapshot") {
    payloadDigest = digest({
      path: loaded.path,
      storage: "snapshot",
      digest: loaded.storage.digest,
    });
  } else {
    payloadDigest = digest({
      path: loaded.path,
      storage: "ast",
      module: encodePortableModule(loaded.module),
    });
  }
  payloadDigestByLoaded.set(loaded, payloadDigest);
  return payloadDigest;
}

/** Exact direct graph-edge and include identity for one configured module. */
export function loadedConfigurationDigest(loaded: Loaded): string {
  const cached = configurationDigestByLoaded.get(loaded);
  if (cached !== undefined) return cached;

  const imports = [...loaded.dependencies]
    .map(([specifier, dependency]) => [specifier, dependency.path] as const)
    .sort(([left], [right]) => compareCodeUnits(left, right));
  const includes = [...loaded.includedFiles]
    .map(([specifier, included]) =>
      [
        specifier,
        included.path,
        included.source,
      ] as const
    )
    .sort(([left], [right]) => compareCodeUnits(left, right));
  const configurationDigest = digest({ imports, includes });
  configurationDigestByLoaded.set(loaded, configurationDigest);
  return configurationDigest;
}

/**
 * Exact process-local compiler-output identity for one loaded graph node.
 *
 * Child revisions enter by their fixed-size digest rather than by embedding the
 * child's serialized key. The portable AST retains every observable origin and
 * span, so an edit that shifts source locations cannot inherit a prior
 * ClosedProgram. Text outside the accepted syntax may reuse it when every
 * source artifact is byte-for-byte identical.
 */
export function loadedRevisionKey(loaded: Loaded): string {
  const cached = revisionKeyByLoaded.get(loaded);
  if (cached !== undefined) return cached;

  const dependencies = [...loaded.dependencies].map(
    ([specifier, dependency]) => ({
      specifier,
      revision: loadedRevisionKey(dependency),
    }),
  );
  const includedFiles = [...loaded.includedFiles].map(
    ([specifier, included]) => ({
      specifier,
      path: included.path,
      source: included.source,
    }),
  );
  let moduleRevision: unknown;
  if (loaded.storage.tag === "snapshot") {
    moduleRevision = { snapshot: loaded.storage.digest };
  } else {
    moduleRevision = encodePortableModule(loaded.module);
  }
  const key = digest({
    path: loaded.path,
    module: moduleRevision,
    dependencies,
    includedFiles,
  });
  revisionKeyByLoaded.set(loaded, key);
  return key;
}
