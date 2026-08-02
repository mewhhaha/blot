import { assertEquals, assertThrows } from "@std/assert";
import { parseBuildArguments } from "./build_arguments.ts";

Deno.test("a build without a target selects gpupaper", () => {
  assertEquals(parseBuildArguments(["example.blot"]), {
    mode: "direct",
    target: "gpupaper",
    paths: ["example.blot"],
    serviceUrl: undefined,
  });
});

Deno.test("gpufuck remains available as an explicit service target", () => {
  assertEquals(
    parseBuildArguments([
      "--target=gpufuck",
      "--mode=service",
      "example.blot",
    ]),
    {
      mode: "service",
      target: "gpufuck",
      paths: ["example.blot"],
      serviceUrl: undefined,
    },
  );
});

Deno.test("the default gpupaper target refuses service mode", () => {
  assertThrows(
    () => parseBuildArguments(["--mode=service", "example.blot"]),
    Error,
    "--target=gpupaper does not support --mode=service",
  );
});
