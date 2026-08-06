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
  assertEquals(
    migrated.source,
    `let result =
  let value = 0
  for values:
    if ready:
      break
    else:
      value := value + 1

  return value
return result
`,
  );
  assertEquals((await parse(migrated.source)).ok, true);
});

Deno.test("layout migration writes colons for every statement conditional branch", async () => {
  const legacy = `let choose = fn value => do
  if value then
    return 1;
  else if other then
    return 2;
  else
    return 3;
  end;
end;
return choose;
`;
  const migrated = await migrateLayoutSource(legacy);
  if (!migrated.ok) throw new Error(migrated.diagnostics[0]?.message);
  assertEquals(
    migrated.source,
    `let choose = fn value =>
  if value:
    return 1
  else if other:
    return 2
  else:
    return 3
return choose
`,
  );
});

Deno.test("layout migration writes vertical value conditional branches", async () => {
  const legacy = `let choose = fn ready => do
  return if ready then 1 else 2 end;
end;
return choose;
`;
  const migrated = await migrateLayoutSource(legacy);
  if (!migrated.ok) throw new Error(migrated.diagnostics[0]?.message);
  assertEquals(
    migrated.source,
    `let choose = fn ready =>
  if ready:
    return 1
  else:
    return 2
return choose
`,
  );
  assertEquals((await parse(migrated.source)).ok, true);
});

Deno.test("layout migration updates the previous indentation syntax", async () => {
  const previous = `let choose = fn ready =>
  return if ready then 1 else 2
return choose
`;
  const migrated = await migrateLayoutSource(previous);
  if (!migrated.ok) throw new Error(migrated.diagnostics[0]?.message);
  assertEquals(
    migrated.source,
    `let choose = fn ready =>
  if ready:
    return 1
  else:
    return 2
return choose
`,
  );
  assertEquals((await parse(migrated.source)).ok, true);
});

Deno.test("layout migration writes a colon after a guard alternative", async () => {
  const legacy = `let unwrap = fn option => do
  if let #Some value = option else
    return 0;
  end;
  return value;
end;
return unwrap;
`;
  const migrated = await migrateLayoutSource(legacy);
  if (!migrated.ok) throw new Error(migrated.diagnostics[0]?.message);
  assertEquals(
    migrated.source,
    `let unwrap = fn option =>
  if let #Some value = option else:
    return 0

  return value
return unwrap
`,
  );
});
