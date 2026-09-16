// scripts/helix_languages.ts
//
// The pure core of the Helix installer: the managed `languages.toml` block
// and the installed language-server command it points at.
//
// scripts/setup_helix.ts owns the impure work (generating and building the
// Tree-sitter grammar, writing files). This module owns the exact block text
// and the replace-or-append merge so tests can pin them without building a
// grammar: the managed block must keep pointing at the Deno `lsp` command,
// keep `auto-format = true`, and add no client timeout override.

import { join } from "@std/path";

/** The installed language server: `deno run` with read permission on the CLI. */
export interface InstalledLspCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** The CLI entry the installed server command executes. */
export function repositoryCliPath(repository: string): string {
  return join(repository, "src", "cli.ts");
}

/** The exact argv the managed block installs for the blot language server. */
export function installedLspCommand(repository: string): InstalledLspCommand {
  return {
    command: "deno",
    args: ["run", "--allow-read", repositoryCliPath(repository), "lsp"],
  };
}

/** The opening delimiter of the managed block for one checkout. */
export function helixBeginMarker(repository: string): string {
  return `# >>> blot (managed by ${repository}) >>>`;
}

/** The closing delimiter of the managed block for one checkout. */
export function helixEndMarker(repository: string): string {
  return `# <<< blot (managed by ${repository}) <<<`;
}

/**
 * Renders the managed `languages.toml` block for one checkout.
 *
 * The block registers the Deno language server, the blot language (with
 * format on save through the LSP and no timeout override), and the generated
 * grammar. Re-running the installer replaces this block rather than
 * appending a second copy.
 */
export function helixManagedBlock(repository: string): string {
  const beginMarker = helixBeginMarker(repository);
  const endMarker = helixEndMarker(repository);
  const grammarDirectory = join(repository, "tree-sitter-blot");
  const server = installedLspCommand(repository);
  const args = server.args.map((argument) => JSON.stringify(argument)).join(
    ", ",
  );
  return `${beginMarker}
[language-server.blot]
command = ${JSON.stringify(server.command)}
args = [${args}]

[[language]]
name = "blot"
language-id = "blot"
scope = "source.blot"
injection-regex = "^blot$"
file-types = ["blot"]
roots = ["AGENTS.md", "deno.json", ".git"]
comment-token = "//"
grammar = "blot"
language-servers = ["blot"]
auto-format = true
text-width = 80
rainbow-brackets = true
indent = { tab-width = 2, unit = "  " }

[[grammar]]
name = "blot"
source = { path = "${grammarDirectory}" }
${endMarker}
`;
}

/**
 * Merges the managed block into existing `languages.toml` content.
 *
 * An earlier block for the same checkout is replaced in place; otherwise the
 * block is appended after the existing content. A block with no closing
 * marker is left for a human to remove: this throws instead of guessing.
 */
export function installHelixManagedBlock(
  existing: string,
  repository: string,
  languagesPath: string,
): string {
  const beginMarker = helixBeginMarker(repository);
  const endMarker = helixEndMarker(repository);
  let languages = existing;
  const start = languages.indexOf(beginMarker);
  if (start >= 0) {
    const end = languages.indexOf(endMarker, start);
    if (end < 0) {
      throw new Error(
        `${languagesPath} has a blot block with no closing marker; remove it by hand and re-run.`,
      );
    }
    languages = languages.slice(0, start) +
      languages.slice(end + endMarker.length);
  }
  const block = helixManagedBlock(repository);
  return `${languages.trimEnd()}\n\n${block}`;
}
