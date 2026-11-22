import { spawn } from "child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { createServer } from "http";
import { basename, dirname, extname, join } from "path";
import { fileURLToPath } from "url";
import { DEFAULT_SYSTEM_PROMPT } from "./judge.mjs";
import { exportRun, isExportFormat } from "./report-export.mjs";
import { isRunFileName, readRun, readRunListing, runFormat } from "./run-store.mjs";
import {
  AGENT_CHAT_ENDPOINT as ENDPOINT,
  CLIENT_PRESETS,
  listBackendCandidates,
  normalizeBackendUrl,
  parseEvalSummary,
  resolveClientPreset,
} from "./backend-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const INPUT_DIR = join(__dirname, "input");
const PROMPTS_DIR = join(__dirname, "prompts");
const RUNS_DIR = join(__dirname, "runs");
const HOST = "127.0.0.1";
const PORT = Number(process.env.UI_PORT) || 8787;
const PROBE_TIMEOUT_MS = 2000;
const MAX_SYSTEM_PROMPT_CHARS = 80_000;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function listInputFiles() {
  if (!existsSync(INPUT_DIR)) return [];
  return readdirSync(INPUT_DIR)
    .filter((name) => {
      const lower = name.toLowerCase();
      if (lower === "outputs.csv") return false;
      return lower.endsWith(".xlsx") || lower.endsWith(".csv");
    })
    .sort((a, b) => a.localeCompare(b));
}

