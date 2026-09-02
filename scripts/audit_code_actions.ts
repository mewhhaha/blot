import { resolve, toFileUrl } from "@std/path";
import { LanguageService, positionAtOffset } from "../src/language_service.ts";

const excludedDirectories = new Set(["pending", "rejected", "traps"]);
const paths: string[] = [];
await collectBlotFiles("examples", paths);
await collectBlotFiles("case-studies", paths);
paths.sort();

const service = new LanguageService();
let actionCount = 0;
try {
  for (const path of paths) {
    const source = await Deno.readTextFile(path);
    const uri = toFileUrl(resolve(path)).href;
    service.open(uri, source, 1);
    try {
      const actions = await service.codeActions(uri, {
        start: { line: 0, character: 0 },
        end: positionAtOffset(source, source.length),
      });
      actionCount += actions.length;
      const edits = new Set<string>();
      for (const action of actions) {
        const key = JSON.stringify(action.edit);
        if (edits.has(key)) {
          throw new Error(
            `${path} publishes duplicate code action edit ${action.title}`,
          );
        }
        edits.add(key);
      }
    } finally {
      await service.close(uri);
    }
  }
} finally {
  await service.destroy();
}

console.log(
  `${actionCount} unique code actions in ${paths.length} accepted files`,
);

async function collectBlotFiles(
  root: string,
  collected: string[],
): Promise<void> {
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      if (!excludedDirectories.has(entry.name)) {
        await collectBlotFiles(path, collected);
      }
      continue;
    }
    if (entry.isFile && entry.name.endsWith(".blot")) collected.push(path);
  }
}
