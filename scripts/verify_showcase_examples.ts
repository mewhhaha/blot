import { assertEquals } from "@std/assert";
import { basename, join } from "@std/path";
import { Compiler } from "../src/compiler/session.ts";
import { evaluateFile, show } from "../src/run.ts";

const everydayExamples = [
  "bank_ledger.blot",
  "checkout_workflow.blot",
  "configuration_layers.blot",
  "http_router.blot",
  "idempotent_events.blot",
  "inventory_restock.blot",
  "invoice_report.blot",
  "log_report.blot",
  "paginated_feed.blot",
  "retry_policy.blot",
  "sensor_units.blot",
  "shader_metadata.blot",
  "shopping_cart.blot",
  "stream_offsets.blot",
  "typed_transitions.blot",
  "unicode_preview.blot",
  "validation_pipeline.blot",
  "word_frequency.blot",
] as const;

const algorithmExamples = [
  "breadth_first_search.blot",
  "depth_first_search.blot",
  "dijkstra_shortest_paths.blot",
  "topological_sort.blot",
] as const;

const abstractionExamples = [
  "nonempty_effect_stream.blot",
  "typed_effect_pipeline.blot",
  "schema_effects.blot",
  "linear_transaction.blot",
  "typed_quantities.blot",
  "typed_lenses.blot",
  "composable_ordering.blot",
  "typed_nonempty.blot",
  "structural_readers.blot",
  "typed_validation.blot",
  "effect_row_middleware.blot",
  "composable_reducers.blot",
  "typed_semiring_matrices.blot",
  "nominal_keyed_index.blot",
  "composable_parser.blot",
  "composable_prisms.blot",
  "derived_structural_diff.blot",
  "staged_request_builder.blot",
  "typed_codec.blot",
  "deferred_fallback.blot",
  "residual_command_router.blot",
  "typed_relational_join.blot",
  "typed_coordinate_spaces.blot",
  "reversible_updates.blot",
  "typed_traversals.blot",
  "typed_record_projections.blot",
  "composable_event_aggregates.blot",
  "staged_bounded_domains.blot",
  "shared_service_contracts.blot",
  "stateful_processors.blot",
  "reversible_protocols.blot",
  "zoomable_state_actions.blot",
  "renderable_observations.blot",
  "typed_record_edits.blot",
  "typed_transducers.blot",
  "typed_subtyping_witnesses.blot",
  "interpretable_policies.blot",
  "typed_resource_leases.blot",
] as const;

let selectedExamples: readonly string[] = [
  ...everydayExamples,
  ...algorithmExamples,
  ...abstractionExamples,
];
if (Deno.args.length > 0) {
  if (Deno.args.length !== 1 || Deno.args[0] !== "--algorithms") {
    throw new TypeError(
      `verify_showcase_examples.ts accepts only --algorithms, received ${
        Deno.args.join(" ")
      }`,
    );
  }
  selectedExamples = algorithmExamples;
}

const compiler = await Compiler.create();
try {
  for (const name of selectedExamples) {
    const path = join("examples", name);
    const printed: string[] = [];
    const value = await evaluateFile(path, {
      write: (line) => printed.push(line),
    });
    const observed = [...printed, show(value)].join("\n").trim();
    const stem = basename(name, ".blot");
    const recorded = (await Deno.readTextFile(
      join("examples/expected", `${stem}.txt`),
    )).trim();

    assertEquals(observed, recorded, `${path} changed its recorded result`);
    await compiler.compile(path);
    console.log(`${path}: evaluated and compiled`);
  }
} finally {
  compiler.destroy();
}
