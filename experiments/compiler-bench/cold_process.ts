import { resolve } from "node:path";
import { Compiler } from "../../src/compiler.ts";

const path = process.argv[2];
if (path === undefined) {
  throw new Error("cold process benchmark requires a path");
}

const compiler = await Compiler.create();
try {
  const checked = await compiler.check(resolve(path));
  process.stdout.write(JSON.stringify({
    observation: JSON.stringify({
      type: checked.type,
      effects: checked.effects,
    }),
    hostRssBytes: process.memoryUsage().rss,
  }));
} finally {
  compiler.destroy();
}
