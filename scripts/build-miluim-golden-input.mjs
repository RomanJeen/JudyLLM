import ExcelJS from "exceljs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SOURCE_PATH =
  process.argv[2] ||
  "/Users/romanrubinahtein/Downloads/golden q&a miluim - for analysis.xlsx";
const OUTPUT_PATH = join(ROOT, "input", "miluim-golden.xlsx");

const ANSWER_LABEL = "תשובת הלקוח (מקור אמת לתוכן, לא נוסח מחייב)";
const FEEDBACK_LABEL = "הנחיית משוב";

const EMOJI =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{20E3}✅📌📊🎯📞📧👤📚✍️🧪📝🎓📅⏳💰🔍💡]/gu;

const DROP_LINE =
  /^(היי[\s,]|בשמחה[!！.]?$|אם יש (לך |עוד )?שאלות|יש עוד (שאלות|משהו)|יש משהו ספציפי|אם תרצי, אוכל|אשמח לעזור|אשמח לפרט|שמח לעזור|תודה על הסבלנות|מקור\s*:|אתר\s|לרשימת הנציגים|למשרתי ומשרתות מילואים התאמות|סיווג לקבוצות לפי משך השירות$)/u;

/**
 * Feedback is an extra requirement, not a rewrite of a previous agent answer.
 * Wording is normalized only so the judge can apply the instruction.
 */
const FEEDBACK_INSTRUCTIONS = {
  2: "חובה לשאול אם שירתה 300 ימי מילואים במהלך לימודיה באוניברסיטת בן-גוריון, או לציין במפורש שזה תנאי זכאות נפרד שאינו ידוע מהשאלה. אם בשיחה ענתה על 300 הימים, התשובה הסופית חייבת להתאים לעובדות: 300+ כסטודנטית = 2 מרתונים, 300+ כלוחמת = 3.",
  4: "חובה לשאול אם הסטודנט לוחם או ייעוד קדמי לפני שקובעים קבוצה אחת, או להציג את שני הענפים בלי לבחור אחד. אם בשיחה כבר נענתה תשובה על הסטטוס, התשובה הסופית חייבת להתאים לענף שנענה.",
  6: "חובה לכלול: אם יש הקלטה לא טובה או בעיה טכנית, הסטודנטים מתבקשים ליידע בזמן אמת כדי להצמיד למרצה סיוע טכני ולתקן את הנדרש. לא מספיק לומר רק ליידע את המחלקה, בלי היידוע בזמן אמת ובלי הסיוע הטכני למרצה.",
};

/**
 * Gold corrections. Each one is grounded in the agent's knowledge base (the
 * official BGU pages / נוהל) where the customer answer was incomplete or
 * contradicted the source. The customer's file is never edited.
 */
const FACT_LINE_REPLACEMENTS = {
  4: [
    {
      test: /קבוצה 5/,
      line: "12 יום בתקופת הבחינות מזכים גם בקבוצה 5, עם התאמות נוספות לתקופת הבחינות.",
    },
  ],
  6: [
    {
      test: /הקלטה לא טובה/,
      line: "אם יש הקלטה לא טובה או בעיה טכנית, הסטודנטים מתבקשים ליידע בזמן אמת כדי להצמיד למרצה סיוע טכני ולתקן את הנדרש.",
    },
  ],
  // סיווג לקבוצות לפי משך השירות: the group set in the qualifying semester
  // is given automatically in the following semester of the same year.
  7: [
    {
      test: /לא בשנה קלנדרית/,
      line: "הקבוצה נקבעת לפי מספר ימי השירות במהלך הסמסטר (לא בשנה קלנדרית); הקבוצה שנקבעה בסמסטר המזכה ניתנת אוטומטית גם בסמסטר העוקב באותה שנה אקדמית",
    },
  ],
  // נוהל התאמות למילואים: one of the two benefits, with the remainder-days
  // rule for students who chose tutoring and served more than 10 days.
  17: [
    {
      test: /לא ניתן לקבל גם חונכות וגם קופוני צילום/,
      line: "כן, סטודנט לתואר ראשון שנעדר מלימודיו בשל שירות מילואים זכאי ל־50 קופוני צילום עבור כל יום לימודים שהפסיד. ככלל בוחרים באחת מההטבות — חונכות/תגבור או קופוני צילום — בהתאם לזכאות; מי שבחר בחונכות ושירת מעל 10 ימים רצופים זכאי לקופוני צילום על יתרת הימים שלא מומשו. את הבקשה מגישים בטופס הבקשה לסיוע אקדמי (מערכת אטלס)",
    },
  ],
  // נוהל התאמות למילואים names the kiosk; גזר is the system behind it.
  18: [
    {
      test: /מערכת גזר/,
      line: "הגשת בקשה למועד מיוחד נעשית בקיוסק המידע האישי (מערכת גזר), או לברר עם רכזת הסטודנטים של מחלקתך",
    },
  ],
};

