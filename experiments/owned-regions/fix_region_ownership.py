from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:100]!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "src/linear/check.ts",
    '''      let owned = produced;
      if (!relevant(owned)) owned = written;
      const lineage = structuralLineage(pattern, owned);
''',
    '''      let owned = produced;
      if (!relevant(owned)) owned = written;
      // A trusted primitive may create a fresh linear resource rather than
      // transfer an older one. Once that value is named, the binding itself is
      // the stable root identity used by downstream extraction lineage.
      if (
        owned.tag === "leaf" && owned.source === null &&
        owned.origins.length === 0 &&
        (owned.qualifier === "linear" || owned.qualifier === "affine")
      ) {
        owned = {
          ...owned,
          source: pattern,
          origins: [{ source: pattern, path: [], extractions: [] }],
        };
      }
      const lineage = structuralLineage(pattern, owned);
''',
)

old_claim = '''        if (name === "@region.array.claim" && application.args.length === 1) {
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
'''
new_claim = '''        if (name === "@region.array.claim" && application.args.length === 1) {
          const source = walk(application.args[0], scope, analysis, "project");
          if (obligation(source) !== "none") {
            analysis.report(
              "BLOT_REGION_OWNED_ELEMENT",
              "The first Region implementation copies its input, so arrays containing owned elements cannot be claimed yet. Consume or unpack those elements first.",
              application.args[0].span,
            );
          }
          // `claim` semantically creates a fresh private Store. The declaration
          // receiving this leaf roots it at that new binding; no source-array
          // identity is reused unless a later Store-provenance optimization
          // proves that stealing the allocation is observationally equivalent.
          return {
            tag: "leaf",
            qualifier: "linear",
            source: null,
            path: [],
            origins: [],
          };
        }
'''
replace_once("src/linear/check.ts", old_claim, new_claim)

replace_once(
    "src/linear/check.ts",
    '''function joinAlternatives(values: readonly Produced[]): Produced {
  if (values.length === 0) return NONE;
  if (values.every((value) => value.tag === "none")) return NONE;
''',
    '''function joinAlternatives(values: readonly Produced[]): Produced {
  if (values.length === 0) return NONE;
  if (values.every((value) => value.tag === "none")) return NONE;
  const first = values[0];
  if (values.every((value) => sameProduced(value, first))) return first;
''',
)

print("fixed fresh Region roots and branch authority joins")
