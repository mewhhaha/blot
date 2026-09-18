// Execute real generated Wasm, including warm edits against fresh compilation.
// This exercises only the explicitly experimental pure fragment, not gdev.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let binaryPath =
  "experiments/staged-core/native/target/release/staged-prototype";
if (process.argv[2] !== undefined) binaryPath = process.argv[2];
const binary = resolve(binaryPath);
const temporary = mkdtempSync(join(tmpdir(), "blot-staged-lab-"));
const here = dirname(fileURLToPath(import.meta.url));
let invocations = 0;
let assertions = 0;
const summaries = [];

function invoke(source, edit) {
  const directory = join(temporary, `case-${invocations++}`);
  const input = `${directory}.blot`;
  const output = `${directory}.wasm`;
  const args = [input, output];
  writeFileSync(input, source);
  if (edit !== undefined) {
    const edited = `${directory}.edited.blot`;
    writeFileSync(edited, edit);
    args.push(edited);
  }
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, result.stderr);
  const records = result.stdout.trim().split("\n").filter(Boolean).map(
    JSON.parse,
  );
  return { ...result, records, output };
}
function success(source, edit) {
  const result = invoke(source, edit);
  assert.equal(result.status, 0, result.stderr);
  let expectedRecords = 1;
  if (edit !== undefined) expectedRecords = 2;
  assert.equal(result.records.length, expectedRecords);
  return result;
}
async function load(path) {
  const bytes = readFileSync(path);
  assert(WebAssembly.validate(bytes));
  const { instance } = await WebAssembly.instantiate(bytes);
  return instance.exports;
}
async function evaluate(source, expected, inputs = [-17n, 0n, 42n, 65535n]) {
  const result = success(source);
  const exports = await load(result.output);
  for (const x of inputs) {
    assert.equal(exports.run(x), expected(x));
    assertions++;
  }
  return { result, exports };
}
async function compareEdit(name, source, edit, before, after) {
  const warm = success(source, edit);
  const fresh = success(edit);
  const a = await load(warm.output);
  const b = await load(`${warm.output}.edited.wasm`);
  const c = await load(fresh.output);
  for (const x of [-7n, 0n, 41n, 999n]) {
    assert.equal(a.run(x), before(x));
    assert.equal(b.run(x), after(x));
    assert.equal(c.run(x), b.run(x));
    assertions += 3;
  }
  summaries.push({ name, cold: warm.records[0], edited: warm.records[1] });
  return warm;
}
const pre = "const Int = @staged.int\nconst Bool = @staged.bool\n";
const exported = "\nreturn { .run = fn (x: Int) -> Int => f x; }\n";
try {
  const demo = readFileSync(join(here, "demo.blot"), "utf8");
  const edit = demo.replace("makeAdder 10", "makeAdder 20");
  assert.notEqual(demo, edit);
  const demoResult = await compareEdit(
    "typed generator and local edit",
    demo,
    edit,
    (x) => x + 10n,
    (x) => x + 20n,
  );
  const work = demoResult.records[1].artifact.work;
  assert.equal(work.checked_definitions, 1);
  assert.equal(work.reused_definitions, 8);
  assert.equal(work.static_calls, 0);
  assert.equal(work.emitted_functions, 1);
  assert(work.reused_functions > 0);

  await evaluate(
    `${pre}const make = fn x => fn y => @staged.add (x, y)
const a = make 10
const b = make 20
const f = fn x => @staged.add (a x, b x)${exported}`,
    (x) => 2n * x + 30n,
  );

  await evaluate(
    `${pre}const get = fn r => r.value
const id = fn x => x
const number = get { .extra = @staged.true; .value = id 3; }
const yes = get { .value = id @staged.true; .different = 99; }
const f = fn x => do:
  if yes:
    return @staged.add (x, number)
  else:
    return 0${exported}`,
    (x) => x + 3n,
  );

  const globals = `${pre}const amount = 1
const f = fn x => @staged.add (x, amount)
const amount = 100${exported}`;
  await compareEdit(
    "shadowed binding and symbol relocation",
    globals,
    globals.replace(
      "const amount = 1\n",
      "const inserted = 77\nconst amount = 2\n",
    ),
    (x) => x + 1n,
    (x) => x + 2n,
  );
  await compareEdit(
    "deleted preceding definition",
    `${pre}const unused = fn n => n
const f = fn x => @staged.add (x, 4)${exported}`,
    `${pre}const f = fn x => @staged.add (x, 5)${exported}`,
    (x) => x + 4n,
    (x) => x + 5n,
  );

  const helper = `${pre}const helper = fn x => @staged.add (x, 1)
const fixed = @staged.static (helper 5)
const f = fn x => @staged.add (helper x, fixed)${exported}`;
  const h = await compareEdit(
    "static implementation dependency",
    helper,
    helper.replace("(x, 1)", "(x, 2)"),
    (x) => x + 7n,
    (x) => x + 9n,
  );
  assert.equal(h.records[1].artifact.work.checked_definitions, 2);
  assert(h.records[1].artifact.work.static_calls > 0);

  const syntax = `infixl 5 (+) = add
const add = fn x => fn y => @staged.add (x, y)
const sub = fn x => fn y => @staged.sub (x, y)
${pre}const f = fn (x: Int) -> Int => x + 3${exported}`;
  await compareEdit(
    "fixity is an observed input",
    syntax,
    syntax.replace("(+) = add", "(+) = sub"),
    (x) => x + 3n,
    (x) => x - 3n,
  );

  await evaluate(
    `${pre}const code = @staged.static (@staged.quote (fn x => @staged.mul (x, 3)))
const f = @staged.splice code${exported}`,
    (x) => x * 3n,
  );

  const both = success(
    `${pre}const compute = fn x => @staged.add (@staged.mul (x, 3), 2)
const expected = @staged.static (compute 17)
return { .run = fn (x: Int) -> Int => compute x; .expected = fn () -> Int => expected; }
`,
  );
  const observed = await load(both.output);
  assert.equal(observed.expected(), 53n);
  assert.equal(observed.run(17n), observed.expected());
  assertions += 2;

  const bool = success(`${pre}return { .flip = fn (x: Bool) -> Bool => do:
  if x:
    return @staged.false
  else:
    return @staged.true
; }
`);
  const booleans = await load(bool.output);
  assert.equal(booleans.flip(0), 1);
  assert.equal(booleans.flip(1), 0);
  assert.throws(() => booleans.flip(2), WebAssembly.RuntimeError);
  assertions += 3;

  // Scalar exports restore request scratch storage; closures still capture distinct values.
  const repeat = await load(demoResult.output);
  for (let i = 0; i < 100_000; i++) {
    assert.equal(repeat.run(BigInt(i)), BigInt(i + 10));
    assertions++;
  }

  // Arithmetic intentionally has this laboratory's explicit wrapping Int64 contract.
  const wrapping = await evaluate(
    `${pre}const f = fn x => @staged.add (x, 1)${exported}`,
    (x) => BigInt.asIntN(64, x + 1n),
    [(1n << 63n) - 1n, -(1n << 63n)],
  );
  assert.equal(wrapping.exports.run((1n << 63n) - 1n), -(1n << 63n));

  const bad = demo.replace(
    "makeSchema (Int, Int)",
    "makeSchema (@staged.bool, Int)",
  );
  const warmError = invoke(demo, bad);
  const freshError = invoke(bad);
  assert.equal(warmError.status, 1);
  assert.equal(freshError.status, 1);
  const error = JSON.parse(warmError.stderr.trim());
  assert.equal(error.class, "Source");
  assert.deepEqual(error, JSON.parse(freshError.stderr.trim()));
  const unchangedEdit = invoke(demo, demo);
  assert.equal(unchangedEdit.status, 1);
  assert.match(unchangedEdit.stderr, /must differ/);

  for (
    const invalid of [
      "const x = @staged.splice 1\nreturn {}\n",
      "const f = fn n => @staged.static n\nreturn {}\n",
      "const wrong = @staged.add (1, @staged.true)\nreturn {}\n",
      "const f = fn x => x x\nreturn {}\n",
    ]
  ) {
    const failure = invoke(invalid);
    assert.equal(failure.status, 1);
    assert.equal(JSON.parse(failure.stderr.trim()).class, "Source");
  }
  const unsupported = invoke('open import "blot:prelude"\nreturn {}\n');
  assert.equal(unsupported.status, 1);
  assert.equal(JSON.parse(unsupported.stderr.trim()).class, "Unsupported");
  console.log(
    JSON.stringify({
      suite: "staged-lab-wasm",
      invocations,
      assertions,
      summaries,
    }),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
