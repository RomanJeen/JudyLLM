import assert from "node:assert/strict";
import test from "node:test";
import {
  createBackendGate,
  createChatSessionClient,
  describeError,
  fetchWhenReady,
  formatFetchError,
} from "./backend-config.mjs";

function refused() {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4000"), {
    code: "ECONNREFUSED",
  });
  return new TypeError("fetch failed", { cause });
}

test("formatFetchError keeps the undici cause", () => {
  const text = formatFetchError(refused());
  assert.match(text, /fetch failed/);
  assert.match(text, /ECONNREFUSED/);
});

test("describeError attaches the cause once, including on a wrapped outage error", () => {
  const wrapped = new Error(
    "backend still down after 600s (fetch failed; connect ECONNREFUSED 127.0.0.1:4000)",
  );
  wrapped.cause = refused();
  const text = describeError(wrapped);
  assert.equal(text, wrapped.message);
  assert.equal(text.split("ECONNREFUSED").length - 1, 1);
});

test("fetchWhenReady holds until health recovers, then retries once", async () => {
  let up = false;
  let chats = 0;
  const logs = [];
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/api/v1/health")) {
      if (!up) throw refused();
      return { ok: true, status: 200 };
    }
    chats += 1;
    if (chats === 1) throw refused();
    return { ok: true, status: 200 };
  };
  const gate = createBackendGate({
    backendUrl: "http://127.0.0.1:4000",
    fetchImpl,
    waitMs: 400,
    probeMs: 15,
    log: (line) => logs.push(line),
  });

  setTimeout(() => {
    up = true;
  }, 40);

  const response = await fetchWhenReady(
    gate,
    fetchImpl,
    "http://127.0.0.1:4000/api/v1/agent/chat",
    { method: "POST" },
  );
  assert.equal(response.status, 200);
  assert.equal(chats, 2);
  assert.equal(logs.filter((line) => line.startsWith("backend down")).length, 1);
  assert.ok(logs.some((line) => line.includes("backend is back")));
});

test("concurrent callers share one outage wait", async () => {
  let up = false;
  const logs = [];
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/api/v1/health")) {
      if (!up) throw refused();
      return { ok: true, status: 200 };
    }
    if (!up) throw refused();
    return { ok: true, status: 200 };
  };
  const gate = createBackendGate({
    backendUrl: "http://127.0.0.1:4000",
    fetchImpl,
    waitMs: 400,
    probeMs: 15,
    log: (line) => logs.push(line),
  });
  setTimeout(() => {
    up = true;
  }, 40);

  const [a, b] = await Promise.all([
    fetchWhenReady(gate, fetchImpl, "http://127.0.0.1:4000/api/v1/agent/session", {}),
    fetchWhenReady(gate, fetchImpl, "http://127.0.0.1:4000/api/v1/agent/chat", {}),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(logs.filter((line) => line.startsWith("backend down")).length, 1);
});

test("gives up with the socket cause when health never returns", async () => {
  const fetchImpl = async () => {
    throw refused();
  };
  const gate = createBackendGate({
    backendUrl: "http://127.0.0.1:4000",
    fetchImpl,
    waitMs: 40,
    probeMs: 10,
    log: () => {},
  });
  await assert.rejects(
    () => fetchWhenReady(gate, fetchImpl, "http://127.0.0.1:4000/api/v1/agent/chat", {}),
    (err) => {
      const text = describeError(err);
      assert.match(text, /backend still down/);
      assert.match(text, /ECONNREFUSED/);
      assert.match(text, /connect ECONNREFUSED 127\.0\.0\.1:4000/);
      return true;
    },
  );
});

test("session mint waits out connection refusal without using the 429 budget", async () => {
  let up = false;
  let mints = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/api/v1/health")) {
      if (!up) throw refused();
      return { ok: true, status: 200 };
    }
    mints += 1;
    if (!up) throw refused();
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ sessionId: "s1", sessionToken: "t1" }),
    };
  };
  const gate = createBackendGate({
    backendUrl: "http://127.0.0.1:4000",
    fetchImpl,
    waitMs: 400,
    probeMs: 15,
    log: () => {},
  });
  const client = createChatSessionClient({
    backendUrl: "http://127.0.0.1:4000",
    apiKey: "local-client",
    mode: "required",
    fetchImpl,
    gate,
    maxRetries: 0,
  });
  setTimeout(() => {
    up = true;
  }, 40);
  const session = await client.create();
  assert.equal(session.sessionId, "s1");
  assert.equal(session.sessionToken, "t1");
  assert.ok(mints >= 2);
});

test("after the outage window, later calls fail without waiting again", async () => {
  const fetchImpl = async () => {
    throw refused();
  };
  const gate = createBackendGate({
    backendUrl: "http://127.0.0.1:4000",
    fetchImpl,
    waitMs: 50,
    probeMs: 10,
    log: () => {},
  });
  const started = Date.now();
  await assert.rejects(
    () => fetchWhenReady(gate, fetchImpl, "http://127.0.0.1:4000/api/v1/agent/chat", {}),
    /backend still down/,
  );
  const firstMs = Date.now() - started;
  const secondStarted = Date.now();
  await assert.rejects(
    () => fetchWhenReady(gate, fetchImpl, "http://127.0.0.1:4000/api/v1/agent/session", {}),
    (err) => {
      assert.match(describeError(err), /backend still down/);
      assert.match(describeError(err), /ECONNREFUSED/);
      return true;
    },
  );
  const secondMs = Date.now() - secondStarted;
  assert.ok(firstMs >= 40, `first wait was ${firstMs}ms`);
  assert.ok(secondMs < 20, `second wait was ${secondMs}ms`);
});

test("http failures are not held for a backend outage", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 500, text: async () => "nope" };
  };
  const gate = createBackendGate({
    backendUrl: "http://127.0.0.1:4000",
    fetchImpl,
    waitMs: 400,
    probeMs: 15,
    log: () => {},
  });
  const client = createChatSessionClient({
    backendUrl: "http://127.0.0.1:4000",
    apiKey: "local-client",
    mode: "required",
    fetchImpl,
    gate,
    maxRetries: 0,
  });
  await assert.rejects(() => client.create(), /HTTP 500/);
  assert.equal(calls, 1);
});
