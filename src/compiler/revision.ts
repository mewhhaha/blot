import { createHash } from "node:crypto";
import type { Loaded } from "./frontend.ts";
import { encodePortableModule } from "../syntax/portable.ts";

const revisionKeyByLoaded = new WeakMap<Loaded, string>();

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
  const key = createHash("sha256")
    .update(JSON.stringify({
      path: loaded.path,
      module: encodePortableModule(loaded.module),
      dependencies,
      includedFiles,
    }))
    .digest("hex");
  revisionKeyByLoaded.set(loaded, key);
  return key;
}
