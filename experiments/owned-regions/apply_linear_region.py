from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:80]!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "src/linear/check.ts",
    '  readonly operation: "@array.take" | "@array.split";\n',
    '  readonly operation: "@array.take" | "@array.split" | "@region.array.split";\n',
)

region_rules = r'''        if (name === "@region.array.claim" && application.args.length === 1) {
          const source = walk(application.args[0], scope, analysis, "move");
          if (obligation(source) === "none") {
            analysis.report(
              "BLOT_REGION_CLAIM_NOT_OWNED",
              "Region claim needs an explicitly owned array (`!array`). The claim copies into a private Store, while the owned source supplies the unique static authority root.",
              application.args[0].span,
            );
          } else if (source.tag !== "leaf" || source.origins.length === 0) {
            analysis.report(
              "BLOT_REGION_OWNED_ELEMENT",
              "The first Region implementation accepts arrays whose elements carry no ownership obligations. Consume or unpack owned elements before claiming the array.",
              application.args[0].span,
            );
          }
          return source;
        }
        if (name === "@region.array.length" && application.args.length === 1) {
          walk(application.args[0], scope, analysis, "borrow");
          return NONE;
        }
        if (name === "@region.array.get" && application.args.length === 2) {
          walk(application.args[0], scope, analysis, "borrow");
          walk(application.args[1], scope, analysis, "move");
          return NONE;
        }
        if (name === "@region.array.set" && application.args.length === 3) {
          const region = walk(application.args[0], scope, analysis, "move");
          walk(application.args[1], scope, analysis, "move");
          const replacement = walk(application.args[2], scope, analysis, "move");
          if (obligation(replacement) !== "none") {
            analysis.report(
              "BLOT_REGION_OWNED_ELEMENT",
              "Region replacement cannot move an owned element in the first implementation.",
              application.args[2].span,
            );
          }
          return region;
        }
        if (name === "@region.array.swap" && application.args.length === 3) {
          const region = walk(application.args[0], scope, analysis, "move");
          walk(application.args[1], scope, analysis, "move");
          walk(application.args[2], scope, analysis, "move");
          return region;
        }
        if (name === "@region.array.split" && application.args.length === 2) {
          const region = walk(application.args[0], scope, analysis, "move");
          walk(application.args[1], scope, analysis, "move");
          if (obligation(region) === "none") {
            analysis.report(
              "BLOT_REGION_SPLIT_NOT_OWNED",
              "Region split requires an owned Region authority.",
              application.args[0].span,
            );
          }
          const parts = extractionParts(
            region,
            "@region.array.split",
            2,
            expr.span,
          );
          return {
            tag: "choice",
            cases: new Map([
              ["Split", { tag: "sequence", elements: parts }],
              ["SplitOutOfBounds", region],
            ]),
          };
        }
        if (name === "@region.array.join" && application.args.length === 2) {
          const left = walk(application.args[0], scope, analysis, "move");
          const right = walk(application.args[1], scope, analysis, "move");
          return joinRegionParts(left, right, expr.span, analysis);
        }
        if (name === "@region.array.freeze" && application.args.length === 1) {
          const region = walk(application.args[0], scope, analysis, "move");
          const leaves = ownershipLeaves(region);
          const full = leaves.length === 1 && leaves[0].origins.length === 1 &&
            leaves[0].origins[0].extractions.length === 0;
          if (!full) {
            analysis.report(
              "BLOT_REGION_PARTIAL_FREEZE",
              "Only a complete root Region authority can be frozen. Rejoin every split first.",
              application.args[0].span,
            );
          }
          return NONE;
        }
'''
array_anchor = '''        if (
          (name === "@array.take" || name === "@array.split") &&
          application.args.length === 2
        ) {
'''
replace_once(
    "src/linear/check.ts",
    array_anchor,
    region_rules + array_anchor,
)

join_helper = r'''function joinRegionParts(
  left: Produced,
  right: Produced,
  span: Span,
  analysis: Analysis,
): Produced {
  const leftLeaves = ownershipLeaves(left);
  const rightLeaves = ownershipLeaves(right);
  if (leftLeaves.length !== 1 || rightLeaves.length !== 1) {
    analysis.report(
      "BLOT_REGION_JOIN_UNPROVED",
      "Region join needs exactly one authority on each side.",
      span,
    );
    return combine(left, right);
  }
  const leftLeaf = leftLeaves[0];
  const rightLeaf = rightLeaves[0];
  if (
    leftLeaf.qualifier !== rightLeaf.qualifier ||
    leftLeaf.origins.length !== 1 || rightLeaf.origins.length !== 1
  ) {
    analysis.report(
      "BLOT_REGION_JOIN_UNPROVED",
      "Region join needs two sibling authorities with one common origin.",
      span,
    );
    return combine(left, right);
  }
  const leftOrigin = leftLeaf.origins[0];
  const rightOrigin = rightLeaf.origins[0];
  const leftExtractions = leftOrigin.extractions;
  const rightExtractions = rightOrigin.extractions;
  if (
    leftOrigin.source !== rightOrigin.source ||
    !samePath(leftOrigin.path, rightOrigin.path) ||
    leftExtractions.length === 0 ||
    leftExtractions.length !== rightExtractions.length
  ) {
    analysis.report(
      "BLOT_REGION_JOIN_UNPROVED",
      "Region join needs adjacent parts of the same split lineage.",
      span,
    );
    return combine(left, right);
  }
  const last = leftExtractions.length - 1;
  const leftSplit = leftExtractions[last];
  const rightSplit = rightExtractions[last];
  const samePrefix = leftExtractions.slice(0, last).every((entry, index) => {
    const compared = rightExtractions[index];
    return entry.operation === compared.operation && entry.part === compared.part &&
      entry.span.start === compared.span.start && entry.span.end === compared.span.end;
  });
  const siblings = samePrefix &&
    leftSplit.operation === "@region.array.split" &&
    rightSplit.operation === "@region.array.split" &&
    leftSplit.part === 0 && rightSplit.part === 1 &&
    leftSplit.span.start === rightSplit.span.start &&
    leftSplit.span.end === rightSplit.span.end;
  if (!siblings) {
    analysis.report(
      "BLOT_REGION_JOIN_UNPROVED",
      "Region join accepts only the ordered sibling pair produced by one Region split.",
      span,
    );
    return combine(left, right);
  }
  return {
    tag: "leaf",
    qualifier: leftLeaf.qualifier,
    source: null,
    path: [],
    origins: [{
      source: leftOrigin.source,
      path: leftOrigin.path,
      extractions: leftExtractions.slice(0, last),
    }],
  };
}

'''
replace_once(
    "src/linear/check.ts",
    "function extractionParts(\n",
    join_helper + "function extractionParts(\n",
)

certificate_anchor = '''  if (operation === "@array.take") return 2;
  if (operation === "@array.split") return 3;
  return null;
'''
replace_once(
    "src/linear/certificate.ts",
    certificate_anchor,
    '''  if (operation === "@array.take") return 2;
  if (operation === "@array.split") return 3;
  if (operation === "@region.array.split") return 2;
  return null;
''',
)

print("applied Region ownership lineage patch")
