import { assert, assertEquals } from "@std/assert";
import { DEFAULT_LINT_RULES } from "./rules.ts";
import {
  diagnosticEvidence,
  findLintCandidate,
  lintCandidateIdentity,
  lintEvidenceFor,
  splitLintDiagnostics,
} from "./staged.ts";
import type { LintDiagnostic } from "./types.ts";

const EVIDENCE: ReadonlySet<string> = new Set([
  "syntax-only",
  "semantic-fact",
  "rewrite-validation",
]);

Deno.test("every default rule declares valid evidence under a unique code", () => {
  const codes = new Set<string>();
  for (const rule of DEFAULT_LINT_RULES) {
    assert(
      EVIDENCE.has(rule.evidence),
      `${rule.code} declares invalid evidence`,
    );
    assert(!codes.has(rule.code), `${rule.code} is declared twice`);
    codes.add(rule.code);
    assertEquals(lintEvidenceFor(rule.code), rule.evidence);
  }
  assertEquals(lintEvidenceFor("BLOT_LINT_NO_SUCH_RULE"), null);
});

Deno.test("semantic-fact evidence names exactly the compiler-fact rules", () => {
  const semantic = DEFAULT_LINT_RULES.filter((rule) =>
    rule.evidence === "semantic-fact"
  ).map((rule) => rule.code).sort();
  assertEquals(semantic, [
    "BLOT_LINT_EMPTY_ARRAY_SPELLING",
    "BLOT_LINT_EQUALITY_CASE",
    "BLOT_LINT_IF_CHAIN",
    "BLOT_LINT_LOCAL_OPEN",
    "BLOT_LINT_OPEN_SHADOW",
    "BLOT_LINT_RECORD_RECONSTRUCTION",
    "BLOT_LINT_SELECTIVE_OPEN",
    "BLOT_LINT_SPECIALIZATION_COUNT",
    "BLOT_LINT_STABLE_SHADOWING",
    "BLOT_LINT_TERMINAL_EFFECT_FORWARDING",
    "BLOT_LINT_UNUSED_OPEN",
  ]);
});

Deno.test("rewrite-validation evidence names exactly the proof-shaped rules", () => {
  const rewrite = DEFAULT_LINT_RULES.filter((rule) =>
    rule.evidence === "rewrite-validation"
  ).map((rule) => rule.code).sort();
  assertEquals(rewrite, [
    "BLOT_LINT_NOOP_REBINDING",
    "BLOT_LINT_PROVED_ARRAY_LOOKUP",
  ]);
});

Deno.test("staged split holds only rewrite claims that carry a fix", () => {
  const rewriteFix = diagnostic("BLOT_LINT_NOOP_REBINDING", "check-interface");
  const syntaxFix = diagnostic("BLOT_LINT_UNUSED_BINDING", "parse");
  const semanticFix = diagnostic("BLOT_LINT_EQUALITY_CASE", "check");
  const rewriteBare = diagnostic("BLOT_LINT_NOOP_REBINDING", null);
  const split = splitLintDiagnostics([
    rewriteFix,
    syntaxFix,
    semanticFix,
    rewriteBare,
  ]);
  assertEquals(split.rewriteCandidates, [rewriteFix]);
  assertEquals(split.publishable, [syntaxFix, semanticFix, rewriteBare]);
});

Deno.test("unknown rule codes fall back to their fix obligation", () => {
  assertEquals(
    diagnosticEvidence(diagnostic("BLOT_LINT_TEST_UNKNOWN", null)),
    "syntax-only",
  );
  assertEquals(
    diagnosticEvidence(diagnostic("BLOT_LINT_TEST_UNKNOWN", "parse")),
    "syntax-only",
  );
  assertEquals(
    diagnosticEvidence(diagnostic("BLOT_LINT_TEST_UNKNOWN", "check")),
    "rewrite-validation",
  );
  assertEquals(
    diagnosticEvidence(
      diagnostic("BLOT_LINT_TEST_UNKNOWN", "check-interface"),
    ),
    "rewrite-validation",
  );
});

Deno.test("resolve matches a re-detected candidate by rule span and title", () => {
  const first = diagnostic("BLOT_LINT_UNUSED_BINDING", "parse");
  const second: LintDiagnostic = {
    ...diagnostic("BLOT_LINT_UNUSED_BINDING", "parse"),
    span: { start: 40, end: 48 },
  };
  const identity = lintCandidateIdentity(first);
  assert(identity !== null);
  assertEquals(identity, { start: 8, end: 16, title: "Fix BLOT" });
  assertEquals(findLintCandidate([first, second], first.code, identity), first);
  assertEquals(
    findLintCandidate([second], first.code, identity),
    null,
  );
  assertEquals(
    findLintCandidate([first], "BLOT_LINT_UNUSED_OPEN", identity),
    null,
  );
  assertEquals(
    lintCandidateIdentity(diagnostic("BLOT_LINT_OPEN_SHADOW", null)),
    null,
  );
});

function diagnostic(
  code: string,
  validation: "parse" | "check" | "check-interface" | null,
): LintDiagnostic {
  let fix: LintDiagnostic["fix"] = null;
  if (validation !== null) {
    fix = {
      title: "Fix BLOT",
      edits: [{ span: { start: 8, end: 16 }, replacement: "" }],
      kind: "quickfix",
      validation,
    };
  }
  return {
    code: code as LintDiagnostic["code"],
    severity: "hint",
    message: "staged",
    span: { start: 8, end: 16 },
    fix,
  };
}
