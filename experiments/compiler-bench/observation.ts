import type { CheckedModule } from "../../src/compiler.ts";

const effectIdentity = /\b(host|effect|Effect):(\d+):/g;
const closedEffectRow =
  /\{ ((?:(?:host|effect):\d+:[^,}]+)(?:, (?:host|effect):\d+:[^,}]+)*) \}/g;
const openEffectRow =
  /\{ ((?:(?:host|effect):\d+:[^,}]+)(?:, (?:host|effect):\d+:[^,}]+)*), (\.\.[^}]+) \}/g;

export function compilerObservation(
  checked: Pick<CheckedModule, "type" | "effects">,
): string {
  const identities = new Map<string, number>();
  let nextIdentity = 0;
  const rename = (value: string): string =>
    orderedEffectRows(value).replace(
      effectIdentity,
      (_match, prefix: string, identity: string) => {
        let canonical = identities.get(identity);
        if (canonical === undefined) {
          canonical = nextIdentity;
          nextIdentity += 1;
          identities.set(identity, canonical);
        }
        return `${prefix}:${canonical}:`;
      },
    );
  const type = orderedEffectRows(rename(checked.type));
  const effects = orderedEffectRows(rename(checked.effects));
  return JSON.stringify({ type, effects });
}

function orderedEffectRows(value: string): string {
  const openRows = value.replace(
    openEffectRow,
    (_match, labels: string, tail: string) =>
      `{ ${orderedLabels(labels).join(", ")}, ${tail} }`,
  );
  return openRows.replace(
    closedEffectRow,
    (_match, labels: string) => `{ ${orderedLabels(labels).join(", ")} }`,
  );
}

function orderedLabels(labels: string): readonly string[] {
  return labels.split(", ").sort((left, right) => {
    const leftName = left.replace(effectIdentity, "$1:*:");
    const rightName = right.replace(effectIdentity, "$1:*:");
    const byName = leftName.localeCompare(rightName);
    if (byName !== 0) return byName;
    return left.localeCompare(right, undefined, { numeric: true });
  });
}
