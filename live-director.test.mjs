import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// Both files are browser scripts; in Node they attach to globalThis.
require("./public/judy-ui.js");
require("./public/judy-live.js");
const { Judy, JudyLive } = globalThis;

function logLine(l, t, s = "out") {
  return { t, s, l };
}

function collect(lines, extra = {}) {
  const actions = [];
  const director = JudyLive.createDirector({
    onAction: (slot, action) => actions.push({ slot, ...action }),
    onReset: () => { actions.length = 0; },
    ...extra,
  });
  for (const entry of lines) director.ingest(entry.l, entry.s === "err" ? "stderr" : "stdout", entry.t);
  return { director, actions };
}

const HEADER = [
  "Loaded 4 questions from x.xlsx (running 4)",
  "Target: dev",
  "Backend: http://localhost:4000/api/v1/agent/chat",
  "Concurrency: 2",
  "Max agent turns per row: 4",
  "",
];

function synthetic() {
  const body = [
    "[ 1/4] first question",
    "[ 2/4] second question",
    "[ 1/4] agent  -> HTTP 429, retry 1/8 in 10000ms",
    "[ 1/4] turn 1/4: agent -> 120 chars",
    "[ 2/4] turn 1/4: agent -> 80 chars",
    "[ 1/4] judge  -> NEEDS_FOLLOWUP | user -> more please",
    "[ 2/4] judge  -> OK - fine\n",
    "[ 3/4] third question",
    "[ 1/4] turn 2/4: agent -> 200 chars",
    "[ 1/4] judge  -> FALSE - wrong\n",
    "[ 4/4] fourth question",
    "[ 3/4] session -> ERROR: HTTP 403",
    "[ 4/4] turn 1/4: agent -> 10 chars",
    "[ 4/4] judge  -> PARTIAL - half\n",
    "Done. 4 rows | 1 OK | 1 PARTIAL | 1 FALSE | 1 ERROR | 25.0% pass rate",
  ];
  return [...HEADER, ...body.flatMap((l) => l.split("\n"))].map((l, i) => logLine(l, 1000 + i * 10, l.includes("ERROR:") ? "err" : "out"));
}

test("assigns each question to a free judge and never exceeds concurrency", () => {
  const { director, actions } = collect(synthetic());
  assert.equal(director.slots.length, 2);
  const starts = actions.filter((a) => a.type === "start");
  assert.deepEqual(starts.map((a) => a.n), [1, 2, 3, 4]);
  assert.ok(actions.every((a) => a.slot < 2));
  // Question 3 starts after question 2 finished, so it reuses judge 1.
  assert.equal(starts[2].slot, 1);
  // Question 4 starts after question 1 finished, so it reuses judge 0.
  assert.equal(starts[3].slot, 0);
});

test("every verdict produces exactly one stamp, and errors produce one error", () => {
  const { actions } = collect(synthetic());
  const stamps = actions.filter((a) => a.type === "stamp");
  assert.deepEqual(stamps.map((a) => [a.n, a.verdict]).sort(), [[1, "FALSE"], [2, "OK"], [4, "PARTIAL"]]);
  const errors = actions.filter((a) => a.type === "error");
  assert.deepEqual(errors.map((a) => a.n), [3]);
});

test("HTTP 429 queues the judge at the agent's door", () => {
  const { actions } = collect(synthetic());
  const retries = actions.filter((a) => a.type === "retry");
  assert.equal(retries.length, 1);
  assert.deepEqual({ n: retries[0].n, attempt: retries[0].attempt, delayMs: retries[0].delayMs }, { n: 1, attempt: 1, delayMs: 10000 });
});

test("answers and follow-ups keep their order inside one judge", () => {
  const { actions } = collect(synthetic());
  const forOne = actions.filter((a) => a.n === 1).map((a) => a.type);
  assert.deepEqual(forOne, ["start", "retry", "answer", "followup", "answer", "stamp"]);
});

test("catch-up speed is 1x up to two queued events, then 2-3x, then faster", () => {
  assert.equal(JudyLive.catchUpSpeed(0), 1);
  assert.equal(JudyLive.catchUpSpeed(2), 1);
  assert.equal(JudyLive.catchUpSpeed(3), 2);
  assert.ok(JudyLive.catchUpSpeed(5) <= 3 && JudyLive.catchUpSpeed(5) >= 2);
  assert.ok(JudyLive.catchUpSpeed(40) > 3);
});

