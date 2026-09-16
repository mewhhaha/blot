// src/tooling/format/equivalence.ts
//
// Preservation contract for formatting: the printed output must lower to
// the same representation as the input.
//
// The comparison normalizes two facts before comparing, both documented:
//
// 1. Empty-block collapse. Surface elaboration may wrap a bare result in a
//    block node with no declarations (`{ tag: "block", declarations: [],
//    result }`). Such a wrapper carries no binding or sequencing meaning,
//    so the digest compares it as its bare result. A block with at least
//    one declaration is structurally significant and is never collapsed.
//
// 2. Generated-name rewrite. The frontend mints capture-avoiding names that
//    embed source offsets (`name$123`). Formatting legitimately shifts
//    offsets, so the digest rewrites every `$<digits>` suffix to the fixed
//    marker `$span` before comparing. Semantically distinct names still
//    differ: only the numeric suffix is erased.
//
// Spans are dropped entirely: formatting moves every token by design.
// The pipeline computes each side exactly once: the input digest comes from
// the input snapshot module, the output digest from the single output
// validation parse. Equality failure is a typed invariant failure, never
// silently returned text.

import type { Module } from "../../syntax/ast.ts";
import { FormatterInvariantError } from "./errors.ts";

/** Canonical representation digest of a lowered module. */
export function digestModule(module: Module): string {
  return JSON.stringify(normalizeModuleValue(module));
}

/**
 * Compares the input and output representations. Throws
 * FormatterInvariantError with a structural summary on mismatch.
 */
export function assertRepresentationEqual(
  input: Module,
  output: Module,
): void {
  const expected = digestModule(input);
  const actual = digestModule(output);
  if (expected !== actual) {
    throw new FormatterInvariantError(
      `formatter changed the lowered module: ${
        summarizeDigest(expected)
      } became ${summarizeDigest(actual)}`,
    );
  }
}

export function representationEqual(input: Module, output: Module): boolean {
  return digestModule(input) === digestModule(output);
}

function summarizeDigest(digest: string): string {
  if (digest.length <= 120) return digest;
  return `${digest.slice(0, 120)}...(${digest.length} bytes)`;
}

function normalizeModuleValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeModuleValue);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value !== "object" || value === null) return value;

  const record = value as Record<string, unknown>;
  if (
    record.tag === "block" && Array.isArray(record.declarations) &&
    record.declarations.length === 0
  ) {
    return normalizeModuleValue(record.result);
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(record)) {
    if (key === "span") continue;
    if (key === "name" && typeof field === "string") {
      normalized[key] = rewriteGeneratedName(field);
      continue;
    }
    normalized[key] = normalizeModuleValue(field);
  }
  return normalized;
}

/**
 * Rewrites compiler-minted `$<digits>` suffixes to `$span`. Hand-written
 * from the name grammar (a dollar sign followed by ASCII digits) so the
 * comparison never depends on a pattern that could also match source text.
 */
function rewriteGeneratedName(name: string): string {
  let rewritten = "";
  let index = 0;
  while (index < name.length) {
    const dollar = name.indexOf("$", index);
    if (dollar < 0) {
      rewritten += name.slice(index);
      break;
    }
    rewritten += name.slice(index, dollar);
    let end = dollar + 1;
    while (
      end < name.length && name[end] !== undefined && isAsciiDigit(name[end])
    ) {
      end += 1;
    }
    if (end === dollar + 1) {
      rewritten += "$";
      index = dollar + 1;
    } else {
      rewritten += "$span";
      index = end;
    }
  }
  return rewritten;
}

function isAsciiDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}
