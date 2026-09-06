import * as path from "node:path";

type PathStyle = Pick<typeof path, "isAbsolute" | "relative" | "sep">;

/**
 * Return a root-relative name, or null when the target is lexically outside it.
 * Only the selected path style's separators become `/`; a POSIX backslash is
 * part of a filename. This does not resolve symlinks or provide a filesystem
 * sandbox. An explicit style lets callers check either platform's path rules.
 */
export function relativeWithinRoot(
  root: string,
  target: string,
  style: PathStyle = path,
): string | null {
  const relative = style.relative(root, target);
  if (
    style.isAbsolute(relative) || relative === ".." ||
    relative.startsWith(`..${style.sep}`)
  ) {
    return null;
  }
  return relative.split(style.sep).join("/");
}
