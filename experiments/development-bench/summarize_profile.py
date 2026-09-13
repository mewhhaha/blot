"""Summarize sampled CPU time inside development compilation, excluding provenance."""

import collections
import json
import sys


with open(sys.argv[1], encoding="utf-8") as source:
    profile = json.load(source)
nodes = {node["id"]: node for node in profile["nodes"]}
parents = {
    child: node["id"]
    for node in nodes.values()
    for child in node.get("children", [])
}
phases = collections.Counter()
operations = collections.Counter()
total = 0
for sample, duration in zip(profile["samples"], profile["timeDeltas"], strict=True):
    stack = []
    while True:
        stack.append(nodes[sample]["callFrame"]["functionName"])
        if sample not in parents:
            break
        sample = parents[sample]
    if "compileCompilerSessionDevelopmentProgram" not in stack:
        continue
    total += duration
    # Rust's v0 names retain these identifiers even without demangling.
    if any("14ensure_current" in name for name in stack):
        phase = "module checking and invalidation"
    elif any("22begin_semantic_request" in name for name in stack):
        phase = "request reset and setup"
    elif any("16elaborate_common" in name for name in stack):
        phase = "Runtime HIR elaboration"
    else:
        phase = "remaining compilation and transport"
    phases[phase] += duration
    for label, identifier in [
        ("cached interface inflation", "17inflate_interface"),
        ("cached interface budget validation", "20validate_type_budget"),
        ("value capsule reconstruction", "34decode_after_structural_validation"),
        ("environment name lookup", "5value6lookup"),
        ("safety checking", "6safety"),
        ("portable cache evidence", "17portable_evidence"),
    ]:
        if any(identifier in name for name in stack):
            operations[label] += duration

if total == 0:
    raise SystemExit("No development compiler CPU samples found")

print(f"Sampled development compiler time: {total / 1000:.1f} ms")
for title, measurements in [
    ("Disjoint phases", phases),
    ("Inclusive operations (overlap; do not sum)", operations),
]:
    print(title)
    for label, duration in measurements.most_common():
        print(f"  {duration / 1000:8.1f} ms {duration / total:6.1%}  {label}")
