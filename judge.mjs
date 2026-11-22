import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { lookup as systemLookup } from "node:dns";
import { Resolver } from "node:dns/promises";
import { Agent as HttpsAgent } from "node:https";

const DEFAULT_JUDGE_MODEL = "eu.anthropic.claude-haiku-5-5";
const JUDGE_VERDICTS = ["OK", "PARTIAL", "FALSE", "NEEDS_FOLLOWUP"];

export const DEFAULT_SYSTEM_PROMPT = `You are a senior content reviewer for the "Pola" admissions assistant at Ben-Gurion University. You will be given a candidate's original question, an older expected answer, optional human feedback about that older expected answer, and the conversation transcript so far. Decide whether Pola's latest answer is acceptable, or whether Pola asked a clarifying question that a candidate should answer.

Rules:
- Treat the expected answer as the baseline answer.
- Treat the human feedback as reviewer notes, not as ground truth. Some feedback may be irrelevant, subjective, stale, or wrong.
- Use human feedback only when it contains concrete information about answer correctness, such as a specific factual error, missing requirement, changed policy, or correction to the expected answer.
- Ignore feedback that is only about wording, style, preference, tone, formatting, or unrelated context.
- If the human feedback conflicts with the expected answer, override the expected answer only when the feedback gives specific correctness evidence. Otherwise keep judging against the expected answer.
- Do not penalize the agent for differing from the older expected answer when the human feedback gives specific correctness evidence that the older expected answer was wrong.
- Grade by meaning, not wording. Ignore differences in wording, formatting, length, structure, or order of points if the meaning is the same. Do not expect the answer to repeat the expected answer verbatim.
- First decide what the candidate actually needs answered: the decision and the 1-4 key facts it depends on. Everything else in the expected answer (contacts, links, tips, closing lines) is supporting detail and is never a reason for FALSE.
- Extra information that is correct is not an error. Treat an addition as a problem only when it is wrong or misleading.
- Judge only Pola's latest assistant message, using earlier turns as context.
- If Pola's latest assistant message is mainly a clarifying question or asks the candidate for missing information before giving a final answer, return NEEDS_FOLLOWUP and generate a short userReply as if you were the candidate. This takes priority, and asking is never a fault.
- Mark OK when the core decision is correct, the key facts are present and correct, and nothing contradicts the expected answer after applying the human feedback.
- Mark PARTIAL when the core decision is correct but one or two key facts are missing or vague.
- Mark FALSE when the core decision is wrong, a key fact is contradicted, or the answer misses most of what the candidate needed.
- When generating userReply, behave like a real candidate. Prefer facts already stated in the original question. If Pola asks for information not stated there, invent one plausible concise value that is consistent with the question and expected answer.
- Do not paste the expected answer into userReply. Do not include detailed thresholds, lists, or factual answer content as the candidate.
- explanation is always Hebrew, never a paragraph.
- explanation must be a JSON array of strings, at most 4 items. Each item is one distinct key problem.
- Prefix each item with exactly one of: חסר / חלקי / סתירה / הוסיף.
- Each item is one short clause. No preamble, no restating the verdict. Never list missing supporting detail.
- OK: one item only — "אין בעיות מהותיות".
- NEEDS_FOLLOWUP: one item on what Pola asked.
- Reply with only a JSON object: {"coreNeed": "...", "verdict": "OK" | "PARTIAL" | "FALSE" | "NEEDS_FOLLOWUP", "explanation": ["..."], "userReply": "..."}. coreNeed is one short Hebrew phrase naming what the candidate needed. userReply is required only when verdict is NEEDS_FOLLOWUP. No markdown, no prose around the JSON.`;

export function resolveJudgeSystemPrompt(raw = process.env.JUDGE_SYSTEM_PROMPT) {
  const trimmed = String(raw ?? "").trim();
  return trimmed || DEFAULT_SYSTEM_PROMPT;
}

export function describeJudgeSystemPrompt(raw = process.env.JUDGE_SYSTEM_PROMPT) {
  const prompt = resolveJudgeSystemPrompt(raw);
  const name = String(process.env.JUDGE_PROMPT_NAME ?? "").trim();
  return {
    prompt,
    name,
    source: name || (prompt === DEFAULT_SYSTEM_PROMPT ? "default" : "custom"),
  };
}

function parseDnsServers(raw) {
  return String(raw ?? "8.8.8.8,1.1.1.1")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    }),
  ]);
}

