import { createHash } from "node:crypto";
import type { Loaded } from "./frontend.ts";
import { encodePortableModule } from "../syntax/portable.ts";

const revisionKeyByLoaded = new WeakMap<Loaded, string>();

/**
 * Process-local semantic revision identity for one loaded module graph node.
 *
 * Child revisions enter by their fixed-size digest rather than by embedding the
 * child's serialized key. The canonical portable AST still owns semantic/source
 * location equality, so comment-only revisions keep the same key while edits
 * that move or change syntax do not.
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
