import { assertEquals, assertRejects } from "@std/assert";
import { BlotError } from "../diagnostic.ts";
import { checkFile, checkSource } from "./mod.ts";

const PRELUDE = `open import "blot:prelude"\n`;

async function writeFreshEffectModule(directory: string): Promise<string> {
  const path = `${directory}/fresh_effect.blot`;
  await Deno.writeTextFile(
    path,
    `${PRELUDE}const Fresh = @effect { .ask = Unit -> Unit; }\nreturn Fresh\n`,
  );
  return path;
}

Deno.test("distinct import occurrences keep generative effect identities distinct", async () => {
  const directory = await Deno.makeTempDir();
  await writeFreshEffectModule(directory);
  const root = `${directory}/root.blot`;
  await Deno.writeTextFile(
    root,
    `${PRELUDE}const First = import "./fresh_effect.blot"\nconst Second = import "./fresh_effect.blot"\nlet work = fn () => do:\n  <- Second.ask ()\n  return ()\nlet handler = {\n  .ask = fn (_, ?resume) => do:\n    rest <- resume ()\n    return rest\n  ;\n}\nreturn @handle (First, work, handler)\n`,
  );

  await assertRejects(
    () => checkFile(root),
    BlotError,
    "BLOT_UNHANDLED_EFFECT",
  );
});

Deno.test("an alias of one imported effect retains that instance identity", async () => {
  const directory = await Deno.makeTempDir();
  await writeFreshEffectModule(directory);
  const root = `${directory}/root.blot`;
  await Deno.writeTextFile(
    root,
    `${PRELUDE}const Fresh = import "./fresh_effect.blot"\nconst Alias = Fresh\nlet work = fn () => do:\n  <- Fresh.ask ()\n  return ()\nlet handler = {\n  .ask = fn (_, ?resume) => do:\n    rest <- resume ()\n    return rest\n  ;\n}\nreturn @handle (Alias, work, handler)\n`,
  );

  const checked = await checkFile(root);
  assertEquals(checked.type, "()");
  assertEquals(checked.effects, "");
});

Deno.test("a handler clause can reintroduce the effect it discharges", async () => {
  await assertRejects(
    () =>
      checkSource(
        "/tmp/handler-reintroduces-effect.blot",
        `${PRELUDE}const Ping = @effect { .ping = Unit -> Unit; }\nlet work = fn () => do:\n  <- Ping.ping ()\n  return ()\nlet repeats = {\n  .ping = fn (_, ?resume) => do:\n    <- Ping.ping ()\n    rest <- resume ()\n    return rest\n  ;\n}\nreturn @handle (Ping, work, repeats)\n`,
      ),
    BlotError,
    "BLOT_UNHANDLED_EFFECT",
  );
});

Deno.test("handling an absent effect is valid and may transform the return", async () => {
  const checked = await checkSource(
    "/tmp/redundant-handler.blot",
    `${PRELUDE}const Ping = @effect { .ping = Unit -> Unit; }\nlet work = fn () => 1\nlet handler = {\n  .ping = fn (_, ?resume) => do:\n    rest <- resume ()\n    return rest\n  ;\n  .return = fn value => value + 1;\n}\nreturn @handle (Ping, work, handler)\n`,
  );

  assertEquals(checked.type, "Int");
  assertEquals(checked.effects, "");
});
