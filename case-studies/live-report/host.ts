import { Compiler } from "../../src/compiler.ts";
import { type HostedModule, instantiateArtifact } from "../../src/host.ts";

export interface Report {
  readonly heading: string;
  readonly score: string;
  readonly revision: number;
}

/** A resident compiler plus the last successfully validated report instance. */
export class LiveReport {
  readonly #compiler: Compiler;
  readonly #entry: string;
  #active: HostedModule | null = null;
  #queue: Promise<void> = Promise.resolve();
  #requested = 0;
  #revision = 0;
  #closed = false;
  #closing: Promise<void> | null = null;

  private constructor(compiler: Compiler, entry: string) {
    this.#compiler = compiler;
    this.#entry = entry;
  }

  static async create(entry: string): Promise<LiveReport> {
    const report = new LiveReport(await Compiler.create(), entry);
    try {
      await report.reload();
      return report;
    } catch (error) {
      await report.close();
      throw error;
    }
  }

  reload(
    changedPaths: readonly string[] = [],
  ): Promise<"activated" | "superseded"> {
    if (this.#closed) return Promise.reject(new Error("report is closed"));
    const ticket = ++this.#requested;
    const paths = [...changedPaths];
    const work = this.#queue.then(async () => {
      if (this.#closed) return "superseded" as const;
      // All invalidations are retained, even when a newer request supersedes
      // activation. Compiler session access stays serialized.
      for (const path of paths) await this.#compiler.markChanged(path);
      if (ticket !== this.#requested) return "superseded" as const;
      const artifact = await this.#compiler.compile(this.#entry);
      const candidate = await instantiateArtifact(artifact);
      try {
        if (typeof candidate.call("heading") !== "string") {
          throw new TypeError("report heading must be Text");
        }
        if (typeof candidate.call("score", [0n]) !== "bigint") {
          throw new TypeError("report score must accept and return Int");
        }
        if (this.#closed || ticket !== this.#requested) {
          return "superseded" as const;
        }
        const previous = this.#active;
        this.#active = candidate;
        this.#revision += 1;
        if (previous !== null) previous.destroy();
        return "activated" as const;
      } finally {
        if (this.#active !== candidate) candidate.destroy();
      }
    });
    // The caller still receives the original rejection; only the queue tail
    // recovers so a repaired source can be compiled after a failed candidate.
    this.#queue = work.then(() => {}, () => {});
    return work;
  }

  evaluate(quantity: string): Report {
    if (this.#closed || this.#active === null) {
      throw new Error("report is closed");
    }
    if (quantity.length > 20 || !/^-?(0|[1-9][0-9]*)$/.test(quantity)) {
      throw new TypeError("quantity must be a decimal signed 64-bit integer");
    }
    const value = BigInt(quantity);
    if (value < -9223372036854775808n || value > 9223372036854775807n) {
      throw new RangeError("quantity must be a decimal signed 64-bit integer");
    }
    const heading = this.#active.call("heading");
    const score = this.#active.call("score", [value]);
    if (typeof heading !== "string" || typeof score !== "bigint") {
      throw new TypeError("active report violated its host interface");
    }
    return { heading, score: String(score), revision: this.#revision };
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    this.#requested += 1;
    this.#closing = this.#queue.then(() => {
      if (this.#active !== null) this.#active.destroy();
      this.#active = null;
      this.#compiler.destroy();
    });
    return this.#closing;
  }
}