/**
 * Lines appended to the customer answer (same grounding rule as above).
 */
const EXTRA_FACT_LINES = {
  // הגדרות + miluim-q&a: semester-B counting starts at 28/02 (שאגת הארי).
  32: [
    'לשיוך בסמסטר ב\' תשפ"ו נספרים גם ימי המילואים מתחילת מבצע "שאגת הארי" (28.2.26)',
  ],
};

/**
 * Whole-answer overrides, for rows whose customer answer belongs to a
 * different question (copy/paste in the source sheet).
 */
const EXPECTED_OVERRIDES = {
  // Source row copied the "שירות סדיר" answer (#15). The question is about a
  // student starting next year; miluim-q&a: next year's plan is unpublished.
  21: [
    'טרם פורסם המתווה לשנה הבאה (תשפ"ז); עם פרסומו תופץ הודעה לסטודנטים והמידע יפורסם בדף חרבות ברזל',
    "מסלול 60 הימים לפני הסמסטר חל רק על מי שכבר לומד/ת בשנת המתווה שפורסם, ולכן אי אפשר להתחייב כעת על זכאות או קבוצה",
    "לעדכון עם פרסום המתווה אפשר לפנות למשרד המילואים: miluim@bgu.ac.il, 08-6472481",
  ].join("\n"),
};

const FOLLOW_UP_PREFIX_RE = /^בהמשך לשאלה:\s*([\s\S]*?)\n\s*\n([\s\S]*)$/u;

/**
 * Each eval row runs in a fresh session. A row written as
 * "בהמשך לשאלה: <previous>\n\n<current>" only carries one step back, so the
 * second follow-up in a chain loses the opening turn that set the context
 * (e.g. "starting next year" → "what am I entitled to" → "and if I serve two
 * days in semester A"). Resolve chains transitively by matching <previous>
 * to an earlier row's own question and render the whole chain.
 */
function resolveFollowUpChains(rows) {
  const seen = [];
  return rows.map((row) => {
    const match = FOLLOW_UP_PREFIX_RE.exec(row.question);
    if (!match) {
      seen.push({ last: row.question.trim(), chain: [] });
      return row;
    }
    const previous = match[1].trim();
    const current = match[2].trim();
    const parent = [...seen].reverse().find((entry) => entry.last === previous);
    const chain = parent ? [...parent.chain, previous] : [previous];
    seen.push({ last: current, chain });
    if (chain.length === 1) return row;
    const list = chain.map((q, i) => `${i + 1}. ${q}`).join("\n");
    return { ...row, question: `בהמשך לשאלות הקודמות:\n${list}\n\n${current}` };
  });
}

function cellText(value) {
  if (value == null || value === "") return "";
  if (typeof value !== "object") return String(value);
  if ("error" in value) return "";
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  if ("text" in value) return String(value.text ?? "");
  if ("result" in value) return String(value.result ?? "");
  if ("hyperlink" in value) return String(value.text || value.hyperlink || "");
  return "";
}

function normalize(value) {
  return cellText(value).replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
}

function stripEmoji(text) {
  return text.replace(EMOJI, ". ");
}

