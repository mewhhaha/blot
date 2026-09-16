import { sourceOperations } from "../operations.ts";
import { directRule, fieldRule, fieldRules } from "../syntax.ts";
import type { LintRule } from "../types.ts";

export const arrayFind: LintRule = {
  name: "array-find",
  code: "BLOT_LINT_ARRAY_FIND",
  severity: "hint",
  evidence: "syntax-only",
  create(context) {
    return {
      concrete(rule) {
        if (rule.name !== "do_block") return;
        const statements = fieldRules(rule, "statements");
        if (statements.length !== 3) return;
        const initial = directRule(statements[0], "binding");
        const loop = directRule(statements[1], "iteration");
        const result = directRule(statements[2], "result");
        if (initial === null || loop === null || result === null) return;
        if (
          fieldRules(initial, "tags").length !== 0 ||
          fieldRule(initial, "annotation") !== null
        ) return;
        const pattern = fieldRule(initial, "pattern");
        const initialValue = fieldRule(initial, "value");
        const returned = fieldRule(result, "value");
        const element = fieldRule(loop, "head");
        const drawn = fieldRule(loop, "drawn");
        const body = fieldRule(loop, "body");
        if (
          pattern === null || initialValue === null || returned === null ||
          element === null || drawn === null || body === null
        ) return;
        const name = context.sourceText(pattern);
        const elementName = context.sourceText(element);
        if (
          !/^[a-z_][A-Za-z0-9_]*$/.test(name) ||
          !/^[a-z_][A-Za-z0-9_]*$/.test(elementName) ||
          name === elementName || context.sourceText(returned) !== name
        ) return;
        if (
          context.sourceText(initialValue) !== "#None" &&
          sourceOperations(context, initialValue)?.callee !== "None"
        ) return;
        const iterator = fieldRule(drawn, "source");
        if (iterator === null) return;
        const operations = sourceOperations(context, iterator);
        if (
          operations?.callee !== "Iter.items" ||
          !operations.operations.includes("Array.find")
        ) return;
        const iteratorText = context.sourceText(iterator);
        // The compiler certifies this callee; the CST supplies its written argument.
        const source = iteratorText.replace(/^Iter\.items\s+/, "");
        if (source === iteratorText) return;
        const loopStatements = fieldRules(body, "statements");
        if (loopStatements.length !== 1) return;
        const conditional = directRule(
          loopStatements[0],
          "conditional_statement",
        );
        if (conditional === null) return;
        const branches = fieldRule(conditional, "body");
        if (
          branches?.name !== "conditional_statement_branches" ||
          fieldRules(branches, "alternatives").length !== 0 ||
          fieldRule(branches, "fallback") !== null
        ) return;
        const condition = fieldRule(branches, "condition");
        const consequence = fieldRule(branches, "consequence");
        if (condition === null || consequence === null) return;
        const success = fieldRules(consequence, "statements");
        if (
          success.length !== 2 || directRule(success[1], "breaking") === null
        ) return;
        const rebinding = directRule(success[0], "rebinding");
        if (rebinding === null) return;
        const value = fieldRule(rebinding, "value");
        if (value === null) return;
        const assignment = context.sourceText(rebinding);
        const wrapped = context.sourceText(value);
        if (
          !assignment.startsWith(name + " :=") ||
          (wrapped !== "#Some " + elementName &&
            (wrapped !== "Some " + elementName ||
              sourceOperations(context, value)?.callee !== "Some"))
        ) return;
        const conditionText = context.sourceText(condition);
        if (new RegExp("\\b" + name + "\\b").test(conditionText)) return;
        context.report({
          message:
            "This loop returns the first array element that matches its predicate.",
          span: loop.span,
          fix: context.fix(
            rule.span,
            "Find the first matching array element",
            "Array.find ((" + source + "), fn " + elementName + " => " +
              conditionText + ")",
            "check-interface",
            "refactor.rewrite",
          ),
        });
      },
    };
  },
};
