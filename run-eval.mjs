import { createHash } from "crypto";
import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import { appendFileSync, readFileSync, rmSync } from "fs";
import { format } from "util";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  AGENT_CHAT_ENDPOINT as ENDPOINT,
  agentAuthHeaders,
  createBackendGate,
  createChatSessionClient,
  describeError,
  fetchWhenReady,
  formatAuthLog,
  formatSessionLog,
  resolveBackendConfig,
} from "./backend-config.mjs";
import {
  createJudge,
  describeJudgeSystemPrompt,
  JudgeModelError,
  resolveIncludeFeedback,
} from "./judge.mjs";
import { createRunWriter } from "./run-store.mjs";

const INPUT_FILE = basename(process.env.INPUT_FILE || "pola_test_20260521.xlsx");

const runLog = createRunLog();
runLog.install();

function logPathFor(runPath) {
  return String(runPath).replace(/\.(json|xlsx)$/i, ".log.jsonl");
}

function createRunLog() {
  let pending = [];
  let logPath = null;

  function record(stream, args) {
    const t = Date.now();
    for (const l of format(...args).split(/\r?\n/)) {
      const entry = JSON.stringify({ t, s: stream, l });
      if (logPath) appendFileSync(logPath, `${entry}\n`);
      else pending.push(entry);
    }
  }

  return {
    install() {
      for (const [method, stream] of [["log", "out"], ["error", "err"], ["warn", "err"]]) {
        const original = console[method].bind(console);
        console[method] = (...args) => {
          original(...args);
          record(stream, args);
        };
      }
    },
    attach(runPath) {
      logPath = logPathFor(runPath);
      if (pending.length) appendFileSync(logPath, `${pending.join("\n")}\n`);
      pending = [];
    },
  };
}

let activeRunPath = null;
let runFinished = false;

process.on("exit", () => {
  if (runFinished || !activeRunPath) return;
  for (const path of [activeRunPath, `${activeRunPath}.tmp`, logPathFor(activeRunPath)]) {
    rmSync(path, { force: true });
  }
});
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

// The UI server asks for a stop over the IPC channel (works on every OS; POSIX
// signals do not carry a payload and do not exist on Windows). `{ type: "stop",
// save: true }` keeps what has been judged so far as a partial report.
let partialSaver = null;
if (typeof process.send === "function") {
  process.on("message", (message) => {
    if (message?.type !== "stop") return;
    if (message.save !== true || !partialSaver) process.exit(143);
    try {
      const { outputPath, stats } = partialSaver();
      runFinished = true;
      console.log(
        `Stopped. ${stats.total} rows kept as a partial report | ${stats.ok} OK | ${stats.partial} PARTIAL | ${stats.false} FALSE | ${stats.error} ERROR`,
      );
      console.log(`File: ${outputPath}`);
      process.exit(0);
    } catch (err) {
      console.error(`Could not save partial report: ${err.message}`);
      process.exit(143);
    }
  });
  // Listening on the channel must not keep the process alive after the run ends.
  process.channel?.unref();
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = join(__dirname, "input");

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const {
  target: EVAL_TARGET,
  backendUrl: BACKEND_URL,
  apiKey: API_KEY,
  apiKeySource: API_KEY_SOURCE,
  chatSessionMode: CHAT_SESSION_MODE,
} = resolveBackendConfig();
const LIMIT = envNumber("LIMIT", 0);
const CONCURRENCY = Math.max(1, envNumber("CONCURRENCY", 2));
const STAGGER_MS = Math.max(0, envNumber("STAGGER_MS", 3000));
const AGENT_MAX_RETRIES = Math.max(0, envNumber("AGENT_MAX_RETRIES", 8));
const AGENT_RETRY_BASE_MS = Math.max(100, envNumber("AGENT_RETRY_BASE_MS", 10000));
const AGENT_RETRY_MAX_MS = Math.max(
  AGENT_RETRY_BASE_MS,
  envNumber("AGENT_RETRY_MAX_MS", 60000),
);
const BACKEND_WAIT_MS = Math.max(0, envNumber("BACKEND_WAIT_MS", 600_000));
const BACKEND_PROBE_MS = Math.max(200, envNumber("BACKEND_PROBE_MS", 2_000));
const backendGate = createBackendGate({
  backendUrl: BACKEND_URL,
  waitMs: BACKEND_WAIT_MS,
  probeMs: BACKEND_PROBE_MS,
  log: (line) => console.warn(line),
});
const JUDGE_MAX_AGENT_TURNS = Math.max(
  1,
  envNumber("JUDGE_MAX_AGENT_TURNS", 4),
);
const chatSessions = createChatSessionClient({
  backendUrl: BACKEND_URL,
  apiKey: API_KEY,
  mode: CHAT_SESSION_MODE,
  gate: backendGate,
  maxRetries: AGENT_MAX_RETRIES,
  retryBaseMs: AGENT_RETRY_BASE_MS,
  retryMaxMs: AGENT_RETRY_MAX_MS,
});
const QUESTION_COLUMNS = ["שאלה", "input"];
const EXPECTED_COLUMNS = ["תשובה", "תשובה עדכנית פולה"];
const HUMAN_FEEDBACK_COLUMNS = ["מקור / ציטוט", "הערות עילם ורויטל"];

class AgentHttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let chatSlot = Promise.resolve();

async function waitForChatSlot() {
  if (STAGGER_MS <= 0) return;

  const previous = chatSlot;
  let release;
  chatSlot = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  setTimeout(release, STAGGER_MS);
}

function retryDelayMs(attempt) {
  const exponential = AGENT_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, AGENT_RETRY_MAX_MS);
  const jitter = Math.floor(Math.random() * Math.min(1000, capped));
  return capped + jitter;
}

