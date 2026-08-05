import { assertEquals } from "@std/assert";
import { parse } from "../syntax/parse.ts";
import { migrateLayoutSource } from "./layout.ts";

Deno.test("layout migration removes delimiters without changing the AST", async () => {
  const legacy = `let choose = fn value => do
  return case value of #Left => 1, #Right => 2 end;
end;
return choose;
`;
  const migrated = await migrateLayoutSource(legacy);
  if (!migrated.ok) throw new Error(migrated.diagnostics[0]?.message);
  assertEquals(
    migrated.source,
    `let choose = fn value =>
  return case value of
    #Left => 1
    #Right => 2
return choose
`,
  );
  assertEquals((await parse(migrated.source)).ok, true);
});

Deno.test("layout migration rewrites statement suites and loops", async () => {
  const legacy = `let result = do
  let value = 0;
  for values do
    if ready then
      break;
    else
      value := value + 1;
    end;
  end;
  return value;
end;
return result;
`;
  const migrated = await migrateLayoutSource(legacy);
  if (!migrated.ok) throw new Error(migrated.diagnostics[0]?.message);
  assertEquals(migrated.source.includes("do"), false);
  assertEquals(migrated.source.includes("end"), false);
  assertEquals(migrated.source.includes("for values:"), true);
  assertEquals((await parse(migrated.source)).ok, true);
});