function createIpv4Lookup(dnsServers) {
  const resolver = new Resolver();
  const servers = parseDnsServers(dnsServers);
  if (servers.length) resolver.setServers(servers);
  const dnsTimeoutMs = envNumber("JUDGE_DNS_TIMEOUT_MS", 2500);

  return function ipv4Lookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }

    const deliver = (err, address, family) => {
      if (options?.all) {
        if (err) return callback(err);
        const list = Array.isArray(address)
          ? address
          : [{ address, family: family ?? 4 }];
        return callback(null, list);
      }
      return callback(err, address, family);
    };

    withTimeout(
      resolver.resolve4(hostname),
      dnsTimeoutMs,
      `DNS timeout after ${dnsTimeoutMs}ms`,
    ).then(
      (addresses) => {
        if (!addresses.length) {
          systemLookup(hostname, { ...options, family: 4 }, deliver);
          return;
        }
        if (options?.all) {
          deliver(
            null,
            addresses.map((address) => ({ address, family: 4 })),
          );
          return;
        }
        deliver(null, addresses[0], 4);
      },
      (err) => {
        console.warn(
          `judge -> ${err.message}; falling back to system DNS for ${hostname}`,
        );
        systemLookup(hostname, { ...options, family: 4 }, deliver);
      },
    );
  };
}

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getOutputText(response) {
  return (
    response.output?.message?.content
      ?.map((part) => part.text ?? "")
      .join("")
      .trim() ?? ""
  );
}

function formatTranscript(transcript, agent) {
  if (Array.isArray(transcript) && transcript.length > 0) {
    return transcript
      .map((turn, index) => {
        const role = turn.role === "assistant" ? "Pola" : "Candidate";
        return `${index + 1}. ${role}: ${turn.content ?? ""}`;
      })
      .join("\n\n");
  }

  return `1. Pola: ${agent ?? ""}`;
}

export function resolveIncludeFeedback(raw = process.env.JUDGE_INCLUDE_FEEDBACK) {
  const value = String(raw ?? "").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(value);
}

export function buildUserPrompt({
  question,
  expected,
  humanFeedback,
  transcript,
  agent,
  forceFinal = false,
  includeFeedback = true,
}) {
  const feedbackText = humanFeedback?.trim() || "No human feedback was provided.";
  const forceFinalRule = forceFinal
    ? `\nImportant: The conversation is at the maximum allowed turn count. Treat the last assistant message as the agent's final answer. You MUST return only OK, PARTIAL, or FALSE. Do NOT return NEEDS_FOLLOWUP.\n`
    : "";
  const expectedLabel = includeFeedback
    ? "Older expected answer"
    : "Older reference answer (may be outdated; use only to understand the topic)";
  const feedbackSection = includeFeedback
    ? `Human feedback about the older expected answer:
${feedbackText}

`
    : "";

  return `Question:
${question}

${expectedLabel}:
${expected}

${feedbackSection}Conversation transcript:
${formatTranscript(transcript, agent)}
${forceFinalRule}

Return only the JSON verdict.`;
}

function formatExplanation(raw) {
  const items = Array.isArray(raw) ? raw : String(raw ?? "").split(/\n+/);
  return items
    .map((item) => String(item ?? "").replace(/^\s*[-•*]\s*/, "").trim())
    .filter(Boolean)
    .map((item) => `- ${item}`)
    .join("\n");
}

function parseJudgeJson(text) {
  const trimmed = text.trim();
  let parsed;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("judge returned non-JSON");
    }
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  }

  const verdict = String(parsed.verdict ?? "").toUpperCase();
  if (!JUDGE_VERDICTS.includes(verdict)) {
    throw new Error(`judge returned invalid verdict: ${parsed.verdict}`);
  }

  const userReply = String(parsed.userReply ?? "").trim();
  if (verdict === "NEEDS_FOLLOWUP" && !userReply) {
    throw new Error("judge returned NEEDS_FOLLOWUP without userReply");
  }

  return {
    verdict,
    explanation: formatExplanation(parsed.explanation),
    userReply: verdict === "NEEDS_FOLLOWUP" ? userReply : undefined,
  };
}

function isRetryableNetworkError(error) {
  const parts = [error?.code, error?.name, error?.message];
  for (let current = error?.cause; current; current = current.cause) {
    parts.push(current?.code, current?.name, current?.message);
  }
  const haystack = parts.filter(Boolean).join(" ");
  return /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|pending stream has been canceled|did not establish a connection|TimeoutError|timeout/i.test(
    haystack,
  );
}