async function sendMessage(message, session) {
  await waitForChatSlot();
  const response = await fetchWhenReady(backendGate, fetch, `${BACKEND_URL}${ENDPOINT}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...agentAuthHeaders(API_KEY, session.sessionToken),
    },
    body: JSON.stringify({ message, sessionId: session.sessionId }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AgentHttpError(response.status, body);
  }

  const text = await response.text();
  let fullResponse = "";

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ")) continue;
    const json = trimmed.slice(6);
    try {
      const parsed = JSON.parse(json);
      if (parsed.type === "token") {
        fullResponse += parsed.chunk;
      } else if (parsed.type === "end") {
        fullResponse = parsed.text || fullResponse;
      } else if (parsed.type === "error") {
        throw new Error(parsed.text);
      }
    } catch (err) {
      if (err instanceof SyntaxError) continue;
      throw err;
    }
  }

  return fullResponse.trim();
}

async function sendMessageWithRetry(message, session, rowLabel) {
  for (let attempt = 0; attempt <= AGENT_MAX_RETRIES; attempt++) {
    try {
      return await sendMessage(message, session);
    } catch (err) {
      const canRetry = err instanceof AgentHttpError && err.status === 429;
      const hasRetriesLeft = attempt < AGENT_MAX_RETRIES;
      if (!canRetry || !hasRetriesLeft) throw err;

      const delayMs = retryDelayMs(attempt + 1);
      console.warn(
        `${rowLabel} agent  -> HTTP 429, retry ${attempt + 1}/${AGENT_MAX_RETRIES} in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error("agent retry loop exhausted");
}

function cellText(value) {
  if (value == null) return "";
  if (typeof value === "object" && "richText" in value) {
    return value.richText.map((part) => part.text).join("");
  }
  if (typeof value === "object" && "text" in value) return String(value.text);
  if (typeof value === "object" && "result" in value) return String(value.result ?? "");
  return String(value);
}

function readCsv(path) {
  const rawBuffer = readFileSync(path);
  let csvContent;
  if (
    rawBuffer.length >= 3 &&
    rawBuffer[0] === 0xef &&
    rawBuffer[1] === 0xbb &&
    rawBuffer[2] === 0xbf
  ) {
    csvContent = rawBuffer.toString("utf-8").replace(/^\uFEFF/, "");
  } else {
    const utf8 = rawBuffer.toString("utf-8");
    csvContent = utf8.includes("\uFFFD")
      ? new TextDecoder("windows-1255").decode(rawBuffer)
      : utf8;
  }

  return parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });
}

async function readXlsx(path) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const worksheet = workbook.worksheets[0];
  const headerRow = worksheet.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = cellText(cell.value).trim();
  });

  const records = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record = {};
    let hasValue = false;
    headers.forEach((header, col) => {
      if (!header) return;
      const value = cellText(row.getCell(col).value).trim();
      if (value) hasValue = true;
      record[header] = value;
    });
    if (hasValue) records.push(record);
  });
  return records;
}

async function readInputFile(path) {
  if (path.toLowerCase().endsWith(".csv")) {
    return readCsv(path);
  }
  return readXlsx(path);
}

function getField(record, ...headers) {
  for (const header of headers) {
    if (record[header] != null && String(record[header]).trim()) {
      return record[header];
    }

    const matchingKey = Object.keys(record).find((key) => key.trim() === header);
    if (matchingKey && String(record[matchingKey]).trim()) {
      return record[matchingKey];
    }
  }

  return "";
}