function listRunFiles() {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter(isRunFileName)
    .map((name) => {
      const fullPath = join(RUNS_DIR, name);
      const stats = statSync(fullPath);
      return {
        name,
        path: fullPath,
        format: runFormat(name),
        mtimeMs: stats.mtimeMs,
        mtime: stats.mtime.toISOString(),
        size: stats.size,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const runListingCache = new Map();

async function listingForRun(run) {
  const key = `${run.name}:${run.mtimeMs}:${run.size}`;
  if (runListingCache.has(key)) return runListingCache.get(key);

  try {
    const listing = await readRunListing(join(RUNS_DIR, run.name));
    runListingCache.set(key, listing);
    return listing;
  } catch {
    return { summary: null, meta: null, complete: false, partial: false, plannedTotal: null };
  }
}

async function listRunFilesWithSummaries() {
  const runs = listRunFiles();
  const listed = await Promise.all(
    runs.map(async (run) => {
      const { summary, meta, complete, partial = false, plannedTotal = null } = await listingForRun(run);
      if (!complete && !partial && !runIsInProgress(run.name, run.path)) return null;
      return {
        ...run,
        summary,
        meta,
        complete,
        partial,
        plannedTotal,
        tags: meta?.tags ?? [],
      };
    }),
  );
  return listed.filter(Boolean);
}

function runLogName(runName) {
  return String(runName).replace(/\.(json|xlsx)$/i, ".log.jsonl");
}

// A partial run was kept on purpose, so it is never "incomplete" in the sense of
// being safe to throw away, unless the caller says so (`includePartial`).
function isIncompleteJsonRun(runName, { includePartial = false } = {}) {
  if (runFormat(runName) !== "json") return false;
  try {
    const raw = JSON.parse(readFileSync(join(RUNS_DIR, runName), "utf8"));
    if (raw.complete) return false;
    return includePartial || !raw.partial;
  } catch (err) {
    return err.code === "ENOENT" || err instanceof SyntaxError;
  }
}

function readSavedPartial(runName) {
  if (!runName || !isRunFileName(runName) || runFormat(runName) !== "json") return null;
  try {
    const raw = JSON.parse(readFileSync(join(RUNS_DIR, runName), "utf8"));
    if (!raw.partial || raw.complete || !raw.summary || !(raw.summary.total > 0)) return null;
    return raw.summary;
  } catch {
    return null;
  }
}

function discardRunFiles(runName, options) {
  if (!runName || !isRunFileName(runName) || !isIncompleteJsonRun(runName, options)) return;
  for (const name of [runName, `${runName}.tmp`, runLogName(runName)]) {
    rmSync(join(RUNS_DIR, name), { force: true });
  }
}

function isSafeBasename(name) {
  if (!name || typeof name !== "string") return false;
  if (name !== basename(name)) return false;
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    return false;
  }
  return true;
}

function promptScenarioName(raw) {
  const name = basename(String(raw ?? "").trim()).replace(/\.md$/i, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    const err = new Error(
      "scenario name must be 1-64 letters, numbers, _ or -",
    );
    err.status = 400;
    throw err;
  }
  return name;
}

function promptScenarioPath(name) {
  return join(PROMPTS_DIR, `${promptScenarioName(name)}.md`);
}

function ensurePromptsDir() {
  mkdirSync(PROMPTS_DIR, { recursive: true });
  const defaultPath = join(PROMPTS_DIR, "default.md");
  if (!existsSync(defaultPath)) {
    writeFileSync(defaultPath, DEFAULT_SYSTEM_PROMPT, "utf8");
  }
}

function listPromptScenarios() {
  ensurePromptsDir();
  return readdirSync(PROMPTS_DIR)
    .filter((name) => name.toLowerCase().endsWith(".md") && isSafeBasename(name))
    .map((name) => name.replace(/\.md$/i, ""))
    .sort((a, b) => a.localeCompare(b));
}

function readPromptScenario(rawName) {
  ensurePromptsDir();
  const name = promptScenarioName(rawName);
  const path = promptScenarioPath(name);
  if (!existsSync(path)) {
    if (name === "default") {
      return { name, text: DEFAULT_SYSTEM_PROMPT };
    }
    const err = new Error("Unknown prompt scenario");
    err.status = 404;
    throw err;
  }
  return { name, text: readFileSync(path, "utf8") };
}

function writePromptScenario(rawName, text) {
  ensurePromptsDir();
  const name = promptScenarioName(rawName);
  const promptText = String(text ?? "");
  if (promptText.trim().length === 0) {
    const err = new Error("systemPrompt must not be empty");
    err.status = 400;
    throw err;
  }
  if (promptText.length > MAX_SYSTEM_PROMPT_CHARS) {
    const err = new Error(
      `systemPrompt must be at most ${MAX_SYSTEM_PROMPT_CHARS} characters`,
    );
    err.status = 400;
    throw err;
  }
  writeFileSync(promptScenarioPath(name), promptText, "utf8");
  return { name, text: promptText };
}

async function probeUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
    });
    // Any HTTP response means the host is reachable.
    void response.status;
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeBackend(url) {
  const base = normalizeBackendUrl(url);
  if (!base) return false;
  if (await probeUrl(base)) return true;
  return probeUrl(`${base}${ENDPOINT}`);
}

async function listBackends() {
  const probed = await Promise.all(
    listBackendCandidates().map(async (candidate) => ({
      ...candidate,
      live: await probeBackend(candidate.url),
    })),
  );

  return probed;
}

const MAX_REPLAY_LINES = 20_000;

const runState = {
  child: null,
  listeners: new Set(),
  outputFile: null,
  summary: null,
  stopped: false,
  saveOnStop: false,
  startedAt: null,
  lines: [],
  lastExit: null,
};

function resolveRequestedClientId(clientId) {
  const raw = String(clientId ?? "").trim();
  if (!raw || raw === "custom") {
    const err = new Error("clientId is required");
    err.status = 400;
    throw err;
  }

  const preset = resolveClientPreset(raw);
  if (preset) return preset.clientId;
  return raw;
}

function broadcast(event) {
  if (event.type === "log") {
    runState.lines.push({ stream: event.stream, line: event.line });
    if (runState.lines.length > MAX_REPLAY_LINES) {
      runState.lines.splice(0, runState.lines.length - MAX_REPLAY_LINES);
    }
  } else if (event.type === "exit") {
    runState.lastExit = event;
  }
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of runState.listeners) {
    res.write(data);
  }
}

function attachLineBuffer(stream, onLine) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      onLine(line);
    }
  });
  stream.on("end", () => {
    if (buffer) onLine(buffer);
  });
}