test("a judge that falls behind plays its queue faster, and plays every action", async () => {
  const speeds = [];
  const played = [];
  const { director } = collect(synthetic(), {
    play: (slot, action, speed) => {
      speeds.push(speed);
      played.push(action.type);
      return Promise.resolve();
    },
  });
  await director.whenIdle();
  assert.ok(speeds.some((s) => s > 1), "expected a catch-up speed-up");
  assert.equal(played.filter((t) => t === "stamp").length, 3);
});

test("silent mode tracks where each judge is without queueing actions", () => {
  const played = [];
  const director = JudyLive.createDirector({ play: (slot, action) => played.push(action) });
  director.setSilent(true);
  for (const entry of synthetic().slice(0, 12)) director.ingest(entry.l, "stdout", entry.t);
  assert.equal(played.length, 0);
  const phases = director.slots.map((s) => s.state.phase);
  assert.deepEqual(phases, ["atAgent", "reading"]);
});

test("finish interrupts unfinished questions and sends every judge to the finale", () => {
  const lines = synthetic().slice(0, 12);
  const { director, actions } = collect(lines);
  const result = director.finish({ status: "STOPPED" });
  assert.ok(result.touched.length >= 1);
  const finales = actions.filter((a) => a.type === "finale");
  assert.equal(finales.length, director.slots.length);
  assert.ok(actions.some((a) => a.type === "error" && /stopped/.test(a.text)));
});

/* Invariants over every recorded run on this machine (skipped when none). */
const runsDir = join(here, "runs");
const logs = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith(".log.jsonl")) : [];

for (const file of logs) {
  test(`recorded run ${file} keeps director invariants`, () => {
    const lines = [];
    for (const raw of readFileSync(join(runsDir, file), "utf8").split("\n")) {
      if (!raw.trim()) continue;
      try {
        const entry = JSON.parse(raw);
        if (typeof entry.l === "string") lines.push({ t: entry.t, s: entry.s === "err" ? "err" : "out", l: entry.l });
      } catch { /* partial line */ }
    }
    const { director, actions } = collect(lines);
    const model = director.model;
    const concurrency = Number(model.run.fields.concurrency) || 0;
    if (concurrency) assert.ok(director.slots.length <= concurrency, `slots ${director.slots.length} > concurrency ${concurrency}`);

    // Replay the actions to prove a judge never holds two questions at once.
    const open = new Map();
    for (const a of actions) {
      if (a.type === "start") {
        assert.equal(open.get(a.slot) ?? null, null, `slot ${a.slot} started #${a.n} while busy`);
        open.set(a.slot, a.n);
      } else if (a.type === "stamp" || a.type === "error") {
        assert.equal(open.get(a.slot), a.n);
        open.set(a.slot, null);
      }
    }

    let verdicts = 0;
    let retries = 0;
    for (const q of model.questions.values()) {
      for (const step of q.steps) {
        if (step.kind === "verdict") verdicts += 1;
        if (step.kind === "retry") retries += 1;
      }
    }
    assert.equal(actions.filter((a) => a.type === "stamp").length, verdicts);
    assert.equal(actions.filter((a) => a.type === "retry").length, retries);
  });
}

void Judy;

test("computeLayout fits 1 to 32 judges without overlapping desks", () => {
  for (let n = 1; n <= 32; n += 1) {
    const L = JudyLive.computeLayout(n);
    assert.equal(L.desks.length, n, `desk count for ${n}`);
    assert.equal(new Set(L.desks.map((d) => d.slot)).size, n);
    for (const d of L.desks) {
      assert.ok(Math.abs(d.y) - 1 >= L.aisle / 2, `aisle clear at n=${n}, slot ${d.slot}`);
      assert.ok(Math.abs(d.y) + 1 <= L.halfW, `desk inside the room at n=${n}`);
      assert.ok(d.chair.x < d.x, "chair sits on the aisle side of the desk");
    }
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const a = L.desks[i];
        const b = L.desks[j];
        const apart = Math.abs(a.x - b.x) >= 2 || Math.abs(a.y - b.y) >= 2;
        assert.ok(apart, `desks ${i} and ${j} overlap at n=${n}`);
      }
    }
  }
});

test("computeLayout keeps trays past the last desk row and the pod before the first", () => {
  for (const n of [1, 2, 8, 17, 32]) {
    const L = JudyLive.computeLayout(n);
    const lastX = Math.max(...L.desks.map((d) => d.x));
    const firstX = Math.min(...L.desks.map((d) => d.laneX));
    assert.ok(L.trayX > lastX + 1, `trays beyond the last row at n=${n}`);
    assert.ok(L.xMax > L.trayX);
    assert.ok(L.pod.x1 < firstX, `pod ahead of the first lane at n=${n}`);
    assert.ok(L.xMin < L.pod.x0);
  }
});