function preview(text, max = 70) {
  return text.length > max ? `${text.substring(0, max)}...` : text;
}

function countAssistantTurns(transcript) {
  return transcript.filter((turn) => turn.role === "assistant").length;
}

function latestAssistantMessage(transcript) {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === "assistant") return transcript[i].content;
  }
  return "";
}

function formatTranscript(transcript) {
  return transcript
    .map((turn) => {
      const label = turn.role === "assistant" ? "פולה" : "מועמד";
      return `${label}: ${turn.content}`;
    })
    .join("\n\n");
}

function transcriptForRow(transcript) {
  return transcript.length > 2 ? formatTranscript(transcript) : "";
}

async function runWithConcurrency(items, limit, worker) {
  let next = 0;

  async function drain() {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  }

  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, drain));
}

function createOrderedWriter(writer) {
  const pending = new Map();
  let nextToWrite = 0;
  let chain = Promise.resolve();

  async function flushReady() {
    while (pending.has(nextToWrite)) {
      const rowData = pending.get(nextToWrite);
      pending.delete(nextToWrite);
      if (rowData) await writer.appendRow(rowData);
      nextToWrite += 1;
    }
  }

  return {
    outputPath: writer.outputPath,
    // Rows judged but not yet written (waiting on an earlier row) when a run is stopped.
    savePartial(options) {
      return writer.savePartial({
        ...options,
        extraRows: [...pending.values()].filter(Boolean),
      });
    },
    submit(index, rowData) {
      // Register synchronously so a stop request never misses a finished row.
      pending.set(index, rowData);
      const task = chain.then(flushReady);
      chain = task.catch(() => {});
      return task;
    },
    finalize() {
      return chain.then(() => writer.finalize());
    },
  };
}

async function processRow({ record, index, total, judge }) {
  const rowLabel = `[${String(index + 1).padStart(String(total).length, " ")}/${total}]`;
  const question = getField(record, ...QUESTION_COLUMNS)?.trim();
  const expected = getField(record, ...EXPECTED_COLUMNS)?.trim();
  const humanFeedback = getField(record, ...HUMAN_FEEDBACK_COLUMNS)?.trim();

  if (!question) {
    console.log(`${rowLabel} Skipping empty input`);
    return null;
  }

  console.log(`${rowLabel} ${question.replace(/\s+/g, " ").trim()}`);

  let session;
  try {
    session = await chatSessions.create();
  } catch (err) {
    const message = `ERROR: ${describeError(err)}`;
    console.error(`${rowLabel} session -> ${message}\n`);
    return {
      index: index + 1,
      question,
      expected,
      humanFeedback,
      finalAgentAnswer: message,
      transcript: "",
      turns: 0,
      verdict: "ERROR",
      explanation: message,
    };
  }

  const transcript = [{ role: "user", content: question }];

  while (true) {
    const nextUserMessage = transcript[transcript.length - 1].content;
    let agentAnswer = "";

    try {
      agentAnswer = await sendMessageWithRetry(nextUserMessage, session, rowLabel);
      if (!agentAnswer) throw new Error("empty agent response");
      transcript.push({ role: "assistant", content: agentAnswer });
    } catch (err) {
      const message = `ERROR: ${describeError(err)}`;
      const turns = countAssistantTurns(transcript);
      console.error(`${rowLabel} agent  -> ${message}\n`);
      return {
        index: index + 1,
        question,
        expected,
        humanFeedback,
        finalAgentAnswer: message,
        transcript: transcriptForRow(transcript),
        turns,
        verdict: "ERROR",
        explanation: message,
      };
    }

    const turns = countAssistantTurns(transcript);
    console.log(`${rowLabel} turn ${turns}/${JUDGE_MAX_AGENT_TURNS}: agent -> ${agentAnswer.length} chars`);

    try {
      const forceFinal = turns >= JUDGE_MAX_AGENT_TURNS;
      let result = await judge.judge({
        question,
        expected,
        humanFeedback,
        transcript,
        forceFinal,
      });

      if (forceFinal && result.verdict === "NEEDS_FOLLOWUP") {
        result = {
          verdict: "FALSE",
          explanation: `agent did not produce a final answer within ${JUDGE_MAX_AGENT_TURNS} turns`,
        };
      }

      if (result.verdict === "NEEDS_FOLLOWUP") {
        console.log(`${rowLabel} judge  -> NEEDS_FOLLOWUP | user -> ${preview(result.userReply)}`);
        transcript.push({ role: "user", content: result.userReply });
        continue;
      }

      const suffix = result.explanation ? ` - ${result.explanation}` : "";
      console.log(`${rowLabel} judge  -> ${result.verdict}${suffix}\n`);
      return {
        index: index + 1,
        question,
        expected,
        humanFeedback,
        finalAgentAnswer: latestAssistantMessage(transcript),
        transcript: transcriptForRow(transcript),
        turns,
        verdict: result.verdict,
        explanation: result.explanation,
      };
    } catch (err) {
      const message = `judge error: ${describeError(err)}`;
      const severity = err instanceof JudgeModelError ? "FATAL" : "ERROR";
      console.error(`${rowLabel} judge  -> ${severity} - ${message}\n`);
      return {
        index: index + 1,
        question,
        expected,
        humanFeedback,
        finalAgentAnswer: latestAssistantMessage(transcript),
        transcript: transcriptForRow(transcript),
        turns,
        verdict: "ERROR",
        explanation: message,
      };
    }
  }
}

