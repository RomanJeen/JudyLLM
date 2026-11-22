import { parse } from "csv-parse/sync";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
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
  generateLegacySessionId,
  resolveBackendConfig,
} from "./backend-config.mjs";
import { createJudge, JudgeModelError } from "./judge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const {
  target: EVAL_TARGET,
  backendUrl: BACKEND_URL,
  apiKey: API_KEY,
  apiKeySource: API_KEY_SOURCE,
  chatSessionMode: CHAT_SESSION_MODE,
} = resolveBackendConfig();
const DELAY_MS = Number(process.env.DELAY_MS) || 1500;
const LIMIT = Number(process.env.LIMIT) || 0;
const JUDGE_MAX_AGENT_TURNS = Math.max(
  1,
  Number(process.env.JUDGE_MAX_AGENT_TURNS) || 4,
);
const PHOENIX_BASE_URL = process.env.PHOENIX_BASE_URL || "http://localhost:6006";
const PHOENIX_PROJECT = process.env.PHOENIX_PROJECT || "ask_pola";
const PHOENIX_API_KEY = process.env.PHOENIX_API_KEY || "";
const HUMAN_ANNOTATION = process.env.PHOENIX_HUMAN_ANNOTATION || "correctness";
const LLM_ANNOTATION = process.env.PHOENIX_LLM_ANNOTATION || "llm_correctness";
const PHOENIX_TRACE_WAIT_MS = Number(process.env.PHOENIX_TRACE_WAIT_MS) || 30000;
const PHOENIX_TRACE_POLL_MS = Number(process.env.PHOENIX_TRACE_POLL_MS) || 750;
const EXPECTED_COLUMN = "תשובה עדכנית פולה";
const HUMAN_FEEDBACK_COLUMN = "הערות עילם ורויטל";
const backendGate = createBackendGate({
  backendUrl: BACKEND_URL,
  waitMs: Math.max(0, Number(process.env.BACKEND_WAIT_MS) || 600_000),
  probeMs: Math.max(200, Number(process.env.BACKEND_PROBE_MS) || 2_000),
  log: (line) => console.warn(line),
});
const chatSessions = createChatSessionClient({
  backendUrl: BACKEND_URL,
  apiKey: API_KEY,
  mode: CHAT_SESSION_MODE,
  gate: backendGate,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function getField(record, header) {
  if (record[header] != null) return record[header];

  const matchingKey = Object.keys(record).find((key) => key.trim() === header);
  return matchingKey ? record[matchingKey] : "";
}

function preview(text, max = 90) {
  return text.length > max ? `${text.substring(0, max)}...` : text;
}

function generateTraceId() {
  return randomBytes(16).toString("hex");
}

function generateSpanId() {
  return randomBytes(8).toString("hex");
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
      const label = turn.role === "assistant" ? "Pola" : "Candidate";
      return `${label}: ${turn.content}`;
    })
    .join("\n\n");
}

function verdictToLabel(verdict) {
  const normalized = String(verdict ?? "").toUpperCase();
  if (normalized === "OK") return "correct";
  if (normalized === "PARTIAL") return "partially_correct";
  if (normalized === "FALSE") return "not_correct";
  return "error";
}

function labelToScore(label) {
  if (label === "correct") return 1;
  if (label === "partially_correct") return 0.5;
  if (label === "not_correct") return 0;
  return null;
}

function normalizeLabel(label) {
  const normalized = String(label ?? "").trim().toLowerCase();
  if (["correct", "ok", "true", "pass"].includes(normalized)) return "correct";
  if (["partially_correct", "partial"].includes(normalized)) return "partially_correct";
  if (["not_correct", "incorrect", "false", "fail"].includes(normalized)) {
    return "not_correct";
  }
  return null;
}

function nowIso() {
  return new Date().toISOString();
}

