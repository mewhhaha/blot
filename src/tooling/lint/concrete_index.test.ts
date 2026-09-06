import { assert, assertEquals } from "@std/assert";
import type { Span } from "../../syntax/ast.ts";
import type { Cursor, Rule } from "../../syntax/cursor.ts";
import { parseConcrete } from "../../syntax/parse.ts";
import { ConcreteIndex } from "./concrete_index.ts";

function rule(
  name: string,
  start: number,
  end: number,
  children: readonly Cursor[] = [],
): Rule {
  return {
    type: "rule",
    name,
    span: { start, end },
    child: (index) => children[index],
    children: () => children,
    field: () => undefined,
  };
}

function rulesBelow(root: Rule): Rule[] {
  const rules: Rule[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    assert(current !== undefined);
    rules.push(current);
    for (const child of current.children()) {
      if (child.type === "rule") pending.push(child);
    }
  }
  return rules;
}

function referenceDescendant(
  rules: readonly Rule[],
  span: Span,
  name: string,
  descendant: string,
): boolean {
  return rules.some((candidate) =>
    candidate.name === name && candidate.span.start === span.start &&
    candidate.span.end === span.end &&
    rulesBelow(candidate).slice(1).some((child) => child.name === descendant)
  );
}

Deno.test("origins match both offsets and rule names, not tokens", () => {
  const span = { start: 2, end: 8 };
  const root = rule("root", 0, 10, [
    rule("case_expression", span.start, span.end),
    { type: "token", kind: "case_guard", text: "if", span },
  ]);
  const index = new ConcreteIndex(root);
  assert(index.hasOrigin(span, "case_expression"));
  assert(!index.hasOrigin({ start: 2, end: 7 }, "case_expression"));
  assert(!index.hasOrigin({ start: 1, end: 8 }, "case_expression"));
  assert(!index.hasOrigin(span, "case_guard"));
  assert(!index.hasDescendant(root.span, "root", "case_guard"));
  assert(!index.hasDescendant(root.span, "missing", "case_expression"));
  assert(!index.hasDescendant(root.span, "root", "missing"));
});

Deno.test("descendants exclude self and unrelated overlapping spans", () => {
  const leaf = rule("case_expression", 0, 10);
  const guarded = rule("other", 0, 10, [rule("case_guard", 2, 3)]);
  const root = rule("root", 0, 10, [leaf, guarded]);
  const index = new ConcreteIndex(root);
  assert(!index.hasDescendant(leaf.span, leaf.name, leaf.name));
  assert(!index.hasDescendant(leaf.span, leaf.name, "case_guard"));
  assert(index.hasDescendant(root.span, root.name, "case_guard"));
  assert(index.hasDescendant(guarded.span, guarded.name, "case_guard"));
});

Deno.test("duplicate origins retain the union of strict descendants", () => {
  const span = { start: 0, end: 0 };
  const root = rule("root", 0, 0, [
    rule("case_expression", 0, 0, [rule("first", 0, 0)]),
    rule("case_expression", 0, 0, [
      rule("case_expression", 0, 0, [rule("case_guard", 0, 0)]),
    ]),
  ]);
  const index = new ConcreteIndex(root);
  for (const descendant of ["first", "case_guard", "case_expression"]) {
    assert(index.hasDescendant(span, "case_expression", descendant));
  }
  assert(!index.hasDescendant(span, "first", "case_guard"));
});

Deno.test("concrete indexes remain local to their source tree", () => {
  const root = rule("root", 0, 10, [rule("case_guard", 2, 3)]);
  const first = new ConcreteIndex(root);
  const second = new ConcreteIndex(rule("root", 0, 10));
  assert(first.hasDescendant(root.span, root.name, "case_guard"));
  assert(!second.hasDescendant(root.span, root.name, "case_guard"));
});

Deno.test("concrete interval queries match an independent tree walk", () => {
  let seed = 1701;
  const random = (limit: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  for (let sample = 0; sample < 30; sample += 1) {
    const nodes: Rule[] = [];
    const children: Cursor[][] = [];
    for (let index = 0; index < 80; index += 1) {
      const nested: Cursor[] = [];
      const start = random(10);
      const node = rule(`rule${random(6)}`, start, start + random(4), nested);
      if (index > 0) children[random(index)].push(node);
      nodes.push(node);
      children.push(nested);
    }
    const index = new ConcreteIndex(nodes[0]);
    for (const node of nodes) {
      assert(index.hasOrigin(node.span, node.name));
      for (let kind = 0; kind < 7; kind += 1) {
        const descendant = `rule${kind}`;
        assertEquals(
          index.hasDescendant(node.span, node.name, descendant),
          referenceDescendant(nodes, node.span, node.name, descendant),
        );
      }
    }
  }
});

Deno.test("indexing visits deep trees once without recursive calls", () => {
  const depth = 20_000;
  let visits = 0;
  let root = rule("leaf", 0, 0);
  for (let index = 1; index < depth; index += 1) {
    const child = root;
    const parent = rule(`rule${index}`, 0, index, [child]);
    root = {
      ...parent,
      children() {
        visits += 1;
        return [child];
      },
    };
  }
  const index = new ConcreteIndex(root);
  assertEquals(visits, depth - 1);
  assert(index.hasDescendant(root.span, root.name, "leaf"));
  assert(!index.hasDescendant(root.span, root.name, root.name));
  assertEquals(visits, depth - 1);
});

Deno.test("queries preserve Baba layout-mapped source origins", async () => {
  const source = `// A nested case with repeated wrapper spans.
let choose = fn value => case value of
  #First => 1
  #Next => case other of
    #First => 2
    _ => 3
return choose
`;
  const parsed = await parseConcrete(source);
  assert(parsed.ok);
  const nodes = rulesBelow(parsed.cst);
  const index = new ConcreteIndex(parsed.cst);
  const names = [...new Set(nodes.map((node) => node.name)), "missing"];
  for (const node of nodes) {
    assert(index.hasOrigin(node.span, node.name));
    for (const name of names) {
      assertEquals(
        index.hasDescendant(node.span, node.name, name),
        referenceDescendant(nodes, node.span, node.name, name),
      );
    }
  }
});
