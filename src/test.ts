import { Compiler } from "./compiler.ts";
import type { Diagnostic } from "./diagnostic.ts";
import type { Span } from "./syntax/ast.ts";

export type TestOutcome =
  | {
    readonly status: "passed";
    readonly path: string;
    readonly name: string;
    readonly span: Span;
  }
  | {
    readonly status: "failed";
    readonly path: string;
    readonly name: string;
    readonly span: Span;
    readonly diagnostic: Diagnostic;
  };

let sharedCompiler: Promise<Compiler> | undefined;

/** Discovers and executes declaration-tag tests in the Rust compiler. */
export async function testFile(path: string): Promise<readonly TestOutcome[]> {
  if (sharedCompiler === undefined) sharedCompiler = Compiler.create();
  const outcomes = await (await sharedCompiler).test(path);
  return outcomes.map((outcome): TestOutcome => {
    if (outcome.status === "passed") {
      return {
        status: "passed",
        path: outcome.path,
        name: outcome.name,
        span: outcome.span,
      };
    }
    const diagnostic = outcome.diagnostic;
    if (diagnostic === undefined) {
      throw new Error(`failed test ${outcome.name} omitted its diagnostic`);
    }
    return {
      status: "failed",
      path: outcome.path,
      name: outcome.name,
      span: outcome.span,
      diagnostic: {
        code: diagnostic.code,
        message: diagnostic.message,
        span: diagnostic.span,
      },
    };
  });
}