function extractOutputFile(line) {
  const match =
    line.match(/^File:\s+(.+\.(?:json|xlsx))\s*$/i) ||
    line.match(/^Saved checkpoint:\s+(.+\.(?:json|xlsx))\s+\(\d+ rows\)\s*$/i);
  if (!match) return null;
  const full = match[1].trim();
  return basename(full);
}

function defaultConcurrency() {
  const parsed = Number(process.env.CONCURRENCY);
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(32, Math.max(1, Math.floor(parsed)));
}

function defaultMaxTurns() {
  const parsed = Number(process.env.JUDGE_MAX_AGENT_TURNS);
  if (!Number.isFinite(parsed)) return 4;
  return Math.min(32, Math.max(1, Math.floor(parsed)));
}

function startEval({
  inputFile,
  target,
  customUrl,
  limit,
  concurrency,
  maxTurns,
  clientId,
  systemPrompt,
  promptName,
  includeFeedback,
}) {
  if (runState.child) {
    const err = new Error("A run is already in progress");
    err.status = 409;
    throw err;
  }

  if (!isSafeBasename(inputFile) || !listInputFiles().includes(inputFile)) {
    const err = new Error("Invalid input file");
    err.status = 400;
    throw err;
  }

  const normalizedTarget = String(target || "").toLowerCase();
  const requestedPreset = resolveClientPreset(String(clientId ?? "").trim());
  if (requestedPreset && requestedPreset.target !== normalizedTarget && normalizedTarget !== "custom") {
    const err = new Error(
      `${requestedPreset.label} runs against "${requestedPreset.target}", not "${normalizedTarget}"`,
    );
    err.status = 400;
    throw err;
  }
  if (!["local", "dev", "stg", "miluim-dev", "miluim-stg", "custom"].includes(normalizedTarget)) {
    const err = new Error(
      'target must be "local", "dev", "stg", "miluim-dev", "miluim-stg", or "custom"',
    );
    err.status = 400;
    throw err;
  }

  if (normalizedTarget === "custom") {
    const url = normalizeBackendUrl(customUrl);
    if (!url || !/^https?:\/\//i.test(url)) {
      const err = new Error("customUrl must be an http(s) URL");
      err.status = 400;
      throw err;
    }
  }

  let limitValue = "";
  if (limit != null && String(limit).trim() !== "") {
    const parsed = Number(limit);
    if (!Number.isFinite(parsed) || parsed < 0) {
      const err = new Error("limit must be a non-negative number");
      err.status = 400;
      throw err;
    }
    limitValue = String(Math.floor(parsed));
  }

  const promptText = String(systemPrompt ?? "").trim();
  if (promptText.length > MAX_SYSTEM_PROMPT_CHARS) {
    const err = new Error(
      `systemPrompt must be at most ${MAX_SYSTEM_PROMPT_CHARS} characters`,
    );
    err.status = 400;
    throw err;
  }

  const env = {
    ...process.env,
    EVAL_TARGET: normalizedTarget,
    INPUT_FILE: inputFile,
    CLIENT_ID: resolveRequestedClientId(clientId),
  };

  if (promptText) {
    env.JUDGE_SYSTEM_PROMPT = promptText;
  } else {
    delete env.JUDGE_SYSTEM_PROMPT;
  }

  const scenarioName = String(promptName ?? "").trim();
  if (scenarioName) {
    env.JUDGE_PROMPT_NAME = promptScenarioName(scenarioName);
  } else {
    delete env.JUDGE_PROMPT_NAME;
  }

  // Explicit true/false from the UI wins. When omitted, the inherited
  // JUDGE_INCLUDE_FEEDBACK (default: on) applies.
  if (typeof includeFeedback === "boolean") {
    env.JUDGE_INCLUDE_FEEDBACK = includeFeedback ? "1" : "0";
  }

  if (limitValue !== "") {
    env.LIMIT = limitValue;
  } else {
    delete env.LIMIT;
  }

  let concurrencyValue = "";
  if (concurrency != null && String(concurrency).trim() !== "") {
    const parsed = Number(concurrency);
    if (!Number.isFinite(parsed) || parsed < 1) {
      const err = new Error("concurrency must be an integer of at least 1");
      err.status = 400;
      throw err;
    }
    concurrencyValue = String(Math.min(32, Math.floor(parsed)));
  }

  if (concurrencyValue !== "") {
    env.CONCURRENCY = concurrencyValue;
  }

  let maxTurnsValue = "";
  if (maxTurns != null && String(maxTurns).trim() !== "") {
    const parsed = Number(maxTurns);
    if (!Number.isFinite(parsed) || parsed < 1) {
      const err = new Error("maxTurns must be an integer of at least 1");
      err.status = 400;
      throw err;
    }
    maxTurnsValue = String(Math.min(32, Math.floor(parsed)));
  }

  if (maxTurnsValue !== "") {
    env.JUDGE_MAX_AGENT_TURNS = maxTurnsValue;
  }

  if (normalizedTarget === "custom") {
    env.BACKEND_URL = normalizeBackendUrl(customUrl);
    env.API_KEY = env.CLIENT_ID;
  }

  runState.outputFile = null;
  runState.summary = null;
  runState.stopped = false;
  runState.saveOnStop = false;
  runState.startedAt = Date.now();
  runState.lines = [];
  runState.lastExit = null;

  const child = spawn(
    process.execPath,
    ["--env-file-if-exists=.env", "run-eval.mjs"],
    {
      cwd: __dirname,
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );

  runState.child = child;
  broadcast({ type: "status", status: "RUNNING" });

  attachLineBuffer(child.stdout, (line) => {
    const file = extractOutputFile(line);
    if (file) runState.outputFile = file;
    const summary = parseEvalSummary(line);
    if (summary) runState.summary = summary;
    broadcast({ type: "log", stream: "stdout", line });
  });

  attachLineBuffer(child.stderr, (line) => {
    broadcast({ type: "log", stream: "stderr", line });
  });

  // run-eval reports the exact file it owns as soon as it has claimed it, so a
  // stop or crash never has to guess (and never touches an earlier run's file).
  child.on("message", (message) => {
    if (message?.type === "output" && typeof message.path === "string") {
      runState.outputFile = basename(message.path);
    }
  });

  child.on("error", (err) => {
    broadcast({ type: "log", stream: "stderr", line: `spawn error: ${err.message}` });
  });

  child.on("close", (code, signal) => {
    const exitCode = code ?? (signal ? 1 : 0);
    const status = runState.stopped ? "STOPPED" : exitCode === 0 ? "DONE" : "DONE";
    // "Save & stop": run-eval wrote the rows judged so far and flagged the file as partial.
    const savedSummary =
      runState.stopped && runState.saveOnStop && exitCode === 0
        ? readSavedPartial(runState.outputFile)
        : null;
    if (savedSummary) {
      runState.summary = savedSummary;
    } else if (runState.stopped || exitCode !== 0 || !runState.summary) {
      discardRunFiles(runState.outputFile, { includePartial: runState.stopped });
      runState.outputFile = null;
    }
    broadcast({
      type: "exit",
      code: exitCode,
      signal: signal || null,
      status,
      endedAt: Date.now(),
      outputFile: runState.outputFile,
      summary: runState.summary,
      saved: Boolean(savedSummary),
    });
    runState.child = null;
  });

  return { ok: true };
}

function stopEval({ save = false } = {}) {
  if (!runState.child) {
    const err = new Error("No run in progress");
    err.status = 409;
    throw err;
  }
  // "Save & stop" is a message over the IPC channel so run-eval can write the rows
  // judged so far; discarding is a plain SIGTERM (run-eval removes its files on exit,
  // and the close handler cleans up anything left, e.g. after a forced kill).
  const keep = save === true && runState.child.connected;
  runState.stopped = true;
  runState.saveOnStop = keep;
  if (keep) {
    const child = runState.child;
    child.send({ type: "stop", save: true }, (err) => {
      // Channel went away: fall back to discarding rather than leaving the run alive.
      if (err) {
        runState.saveOnStop = false;
        child.kill("SIGTERM");
      }
    });
  } else {
    runState.child.kill("SIGTERM");
  }
  return { ok: true, saving: keep };
}

function serveStatic(req, res, pathname) {
  const filePath =
    pathname === "/" ? join(PUBLIC_DIR, "index.html") : join(PUBLIC_DIR, basename(pathname));

  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    text(res, 404, "Not found");
    return;
  }

  sendFile(res, filePath);
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
};

