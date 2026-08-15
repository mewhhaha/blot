import type { RefinementVariable } from "../../src/core/refinement.ts";
import {
  instantiateSummaryProposition,
  loadRelationalSummary,
  type PublishedRelationalSummary,
  publishRelationalSummary,
  RelationalState,
  type RelationalSummary,
  relationalSummaryError,
} from "./summary.ts";

export type RelationalBody = (
  state: RelationalState,
  parameters: readonly RefinementVariable[],
) => readonly RefinementVariable[];

export interface RelationalDefinition {
  readonly name: string;
  readonly revision: string;
  readonly summary: RelationalSummary;
  readonly body: RelationalBody;
}

export interface VerifiedRelationalSummary {
  readonly tag: "verified-relational-summary";
  readonly definition: string;
  readonly bodyRevision: string;
  readonly fingerprint: string;
  readonly published: PublishedRelationalSummary;
  readonly summary: RelationalSummary;
}

export type SummaryVerification =
  | {
    readonly tag: "verified";
    readonly artifact: VerifiedRelationalSummary;
  }
  | { readonly tag: "rejected"; readonly reason: string };

export interface RelationalCaller {
  readonly name: string;
  readonly revision: string;
  readonly check: (summary: RelationalSummary) => void;
}

export interface RelationalCheckResult {
  readonly artifact: VerifiedRelationalSummary;
  readonly bodyVerified: boolean;
  readonly interfaceChanged: boolean;
  readonly recheckedCallers: readonly string[];
}

interface CachedDefinition {
  readonly revision: string;
  readonly declaredFingerprint: string;
  readonly artifact: VerifiedRelationalSummary;
}

interface CachedCaller {
  readonly revision: string;
  readonly dependencyFingerprint: string;
}

/**
 * Verify a declared summary against one symbolic execution of its body.
 *
 * The callback stands in for a compiler-owned checked body. A production
 * integration would drive the same state from typed Core rather than host code.
 */
export function verifyRelationalSummary(
  definition: RelationalDefinition,
): SummaryVerification {
  const error = relationalSummaryError(definition.summary);
  if (error !== null) return { tag: "rejected", reason: error };

  const state = new RelationalState();
  const parameters: RefinementVariable[] = [];
  for (let index = 0; index < definition.summary.parameters; index += 1) {
    parameters.push(state.bindFresh(`parameter-${index}`, {
      description: `${definition.name} parameter ${index}`,
    }));
  }
  for (const proposition of definition.summary.requires) {
    state.assume(
      instantiateSummaryProposition(proposition, parameters, []),
      { description: `${definition.name} declared precondition` },
    );
  }

  const results = definition.body(state, parameters);
  if (results.length !== definition.summary.results.length) {
    return {
      tag: "rejected",
      reason:
        `${definition.name} returned ${results.length} relational results, expected ${definition.summary.results.length}`,
    };
  }

  for (let index = 0; index < results.length; index += 1) {
    const identity = results[index];
    if (identity === undefined || !state.hasIdentity(identity)) {
      return {
        tag: "rejected",
        reason:
          `${definition.name} returned an unallocated identity at result ${index}`,
      };
    }
    const policy = definition.summary.results[index];
    if (policy === undefined) {
      throw new Error("validated relational result policy is missing");
    }
    if (policy.tag === "alias") {
      if (identity !== parameters[policy.parameter]) {
        return {
          tag: "rejected",
          reason:
            `${definition.name} result ${index} does not preserve its declared parameter identity`,
        };
      }
      continue;
    }
    if (parameters.includes(identity) || results.indexOf(identity) !== index) {
      return {
        tag: "rejected",
        reason: `${definition.name} result ${index} is not fresh`,
      };
    }
  }

  for (const proposition of definition.summary.ensures) {
    const required = instantiateSummaryProposition(
      proposition,
      parameters,
      results,
    );
    if (!state.entails(required)) {
      return {
        tag: "rejected",
        reason: `${definition.name} does not establish ${proposition.tag}`,
      };
    }
  }

  const published = publishRelationalSummary(definition.summary);
  const loaded = loadRelationalSummary(published);
  if (loaded === null) {
    throw new Error("published relational summary did not load");
  }
  return {
    tag: "verified",
    artifact: {
      tag: "verified-relational-summary",
      definition: definition.name,
      bodyRevision: definition.revision,
      fingerprint: JSON.stringify(published),
      published,
      summary: loaded,
    },
  };
}

/**
 * A small incremental model: body revisions key verification, while callers
 * depend only on the canonical verified summary fingerprint.
 */
export class RelationalCheckSession {
  readonly #definitions = new Map<string, CachedDefinition>();
  readonly #callers = new Map<string, CachedCaller>();

  check(
    definition: RelationalDefinition,
    callers: readonly RelationalCaller[],
  ): RelationalCheckResult {
    const declaredFingerprint = JSON.stringify(
      publishRelationalSummary(definition.summary),
    );
    const previous = this.#definitions.get(definition.name);
    let artifact: VerifiedRelationalSummary;
    let bodyVerified = false;
    let definitionUpdate: CachedDefinition | undefined;
    if (
      previous !== undefined &&
      previous.revision === definition.revision &&
      previous.declaredFingerprint === declaredFingerprint
    ) {
      artifact = previous.artifact;
    } else {
      const verification = verifyRelationalSummary(definition);
      if (verification.tag === "rejected") {
        throw new Error(verification.reason);
      }
      artifact = verification.artifact;
      bodyVerified = true;
      definitionUpdate = {
        revision: definition.revision,
        declaredFingerprint,
        artifact,
      };
    }

    let interfaceChanged = true;
    if (previous !== undefined) {
      interfaceChanged = previous.artifact.fingerprint !== artifact.fingerprint;
    }
    const recheckedCallers: string[] = [];
    const callerUpdates: [string, CachedCaller][] = [];
    for (const caller of callers) {
      const cached = this.#callers.get(caller.name);
      if (
        cached !== undefined &&
        cached.revision === caller.revision &&
        cached.dependencyFingerprint === artifact.fingerprint
      ) continue;
      caller.check(artifact.summary);
      callerUpdates.push([caller.name, {
        revision: caller.revision,
        dependencyFingerprint: artifact.fingerprint,
      }]);
      recheckedCallers.push(caller.name);
    }
    if (definitionUpdate !== undefined) {
      this.#definitions.set(definition.name, definitionUpdate);
    }
    for (const [name, update] of callerUpdates) {
      this.#callers.set(name, update);
    }
    return { artifact, bodyVerified, interfaceChanged, recheckedCallers };
  }
}
