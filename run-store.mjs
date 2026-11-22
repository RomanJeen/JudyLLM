import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { basename, join } from "path";
import {
  buildRunMeta,
  countVerdict,
  emptyStats,
  readEvalWorkbookRows,
  readEvalWorkbookSummary,
  readRunMetaFile,
  withRates,
} from "./excel-writer.mjs";

export const RUN_FILE_VERSION = 2;
const SAVE_EVERY_ROWS = 10;

export const RUN_NAME_RE = /^judged-.+\.(json|xlsx)$/i;

export function isRunFileName(name) {
  const lower = String(name || "").toLowerCase();
  return RUN_NAME_RE.test(lower) && !lower.endsWith(".meta.json");
}

export function runFormat(name) {
  return String(name).toLowerCase().endsWith(".xlsx") ? "xlsx" : "json";
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function makeTimestamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// Reserve a run file name no earlier run (saved partial reports included) can
// share. Seconds in the timestamp make clashes rare; the exclusive create
// ("wx") makes them impossible, and a numeric suffix resolves any that remain.
function claimRunPath(outputDir, timestamp) {
  for (let attempt = 1; ; attempt += 1) {
    const stem = attempt === 1 ? `judged-${timestamp}` : `judged-${timestamp}-${attempt}`;
    const path = join(outputDir, `${stem}.json`);
    const siblings = [`${stem}.xlsx`, `${stem}.log.jsonl`].map((name) => join(outputDir, name));
    if (siblings.some((sibling) => existsSync(sibling))) continue;
    try {
      closeSync(openSync(path, "wx"));
      return path;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
}

function writeJsonAtomic(path, data) {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
}

export class RunWriter {
  constructor({
    outputDir,
    timestamp = makeTimestamp(),
    saveEvery = SAVE_EVERY_ROWS,
    systemPrompt = "",
    systemPromptSource = "",
    systemPromptName = "",
    inputFile = "",
    target = "",
    backendUrl = "",
    includeFeedback = true,
  }) {
    mkdirSync(outputDir, { recursive: true });
    this.outputPath = claimRunPath(outputDir, timestamp);
    this.saveEvery = saveEvery;
    this.stats = emptyStats();
    this.rows = [];

    const createdAt = new Date().toISOString();
    const meta = buildRunMeta({
      outputFile: basename(this.outputPath),
      inputFile,
      promptName: systemPromptName,
      promptSource: systemPromptSource,
      target,
      backendUrl,
      humanFeedback: includeFeedback,
      createdAt,
    });
    this.run = {
      version: RUN_FILE_VERSION,
      createdAt,
      updatedAt: createdAt,
      complete: false,
      title: `Pola Eval - ${createdAt}`,
      meta,
      judgePrompt: {
        scenario: systemPromptName || systemPromptSource || "",
        source: systemPromptSource,
        text: systemPrompt,
      },
      summary: withRates(this.stats),
      rows: this.rows,
    };

    mkdirSync(outputDir, { recursive: true });
    this.save();
  }

  async appendRow(rowData) {
    this.addRow(rowData);

    if (this.stats.total % this.saveEvery === 0) {
      this.save();
      console.log(`Saved checkpoint: ${this.outputPath} (${this.stats.total} rows)`);
    }
  }

  addRow(rowData) {
    const verdict = String(rowData.verdict ?? "").toUpperCase();
    countVerdict(this.stats, verdict);
    this.rows.push({
      index: rowData.index ?? this.stats.total,
      question: rowData.question ?? "",
      expected: rowData.expected ?? "",
      humanFeedback: rowData.humanFeedback ?? "",
      finalAgentAnswer: rowData.finalAgentAnswer ?? "",
      transcript: rowData.transcript ?? "",
      turns: rowData.turns ?? null,
      verdict,
      explanation: rowData.explanation ?? "",
    });
  }

  // Keep what has been judged so far when a run is stopped on purpose.
  // `extraRows` are rows that finished out of order and have not been written yet.
  savePartial({ extraRows = [], plannedTotal = null } = {}) {
    const ordered = [...extraRows]
      .filter(Boolean)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const rowData of ordered) this.addRow(rowData);
    this.rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    this.run.complete = false;
    this.run.partial = true;
    this.run.stoppedAt = new Date().toISOString();
    this.run.plannedTotal = Number.isFinite(plannedTotal) ? plannedTotal : null;
    this.save();
    return { outputPath: this.outputPath, stats: withRates(this.stats) };
  }

  save() {
    this.run.summary = withRates(this.stats);
    this.run.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.outputPath, this.run);
  }

  async finalize() {
    this.run.complete = true;
    this.save();
    return { outputPath: this.outputPath, stats: withRates(this.stats) };
  }
}

export function createRunWriter(options) {
  return new RunWriter(options);
}

const CHAT_PATH_RE = /\/api\/v1\/agent\/chat\/?$/;

// Runs saved before endpoint tracking only have it in the sidecar log
// ("Target: dev" / "Backend: https://host/api/v1/agent/chat" near the top).
function readEndpointFromLog(runPath) {
  const logPath = String(runPath).replace(/\.(json|xlsx)$/i, ".log.jsonl");
  if (!existsSync(logPath)) return {};
  let target = "";
  let backendUrl = "";
  try {
    for (const line of readFileSync(logPath, "utf8").split("\n").slice(0, 60)) {
      if (!line) continue;
      const text = String(JSON.parse(line).l ?? "");
      const targetMatch = text.match(/^Target:\s*(\S+)/);
      const backendMatch = text.match(/^Backend:\s*(\S+)/);
      if (targetMatch) target = targetMatch[1];
      if (backendMatch) backendUrl = backendMatch[1].replace(CHAT_PATH_RE, "");
      if (target && backendUrl) break;
    }
  } catch {
    return {};
  }
  return { target, backendUrl };
}

function readJsonRun(fullPath) {
  const raw = JSON.parse(readFileSync(fullPath, "utf8"));
  const legacyEndpoint = raw.meta && !raw.meta.target && !raw.meta.backendUrl ? readEndpointFromLog(fullPath) : {};
  const meta = raw.meta
    ? buildRunMeta({ ...raw.meta, ...legacyEndpoint, createdAt: raw.createdAt })
    : null;
  return {
    createdAt: raw.createdAt || "",
    complete: Boolean(raw.complete),
    partial: Boolean(raw.partial) && !raw.complete,
    plannedTotal: Number.isFinite(raw.plannedTotal) ? raw.plannedTotal : null,
    title: raw.title || "",
    meta: meta?.tags.length ? meta : null,
    judgePrompt: raw.judgePrompt || null,
    summary: raw.summary ? withRates(raw.summary) : null,
    rows: Array.isArray(raw.rows) ? raw.rows : [],
  };
}

async function readXlsxRun(fullPath) {
  const workbook = await readEvalWorkbookRows(fullPath);
  const meta = readRunMetaFile(fullPath);
  return {
    createdAt: meta?.createdAt || "",
    complete: true,
    meta,
    ...workbook,
  };
}

export async function readRun(fullPath) {
  const name = basename(fullPath);
  const format = runFormat(name);
  const run = format === "json" ? readJsonRun(fullPath) : await readXlsxRun(fullPath);
  return { name, format, ...run };
}

export async function readRunListing(fullPath) {
  if (runFormat(fullPath) === "json") {
    const { summary, meta, complete, partial, plannedTotal } = readJsonRun(fullPath);
    return { summary, meta, complete, partial, plannedTotal };
  }
  return {
    summary: await readEvalWorkbookSummary(fullPath),
    meta: readRunMetaFile(fullPath),
    complete: true,
    partial: false,
    plannedTotal: null,
  };
}