function sendFile(res, filePath, cacheControl = "no-cache") {
  const contentType =
    CONTENT_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
  const body = readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": cacheControl });
  res.end(body);
}

const NODE_MODULES_DIR = join(__dirname, "node_modules");
const VENDOR_FONTS = [
  ...[500, 700].flatMap((weight) => [
    ["frank-ruhl-libre", `frank-ruhl-libre-latin-${weight}-normal.woff2`],
    ["frank-ruhl-libre", `frank-ruhl-libre-hebrew-${weight}-normal.woff2`],
  ]),
  ["jetbrains-mono", "jetbrains-mono-latin-400-normal.woff2"],
  ["jetbrains-mono", "jetbrains-mono-latin-600-normal.woff2"],
  ...[400, 500, 600, 700].flatMap((weight) => [
    ["rubik", `rubik-latin-${weight}-normal.woff2`],
    ["rubik", `rubik-hebrew-${weight}-normal.woff2`],
  ]),
];
const VENDOR_FILES = new Map([
  ["/vendor/gsap.min.js", join(NODE_MODULES_DIR, "gsap/dist/gsap.min.js")],
  ["/vendor/chart.umd.min.js", join(NODE_MODULES_DIR, "chart.js/dist/chart.umd.min.js")],
  ...VENDOR_FONTS.map(([pkg, file]) => [
    `/vendor/fonts/${file}`,
    join(NODE_MODULES_DIR, "@fontsource", pkg, "files", file),
  ]),
]);
const PUBLIC_ASSETS = new Set([
  "/judy-mark.svg",
  "/judy-theme.css",
  "/judy-ui.js",
  "/judy-live.js",
  "/judy-live.css",
  "/judy-live-3d.mjs",
]);

