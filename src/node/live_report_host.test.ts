import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LiveReport } from "../../case-studies/live-report/host.ts";
import { serveReport } from "../../case-studies/live-report/serve.ts";

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "blot-live-host-"));
  for (
    const file of [
      "main.blot",
      "score.blot",
      "heading.blot",
      "config.blot",
      "label.txt",
    ]
  ) {
    await cp(
      new URL(`../../case-studies/live-report/${file}`, import.meta.url),
      join(directory, file),
    );
  }
  return directory;
}

test("live report activates only validated candidates and recovers after failure", async () => {
  const directory = await fixture();
  const report = await LiveReport.create(join(directory, "main.blot"));
  try {
    assert.equal(report.evaluate("21").score, "42");
    const old = report.evaluate("21");
    const score = join(directory, "score.blot");
    await writeFile(score, "return invalid_name\n");
    await assert.rejects(() => report.reload([score]));
    assert.deepEqual(report.evaluate("21"), old);
    await writeFile(
      score,
      'open import "blot:prelude"\nreturn fn item => @int.mul item.quantity 3\n',
    );
    assert.equal(await report.reload([score]), "activated");
    assert.equal(report.evaluate("21").score, "63");
    assert.ok(report.evaluate("21").revision > old.revision);
    const valid = report.evaluate("21");
    await writeFile(
      score,
      'open import "blot:prelude"\nreturn fn item => @int.div item.quantity item.quantity\n',
    );
    await assert.rejects(() => report.reload([score]));
    assert.deepEqual(
      report.evaluate("21"),
      valid,
      "candidate startup trap retains prior instance",
    );
  } finally {
    await report.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("live report supersedes stale requests, rejects bad input, and closes", async () => {
  const directory = await fixture();
  const report = await LiveReport.create(join(directory, "main.blot"));
  try {
    const first = report.reload();
    const second = report.reload();
    assert.equal(await first, "superseded");
    assert.equal(await second, "activated");
    for (
      const value of ["", "2.1", "1e3", "01", " 21", "9223372036854775808"]
    ) {
      assert.throws(() => report.evaluate(value), /signed 64-bit integer/);
    }
    assert.equal(report.evaluate("-3").score, "-6");
    const pending = report.reload();
    await report.close();
    assert.equal(await pending, "superseded");
    await assert.rejects(() => report.reload(), /closed/);
    assert.throws(() => report.evaluate("21"), /closed/);
  } finally {
    await report.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("live report HTTP host serves the application and exact decimal results", async () => {
  const directory = await fixture();
  const server = await serveReport(join(directory, "main.blot"), 0);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    assert.match(await (await fetch(base)).text(), /Blot live report/);
    const response = await fetch(`${base}/report?quantity=21`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).score, "42");
    assert.equal((await fetch(`${base}/report?quantity=1.5`)).status, 400);
    assert.equal((await fetch(`${base}/missing`)).status, 404);
    assert.equal(
      (await fetch(`${base}/report`, { method: "POST" })).status,
      405,
    );
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
