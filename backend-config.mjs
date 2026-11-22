export const AGENT_CHAT_ENDPOINT = "/api/v1/agent/chat";
export const AGENT_SESSION_ENDPOINT = "/api/v1/agent/session";
export const POLA_CLIENT_ID_HEADER = "x-pola-client-id";
export const LEGACY_API_KEY_HEADER = "x-jeen-api-key";
export const CHAT_SESSION_TOKEN_HEADER = "x-pola-session-token";

const DEFAULT_CLIENT_ID = "test123";
const DEFAULT_BACKEND_URL = "http://localhost:4000";
const DEFAULT_POLA_DEV_URL = "https://askpola-v2-dev.jeen-sp.app";
const DEFAULT_POLA_STG_URL = "https://askpola-v2-stg.jeen-sp.app";
// API hosts (the bare miluim-agent-{dev,stg} hosts serve the chatbot UI only).
const DEFAULT_MILUIM_DEV_URL = "https://miluim-agent-dev-api.jeen-sp.app";
const DEFAULT_MILUIM_STG_URL = "https://miluim-agent-stg-api.jeen-sp.app";
const POLA_DEV_CLIENT_ID =
  "9ed19fe553d7cb646acfd901488ce84bbdb85dc41d0b15f102ccdb15d9b67bc8";

// One preset = one agent in one environment. `target` is the backend it talks to
// (a key of listBackendCandidates), so the client ID is always paired with its backend.
export const CLIENT_PRESETS = [
  { id: "pola", agent: "pola", env: "local", target: "local", label: "Pola agent · local", clientId: "test123" },
  { id: "pola-dev", agent: "pola", env: "dev", target: "dev", label: "Pola agent · dev", clientId: POLA_DEV_CLIENT_ID },
  { id: "pola-stg", agent: "pola", env: "stg", target: "stg", label: "Pola agent · stg", clientId: POLA_DEV_CLIENT_ID },
  { id: "miluim", agent: "miluim", env: "local", target: "local", label: "Mitve Miluim agent · local", clientId: "local-client" },
  {
    id: "miluim-dev",
    agent: "miluim",
    env: "dev",
    target: "miluim-dev",
    label: "Mitve Miluim agent · dev",
    clientId: "gZJzYeyafHO3pTYZ6Ny9fsrtpTfI0cyouM1OFOUtyks=",
  },
  {
    id: "miluim-stg",
    agent: "miluim",
    env: "stg",
    target: "miluim-stg",
    label: "Mitve Miluim agent · stg",
    clientId: "zzBRcV5hfFmSo94yH2F0MpkGaH/FC247rLvVWDzhr44=",
  },
];

export function resolveClientPreset(value) {
  const raw = firstNonEmpty(value);
  if (!raw) return CLIENT_PRESETS[0];
  return (
    CLIENT_PRESETS.find((preset) => preset.id === raw || preset.clientId === raw) ||
    null
  );
}

export function parseEvalSummary(line) {
  const match = String(line || "").match(
    /^Done\.\s+(\d+)\s+rows\s+\|\s+(\d+)\s+OK\s+\|\s+(?:(\d+)\s+PARTIAL\s+\|\s+)?(\d+)\s+FALSE\s+\|\s+(\d+)\s+ERROR\s+\|\s+([\d.]+)%\s+pass rate(?:\s+\|\s+([\d.]+)%\s+score)?/,
  );
  if (!match) return null;
  return {
    total: Number(match[1]),
    ok: Number(match[2]),
    partial: Number(match[3] ?? 0),
    false: Number(match[4]),
    error: Number(match[5]),
    passRate: match[6],
    score: match[7] ?? match[6],
  };
}

const UNSUPPORTED_SESSION_STATUSES = new Set([404, 405, 501]);