const THREE_DIR = join(NODE_MODULES_DIR, "three");
const THREE_ADDON_RE = /^\/vendor\/three\/addons\/(loaders|controls|utils)\/[A-Za-z0-9]+\.js$/;
const ASSET_RE = /^\/assets\/[A-Za-z0-9_\-/]+\.(glb|png|md)$/;
const ASSETS_DIR = join(PUBLIC_DIR, "assets");

/* three.js build + a few addons, from node_modules. The addon regex keeps the
   route from reaching anything else in the package. */
function threeVendorPath(pathname) {
  if (pathname === "/vendor/three/three.module.js") return join(THREE_DIR, "build/three.module.js");
  if (THREE_ADDON_RE.test(pathname)) {
    return join(THREE_DIR, "examples/jsm", pathname.slice("/vendor/three/addons/".length));
  }
  return null;
}

/* Curated models and emoji under public/assets/. */
function serveAsset(res, pathname) {
  const filePath = join(PUBLIC_DIR, pathname);
  if (
    pathname.includes("..") ||
    !ASSET_RE.test(pathname) ||
    !filePath.startsWith(ASSETS_DIR) ||
    !existsSync(filePath)
  ) {
    text(res, 404, "Not found");
    return;
  }
  sendFile(res, filePath, "public, max-age=3600");
}

function serveVendor(res, pathname) {
  const filePath = VENDOR_FILES.get(pathname) || threeVendorPath(pathname);
  if (!filePath || !existsSync(filePath)) {
    text(res, 404, "Not found");
    return;
  }
  sendFile(res, filePath, "public, max-age=604800, immutable");
}

function isJudgedRunName(fileName) {
  return isSafeBasename(fileName) && isRunFileName(fileName);
}

function isTransientWorkbookReadError(err) {
  const code = err?.code;
  if (code === "EBUSY" || code === "EPERM") return true;
  const msg = String(err?.message || "");
  return /invalid archive|end of data|central directory|corrupted|bad zip|unexpected end|zip/i.test(
    msg,
  );
}

