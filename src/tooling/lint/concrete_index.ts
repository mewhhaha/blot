import type { Span } from "../../syntax/ast.ts";
import type { Rule } from "../../syntax/cursor.ts";
import { spanKey } from "./syntax.ts";

interface Subtree {
  readonly start: number;
  end: number;
}

interface NamedRules {
  readonly origins: Map<string, Subtree[]>;
  readonly positions: number[];
}

type Pending =
  | { readonly tag: "enter"; readonly rule: Rule }
  | { readonly tag: "leave"; readonly subtree: Subtree };

/** Source origins and strict descendants, indexed in linear space. */
export class ConcreteIndex {
  readonly #names = new Map<string, NamedRules>();

  constructor(root: Rule) {
    const pending: Pending[] = [{ tag: "enter", rule: root }];
    let position = 0;
    while (pending.length > 0) {
      const entry = pending.pop();
      if (entry === undefined) throw new Error("missing concrete index entry");
      if (entry.tag === "leave") {
        entry.subtree.end = position;
        continue;
      }
      const rule = entry.rule;
      let named = this.#names.get(rule.name);
      if (named === undefined) {
        named = { origins: new Map(), positions: [] };
        this.#names.set(rule.name, named);
      }
      const key = spanKey(rule.span);
      let origins = named.origins.get(key);
      if (origins === undefined) {
        origins = [];
        named.origins.set(key, origins);
      }
      const subtree = { start: position, end: position + 1 };
      origins.push(subtree);
      named.positions.push(position);
      position += 1;
      pending.push({ tag: "leave", subtree });
      const children = rule.children();
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child.type === "rule") pending.push({ tag: "enter", rule: child });
      }
    }
  }

  hasOrigin(span: Span, name: string): boolean {
    return this.#names.get(name)?.origins.has(spanKey(span)) === true;
  }

  hasDescendant(span: Span, name: string, descendant: string): boolean {
    const origins = this.#names.get(name)?.origins.get(spanKey(span));
    const positions = this.#names.get(descendant)?.positions;
    if (origins === undefined || positions === undefined) return false;
    // Several concrete nodes can share a name and source span. Preserve the
    // union of their descendants; source containment alone is not ancestry.
    for (const origin of origins) {
      let low = 0;
      let high = positions.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (positions[middle] <= origin.start) low = middle + 1;
        else high = middle;
      }
      if (low < positions.length && positions[low] < origin.end) return true;
    }
    return false;
  }
}
