import { existsSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { buildEvalWorkbook, EVAL_COLUMNS } from "./excel-writer.mjs";
import { isRunFileName, readRun } from "./run-store.mjs";

export const EXPORT_FORMATS = {
  xlsx: {
    label: "Excel",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  csv: { label: "CSV", contentType: "text/csv; charset=utf-8" },
  json: { label: "JSON", contentType: "application/json; charset=utf-8" },
};

export function isExportFormat(format) {
  return Object.hasOwn(EXPORT_FORMATS, String(format || ""));
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function runToCsv(run) {
  const lines = [EVAL_COLUMNS.map((column) => csvCell(column.header)).join(",")];
  for (const row of run.rows) {
    lines.push(EVAL_COLUMNS.map(({ key }) => csvCell(row[key])).join(","));
  }
  // BOM so Excel opens Hebrew text as UTF-8.
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function runToJson(run) {
  const { name, format, ...data } = run;
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function exportFileName(runName, format) {
  return `${basename(runName).replace(/\.(json|xlsx)$/i, "")}.${format}`;
}

export async function exportRun(run, format) {
  if (!isExportFormat(format)) throw new Error(`Unsupported export format: ${format}`);

  let body;
  if (format === "xlsx") body = Buffer.from(await buildEvalWorkbook(run).xlsx.writeBuffer());
  else if (format === "csv") body = Buffer.from(runToCsv(run), "utf8");
  else body = Buffer.from(runToJson(run), "utf8");

  return {
    body,
    contentType: EXPORT_FORMATS[format].contentType,
    fileName: exportFileName(run.name, format),
  };
}

async function cli(argv) {
  const args = [...argv];
  const formatIdx = args.indexOf("--format");
  const format = formatIdx >= 0 ? args.splice(formatIdx, 2)[1] : "xlsx";
  const [target] = args;

  if (!target || !isExportFormat(format)) {
    console.error("Usage: npm run export -- <run file or name> [--format xlsx|csv|json]");
    process.exit(1);
  }

  const runsDir = join(dirname(fileURLToPath(import.meta.url)), "runs");
  const fullPath = existsSync(target) ? resolve(target) : join(runsDir, basename(target));
  if (!isRunFileName(basename(fullPath)) || !existsSync(fullPath)) {
    console.error(`Run not found: ${target}`);
    process.exit(1);
  }

  const { body, fileName } = await exportRun(await readRun(fullPath), format);
  writeFileSync(fileName, body);
  console.log(`Wrote ${resolve(fileName)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