function runIsInProgress(fileName, fullPath) {
  if (!runState.child) return false;
  if (runState.outputFile && runState.outputFile === fileName) return true;
  if (!runState.startedAt || !existsSync(fullPath)) return false;
  try {
    return statSync(fullPath).mtimeMs >= runState.startedAt;
  } catch {
    return false;
  }
}

function resolveRunPath(fileName) {
  if (!isJudgedRunName(fileName)) {
    const err = new Error("Invalid file name");
    err.status = 400;
    throw err;
  }
  const fullPath = join(RUNS_DIR, fileName);
  if (!existsSync(fullPath)) {
    const err = new Error("File not found");
    err.status = 404;
    throw err;
  }
  return fullPath;
}

function sendAttachment(res, { body, contentType, fileName }) {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "no-store",
  });
  if (body) res.end(body);
}

async function serveRunDownload(res, fileName, format = "xlsx") {
  if (!isExportFormat(format)) {
    const err = new Error("format must be xlsx, csv, or json");
    err.status = 400;
    throw err;
  }
  const fullPath = resolveRunPath(fileName);

  if (format === runFormat(fileName) && format === "xlsx") {
    sendAttachment(res, {
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileName,
    });
    createReadStream(fullPath).pipe(res);
    return;
  }

  try {
    sendAttachment(res, await exportRun(await readRun(fullPath), format));
  } catch (err) {
    if (isTransientWorkbookReadError(err)) {
      json(res, 409, { error: "Report is being written, retry" });
      return;
    }
    throw err;
  }
}

async function serveRunRows(res, fileName) {
  const fullPath = resolveRunPath(fileName);

  try {
    const { name, format, ...run } = await readRun(fullPath);
    json(res, 200, {
      name,
      format,
      inProgress: runIsInProgress(fileName, fullPath),
      ...run,
    });
  } catch (err) {
    if (isTransientWorkbookReadError(err)) {
      json(res, 409, { error: "Report is being written, retry" });
      return;
    }
    throw err;
  }
}

function deleteRun(res, fileName) {
  const fullPath = resolveRunPath(fileName);
  if (runIsInProgress(fileName, fullPath)) {
    json(res, 409, { error: "This run is still in progress. Stop it first." });
    return;
  }
  const siblings = [fileName, `${fileName}.tmp`, runLogName(fileName)];
  if (runFormat(fileName) === "xlsx") siblings.push(fileName.replace(/\.xlsx$/i, ".meta.json"));
  for (const name of siblings) rmSync(join(RUNS_DIR, name), { force: true });
  if (runState.outputFile === fileName) {
    runState.outputFile = null;
    runState.lastExit = runState.lastExit ? { ...runState.lastExit, outputFile: null } : null;
  }
  json(res, 200, { ok: true, deleted: fileName });
}

function serveRunLog(res, fileName) {
  resolveRunPath(fileName);
  const logPath = join(RUNS_DIR, runLogName(fileName));
  if (!existsSync(logPath)) {
    json(res, 200, { lines: [], missing: true });
    return;
  }
  const lines = [];
  for (const raw of readFileSync(logPath, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      const entry = JSON.parse(raw);
      if (typeof entry?.l === "string") lines.push({ t: Number(entry.t) || null, s: entry.s === "err" ? "err" : "out", l: entry.l });
    } catch {
      /* partial line from a concurrent append */
    }
  }
  json(res, 200, { lines });
}

