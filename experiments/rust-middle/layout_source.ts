import { elaborateLayout, type LayoutSource } from "../../src/syntax/layout.ts";

export async function layoutSource(
  path: string,
  source: string,
): Promise<LayoutSource> {
  const result = await elaborateLayout(source);
  if (result.ok) return result.layout;
  const diagnostic = result.diagnostics[0];
  if (diagnostic === undefined) {
    throw new Error(`${path}: layout elaboration failed without a diagnostic`);
  }
  throw new Error(
    `${path}:${diagnostic.span.start}: ${diagnostic.code}: ${diagnostic.message}`,
  );
}
