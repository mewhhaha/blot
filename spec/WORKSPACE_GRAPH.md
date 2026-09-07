# Host workspace graph contract

This focused contract refines the effective input graph and host work boundary
of [incremental compilation](INCREMENTAL.md). It does not change source typing,
module-instance identity, trusted snapshots, or semantic cache authority. The
whole-compiler judgment remains in [COMPILER.md](COMPILER.md).

## Effective source revisions

An editor buffer supplies exact source-module bytes for another revision,
whether that module is a requested root or an imported dependency. Each load
operation uses one staged map of effective source overrides. Invalidating a
module because an included input changed, or evicting its loaded node after a
root is released, does not remove its editor revision. Resolving it again must
use the retained override before disk source. Clearing an overlay explicitly
restores disk authority. Snapshot and capsule authority is unchanged; an editor
source override is not a replacement for a trusted snapshot or capsule node.
In-memory checking uses the same invalidation and fresh-equivalence judgment as
disk checking.

## Overlay version validity

Overlay versions are safe JavaScript integers, including signed versions. A new
version must be greater than the retained version; an identical source/version
pair is idempotent. NaN, infinities, fractions, unsafe integers, and an automatic
increment beyond the safe-integer range fail before publishing any staged graph
state. A rejected update must not advance the automatic sequence or replace the
committed source. Closing an overlay permits a new version sequence for that path.

## Traversal and refresh

Rebinding a retained graph expands each completed reachable node at most once
per load operation. The completed-node memo is operation-local, contains no
semantic facts, and is discarded before another request. Active-path cycle
checking precedes memo lookup; a node enters the memo only after all of its
edges have resolved. A shared dependency must retain one consistent replacement
node for every importer in that operation. Unchanged importer source retains its
AST identity when only its dependency wrappers change.

A full input refresh bounds concurrent filesystem reads independently of the
number of modules and includes. The implementation currently permits at most 16
reads from one refresh operation. Changed or missing inputs are collected before
invalidation. Unexpected read errors drain in-flight work and fail before
publishing invalidation; they are host failures, not evidence of source-language
rejection. This bound does not reserve descriptors against other host activity.

The retained-host traversal benchmark counts dependency expansions on the same
diamond topology independently qualified by source checking and emitted Wasm.
Filesystem reads, syntax materialization, type checking, staging, and emission
are outside its timed boundary. Raw wall-clock samples are observations;
deterministic expansion counts are the regression gate. One expansion per node
does not bound active-path scan/copy cost, source-resolution cost, or semantic
inference work. Its fixture identities never authorize semantic cache reuse.
