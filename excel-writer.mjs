import ExcelJS from "exceljs";
import { existsSync, readFileSync } from "fs";

export const EVAL_COLUMNS = [
  { key: "index", header: "#", width: 6 },
  { key: "question", header: "Question", width: 50 },
  { key: "expected", header: "Expected", width: 60 },
  { key: "humanFeedback", header: "Human Feedback", width: 50 },
  { key: "finalAgentAnswer", header: "Final Agent Answer", width: 60 },
  { key: "transcript", header: "Transcript", width: 70 },
  { key: "turns", header: "Turns", width: 10 },
  { key: "verdict", header: "Verdict", width: 12 },
  { key: "explanation", header: "Explanation", width: 50 },
];

function styleCellByVerdict(cell, verdict) {
  const normalized = String(verdict ?? "").toUpperCase();
  const styles = {
    OK: { fill: "C6EFCE", font: "006100" },
    PARTIAL: { fill: "FCE4D6", font: "C65911" },
    FALSE: { fill: "FFC7CE", font: "9C0006" },
    ERROR: { fill: "FFEB9C", font: "9C5700" },
  };
  const style = styles[normalized];
  if (!style) return;

  cell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: style.fill },
  };
  cell.font = { bold: true, color: { argb: style.font } };
}

export function runMetaPath(workbookPath) {
  return String(workbookPath).replace(/\.xlsx$/i, ".meta.json");
}

export function buildRunMeta({
  outputFile = "",
  inputFile = "",
  promptName = "",
  promptSource = "",
  target = "",
  backendUrl = "",
  humanFeedback = true,
  createdAt = new Date().toISOString(),
} = {}) {
  // Runs saved before the toggle existed have no field and used feedback.
  const feedbackOn = humanFeedback !== false;
  const fileTag = String(inputFile || "").trim();
  const promptTag = String(promptName || promptSource || "").trim();
  const targetName = String(target || "").trim().toLowerCase();
  const url = String(backendUrl || "").trim();
  // Endpoint the judge ran against: the named target, or the URL for custom backends.
  const endpointTag = targetName === "custom" ? url || targetName : targetName || url;
  const tags = [
    ...new Set(
      [fileTag, promptTag, endpointTag, feedbackOn ? "" : "feedback-off"].filter(Boolean),
    ),
  ];
  return {
    version: 1,
    createdAt,
    outputFile: String(outputFile || "").trim(),
    inputFile: fileTag,
    promptName: promptTag,
    promptSource: String(promptSource || "").trim(),
    target: targetName,
    backendUrl: url,
    endpoint: endpointTag,
    humanFeedback: feedbackOn,
    tags,
  };
}

export function readRunMetaFile(workbookPath) {
  const path = runMetaPath(workbookPath);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const meta = buildRunMeta(raw);
    return meta.tags.length ? meta : null;
  } catch {
    return null;
  }
}

export function formatSummaryLine(stats) {
  const { total, ok, partial, error, passRate, score } = withRates(stats);
  return `Total: ${total} | OK: ${ok} | PARTIAL: ${partial} | FALSE: ${stats.false} | Errors: ${error} | Pass rate: ${passRate}% | Score: ${score}%`;
}

function addEvalSheet(workbook, run) {
  const sheet = workbook.addWorksheet("Eval", {
    views: [{ state: "frozen", ySplit: 3, rightToLeft: true }],
  });

  sheet.mergeCells("A1:I1");
  sheet.getCell("A1").value = run.title || `Pola Eval - ${run.createdAt || ""}`;
  sheet.getCell("A1").font = { bold: true, size: 14 };
  sheet.getCell("A1").alignment = { vertical: "middle", horizontal: "center" };

  sheet.mergeCells("A2:I2");
  sheet.getCell("A2").value = formatSummaryLine(run.summary || emptyStats());
  sheet.getCell("A2").font = { bold: true };
  sheet.getCell("A2").alignment = { vertical: "middle", horizontal: "center" };

  const header = sheet.getRow(3);
  header.values = EVAL_COLUMNS.map((column) => column.header);
  header.font = { bold: true };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "D9EAD3" },
  };
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };

  sheet.columns = EVAL_COLUMNS.map(({ key, width }) => ({ key, width }));
  sheet.autoFilter = "A3:I3";

  const verdictCol = EVAL_COLUMNS.findIndex((column) => column.key === "verdict") + 1;
  for (const rowData of run.rows || []) {
    const row = sheet.addRow(EVAL_COLUMNS.map(({ key }) => rowData[key] ?? ""));
    row.alignment = { vertical: "top", wrapText: true };
    styleCellByVerdict(row.getCell(verdictCol), rowData.verdict);
  }
}

function addJudgePromptSheet(workbook, judgePrompt = {}, meta = null) {
  const { scenario = "", source = "", text = "" } = judgePrompt || {};
  const feedbackOn = meta?.humanFeedback !== false;
  const sheet = workbook.addWorksheet("Judge Prompt");
  sheet.getCell("A1").value = "Judge system prompt";
  sheet.getCell("A1").font = { bold: true, size: 14 };
  sheet.getCell("A2").value = `Scenario: ${scenario || source || "unknown"}`;
  sheet.getCell("A3").value = `Source: ${source || "unknown"}`;
  sheet.getCell("A4").value = `Characters: ${String(text).length}`;
  sheet.getCell("A5").value = `Human feedback sent to judge: ${feedbackOn ? "yes" : "no"}`;
  sheet.getCell("A6").value = text;
  sheet.getCell("A6").alignment = { wrapText: true, vertical: "top" };
  sheet.getColumn(1).width = 120;
  sheet.getRow(6).height = 220;
}

