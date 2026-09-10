import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";

// Administrative guest calls have fixed ABI arities even when source exports vary.
const arities = new Map([
  ["cabi_enter", 0],
  ["cabi_leave", 1],
  ["cabi_realloc", 5],
  ["blot:poll", 3],
  ["blot:resume", 2],
  ["blot:cancel", 2],
  ["blot:release", 2],
]);
const files = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collect(path);
    else if (/\.(?:ts|mjs|js)$/.test(entry.name)) files.push(path);
  }
}
for (
  const directory of [
    "src",
    "scripts",
    "experiments",
    "case-studies",
    "test_support",
  ]
) {
  await collect(directory);
}
const api = new API({ cwd: process.cwd() });
const snapshot = api.updateSnapshot({
  openFiles: files.map((path) => resolve(path)),
});
const aliases = new Map();
function unwrap(node) {
  while (
    ts.isAsExpression(node) || ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node)
  ) node = node.expression;
  return node;
}
function exportedName(expression) {
  const node = unwrap(expression);
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "exports"
  ) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "exports" &&
    ts.isStringLiteralLikeNode(node.argumentExpression)
  ) return node.argumentExpression.text;
  if (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === "requiredFunction" &&
    node.arguments.length === 2 && ts.isStringLiteralLikeNode(node.arguments[1])
  ) return node.arguments[1].text;
}
const sources = files.map((path) => {
  const project = snapshot.getDefaultProjectForFile(resolve(path));
  if (project === undefined) {
    throw new Error(`guest ABI audit lost project for ${path}`);
  }
  return {
    source: project.program.getSourceFile(resolve(path)),
    checker: project.checker,
  };
});
for (const { source, checker } of sources) {
  if (source === undefined) {
    throw new Error("guest ABI audit lost a source file");
  }
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const name = exportedName(node.initializer);
      if (name !== undefined) {
        aliases.set(checker.getSymbolAtLocation(node.name), name);
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
}
let failures = 0;
let checked = 0;
for (const { source, checker } of sources) {
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const target = unwrap(node.expression);
      let name = exportedName(target);
      let prefix = 0;
      if (name === undefined && ts.isIdentifier(target)) {
        name = aliases.get(checker.getSymbolAtLocation(target));
      }
      if (name === undefined) {
        const named = node.arguments.findIndex((argument) =>
          ts.isStringLiteralLikeNode(argument) &&
          (arities.has(argument.text) || argument.text.startsWith("cabi_post_"))
        );
        if (named >= 0 && ts.isIdentifier(target) && target.text === "invoke") {
          name = node.arguments[named].text;
          prefix = named + 1;
        }
      }
      let expected = arities.get(name);
      if (name?.startsWith("cabi_post_")) expected = 2;
      if (expected !== undefined && !node.arguments.some(ts.isSpreadElement)) {
        checked += 1;
        const count = node.arguments.length - prefix;
        const discardedScope = name === "cabi_enter" &&
          ts.isExpressionStatement(node.parent);
        if (count !== expected || discardedScope) {
          const position = source.getLineAndCharacterOfPosition(
            node.getStart(source),
          );
          let reason =
            `${name} expects ${expected} raw arguments, found ${count}`;
          if (discardedScope) reason = "cabi_enter token is discarded";
          console.error(`${source.fileName}:${position.line + 1}: ${reason}`);
          failures += 1;
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
}
console.log(
  `Checked ${checked} administrative guest calls across ${files.length} files.`,
);
snapshot.dispose();
api.close();
if (failures !== 0) process.exitCode = 1;