export function listBackendCandidates(env = process.env) {
  const localUrl =
    normalizeBackendUrl(env.LOCAL_BACKEND_URL) || DEFAULT_BACKEND_URL;
  const polaDevUrl =
    normalizeBackendUrl(env.DEV_BACKEND_URL) || DEFAULT_POLA_DEV_URL;
  const polaStgUrl =
    normalizeBackendUrl(env.STG_BACKEND_URL) || DEFAULT_POLA_STG_URL;
  const miluimDevUrl =
    normalizeBackendUrl(env.MILUIM_DEV_BACKEND_URL) || DEFAULT_MILUIM_DEV_URL;
  const miluimStgUrl =
    normalizeBackendUrl(env.MILUIM_STG_BACKEND_URL) || DEFAULT_MILUIM_STG_URL;

  return [
    { id: "local", label: "local", url: localUrl },
    { id: "dev", label: "askPola dev", url: polaDevUrl },
    { id: "stg", label: "askPola stg", url: polaStgUrl },
    { id: "miluim-dev", label: "miluim-dev", url: miluimDevUrl },
    { id: "miluim-stg", label: "miluim-stg", url: miluimStgUrl },
  ];
}

export function stripQuotes(value) {
  if (value == null) return value;
  const trimmed = String(value).trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function firstNonEmpty(...values) {
  for (const value of values) {
    const trimmed = stripQuotes(value);
    if (trimmed) return trimmed;
  }
  return "";
}

export function normalizeBackendUrl(rawUrl, endpoint = AGENT_CHAT_ENDPOINT) {
  if (!rawUrl) return "";
  const url = stripQuotes(rawUrl).replace(/\/+$/, "");
  if (url.endsWith(endpoint)) {
    return url.slice(0, -endpoint.length) || url;
  }
  return url;
}

function pickClientId(env, target) {
  const override = firstNonEmpty(env.CLIENT_ID);
  if (override) {
    return { apiKey: override, apiKeySource: "CLIENT_ID" };
  }

  if (target === "miluim-dev") {
    const specific = firstNonEmpty(env.MILUIM_DEV_API_KEY);
    if (specific) return { apiKey: specific, apiKeySource: "MILUIM_DEV_API_KEY" };
  }

  if (target === "miluim-stg") {
    const specific = firstNonEmpty(env.MILUIM_STG_API_KEY);
    if (specific) return { apiKey: specific, apiKeySource: "MILUIM_STG_API_KEY" };
  }

  if (target === "stg") {
    const specific = firstNonEmpty(env.STG_API_KEY);
    if (specific) return { apiKey: specific, apiKeySource: "STG_API_KEY" };
    const devKey = firstNonEmpty(env.DEV_API_KEY);
    if (devKey) return { apiKey: devKey, apiKeySource: "DEV_API_KEY" };
  }

  if (target === "custom") {
    const generic = firstNonEmpty(env.API_KEY);
    if (generic) return { apiKey: generic, apiKeySource: "API_KEY" };
    const local = firstNonEmpty(env.LOCAL_API_KEY);
    if (local) return { apiKey: local, apiKeySource: "LOCAL_API_KEY" };
    return { apiKey: DEFAULT_CLIENT_ID, apiKeySource: "default" };
  }

  const prefix = target === "dev" ? "DEV" : "LOCAL";
  const specificName = `${prefix}_API_KEY`;
  const specific = firstNonEmpty(env[specificName]);
  if (specific) return { apiKey: specific, apiKeySource: specificName };

  const generic = firstNonEmpty(env.API_KEY);
  if (generic) return { apiKey: generic, apiKeySource: "API_KEY" };

  return { apiKey: DEFAULT_CLIENT_ID, apiKeySource: "default" };
}

function resolveBackendUrl(env, target) {
  if (target === "custom") {
    return env.BACKEND_URL || DEFAULT_BACKEND_URL;
  }
  if (target === "miluim-dev") {
    return env.MILUIM_DEV_BACKEND_URL || DEFAULT_MILUIM_DEV_URL;
  }
  if (target === "miluim-stg") {
    return env.MILUIM_STG_BACKEND_URL || DEFAULT_MILUIM_STG_URL;
  }
  if (target === "stg") {
    return env.STG_BACKEND_URL || DEFAULT_POLA_STG_URL;
  }
  if (target === "dev") {
    return env.DEV_BACKEND_URL || env.BACKEND_URL || DEFAULT_POLA_DEV_URL;
  }
  return env.LOCAL_BACKEND_URL || env.BACKEND_URL || DEFAULT_BACKEND_URL;
}

export function resolveBackendConfig(env = process.env) {
  const target = (env.EVAL_TARGET || "local").toLowerCase();
  const { apiKey, apiKeySource } = pickClientId(env, target);
  const rawUrl = resolveBackendUrl(env, target);

  return {
    target,
    backendUrl: normalizeBackendUrl(rawUrl) || DEFAULT_BACKEND_URL,
    apiKey,
    apiKeySource,
    chatSessionMode: resolveChatSessionMode(env),
  };
}

export function resolveChatSessionMode(env = process.env) {
  const raw = String(env.CHAT_SESSION_MODE || "auto").trim().toLowerCase();
  if (raw === "required" || raw === "on" || raw === "true") return "required";
  if (raw === "off" || raw === "false" || raw === "legacy") return "off";
  return "auto";
}

export function generateLegacySessionId() {
  return `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function parseIssuedChatSession(payload) {
  if (!payload || typeof payload !== "object") return null;

  const inner =
    payload.status === "success" &&
    payload.data &&
    typeof payload.data === "object"
      ? payload.data
      : payload;

  const sessionId = firstNonEmpty(
    inner.sessionId,
    inner.session_id,
    inner.sid,
  );
  const sessionToken = firstNonEmpty(
    inner.sessionToken,
    inner.session_token,
    inner.token,
  );
  if (!sessionId || !sessionToken) return null;

  return {
    sessionId,
    sessionToken,
    expiresAt: firstNonEmpty(inner.expiresAt, inner.expires_at) || null,
  };
}

export function agentAuthHeaders(apiKey, sessionToken) {
  const headers = {
    [POLA_CLIENT_ID_HEADER]: apiKey,
    [LEGACY_API_KEY_HEADER]: apiKey,
  };
  if (sessionToken) {
    headers[CHAT_SESSION_TOKEN_HEADER] = sessionToken;
  }
  return headers;
}

export function redactClientId(id) {
  const value = String(id || "");
  if (!value) return "(empty)";
  if (value.length <= 24) return value;
  return `${value.slice(0, 4)}…${value.slice(-2)} (len=${value.length})`;
}

export function formatAuthLog({ apiKey, apiKeySource }) {
  return `Client ID: ${redactClientId(apiKey)} from ${apiKeySource}`;
}

export function formatSessionLog(mode) {
  if (mode === "required") {
    return "Chat session: required (POST /api/v1/agent/session)";
  }
  if (mode === "off") {
    return "Chat session: off (legacy eval-* ids, no token)";
  }
  return "Chat session: auto (mint token, fall back if endpoint missing)";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function isConnectionError(error) {
  for (let current = error; current; current = current.cause) {
    if (current?.code && CONNECTION_CODES.has(current.code)) return true;
    const message = String(current?.message || "");
    if (message === "fetch failed") return true;
    if (
      /ECONNREFUSED|ECONNRESET|EPIPE|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|other side closed|socket hang up/i.test(
        message,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function formatFetchError(error) {
  const parts = [];
  for (let current = error; current; current = current.cause) {
    const code = current?.code ? String(current.code) : "";
    const message = current?.message ? String(current.message).trim() : "";
    const piece =
      code && message && !message.includes(code) ? `${code}: ${message}` : message || code;
    if (!piece) continue;
    if (parts.some((prev) => prev === piece || prev.includes(piece))) continue;
    parts.push(piece);
  }
  return parts.join("; ") || "fetch failed";
}

export function describeError(error) {
  return formatFetchError(error);
}

function healthUrl(backendUrl) {
  return `${String(backendUrl || "").replace(/\/+$/, "")}/api/v1/health`;
}

function outageError(waitMs, reason) {
  return new Error(
    `backend still down after ${Math.max(1, Math.round(waitMs / 1000))}s (${reason})`,
  );
}

export function createBackendGate({
  backendUrl,
  fetchImpl = fetch,
  waitMs = 600_000,
  probeMs = 2_000,
  probeTimeoutMs = 3_000,
  log = (line) => console.warn(line),
} = {}) {
  let pending = null;
  let outageDeadline = 0;

  async function probe() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
    try {
      const response = await fetchImpl(healthUrl(backendUrl), {
        method: "GET",
        signal: controller.signal,
      });
      return Boolean(response?.ok);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function waitUntilUp(reason) {
    const now = Date.now();
    if (outageDeadline && now >= outageDeadline) {
      return Promise.reject(outageError(waitMs, reason));
    }
    if (pending) return pending;
    if (!outageDeadline) outageDeadline = now + waitMs;

    let settle;
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    pending = promise;
    const deadline = outageDeadline;

    (async () => {
      let announced = false;
      while (Date.now() < deadline) {
        if (await probe()) {
          if (announced) log("backend is back");
          return;
        }
        if (!announced) {
          log(`backend down, waiting (${reason})`);
          announced = true;
        }
        const delay = Math.min(probeMs, Math.max(0, deadline - Date.now()));
        if (delay <= 0) break;
        await sleep(delay);
      }
      throw outageError(waitMs, reason);
    })().then(
      () => {
        outageDeadline = 0;
        if (pending === promise) pending = null;
        settle.resolve();
      },
      (err) => {
        if (pending === promise) pending = null;
        settle.reject(err);
      },
    );

    return promise;
  }

  return { waitUntilUp, waitMs, probeMs };
}

export async function fetchWhenReady(gate, fetchImpl, url, init) {
  const probeMs = gate.probeMs ?? 2_000;
  let instantRetries = 0;

  for (;;) {
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      const description = formatFetchError(err);
      const started = Date.now();
      try {
        await gate.waitUntilUp(description);
      } catch (waitErr) {
        const wrapped = new Error(waitErr.message);
        wrapped.cause = err;
        throw wrapped;
      }

      // Health is already up, so this was not an outage. Retry a couple of
      // times for a dead keep-alive socket, then surface the real cause.
      if (Date.now() - started < Math.min(50, probeMs)) {
        instantRetries += 1;
        if (instantRetries >= 3) {
          const wrapped = new Error(description);
          wrapped.cause = err;
          throw wrapped;
        }
        await sleep(probeMs);
      } else {
        instantRetries = 0;
      }
    }
  }
}

function retryDelayMs(attempt, baseMs, maxMs) {
  const exponential = baseMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, maxMs);
  const jitter = Math.floor(Math.random() * Math.min(1000, capped));
  return capped + jitter;
}

export function createChatSessionClient({
  backendUrl,
  apiKey,
  mode = resolveChatSessionMode(),
  fetchImpl = fetch,
  gate,
  maxRetries = 8,
  retryBaseMs = 10000,
  retryMaxMs = 60000,
} = {}) {
  let unsupported = mode === "off";
  const backendGate =
    gate ||
    createBackendGate({
      backendUrl,
      fetchImpl,
      log: (line) => console.warn(line),
    });

  async function mintOnce() {
    return fetchWhenReady(backendGate, fetchImpl, `${backendUrl}${AGENT_SESSION_ENDPOINT}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...agentAuthHeaders(apiKey),
      },
      body: "{}",
    });
  }

  async function create() {
    if (mode === "off" || unsupported) {
      return {
        sessionId: generateLegacySessionId(),
        sessionToken: null,
        source: "legacy",
      };
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await mintOnce();

      if (response.ok) {
        const raw = await response.text();
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          throw new Error(
            `Chat session returned HTML/non-JSON from ${backendUrl}${AGENT_SESSION_ENDPOINT}. Use the API host, not the chatbot UI.`,
          );
        }
        const issued = parseIssuedChatSession(payload);
        if (!issued) {
          const keys =
            payload && typeof payload === "object"
              ? Object.keys(payload).join(",")
              : typeof payload;
          throw new Error(
            `Chat session response missing sessionId/sessionToken (keys: ${keys})`,
          );
        }
        return {
          sessionId: issued.sessionId,
          sessionToken: issued.sessionToken,
          source: "issued",
        };
      }

      const body = await response.text().catch(() => "");

      if (UNSUPPORTED_SESSION_STATUSES.has(response.status)) {
        if (mode === "required") {
          const err = new Error(
            `HTTP ${response.status}: chat session endpoint unavailable`,
          );
          err.status = response.status;
          err.body = body;
          throw err;
        }
        unsupported = true;
        return {
          sessionId: generateLegacySessionId(),
          sessionToken: null,
          source: "legacy",
        };
      }

      if (response.status === 429 && attempt < maxRetries) {
        await sleep(retryDelayMs(attempt + 1, retryBaseMs, retryMaxMs));
        continue;
      }

      const err = new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
      err.status = response.status;
      err.body = body;
      throw err;
    }

    throw new Error("chat session retry loop exhausted");
  }

  return { create };
}
