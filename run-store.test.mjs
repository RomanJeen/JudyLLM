import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { buildRunMeta } from "./excel-writer.mjs";
import { createRunWriter, readRunListing } from "./run-store.mjs";

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "run-store-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const row = (index, verdict = "OK") => ({ index, question: `q${index}`, verdict });

test("runs created in the same second never share a file", () =>
  withDir((outputDir) => {
    const a = createRunWriter({ outputDir, timestamp: "2026-01-01-000000" });
    const b = createRunWriter({ outputDir, timestamp: "2026-01-01-000000" });
    assert.notEqual(a.outputPath, b.outputPath);
    assert.equal(basename(a.outputPath), "judged-2026-01-01-000000.json");
    assert.equal(basename(b.outputPath), "judged-2026-01-01-000000-2.json");
  }));

test("a run name is not reused when its log or workbook already exists", () =>
  withDir(async (outputDir) => {
    const first = createRunWriter({ outputDir, timestamp: "t" });
    rmSync(first.outputPath);
    // A leftover log from the removed run must not be appended to by a new run.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(outputDir, "judged-t.log.jsonl"), "");
    const next = createRunWriter({ outputDir, timestamp: "t" });
    assert.equal(basename(next.outputPath), "judged-t-2.json");
  }));

test("savePartial keeps judged and out-of-order rows, flags the file as partial", () =>
  withDir(async (outputDir) => {
    const writer = createRunWriter({ outputDir });
    await writer.appendRow(row(1));
    await writer.appendRow(row(2, "FALSE"));
    // Rows 4 and 5 finished before row 3 and were still waiting to be written.
    const { stats } = writer.savePartial({ extraRows: [row(5, "ERROR"), row(4)], plannedTotal: 10 });

    assert.equal(stats.total, 4);
    const saved = JSON.parse(readFileSync(writer.outputPath, "utf8"));
    assert.equal(saved.partial, true);
    assert.equal(saved.complete, false);
    assert.equal(saved.plannedTotal, 10);
    assert.deepEqual(saved.rows.map((r) => r.index), [1, 2, 4, 5]);
    assert.equal(saved.summary.total, 4);
    assert.equal(saved.summary.false, 1);
    assert.equal(saved.summary.error, 1);
    assert.equal(existsSync(`${writer.outputPath}.tmp`), false);

    const listing = await readRunListing(writer.outputPath);
    assert.equal(listing.partial, true);
    assert.equal(listing.complete, false);
    assert.equal(listing.plannedTotal, 10);
  }));

test("run meta records whether human feedback was sent to the judge", () =>
  withDir(async (outputDir) => {
    const off = createRunWriter({ outputDir, timestamp: "off", systemPromptName: "pola-v3", includeFeedback: false });
    const on = createRunWriter({ outputDir, timestamp: "on", systemPromptName: "pola-v3" });
    const savedOff = JSON.parse(readFileSync(off.outputPath, "utf8"));
    const savedOn = JSON.parse(readFileSync(on.outputPath, "utf8"));

    assert.equal(savedOff.meta.humanFeedback, false);
    assert.ok(savedOff.meta.tags.includes("feedback-off"));
    assert.equal(savedOn.meta.humanFeedback, true);
    assert.ok(!savedOn.meta.tags.includes("feedback-off"));

    // Older runs have no field and count as feedback on.
    assert.equal(buildRunMeta({ promptName: "default" }).humanFeedback, true);
  }));

test("finalize marks a run complete and not partial", () =>
  withDir(async (outputDir) => {
    const writer = createRunWriter({ outputDir });
    await writer.appendRow(row(1));
    await writer.finalize();
    const listing = await readRunListing(writer.outputPath);
    assert.equal(listing.complete, true);
    assert.equal(listing.partial, false);
  }));