function createLimiter(max) {
  let active = 0;
  const waiters = [];
  return async function limit(fn) {
    if (active >= max) {
      await new Promise((resolve) => waiters.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = waiters.shift();
      if (next) next();
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTemperatureRejected(error) {
  return (
    error?.name === "ValidationException" &&
    /temperature/i.test(error?.message ?? "")
  );
}

function isModelValidationError(error) {
  const message = error?.message ?? "";
  return (
    error?.name === "ValidationException" &&
    /model|modelId|on-demand throughput|inference profile/i.test(message)
  );
}

export class JudgeModelError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "JudgeModelError";
  }
}

export class Judge {
  constructor({
    region = process.env.AWS_REGION || "eu-west-1",
    model = process.env.JUDGE_MODEL || DEFAULT_JUDGE_MODEL,
    temperature = envNumber("JUDGE_TEMPERATURE", undefined),
    maxTokens = envNumber("JUDGE_MAX_TOKENS", 1536),
    systemPrompt = process.env.JUDGE_SYSTEM_PROMPT,
    includeFeedback = resolveIncludeFeedback(),
  } = {}) {
    this.includeFeedback = includeFeedback !== false;
    this.region = region;
    this.model = model;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.systemPrompt = resolveJudgeSystemPrompt(systemPrompt);
    this.maxRetries = envNumber("JUDGE_MAX_RETRIES", 4);
    this.connectionTimeout = envNumber("JUDGE_CONNECTION_TIMEOUT_MS", 30_000);
    this.requestTimeout = envNumber("JUDGE_REQUEST_TIMEOUT_MS", 60_000);
    this.limitInvoke = createLimiter(
      Math.max(1, envNumber("JUDGE_INVOKE_CONCURRENCY", 4)),
    );
    const dnsServers = process.env.JUDGE_DNS_SERVERS || "8.8.8.8,1.1.1.1";
    const credentials =
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            ...(process.env.AWS_SESSION_TOKEN
              ? { sessionToken: process.env.AWS_SESSION_TOKEN }
              : {}),
          }
        : undefined;
    this.client = new BedrockRuntimeClient({
      region,
      credentials,
      maxAttempts: Math.max(1, this.maxRetries),
      requestHandler: new NodeHttpHandler({
        connectionTimeout: this.connectionTimeout,
        requestTimeout: this.requestTimeout,
        httpsAgent: new HttpsAgent({
          keepAlive: true,
          family: 4,
          lookup: createIpv4Lookup(dnsServers),
        }),
      }),
    });
    console.log(`Judge Bedrock: region ${region}, DNS ${dnsServers}`);
  }

  async judge(input) {
    const userPrompt = buildUserPrompt({
      ...input,
      includeFeedback: this.includeFeedback,
    });

    try {
      const firstText = await this.invoke(userPrompt);
      try {
        return parseJudgeJson(firstText);
      } catch {
        const repairText = await this.invoke(`${userPrompt}

The previous response was not valid JSON or did not match the required schema:
${firstText}

Return a valid JSON object only. Use these keys: coreNeed, verdict (OK, PARTIAL, FALSE, or NEEDS_FOLLOWUP), explanation, and userReply when verdict is NEEDS_FOLLOWUP. explanation must be a JSON array of Hebrew strings, one distinct problem per item.`);
        return parseJudgeJson(repairText);
      }
    } catch (error) {
      if (error instanceof JudgeModelError) {
        throw error;
      }
      if (isModelValidationError(error)) {
        throw new JudgeModelError(
          `Set JUDGE_MODEL to a valid Bedrock model ID for region ${this.region} (see Bedrock console -> Model access). Bedrock said: ${error.message}`,
          { cause: error },
        );
      }
      if (isRetryableNetworkError(error)) {
        throw new Error(
          `Bedrock DNS/network error talking to region ${this.region} (${this.model}). Check VPN/DNS and retry. Original: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  buildCommand(userPrompt) {
    const inferenceConfig = { maxTokens: this.maxTokens };
    if (this.temperature != null) inferenceConfig.temperature = this.temperature;
    return new ConverseCommand({
      modelId: this.model,
      system: [{ text: this.systemPrompt }],
      messages: [
        {
          role: "user",
          content: [{ text: userPrompt }],
        },
      ],
      inferenceConfig,
    });
  }

  async invoke(userPrompt) {
    return this.limitInvoke(async () => {
      let lastError;
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        if (attempt === 1) {
          console.log(
            `judge -> Bedrock ${this.region} (${this.model}) connectTimeout=${this.connectionTimeout}ms`,
          );
        }
        try {
          const response = await this.client.send(this.buildCommand(userPrompt));
          const text = getOutputText(response);
          if (!text) {
            throw new Error("judge returned empty response");
          }
          return text;
        } catch (error) {
          lastError = error;
          if (this.temperature != null && isTemperatureRejected(error)) {
            console.warn(`judge -> ${this.model} rejects temperature; retrying without it`);
            this.temperature = undefined;
            attempt -= 1;
            continue;
          }
          if (!isRetryableNetworkError(error) || attempt === this.maxRetries) {
            throw error;
          }
          const delayMs = 1000 * 2 ** (attempt - 1);
          console.warn(
            `judge -> network error, retry ${attempt}/${this.maxRetries} in ${delayMs}ms: ${error.message}`,
          );
          await sleep(delayMs);
        }
      }

      throw lastError;
    });
  }
}

export function createJudge(options) {
  return new Judge(options);
}