export function buildEvalWorkbook(run) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Pola evals";
  workbook.created = run.createdAt ? new Date(run.createdAt) : new Date();
  addEvalSheet(workbook, run);
  addJudgePromptSheet(workbook, run.judgePrompt, run.meta);
  return workbook;
}

export function emptyStats() {
  return { total: 0, ok: 0, partial: 0, false: 0, error: 0 };
}

export function countVerdict(stats, verdict) {
  stats.total += 1;
  if (verdict === "OK") stats.ok += 1;
  else if (verdict === "PARTIAL") stats.partial += 1;
  else if (verdict === "FALSE") stats.false += 1;
  else stats.error += 1;
}

export function withRates(stats) {
  const partial = stats.partial ?? 0;
  const rate = (value) =>
    stats.total > 0 ? ((value / stats.total) * 100).toFixed(1) : "0.0";
  return {
    ...stats,
    partial,
    passRate: rate(stats.ok),
    score: rate(stats.ok + 0.5 * partial),
  };
}

export function parseWorkbookSummaryCell(raw) {
  const match = String(raw ?? "").match(
    /Total:\s*(\d+)\s*\|\s*OK:\s*(\d+)\s*\|\s*(?:PARTIAL:\s*(\d+)\s*\|\s*)?FALSE:\s*(\d+)\s*\|\s*Errors:\s*(\d+)\s*\|\s*Pass rate:\s*([\d.]+)\s*%(?:\s*\|\s*Score:\s*([\d.]+)\s*%)?/i,
  );
  if (!match) return null;
  const stats = withRates({
    total: Number(match[1]),
    ok: Number(match[2]),
    partial: Number(match[3] ?? 0),
    false: Number(match[4]),
    error: Number(match[5]),
  });
  return { ...stats, passRate: match[6], score: match[7] ?? stats.score };
}

function verdictColumnIndex(worksheet) {
  const values = worksheet.getRow(3).values || [];
  const idx = values.findIndex(
    (value) => String(value || "").trim().toLowerCase() === "verdict",
  );
  return idx >= 1 ? idx : null;
}

function summarizeFromVerdictColumn(worksheet) {
  const col = verdictColumnIndex(worksheet);
  if (!col) return null;

  const stats = emptyStats();
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 3) return;
    const verdict = String(row.getCell(col).value ?? "").trim().toUpperCase();
    if (!verdict) return;
    countVerdict(stats, verdict);
  });

  if (!stats.total) return null;
  return withRates(stats);
}

export async function readEvalWorkbookSummary(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return null;
  return (
    parseWorkbookSummaryCell(worksheet.getCell("A2").value) ||
    summarizeFromVerdictColumn(worksheet)
  );
}

const ROW_FIELD_ALIASES = {
  "#": "index",
  index: "index",
  question: "question",
  expected: "expected",
  "human feedback": "humanFeedback",
  "final agent answer": "finalAgentAnswer",
  agent: "finalAgentAnswer",
  transcript: "transcript",
  turns: "turns",
  verdict: "verdict",
  explanation: "explanation",
};

function cellToString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);

  if (Array.isArray(value.richText)) {
    return value.richText.map((part) => cellToString(part?.text)).join("");
  }
  if (value.text != null && value.text !== value) {
    return cellToString(value.text);
  }
  if (value.result != null && value.result !== value) {
    return cellToString(value.result);
  }
  if (value.hyperlink && value.text == null) {
    return String(value.hyperlink);
  }
  if (value.error) return String(value.error);
  return "";
}

function headerFieldMap(worksheet) {
  const values = worksheet.getRow(3).values || [];
  const map = {};
  values.forEach((value, col) => {
    if (col < 1) return;
    const key = ROW_FIELD_ALIASES[cellToString(value).trim().toLowerCase()];
    if (key && map[key] == null) map[key] = col;
  });
  return map;
}

function parseTurns(raw) {
  const text = cellToString(raw).trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJudgePromptSheet(workbook) {
  const sheet = workbook.worksheets.find(
    (candidate) => String(candidate.name || "").trim().toLowerCase() === "judge prompt",
  );
  if (!sheet) return null;

  const scenarioRaw = cellToString(sheet.getCell("A2").value);
  const sourceRaw = cellToString(sheet.getCell("A3").value);
  const text = cellToString(sheet.getCell("A6").value);
  const scenario = scenarioRaw.replace(/^scenario:\s*/i, "").trim();
  const source = sourceRaw.replace(/^source:\s*/i, "").trim();
  if (!scenario && !source && !text) return null;
  return { scenario, source, text };
}

export async function readEvalWorkbookRows(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    return { title: "", summary: null, rows: [], judgePrompt: null };
  }

  const fields = headerFieldMap(worksheet);
  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 3) return;
    const value = (key) =>
      fields[key] != null ? cellToString(row.getCell(fields[key]).value) : "";
    const question = value("question");
    const verdict = value("verdict").trim().toUpperCase();
    const expected = value("expected");
    const finalAgentAnswer = value("finalAgentAnswer");
    if (!question && !verdict && !expected && !finalAgentAnswer) return;

    const indexText = value("index").trim();
    rows.push({
      index: indexText || String(rowNumber - 3),
      question,
      expected,
      humanFeedback: value("humanFeedback"),
      finalAgentAnswer,
      transcript: value("transcript"),
      turns: fields.turns != null ? parseTurns(row.getCell(fields.turns).value) : null,
      verdict,
      explanation: value("explanation"),
    });
  });

  return {
    title: cellToString(worksheet.getCell("A1").value),
    summary:
      parseWorkbookSummaryCell(worksheet.getCell("A2").value) ||
      summarizeFromVerdictColumn(worksheet),
    rows,
    judgePrompt: parseJudgePromptSheet(workbook),
  };
}