async function sendMessage(message, session) {
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
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
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

class PhoenixClient {
  constructor({
    baseUrl = PHOENIX_BASE_URL,
    project = PHOENIX_PROJECT,
    apiKey = PHOENIX_API_KEY,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.project = project;
    this.apiKey = apiKey;
  }

  headers(extra = {}) {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...extra,
    };
  }

  async request(path, { method = "GET", body, okStatuses = [200] } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();

    if (!okStatuses.includes(response.status)) {
      throw new Error(
        `Phoenix ${method} ${path} failed with ${response.status}: ${text.slice(0, 400)}`,
      );
    }

    if (response.status === 204 || response.status === 404 || !text) return null;
    const contentType = response.headers.get("content-type") || "";
    return contentType.includes("application/json") ? JSON.parse(text) : text;
  }

  async ensureProject() {
    const projectPath = `/v1/projects/${encodeURIComponent(this.project)}`;
    const existing = await this.request(projectPath, { okStatuses: [200, 404] });
    if (existing) return existing.data;

    const created = await this.request("/v1/projects", {
      method: "POST",
      body: { name: this.project, description: "Pola benchmark eval traces" },
    });
    return created.data;
  }

  async ensureAnnotationConfig({ name, description, includeError = false }) {
    const configPath = `/v1/annotation_configs/${encodeURIComponent(name)}`;
    const existing = await this.request(configPath, { okStatuses: [200, 404] });
    if (existing) return existing.data;

    const values = [
      { label: "correct", score: 1 },
      { label: "partially_correct", score: 0.5 },
      { label: "not_correct", score: 0 },
    ];
    if (includeError) values.push({ label: "error", score: null });

    const created = await this.request("/v1/annotation_configs", {
      method: "POST",
      body: {
        name,
        type: "CATEGORICAL",
        description,
        optimization_direction: "MAXIMIZE",
        values,
      },
    });
    return created.data;
  }

  async createTraceSpan({
    traceId,
    spanId,
    rowIndex,
    question,
    expected,
    humanFeedback,
    finalAgentAnswer,
    transcript,
    sessionId,
    turns,
    judgeResult,
    startTime,
    endTime,
    error,
  }) {
    const response = await this.request(`/v1/projects/${encodeURIComponent(this.project)}/spans`, {
      method: "POST",
      okStatuses: [202],
      body: {
        data: [
          {
            name: `benchmark row ${rowIndex}`,
            context: { trace_id: traceId, span_id: spanId },
            span_kind: "CHAIN",
            parent_id: null,
            start_time: startTime,
            end_time: endTime,
            status_code: error ? "ERROR" : "OK",
            status_message: error || "",
            attributes: {
              "input.value": question,
              "output.value": finalAgentAnswer,
              "eval.row_index": rowIndex,
              "eval.session_id": sessionId,
              "eval.expected": expected,
              "eval.human_feedback": humanFeedback,
              "eval.transcript": transcript,
              "eval.turns": turns,
              "eval.judge_verdict": judgeResult.verdict,
              "eval.judge_explanation": judgeResult.explanation,
            },
            events: [],
          },
        ],
      },
    });

    if (response?.total_queued !== 1) {
      throw new Error(
        `Phoenix queued ${response?.total_queued ?? 0} spans out of ${response?.total_received ?? 1}`,
      );
    }
  }

  async waitForTrace(traceId, timeoutMs = PHOENIX_TRACE_WAIT_MS) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const spans = await this.listSpans();
      if (spans.some((span) => getTraceIdFromSpan(span) === traceId)) {
        return;
      }
      await sleep(PHOENIX_TRACE_POLL_MS);
    }

    throw new Error(
      `Phoenix trace ${traceId} was queued but not visible after ${timeoutMs}ms`,
    );
  }

  async annotateTrace({ traceId, name, annotatorKind, label, explanation, metadata }) {
    await this.request("/v1/trace_annotations?sync=true", {
      method: "POST",
      body: {
        data: [
          {
            name,
            annotator_kind: annotatorKind,
            result: {
              label,
              score: labelToScore(label),
              explanation,
            },
            metadata,
            identifier: name,
            trace_id: traceId,
          },
        ],
      },
    });
  }

  async listSpans() {
    const spans = [];
    let cursor = null;
    do {
      const params = new URLSearchParams({ limit: "1000" });
      if (cursor) params.set("cursor", cursor);
      const response = await this.request(
        `/v1/projects/${encodeURIComponent(this.project)}/spans?${params}`,
      );
      spans.push(...response.data);
      cursor = response.next_cursor;
    } while (cursor);
    return spans;
  }

  async listTraceAnnotations(traceIds, annotationNames) {
    if (traceIds.length === 0) return [];

    const annotations = [];
    for (let i = 0; i < traceIds.length; i += 100) {
      const chunk = traceIds.slice(i, i + 100);
      const params = new URLSearchParams({ limit: "10000" });
      for (const traceId of chunk) params.append("trace_ids", traceId);
      for (const name of annotationNames) params.append("include_annotation_names", name);

      const response = await this.request(
        `/v1/projects/${encodeURIComponent(this.project)}/trace_annotations?${params}`,
      );
      annotations.push(...response.data);
    }

    return annotations;
  }

  async deleteTrace(traceId) {
    await this.request(`/v1/traces/${encodeURIComponent(traceId)}`, {
      method: "DELETE",
      okStatuses: [204, 404],
    });
  }
}