function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write("\n");

  const status = runState.child ? "RUNNING" : "IDLE";
  res.write(
    `data: ${JSON.stringify({
      type: "status",
      status,
      outputFile: runState.outputFile,
    })}\n\n`,
  );

  if (runState.lines.length) {
    res.write(
      `data: ${JSON.stringify({
        type: "replay",
        startedAt: runState.startedAt,
        lines: runState.lines,
        exit: runState.child ? null : runState.lastExit,
      })}\n\n`,
    );
  }

  runState.listeners.add(res);
  req.on("close", () => {
    runState.listeners.delete(res);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const { pathname } = url;

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      serveStatic(req, res, "/");
      return;
    }

    if (req.method === "GET" && (pathname === "/report" || pathname === "/report.html")) {
      serveStatic(req, res, "/report.html");
      return;
    }

    if (req.method === "GET" && (pathname === "/reports" || pathname === "/reports.html")) {
      serveStatic(req, res, "/reports.html");
      return;
    }

    if (req.method === "GET" && (pathname === "/live" || pathname === "/live.html")) {
      serveStatic(req, res, "/live.html");
      return;
    }

    if (req.method === "GET" && PUBLIC_ASSETS.has(pathname)) {
      serveStatic(req, res, pathname);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/assets/")) {
      serveAsset(res, pathname);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/vendor/")) {
      serveVendor(res, pathname);
      return;
    }

    if (req.method === "GET" && pathname === "/api/judge-prompt") {
      json(res, 200, { defaultPrompt: DEFAULT_SYSTEM_PROMPT });
      return;
    }

    if (req.method === "GET" && pathname === "/api/prompts") {
      json(res, 200, {
        scenarios: listPromptScenarios(),
        defaultPrompt: DEFAULT_SYSTEM_PROMPT,
      });
      return;
    }

    if (pathname.startsWith("/api/prompts/")) {
      const name = decodeURIComponent(pathname.slice("/api/prompts/".length));
      if (req.method === "GET") {
        json(res, 200, readPromptScenario(name));
        return;
      }
      if (req.method === "PUT") {
        const body = await readBody(req);
        json(res, 200, writePromptScenario(name, body.text));
        return;
      }
    }

    if (req.method === "GET" && pathname === "/api/config") {
      json(res, 200, {
        defaultConcurrency: defaultConcurrency(),
        defaultMaxTurns: defaultMaxTurns(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/inputs") {
      json(res, 200, { files: listInputFiles() });
      return;
    }

    if (req.method === "GET" && pathname === "/api/backends") {
      const backends = await listBackends();
      json(res, 200, { backends });
      return;
    }

    if (req.method === "GET" && pathname === "/api/clients") {
      json(res, 200, {
        clients: CLIENT_PRESETS,
        defaultId: CLIENT_PRESETS[0].id,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/runs") {
      json(res, 200, { runs: await listRunFilesWithSummaries() });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/runs/")) {
      const rest = decodeURIComponent(pathname.slice("/api/runs/".length));
      if (rest.toLowerCase().endsWith("/rows")) {
        await serveRunRows(res, rest.slice(0, -"/rows".length));
        return;
      }
      if (rest.toLowerCase().endsWith("/log")) {
        serveRunLog(res, rest.slice(0, -"/log".length));
        return;
      }
      if (rest.toLowerCase().endsWith("/download")) {
        const format = (url.searchParams.get("format") || "xlsx").toLowerCase();
        await serveRunDownload(res, rest.slice(0, -"/download".length), format);
        return;
      }
      await serveRunDownload(res, rest);
      return;
    }

    if (req.method === "GET" && pathname === "/api/eval/stream") {
      handleSse(req, res);
      return;
    }

    if (req.method === "DELETE" && pathname.startsWith("/api/runs/")) {
      deleteRun(res, decodeURIComponent(pathname.slice("/api/runs/".length)));
      return;
    }

    if (req.method === "POST" && pathname === "/api/eval/start") {
      const body = await readBody(req);
      const result = startEval({
        inputFile: body.inputFile,
        target: body.target,
        customUrl: body.customUrl,
        limit: body.limit,
        concurrency: body.concurrency,
        maxTurns: body.maxTurns,
        clientId: body.clientId,
        systemPrompt: body.systemPrompt,
        promptName: body.promptName,
        includeFeedback: body.includeFeedback,
      });
      json(res, 200, result);
      return;
    }

    if (req.method === "POST" && pathname === "/api/eval/stop") {
      const body = await readBody(req);
      json(res, 200, stopEval({ save: body.save === true }));
      return;
    }

    text(res, 404, "Not found");
  } catch (err) {
    const status = err.status || (err instanceof SyntaxError ? 400 : 500);
    json(res, status, { error: err.message || "Server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`JUDY UI at http://${HOST}:${PORT}`);
});
