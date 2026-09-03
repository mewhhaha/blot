const repository = new URL("../", import.meta.url);

await run("deno", ["task", "generate"]);
await run("pnpm", ["compiler:build"]);

console.log(
  "JSR package prepared; run `deno publish` to publish @mewhhaha/blot",
);

async function run(command: string, args: string[]): Promise<void> {
  const result = await new Deno.Command(command, {
    args,
    cwd: repository,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.code}`,
    );
  }
}