async function produceFinalResult({ judge, question, expected, humanFeedback }) {
  const session = await chatSessions.create();
  const transcript = [{ role: "user", content: question }];

  while (true) {
    const nextUserMessage = transcript[transcript.length - 1].content;
    const agentAnswer = await sendMessage(nextUserMessage, session);
    if (!agentAnswer) throw new Error("empty agent response");
    transcript.push({ role: "assistant", content: agentAnswer });

    const turns = countAssistantTurns(transcript);
    const forceFinal = turns >= JUDGE_MAX_AGENT_TURNS;
    let judgeResult = await judge.judge({
      question,
      expected,
      humanFeedback,
      transcript,
      forceFinal,
    });

    if (forceFinal && judgeResult.verdict === "NEEDS_FOLLOWUP") {
      judgeResult = {
        verdict: "FALSE",
        explanation: `agent did not produce a final answer within ${JUDGE_MAX_AGENT_TURNS} turns`,
      };
    }

    if (judgeResult.verdict === "NEEDS_FOLLOWUP") {
      transcript.push({ role: "user", content: judgeResult.userReply });
      continue;
    }

    return {
      sessionId: session.sessionId,
      transcript,
      turns,
      finalAgentAnswer: latestAssistantMessage(transcript),
      judgeResult,
    };
  }
}

async function runBenchmark() {
  const phoenix = new PhoenixClient();
  await phoenix.ensureProject();
  await phoenix.ensureAnnotationConfig({
    name: HUMAN_ANNOTATION,
    description: "Human correctness label for Pola benchmark traces",
  });
  await phoenix.ensureAnnotationConfig({
    name: LLM_ANNOTATION,
    description: "Single judge.mjs correctness label for Pola benchmark traces",
    includeError: true,
  });

  const records = readCsv(join(__dirname, "input", "inputs.csv"));
  const judge = createJudge();
  const total = LIMIT > 0 ? Math.min(LIMIT, records.length) : records.length;

  console.log(`Loaded ${records.length} questions from inputs.csv (running ${total})`);
  console.log(`Target: ${EVAL_TARGET}`);
  console.log(`Backend: ${BACKEND_URL}${ENDPOINT}`);
  console.log(formatAuthLog({ apiKey: API_KEY, apiKeySource: API_KEY_SOURCE }));
  console.log(formatSessionLog(CHAT_SESSION_MODE));
  console.log(`Phoenix: ${PHOENIX_BASE_URL} / project ${PHOENIX_PROJECT}`);
  console.log(`Manual annotation: ${HUMAN_ANNOTATION}`);
  console.log(`LLM annotation: ${LLM_ANNOTATION}\n`);

  for (let i = 0; i < total; i++) {
    const rowIndex = i + 1;
    const record = records[i];
    const question = getField(record, "input")?.trim();
    const expected = getField(record, EXPECTED_COLUMN)?.trim();
    const humanFeedback = getField(record, HUMAN_FEEDBACK_COLUMN)?.trim();

    if (!question) {
      console.log(`[${rowIndex}/${total}] Skipping empty input`);
      continue;
    }

    console.log(`[${String(rowIndex).padStart(String(total).length, " ")}/${total}] ${preview(question)}`);

    const traceId = generateTraceId();
    const spanId = generateSpanId();
    const startTime = nowIso();
    let result;
    let error = "";

    try {
      result = await produceFinalResult({ judge, question, expected, humanFeedback });
    } catch (err) {
      error = describeError(err);
      result = {
        sessionId: generateLegacySessionId(),
        transcript: [{ role: "user", content: question }],
        turns: 0,
        finalAgentAnswer: `ERROR: ${error}`,
        judgeResult: {
          verdict: "ERROR",
          explanation: error,
        },
      };
    }

    const endTime = nowIso();
    const label = verdictToLabel(result.judgeResult.verdict);

    await phoenix.createTraceSpan({
      traceId,
      spanId,
      rowIndex,
      question,
      expected,
      humanFeedback,
      finalAgentAnswer: result.finalAgentAnswer,
      transcript: formatTranscript(result.transcript),
      sessionId: result.sessionId,
      turns: result.turns,
      judgeResult: result.judgeResult,
      startTime,
      endTime,
      error,
    });
    await phoenix.waitForTrace(traceId);
    await phoenix.annotateTrace({
      traceId,
      name: LLM_ANNOTATION,
      annotatorKind: "LLM",
      label,
      explanation: result.judgeResult.explanation,
      metadata: {
        verdict: result.judgeResult.verdict,
        turns: result.turns,
        rowIndex,
      },
    });

    const suffix = result.judgeResult.explanation
      ? ` - ${result.judgeResult.explanation}`
      : "";
    console.log(`   trace ${traceId} | judge ${label}${suffix}\n`);

    if (i < total - 1) {
      await sleep(DELAY_MS);
    }
  }

  console.log("Done. Annotate traces in Phoenix, then run phoenix:compare.");
}