function cleanLine(line) {
  let text = stripEmoji(line).replace(/[ \t]+/g, " ").trim();
  text = text.replace(/^(שמחה|אושר),\s*/u, "");
  text = text.replace(/^הערה\s*[-–—:]\s*/u, "");
  text = text.replace(/^תשובה נכונה\s*[-–—:]\s*/u, "");
  text = text.replace(/יש לדייק את התשובה\.?\s*/gu, "");
  text = text.replace(/תודה על הסבלנות\.?\s*/gu, "");
  text = text.replace(/דיווחואישור/g, "דיווח ואישור");
  text = text.replace(/\s+\./g, ".");
  text = text.replace(/\.\s*\./g, ".");
  text = text.replace(
    /^אם לא קיימת שאלה ממוקדת אודות סטטוס לוחם\/יעוד קדמי ניתן להשיב כך\.?\s*/u,
    "",
  );
  return text.replace(/^[.\s]+|[.\s]+$/g, "").trim();
}

function isDropLine(line) {
  if (!line) return true;
  if (DROP_LINE.test(line)) return true;
  if (/^[•\-–—*]\s*$/u.test(line)) return true;
  return false;
}

function cleanExpected(expected, number) {
  if (EXPECTED_OVERRIDES[number]) return EXPECTED_OVERRIDES[number];
  const replacements = FACT_LINE_REPLACEMENTS[number] || [];
  const lines = expected
    .split("\n")
    .map(cleanLine)
    .filter((line) => !isDropLine(line))
    .filter((line) => !/פרטים כאן\.?$/u.test(line))
    .map((line) => {
      const replacement = replacements.find((item) => item.test.test(line));
      return replacement ? replacement.line : line;
    })
    .concat(EXTRA_FACT_LINES[number] || []);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildRubric(expected, feedback, number) {
  const facts = cleanExpected(expected, number);
  const behavior = FEEDBACK_INSTRUCTIONS[number] || feedback.trim();
  const sections = [
    `${ANSWER_LABEL}:\n${facts || "לא הוזנה תשובת לקוח לשאלה זו."}`,
  ];
  if (behavior) sections.push(`${FEEDBACK_LABEL}:\n${behavior}`);
  return sections.join("\n\n");
}

async function readRows() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(SOURCE_PATH);
  const sheet = workbook.getWorksheet("Eval") || workbook.worksheets[0];
  const header = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    header[col] = normalize(cell.value);
  });
  const columns = {
    number: header.indexOf("#"),
    question: header.indexOf("questions"),
    expected: header.indexOf("expected"),
    feedback: header.indexOf("feedback"),
  };
  for (const [name, index] of Object.entries(columns)) {
    if (index < 1) throw new Error(`Missing column: ${name}`);
  }

  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const number = Number(normalize(row.getCell(columns.number).value));
    const question = normalize(row.getCell(columns.question).value);
    const expected = normalize(row.getCell(columns.expected).value);
    const feedback = normalize(row.getCell(columns.feedback).value);
    if (!number || !question) return;
    rows.push({ number, question, expected, feedback });
  });
  return rows;
}

async function writeOutput(records) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("miluim-golden", {
    views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }],
  });
  sheet.columns = [
    { header: "שאלה", key: "שאלה", width: 70 },
    { header: "תשובה", key: "תשובה", width: 100 },
    { header: "מקור / ציטוט", key: "מקור / ציטוט", width: 40 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const record of records) {
    const excelRow = sheet.addRow(record);
    for (const column of [1, 2, 3]) {
      excelRow.getCell(column).alignment = { wrapText: true, vertical: "top" };
    }
  }
  await workbook.xlsx.writeFile(OUTPUT_PATH);
}

const rows = resolveFollowUpChains(await readRows());
const records = rows.map((row) => ({
  שאלה: row.question,
  תשובה: buildRubric(row.expected, row.feedback, row.number),
  "מקור / ציטוט": row.feedback
    ? `golden #${row.number}\n${row.feedback}`
    : `golden #${row.number}`,
}));

await writeOutput(records);
const withFeedback = rows.filter((row) => row.feedback).map((row) => row.number);
const emptyGold = rows
  .filter((row) => !row.expected && !row.feedback)
  .map((row) => row.number);
console.log(`Wrote ${records.length} rows to ${OUTPUT_PATH}`);
console.log(`Feedback rows: ${withFeedback.join(", ") || "none"}`);
console.log(`Empty gold rows: ${emptyGold.join(", ") || "none"}`);