async function main() {
  const inputPath = join(INPUT_DIR, INPUT_FILE);
  const outputDir = join(__dirname, "runs");
  const records = await readInputFile(inputPath);
  const judgePrompt = describeJudgeSystemPrompt();
  const includeFeedback = resolveIncludeFeedback();
  const judge = createJudge({
    systemPrompt: judgePrompt.prompt,
    includeFeedback,
  });
  const writer = createOrderedWriter(
    createRunWriter({
      outputDir,
      inputFile: INPUT_FILE,
      target: EVAL_TARGET,
      backendUrl: BACKEND_URL,
      includeFeedback,
      systemPrompt: judgePrompt.prompt,
      systemPromptSource: judgePrompt.source,
      systemPromptName: judgePrompt.name,
    }),
  );
  activeRunPath = writer.outputPath;
  process.send?.({ type: "output", path: writer.outputPath });
  runLog.attach(writer.outputPath);

  const total = LIMIT > 0 ? Math.min(LIMIT, records.length) : records.length;
  partialSaver = () => writer.savePartial({ plannedTotal: total });
  console.log(`Loaded ${records.length} questions from ${INPUT_FILE} (running ${total})`);
  console.log(`Target: ${EVAL_TARGET}`);
  console.log(`Backend: ${BACKEND_URL}${ENDPOINT}`);
  console.log(formatAuthLog({ apiKey: API_KEY, apiKeySource: API_KEY_SOURCE }));
  console.log(formatSessionLog(CHAT_SESSION_MODE));
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(
    `Chat stagger: ${STAGGER_MS}ms (space chat POSTs to stay under the backend ~20/min quota)`,
  );
  console.log(
    `Agent 429 retries: ${AGENT_MAX_RETRIES} (base ${AGENT_RETRY_BASE_MS}ms, max ${AGENT_RETRY_MAX_MS}ms)`,
  );
  console.log(
    `Backend outage wait: ${BACKEND_WAIT_MS}ms (probe ${BACKEND_URL}/api/v1/health every ${BACKEND_PROBE_MS}ms)\n`,
  );
  console.log(`Max agent turns per row: ${JUDGE_MAX_AGENT_TURNS}`);
  const promptHash = createHash("sha256")
    .update(judgePrompt.prompt)
    .digest("hex")
    .slice(0, 8);
  const promptLabel = judgePrompt.name
    ? `${judgePrompt.source} (${judgePrompt.name})`
    : judgePrompt.source;
  console.log(
    `Judge prompt: ${promptLabel} (${judgePrompt.prompt.length} chars, sha256:${promptHash})`,
  );
  console.log(`Human feedback to judge: ${includeFeedback ? "on" : "off"}\n`);

  const jobs = records.slice(0, total).map((record, index) => ({ record, index }));
  await runWithConcurrency(jobs, CONCURRENCY, async ({ record, index }) => {
    const rowData = await processRow({ record, index, total, judge });
    await writer.submit(index, rowData);
  });

  const { outputPath, stats } = await writer.finalize();
  runFinished = true;
  console.log(
    `Done. ${stats.total} rows | ${stats.ok} OK | ${stats.partial} PARTIAL | ${stats.false} FALSE | ${stats.error} ERROR | ${stats.passRate}% pass rate | ${stats.score}% score`,
  );
  console.log(`File: ${outputPath}`);
}

main().catch((err) => {
  if (err instanceof JudgeModelError) {
    console.error(`Fatal error: ${describeError(err)}`);
  } else {
    console.error("Fatal error:", err);
  }
  process.exit(1);
});