function groupAnnotationsByTrace(annotations) {
  const grouped = new Map();
  for (const annotation of annotations) {
    const traceId = annotation.trace_id;
    if (!grouped.has(traceId)) grouped.set(traceId, {});
    grouped.get(traceId)[annotation.name] = annotation;
  }
  return grouped;
}

function getTraceIdFromSpan(span) {
  return span.context?.trace_id || span.attributes?.["context.trace_id"];
}

async function compareAnnotations() {
  const phoenix = new PhoenixClient();
  const spans = await phoenix.listSpans();
  const traceIds = [...new Set(spans.map(getTraceIdFromSpan).filter(Boolean))];
  const spanByTrace = new Map(spans.map((span) => [getTraceIdFromSpan(span), span]));

  if (traceIds.length === 0) {
    console.log(`No traces found in Phoenix project ${PHOENIX_PROJECT}.`);
    return;
  }

  const annotations = await phoenix.listTraceAnnotations(traceIds, [
    HUMAN_ANNOTATION,
    LLM_ANNOTATION,
  ]);
  const grouped = groupAnnotationsByTrace(annotations);

  let humanLabeled = 0;
  let matches = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let missingHuman = 0;
  let missingLlm = 0;
  const mismatches = [];

  for (const traceId of traceIds) {
    const annotationsForTrace = grouped.get(traceId) || {};
    const human = normalizeLabel(annotationsForTrace[HUMAN_ANNOTATION]?.result?.label);
    const llm = normalizeLabel(annotationsForTrace[LLM_ANNOTATION]?.result?.label);
    const span = spanByTrace.get(traceId);

    if (!human) {
      missingHuman += 1;
      continue;
    }

    humanLabeled += 1;
    if (!llm) {
      missingLlm += 1;
      continue;
    }

    if (human === llm) {
      matches += 1;
      continue;
    }

    if (human === "not_correct" && llm === "correct") falsePositive += 1;
    if (human === "correct" && llm === "not_correct") falseNegative += 1;
    mismatches.push({
      traceId,
      rowIndex: span?.attributes?.["eval.row_index"],
      question: span?.attributes?.["input.value"] || "",
      human,
      llm,
    });
  }

  const alignment = humanLabeled > 0 ? (matches / humanLabeled) * 100 : 0;
  console.log(`Traces: ${traceIds.length}`);
  console.log(`Human labeled: ${humanLabeled}`);
  console.log(`Missing human labels: ${missingHuman}`);
  console.log(`Missing LLM labels: ${missingLlm}`);
  console.log(`Matches: ${matches}`);
  console.log(`Alignment: ${alignment.toFixed(1)}%`);
  console.log(`False positives (LLM correct, human not_correct): ${falsePositive}`);
  console.log(`False negatives (LLM not_correct, human correct): ${falseNegative}`);
  console.log(`Target: ${alignment >= 90 ? "PASS" : "FAIL"} (>= 90%)`);

  if (mismatches.length > 0) {
    console.log("\nMismatches:");
    for (const mismatch of mismatches.slice(0, 25)) {
      const row = mismatch.rowIndex ? `row ${mismatch.rowIndex}` : "unknown row";
      console.log(
        `- ${row} | human=${mismatch.human} llm=${mismatch.llm} | ${preview(mismatch.question, 120)}`,
      );
      console.log(`  trace: ${mismatch.traceId}`);
    }
    if (mismatches.length > 25) {
      console.log(`... ${mismatches.length - 25} more mismatches`);
    }
  }
}

async function cleanProjectTraces() {
  const phoenix = new PhoenixClient();
  const spans = await phoenix.listSpans();
  const traceIds = [...new Set(spans.map(getTraceIdFromSpan).filter(Boolean))];

  if (traceIds.length === 0) {
    console.log(`No traces to delete in Phoenix project ${PHOENIX_PROJECT}.`);
    return;
  }

  console.log(`Deleting ${traceIds.length} traces from Phoenix project ${PHOENIX_PROJECT}...`);
  for (const traceId of traceIds) {
    await phoenix.deleteTrace(traceId);
  }
  console.log("Done.");
}

async function main() {
  const command = process.argv[2] || "run";
  if (command === "run") {
    await runBenchmark();
  } else if (command === "compare") {
    await compareAnnotations();
  } else if (command === "clean") {
    await cleanProjectTraces();
  } else {
    throw new Error(`Unknown command "${command}". Use run, compare, or clean.`);
  }
}

main().catch((err) => {
  if (err instanceof JudgeModelError) {
    console.error(`Fatal error: ${err.message}`);
  } else {
    console.error("Fatal error:", err);
  }
  process.exit(1);
});
