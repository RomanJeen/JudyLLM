import ExcelJS from "exceljs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WORK_DIR = join(ROOT, "work files");
const OUTPUT_PATH = join(ROOT, "input", "miluim-feedback-live.xlsx");

const SOURCES = [
  {
    file: "1בדיקה לתוכן בוט מילואים.xlsx",
    sheet: "גיליון1",
  },
  {
    file: "2בדיקה לתוכן בוט מילואים.xlsx",
    sheet: "גיליון1",
  },
  {
    file: "פידבק לתוכן בוט מילואים עם הערות - 10.09.xlsx",
    sheet: "באגים מבן גוריון",
  },
];

const SKIP_QUESTIONS = new Set([
  "בדיקה מתאריך:",
  "שאלה שנשאלה",
  "דוגמא 1",
]);

function cellText(value) {
  if (value == null || value === "") return "";
  if (typeof value !== "object") return String(value);
  if ("error" in value) return "";
  if ("richText" in value) {
    return value.richText.map((part) => part.text).join("");
  }
  if ("text" in value) return String(value.text ?? "");
  if ("result" in value) return String(value.result ?? "");
  if ("hyperlink" in value) return String(value.text || value.hyperlink || "");
  return String(value);
}

function normalize(text) {
  return cellText(text).replace(/\r\n/g, "\n").trim();
}

function isTopel(...fields) {
  return fields.some((field) => normalize(field) === "טופל");
}

function isFollowUp(question) {
  const q = question.trim();
  if (q.startsWith("ו")) return true;
  return q.includes("למה אני זכאית על פי המתווה");
}

function prefixFollowUp(previousQuestions, currentQuestion) {
  if (previousQuestions.length === 1) {
    return `בהמשך לשאלה: ${previousQuestions[0]}\n\n${currentQuestion}`;
  }
  const list = previousQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return `בהמשך לשאלות הקודמות:\n${list}\n\n${currentQuestion}`;
}

function buildExpected(oldAnswer, feedbackParts) {
  const sections = [];
  if (oldAnswer) {
    sections.push(`תשובת סוכן ישנה:\n${oldAnswer}`);
  }
  if (feedbackParts.length) {
    sections.push(`משוב לקוח:\n${feedbackParts.join("\n")}`);
  }
  return sections.join("\n\n");
}

function sourceLabel(file, number, rowNumber) {
  const ref = number || `row ${rowNumber}`;
  return `${file} #${ref}`;
}

async function readSourceRows({ file, sheet }) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(join(WORK_DIR, file));
  const worksheet = workbook.getWorksheet(sheet) || workbook.worksheets[0];
  if (!worksheet) {
    throw new Error(`No worksheet found in ${file}`);
  }

  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const number = normalize(row.getCell(1).value);
    const question = normalize(row.getCell(2).value);
    const oldAnswer = normalize(row.getCell(3).value);
    const noteE = normalize(row.getCell(5).value);
    const noteG = normalize(row.getCell(7).value);

    if (!question || SKIP_QUESTIONS.has(question) || number === "מספר שאלה") {
      return;
    }

    rows.push({
      file,
      rowNumber,
      number,
      question,
      oldAnswer,
      noteE,
      noteG,
    });
  });

  return rows;
}

// Each eval row runs in a fresh session, so a follow-up must carry its whole
// chain of previous questions, not just the one directly before it.
// Otherwise the second follow-up in a chain loses the opening turn that set
// the context (e.g. "starting next year" → "what am I entitled to" → "and
// if I serve two days in semester A").
function buildChainedQuestions(sourceRows) {
  const built = [];
  let chain = [];
  for (const row of sourceRows) {
    if (chain.length > 0 && isFollowUp(row.question)) {
      built.push(prefixFollowUp(chain, row.question));
    } else {
      built.push(row.question);
      chain = [];
    }
    chain.push(row.question);
  }
  return built;
}

function toEvalRecords(sourceRows) {
  const chained = buildChainedQuestions(sourceRows);
  return sourceRows.flatMap((row, index) => {
    if (isTopel(row.noteE, row.noteG)) return [];
    if (!row.oldAnswer && !row.noteE && !row.noteG) return [];

    const question = chained[index];

    const feedbackParts = [row.noteE, row.noteG].filter(Boolean);
    return [
      {
        שאלה: question,
        תשובה: buildExpected(row.oldAnswer, feedbackParts),
        "מקור קובץ": sourceLabel(row.file, row.number, row.rowNumber),
      },
    ];
  });
}

async function writeOutput(records) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("miluim-feedback-live", {
    views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }],
  });
  sheet.columns = [
    { header: "שאלה", key: "שאלה", width: 60 },
    { header: "תשובה", key: "תשובה", width: 80 },
    { header: "מקור קובץ", key: "מקור קובץ", width: 50 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const record of records) {
    const excelRow = sheet.addRow(record);
    excelRow.getCell(1).alignment = { wrapText: true, vertical: "top" };
    excelRow.getCell(2).alignment = { wrapText: true, vertical: "top" };
    excelRow.getCell(3).alignment = { wrapText: true, vertical: "top" };
  }
  await workbook.xlsx.writeFile(OUTPUT_PATH);
}

const sourceRowsByFile = [];
for (const source of SOURCES) {
  const rows = await readSourceRows(source);
  sourceRowsByFile.push({ file: source.file, rows, records: toEvalRecords(rows) });
}

const records = sourceRowsByFile.flatMap((entry) => entry.records);
await writeOutput(records);

for (const entry of sourceRowsByFile) {
  const skipped = entry.rows.length - entry.records.length;
  console.log(
    `${entry.file}: ${entry.rows.length} parsed, ${entry.records.length} kept, ${skipped} skipped`,
  );
}
console.log(`Wrote ${records.length} rows to ${OUTPUT_PATH}`);
