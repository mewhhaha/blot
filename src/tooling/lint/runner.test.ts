import { assert, assertEquals } from "@std/assert";
import type { Rule } from "../../syntax/cursor.ts";
import { parseConcrete } from "../../syntax/parse.ts";
import { lintModule } from "./runner.ts";
import type { LintRule, LintVisitors } from "./types.ts";

function collector(create: LintRule["create"]): LintRule {
  return {
    name: "test-collector",
    code: "BLOT_LINT_UNUSED_BINDING",
    severity: "hint",
    create,
  };
}

Deno.test("empty and AST-only selections do not walk the CST", async () => {
  const source = "return 1\n";
  const parsed = await parseConcrete(source);
  assert(parsed.ok);
  const cst: Rule = {
    ...parsed.cst,
    children() {
      throw new Error("AST-only rules must not inspect the CST");
    },
  };
  assertEquals(lintModule(parsed.module, source, cst, []), []);
  const visited: string[] = [];
  const rule = collector(() => ({
    module() {
      visited.push("module");
    },
    expression(path) {
      visited.push(path.node.tag);
    },
  }));
  assertEquals(lintModule(parsed.module, source, cst, [rule]), []);
  assertEquals(visited, ["module", "int"]);
});

Deno.test("origin queries share one index per invocation", async () => {
  const source = "return 1\n";
  const parsed = await parseConcrete(source);
  assert(parsed.ok);
  let visits = 0;
  const cst: Rule = {
    ...parsed.cst,
    children() {
      visits += 1;
      return parsed.cst.children();
    },
  };
  const rule = collector((context) => {
    assert(context.hasConcreteOrigin(cst, cst.name));
    return {
      expression() {
        assert(context.hasConcreteOrigin(cst, cst.name));
        assert(!context.concreteHasDescendant(cst, cst.name, "missing"));
      },
    };
  });
  lintModule(parsed.module, source, cst, [rule, rule]);
  assertEquals(visits, 1);
  lintModule(parsed.module, source, cst, [rule]);
  assertEquals(visits, 2);
});

Deno.test("visitors retain AST-first ordering and ancestors", async () => {
  const source = "return 1\n";
  const parsed = await parseConcrete(source);
  assert(parsed.ok);
  const expected: string[] = [
    "first:module",
    "second:module",
    "expression:int",
  ];
  const walk = (node: Rule, ancestors: readonly Rule[]): void => {
    for (const name of ["first", "second"]) {
      expected.push(`${name}:${node.name}:${ancestors.length}`);
    }
    for (const child of node.children()) {
      if (child.type === "rule") walk(child, [...ancestors, node]);
    }
  };
  walk(parsed.cst, []);
  const actual: string[] = [];
  const retained: { rule: Rule; ancestors: readonly Rule[] }[] = [];
  const visitors = (name: string): LintVisitors => ({
    module() {
      actual.push(`${name}:module`);
    },
    concrete(node, ancestors) {
      actual.push(`${name}:${node.name}:${ancestors.length}`);
      retained.push({ rule: node, ancestors });
    },
  });
  lintModule(parsed.module, source, parsed.cst, [
    collector(() => visitors("first")),
    collector(() => ({})),
    collector(() => ({
      expression(path) {
        actual.push(`expression:${path.node.tag}`);
      },
    })),
    collector(() => visitors("second")),
  ]);
  assertEquals(actual, expected);
  for (const entry of retained) {
    if (entry.rule === parsed.cst) assertEquals(entry.ancestors, []);
    else assert(entry.ancestors[0] === parsed.cst);
    assert(!entry.ancestors.includes(entry.rule));
  }
});

Deno.test("concrete-only rules skip the AST", async () => {
  const source = "return 1\n";
  const parsed = await parseConcrete(source);
  assert(parsed.ok);
  let visits = 0;
  const cst: Rule = {
    ...parsed.cst,
    children() {
      visits += 1;
      return parsed.cst.children();
    },
  };
  const module = {
    ...parsed.module,
    get result(): typeof parsed.module.result {
      throw new Error("concrete-only rules must not inspect the AST");
    },
  };
  const visited: Rule[] = [];
  lintModule(module, source, cst, [
    collector(() => ({
      concrete(node) {
        visited.push(node);
      },
    })),
  ]);
  assertEquals(visits, 1);
  assert(visited.length > 1);
  assert(visited[0] === cst);
});
