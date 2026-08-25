import { resolve } from "node:path";
import { Compiler } from "../../src/compiler.ts";
import { compilerObservation } from "./observation.ts";

const path = process.argv[2];
if (path === undefined) {
  throw new Error("cold process benchmark requires a path");
}

const compiler = await Compiler.create();
try {
  const checked = await compiler.check(resolve(path));
  process.stdout.write(JSON.stringify({
    observation: compilerObservation(checked),
    hostRssBytes: process.memoryUsage().rss,
  }));
} finally {
  compiler.destroy();
}
