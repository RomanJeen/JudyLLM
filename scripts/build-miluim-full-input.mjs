import ExcelJS from "exceljs";
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SOURCE_PATH =
  process.argv[2] || join(homedir(), "Downloads", "עותק של בוט 01.11.xlsx");
const CURATED_PATH = join(ROOT, "input", "miluim-not-as-expected-2026-11-08.json");
const OUTPUT_PATH =
  process.argv[3] || join(ROOT, "input", "miluim-full-2026-11-15.json");
const SOURCE_TAG = "בוט 01.11";
const APPROVED_HEADER = "תשובת הלקוח (מקור אמת לתוכן, לא נוסח מחייב):";

function cellText(value) {
  if (value == null || value === "") return "";
  if (typeof value !== "object") return String(value);
  if ("error" in value) return "";
  if ("richText" in value) {
    return value.richText.map((part) => part.text).join("");
  }
  if ("text" in value) return String(value.text ?? "");
  if ("result" in value) return String(value.result ?? "");
  return String(value);
}

function normalize(value) {
  return cellText(value).replace(/\r\n/g, "\n").trim();
}

const curated = new Map(
  JSON.parse(readFileSync(CURATED_PATH, "utf8")).map((row) => [
    row._meta.source_row,
    row,
  ]),
);

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(SOURCE_PATH);
const sheet = workbook.worksheets[0];

const rows = [];
sheet.eachRow((row, rowNumber) => {
  if (rowNumber === 1) return;
  const number = Number(normalize(row.getCell(1).value));
  const question = normalize(row.getCell(2).value);
  const feedback = normalize(row.getCell(3).value);
  const botAnswer = normalize(row.getCell(4).value);
  if (!number || !question) return;

  const existing = curated.get(number);
  if (existing) {
    rows.push({ ...existing, _meta: { ...existing._meta, status: "not_as_expected" } });
    return;
  }

  rows.push({
    "שאלה": question,
    "תשובה": `${APPROVED_HEADER}\n${botAnswer}`,
    "מקור / ציטוט": `${SOURCE_TAG} #${number}`,
    _meta: {
      source_row: number,
      status: "approved",
      customer_feedback_raw: feedback,
      previous_bot_answer: botAnswer,
    },
  });
});

const missing = [...curated.keys()].filter(
  (n) => !rows.some((row) => row._meta.source_row === n),
);
if (missing.length) {
  throw new Error(`Curated rows not found in sheet: ${missing.join(", ")}`);
}

writeFileSync(OUTPUT_PATH, `${JSON.stringify(rows, null, 1)}\n`);

const xlsxPath = OUTPUT_PATH.replace(/\.json$/i, ".xlsx");
const out = new ExcelJS.Workbook();
const outSheet = out.addWorksheet("full", {
  views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }],
});
outSheet.columns = [
  { header: "שאלה", key: "q", width: 60 },
  { header: "תשובה", key: "a", width: 80 },
  { header: "מקור / ציטוט", key: "src", width: 24 },
];
for (const row of rows) {
  outSheet.addRow({ q: row["שאלה"], a: row["תשובה"], src: row["מקור / ציטוט"] });
}
outSheet.getColumn("q").alignment = { wrapText: true, vertical: "top" };
outSheet.getColumn("a").alignment = { wrapText: true, vertical: "top" };
await out.xlsx.writeFile(xlsxPath);

const approved = rows.filter((row) => row._meta.status === "approved").length;
console.log(
  `Wrote ${rows.length} rows (${approved} approved, ${rows.length - approved} not as expected) to ${OUTPUT_PATH} and ${xlsxPath}`,
);
