import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

class NotFound extends Error {}

function translateNotFound(error) {
  if (error !== null && typeof error === "object" && error.code === "ENOENT") {
    const translated = new NotFound(error.message);
    translated.cause = error;
    throw translated;
  }
  throw error;
}

async function makeTempDir(options = {}) {
  let directory = options.dir;
  if (directory === undefined) directory = tmpdir();
  let prefix = options.prefix;
  if (prefix === undefined) prefix = "blot-test-";
  const path = await mkdtemp(join(directory, prefix));
  if (options.suffix === undefined) return path;
  const suffixed = path + options.suffix;
  await rename(path, suffixed);
  return suffixed;
}

async function makeTempFile(options = {}) {
  const directory = await makeTempDir({
    dir: options.dir,
    prefix: options.prefix,
  });
  let suffix = options.suffix;
  if (suffix === undefined) suffix = "";
  const path = join(directory, `file${suffix}`);
  const file = await open(path, "wx");
  await file.close();
  return path;
}

async function* readDir(path) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    translateNotFound(error);
  }
  for (const entry of entries) {
    yield {
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymlink: entry.isSymbolicLink(),
    };
  }
}

async function denoReadFile(path) {
  try {
    return await readFile(path);
  } catch (error) {
    translateNotFound(error);
  }
}

async function readTextFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    translateNotFound(error);
  }
}

async function denoStat(path) {
  try {
    const value = await stat(path);
    return {
      isFile: value.isFile(),
      isDirectory: value.isDirectory(),
      isSymlink: value.isSymbolicLink(),
      size: value.size,
      mtime: value.mtime,
    };
  } catch (error) {
    translateNotFound(error);
  }
}

function registerTest(nameOrDefinition, fn) {
  if (typeof nameOrDefinition === "string") {
    test(nameOrDefinition, fn);
    return;
  }
  test(
    nameOrDefinition.name,
    { skip: nameOrDefinition.ignore },
    nameOrDefinition.fn,
  );
}

globalThis.Deno = {
  errors: { NotFound },
  makeTempDir,
  makeTempFile,
  mkdir,
  readDir,
  readFile: denoReadFile,
  readTextFile,
  remove: rm,
  stat: denoStat,
  test: registerTest,
  writeFile,
  writeTextFile: (path, contents) => writeFile(path, contents, "utf8"),
};
