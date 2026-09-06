import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";
import { relativeWithinRoot } from "./host_paths.ts";

const posixCases: readonly (readonly [string, string, string | null])[] = [
  ["/pkg", "/pkg", ""],
  ["/pkg", "/pkg/src/main.blot", "src/main.blot"],
  ["/pkg", "/pkg/src/../main.blot", "main.blot"],
  ["/pkg", "/pkg/..hidden/main.blot", "..hidden/main.blot"],
  ["/pkg", "/pkg/..\\inside.blot", "..\\inside.blot"],
  ["/pkg", "/pkg/a\\b.blot", "a\\b.blot"],
  ["/pkg", "/pkg/a/b.blot", "a/b.blot"],
  ["/pkg", "/pkg/../outside\\file.blot", null],
  ["/pkg", "/pkg/..", null],
  ["/pkg", "/pkg-other/main.blot", null],
  ["/pkg", "/elsewhere/main.blot", null],
  ["/pkg\\name", "/pkg\\name/main.blot", "main.blot"],
  ["/", "/main.blot", "main.blot"],
];

for (const [root, target, expected] of posixCases) {
  test(`POSIX containment: ${JSON.stringify([root, target])}`, () => {
    assert.equal(relativeWithinRoot(root, target, posix), expected);
  });
}

const windowsCases: readonly (readonly [string, string, string | null])[] = [
  ["C:\\pkg", "C:\\pkg", ""],
  ["C:\\pkg", "C:\\pkg\\src\\main.blot", "src/main.blot"],
  ["C:\\pkg", "c:/PKG/src/../main.blot", "main.blot"],
  ["C:\\pkg", "C:\\pkg\\..hidden\\main.blot", "..hidden/main.blot"],
  ["C:\\pkg", "C:\\pkg\\..\\outside.blot", null],
  ["C:\\pkg", "C:\\pkg-other\\main.blot", null],
  ["C:\\pkg", "D:\\main.blot", null],
  ["C:\\pkg", "\\\\server\\share\\main.blot", null],
  ["\\\\server\\share\\pkg", "\\\\server\\share\\pkg\\main.blot", "main.blot"],
  ["\\\\server\\share\\pkg", "\\\\server\\share\\other\\main.blot", null],
  ["\\\\server\\share\\pkg", "\\\\server\\other\\pkg\\main.blot", null],
  ["\\\\server\\share\\pkg", "\\\\other\\share\\pkg\\main.blot", null],
  ["C:\\", "C:\\main.blot", "main.blot"],
];

for (const [root, target, expected] of windowsCases) {
  test(`Windows containment: ${JSON.stringify([root, target])}`, () => {
    assert.equal(relativeWithinRoot(root, target, win32), expected);
  });
}
