/* JUDY live office: plays an eval run as little judges running to the tested
   agent and back to their desks.

   Parts (all in this file, in order):
     1. createDirector   pure, DOM-free: log lines -> per-judge action queues
     2. computeLayout    pure: where desks, the agent pod and the trays go
     3. sources + page   LiveSource (SSE), ReplaySource (saved log), HUD, drawer

   The 3D office itself lives in judy-live-3d.mjs (three.js). It exports
   createScene(container, handlers), and the page boots it with
   JudyLive.boot(createScene).

   Plain script, exposes window.JudyLive. Needs judy-ui.js (window.Judy) first. */
(function (root) {
  "use strict";

  const Judy = root.Judy;
  const JudyLive = (root.JudyLive = root.JudyLive || {});
  const hasDom = typeof document !== "undefined";

  /* =====================================================================
     1. Director
     ===================================================================== */

  /* How fast a judge's queue plays, given how many actions are waiting behind
     the one being played. Up to 2 queued events play at normal speed (the
     scene is truthful); more than that and it catches up at 2-3x. A huge
     backlog (a late-joining tab, a 16x replay) goes faster still, but every
     action is still played, so no verdict stamp is ever dropped. */
  function catchUpSpeed(queued) {
    if (queued <= 2) return 1;
    if (queued > 10) return 6;
    return Math.min(3, 1.5 + (queued - 2) * 0.5);
  }

  /* Turn the log model into per-judge action streams.

     The log carries no worker-slot id, so a question is given to the first
     free judge when it starts, which mirrors runWithConcurrency in run-eval.mjs.

     Actions (one object per event, always carrying the question number `n`):
       start     { text }                      judge takes the question to the agent
       retry     { attempt, of, delayMs }      HTTP 429: queue at the agent's door
       answer    { turn, chars }               agent replied, carry it back to the desk
       followup  { text }                      judge writes a note and returns to the agent
       stamp     { verdict }                   OK | PARTIAL | FALSE
       error     { text, stage }
       finale    { summary }                   run is over (one per judge, no `n`)

     opts.model     existing Judy log model to use (default: a new one)
     opts.onAction  (slotIndex, action) called synchronously when an action is queued
     opts.play      (slotIndex, action, speed) => Promise|void, plays one action;
                    the next action of that judge starts when it settles
     opts.onSlots   (count) called when the number of judges changes */
  function createDirector(opts = {}) {
    let model = opts.model || Judy.createLogModel();
    const slots = [];
    let byQ = new Map();
    let silent = false;
    let announced = 0;
    let idleWaiters = [];

    function slotCount() {
      const concurrency = Number(model.run.fields.concurrency) || 0;
      if (!concurrency) return 0;
      const total = model.total || Number(model.run.fields.loaded) || concurrency;
      return Math.max(1, Math.min(concurrency, total));
    }

    function newSlot() {
      const slot = {
        index: slots.length,
        q: null,
        lastQ: null,
        queue: [],
        busy: false,
        // Where this judge is, as of the log (not as of the animation).
        state: { phase: "idle", n: null, turns: 0, retrying: false, verdict: "" },
      };
      slots.push(slot);
      return slot;
    }

    function announce() {
      if (slots.length !== announced) {
        announced = slots.length;
        if (opts.onSlots) opts.onSlots(announced);
      }
    }

    /* Make sure the judge pool matches the announced concurrency. */
    function sizePool() {
      const want = slotCount();
      while (slots.length < want) newSlot();
      announce();
    }

    function acquire(n) {
      sizePool();
      let slot = slots.find((s) => s.q === null);
      if (!slot) slot = newSlot();
      slot.q = n;
      slot.lastQ = n;
      slot.state = { phase: "start", n, turns: 0, retrying: false, verdict: "" };
      announce();
      return slot;
    }

    function pump(slot) {
      if (slot.busy) return;
      slot.busy = true;
      const next = () => {
        const action = slot.queue.shift();
        if (!action) {
          slot.busy = false;
          if (!isBusy()) {
            const waiters = idleWaiters;
            idleWaiters = [];
            for (const resolve of waiters) resolve();
          }
          return;
        }
        let result;
        try {
          result = opts.play ? opts.play(slot.index, action, catchUpSpeed(slot.queue.length)) : undefined;
        } catch {
          result = undefined;
        }
        Promise.resolve(result).then(next, next);
      };
      next();
    }

    function isBusy() {
      return slots.some((s) => s.busy || s.queue.length);
    }

    function trackState(slot, action) {
      const st = slot.state;
      switch (action.type) {
        case "start": st.phase = "atAgent"; break;
        case "retry": st.phase = "atAgent"; st.retrying = true; st.retry = action; break;
        case "answer": st.phase = "reading"; st.turns = action.turn; st.retrying = false; break;
        case "followup": st.phase = "atAgent"; st.retrying = false; break;
        case "stamp": st.phase = "done"; st.verdict = action.verdict; break;
        case "error": st.phase = "done"; st.verdict = "ERROR"; break;
        default: break;
      }
    }

    function emit(slot, action) {
      trackState(slot, action);
      if (opts.onAction) opts.onAction(slot.index, action);
      if (silent) return;
      slot.queue.push(action);
      pump(slot);
    }

    function sync(n) {
      const q = model.questions.get(n);
      if (!q) return;
      let st = byQ.get(n);
      if (!st) {
        st = { slot: null, seen: 0, started: false, done: false };
        byQ.set(n, st);
      }
      if (st.done) return;
      if (q.status === "skipped") {
        st.done = true;
        return;
      }
      if (q.status === "waiting") return;

      if (!st.started) {
        st.started = true;
        st.slot = acquire(n);
        emit(st.slot, { type: "start", n, text: q.text });
      }
      const slot = st.slot;

      while (st.seen < q.steps.length) {
        const step = q.steps[st.seen];
        st.seen += 1;
        switch (step.kind) {
          case "agent": emit(slot, { type: "answer", n, turn: step.turn, chars: step.chars }); break;
          case "followup": emit(slot, { type: "followup", n, text: step.text }); break;
          case "retry": emit(slot, { type: "retry", n, attempt: step.attempt, of: step.of, delayMs: step.delayMs }); break;
          case "verdict": emit(slot, { type: "stamp", n, verdict: step.verdict }); break;
          case "error": emit(slot, { type: "error", n, text: step.text, stage: step.stage }); break;
          default: break;
        }
      }

      if (q.status === "done" || q.status === "error") {
        st.done = true;
        slot.q = null;
      }
    }

    const director = {
      get model() { return model; },
      get slots() { return slots; },
      get silent() { return silent; },

      /* While silent, state is tracked but no actions are queued. Used to
         catch up on a run that was already going when the page opened. */
      setSilent(value) { silent = Boolean(value); },

      ingest(line, stream = "stdout", now = Date.now()) {
        // A saved log can hold several runs back to back; a fresh "Loaded N
        // questions" header after real activity starts a new office.
        if (/^Loaded\s+\d+\s+questions/i.test(String(line)) && model.questions.size) {
          director.reset();
          if (opts.onReset) opts.onReset();
        }
        const result = model.ingest(line, stream, now);
        if (result && result.q != null) sync(result.q);
        if (!slots.length) sizePool();
        return result;
      },

      /* The run is over (finished, failed or stopped). */
      finish(payload = {}) {
        const stopped = payload.status === "STOPPED";
        const touched = model.interrupt(
          stopped ? "run stopped before this question finished" : "run ended before this question finished",
        );
        for (const n of touched) sync(n);
        const summary = payload.summary || model.run.summary || null;
        for (const slot of slots) emit(slot, { type: "finale", summary, stopped });
        return { touched, summary };
      },

      reset(nextModel) {
        model = nextModel || Judy.createLogModel();
        slots.length = 0;
        byQ = new Map();
        announced = 0;
        silent = false;
        idleWaiters = [];
        if (opts.onSlots) opts.onSlots(0);
      },

      isBusy,
      whenIdle() {
        if (!isBusy()) return Promise.resolve();
        return new Promise((resolve) => idleWaiters.push(resolve));
      },
    };

    return director;
  }

  JudyLive.createDirector = createDirector;
  JudyLive.catchUpSpeed = catchUpSpeed;

  /* =====================================================================
     2. Layout (pure). The 3D scene in judy-live-3d.mjs turns this plan into
     a room: layout x is the aisle (away from the agent) and layout y is
     across the aisle, in world units.
     ===================================================================== */

  const HUES = [200, 332, 38, 152, 268, 8, 96, 226];
  const TRAYS = [
    { key: "ok", verdict: "OK", label: "OK" },
    { key: "partial", verdict: "PARTIAL", label: "PARTIAL" },
    { key: "false", verdict: "FALSE", label: "FALSE" },
    { key: "error", verdict: "ERROR", label: "ERROR" },
  ];


  /* Where desks, the agent pod and the trays go for N judges. Rows run across
     the aisle (up to 4 desks per side), the camera fits whatever comes out. */
  function computeLayout(count) {
    const n = Math.max(1, Math.floor(count) || 1);
    const perSide = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(n / 2))));
    const perRow = perSide * 2;
    const rows = Math.ceil(n / perRow);
    const AISLE = 1.15;
    const ROW0 = 6.4;
    const ROW_PITCH = 3.4;
    const COL0 = 2.4;
    const COL_PITCH = 2.4;
    const desks = [];
    for (let i = 0; i < n; i += 1) {
      const row = Math.floor(i / perRow);
      const within = i % perRow;
      const side = within % 2 === 0 ? 1 : -1;
      const col = Math.floor(within / 2);
      const x = ROW0 + row * ROW_PITCH;
      const y = side * (COL0 + col * COL_PITCH);
      desks.push({
        slot: i,
        x,
        y,
        side,
        row,
        col,
        chair: { x: x - 1.05, y },
        laneX: x - 1.9,
        hue: HUES[i % HUES.length],
      });
    }
    const lastRowX = ROW0 + (rows - 1) * ROW_PITCH;
    const trayX = lastRowX + 3.4;
    const halfW = Math.max(4.4, COL0 + (perSide - 1) * COL_PITCH + 1.6);
    const trayGap = Math.max(1.9, Math.min(3, halfW / 2.2));
    return {
      n,
      perSide,
      rows,
      aisle: AISLE,
      desks,
      xMin: -4.6,
      xMax: trayX + 1.7,
      halfW,
      trayX,
      trayGap,
      pod: { x0: -4.0, x1: 0.2, y0: -2.1, y1: 2.1, h: 9, cx: -1.8 },
    };
  }

  JudyLive.computeLayout = computeLayout;
  JudyLive.TRAYS = TRAYS;

  /* =====================================================================
     3. Sources + page
     ===================================================================== */

  /* "Pola · dev", "Mitve Miluim · stg", or the host for a custom backend. */
  function agentLabel(fields = {}) {
    const target = String(fields.target || "").toLowerCase();
    if (!target) return { name: "Agent under test", sub: "" };
    if (target === "custom") {
      let host = "Custom backend";
      try { host = new URL(fields.backend).host; } catch { /* keep the generic name */ }
      return { name: host, sub: "custom" };
    }
    if (target.startsWith("miluim")) return { name: "Mitve Miluim", sub: target.replace(/^miluim-?/, "") || "local" };
    return { name: "Pola", sub: target };
  }
  JudyLive.agentLabel = agentLabel;

  /* Replays a saved log line by line on a clock that can be scaled. Quiet
     stretches (nothing running, a long wait) are skipped so a 16x replay of a
     long run does not sit idle. */
  function createReplaySource(handlers) {
    const src = {
      lines: [],
      i: 0,
      vt: 0,
      t0: 0,
      speed: 4,
      playing: false,
      raf: 0,
      last: 0,
      ended: false,
    };

    function frame(now) {
      if (!src.playing) return;
      const dt = Math.min(250, now - src.last);
      src.last = now;
      src.vt += dt * src.speed;
      while (src.i < src.lines.length && src.lines[src.i].t <= src.vt) {
        handlers.line(src.lines[src.i]);
        src.i += 1;
      }
      if (src.i < src.lines.length) {
        const gap = src.lines[src.i].t - src.vt;
        if (gap / src.speed > 3000 && !handlers.busy()) src.vt = src.lines[src.i].t - 600 * src.speed;
      } else if (!src.ended) {
        src.ended = true;
        src.playing = false;
        handlers.end();
        return;
      }
      src.raf = requestAnimationFrame(frame);
    }

    Object.assign(src, {
      load(lines) {
        src.cancel();
        let prev = 0;
        src.lines = lines.map((entry) => {
          const t = Number.isFinite(entry.t) ? entry.t : prev + 50;
          prev = t;
          return { t, s: entry.s === "err" ? "stderr" : "stdout", l: entry.l };
        });
        src.i = 0;
        src.t0 = src.lines.length ? src.lines[0].t : 0;
        src.vt = src.t0;
        src.ended = false;
      },
      play() {
        if (src.playing || src.ended) return;
        src.playing = true;
        src.last = performance.now();
        src.raf = requestAnimationFrame(frame);
      },
      pause() {
        src.playing = false;
        cancelAnimationFrame(src.raf);
      },
      cancel() {
        src.pause();
        src.lines = [];
      },
      setSpeed(value) { src.speed = value; },
      elapsed() { return Math.max(0, src.vt - src.t0); },
    });
    return src;
  }
  JudyLive.createReplaySource = createReplaySource;

  const VERDICT_PILL = { OK: "ok", PARTIAL: "partial", FALSE: "false", ERROR: "error" };

  async function bootPage(createScene) {
    const $ = (id) => document.getElementById(id);
    const stageEl = $("stage");
    if (!stageEl) return;
    for (const el of Array.from(document.querySelectorAll("[data-icon]"))) el.outerHTML = Judy.icon(el.dataset.icon);
    Judy.theme.mountToggle($("themeBtn"));

    const wrap = $("stageWrap");
    const tip = $("tip");
    const drawer = $("drawer");
    const els = {
      led: $("statusLed"), status: $("statusText"),
      done: $("hudDone"), total: $("hudTotal"),
      barOk: $("barOk"), barPartial: $("barPartial"), barFalse: $("barFalse"), barError: $("barError"),
      cntOk: $("cntOk"), cntPartial: $("cntPartial"), cntFalse: $("cntFalse"), cntError: $("cntError"),
      target: $("hudTarget"), judges: $("hudJudges"), elapsed: $("hudElapsed"),
      empty: $("stageEmpty"), emptyText: $("stageEmptyText"),
      mode: $("modeSelect"), speed: $("speedSeg"), play: $("playBtn"), playLabel: $("playLabel"),
      restart: $("restartBtn"), stop: $("stopBtn"), fs: $("fsBtn"),
    };

    if (!root.gsap) {
      els.emptyText.textContent = "The animation library failed to load, so the office cannot be drawn.";
      return;
    }

    const page = {
      mode: "live",
      running: false,
      startedAt: null,
      endedAt: null,
      finished: false,
      counts: { OK: 0, PARTIAL: 0, FALSE: 0, ERROR: 0 },
      outputFile: null,
      replayName: null,
      drawerN: null,
      drawerSlot: null,
      labelKey: "",
      paused: false,
    };

    /* ----- scene + director ----- */

    let scene;
    try {
      scene = await createScene(stageEl, {
        onPick: (slot) => openDrawer(slot),
        onHover: showTip,
        onCount: (counts) => { page.counts = counts; renderHud(); },
      });
    } catch (err) {
      console.error(err);
      els.empty.classList.remove("hidden");
      els.emptyText.textContent = `The 3D office could not start (${err && err.message ? err.message : err}). WebGL must be available.`;
      return;
    }

    const director = createDirector({
      play: (slot, action, speed) => scene.play(slot, action, speed),
      onSlots: (n) => { if (n === 0) scene.clearRun(); else scene.setSlots(n); },
      onReset: () => resetPage(false),
    });

    scene.setSlots(4);

    /* ----- status + HUD ----- */

    function setStatus(kind, text) {
      els.led.className = `led ${kind}`;
      els.status.textContent = text;
    }

    function totalQuestions() {
      const m = director.model;
      return m.total || Number(m.run.fields.loaded) || 0;
    }

    function elapsedMs() {
      if (page.mode === "replay") return replay.elapsed();
      if (!page.startedAt) return 0;
      return (page.endedAt || Date.now()) - page.startedAt;
    }

    function renderElapsed() {
      els.elapsed.textContent = elapsedMs() ? Judy.formatDuration(elapsedMs()) : "0s";
    }

    function renderHud() {
      const m = director.model;
      const c = page.counts;
      const skipped = m.tally().skipped || 0;
      const done = c.OK + c.PARTIAL + c.FALSE + c.ERROR + skipped;
      const total = totalQuestions();
      els.done.textContent = String(done);
      els.total.textContent = String(total);
      els.cntOk.textContent = String(c.OK);
      els.cntPartial.textContent = String(c.PARTIAL);
      els.cntFalse.textContent = String(c.FALSE);
      els.cntError.textContent = String(c.ERROR);
      const pct = (n) => `${total ? Math.min(100, (n / total) * 100) : 0}%`;
      els.barOk.style.width = pct(c.OK);
      els.barPartial.style.width = pct(c.PARTIAL);
      els.barFalse.style.width = pct(c.FALSE);
      els.barError.style.width = pct(c.ERROR);

      const key = `${m.run.fields.target || ""}|${m.run.fields.backend || ""}`;
      if (key !== page.labelKey) {
        page.labelKey = key;
        const label = agentLabel(m.run.fields);
        scene.setTarget(label.name, label.sub);
        els.target.textContent = m.run.fields.target ? `${label.name} · ${label.sub}` : "—";
      }
      els.judges.textContent = scene.slotCount ? String(scene.slotCount) : "—";
      els.empty.classList.toggle("hidden", m.questions.size > 0);
      renderElapsed();
    }

    setInterval(renderElapsed, 250);

    function resetPage(resetDirector = true) {
      if (resetDirector) director.reset();
      scene.clearRun();
      page.counts = { OK: 0, PARTIAL: 0, FALSE: 0, ERROR: 0 };
      page.startedAt = null;
      page.endedAt = null;
      page.finished = false;
      page.outputFile = null;
      page.labelKey = "";
      closeDrawer();
      hideTip();
      renderHud();
    }

    /* ----- tooltip ----- */

    function questionFor(slot) {
      const r = scene.runner(slot);
      if (!r || r.q == null) return null;
      return director.model.questions.get(r.q) || null;
    }

    function statusWord(q) {
      if (!q) return "";
      if (q.status === "done" || q.status === "error") return q.verdict;
      if (q.status === "agent") return "at the agent";
      if (q.status === "judging") return "reading the answer";
      return q.status;
    }

    function showTip(slot, event) {
      if (slot == null || !event) { hideTip(); return; }
      const q = questionFor(slot);
      if (!q) {
        tip.innerHTML = `<div class="t-head">Judge ${slot + 1}</div><div class="t-q">Waiting for a question</div>`;
      } else {
        tip.innerHTML = `<div class="t-head"><strong>#${q.n}</strong><span>${Judy.escapeHtml(statusWord(q))}</span>${q.turn ? `<span>turn ${q.turn}${q.maxTurns ? `/${q.maxTurns}` : ""}</span>` : ""}</div><div class="t-q" dir="auto">${Judy.escapeHtml(q.text || "")}</div>`;
      }
      const box = wrap.getBoundingClientRect();
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;
      tip.classList.add("show");
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      tip.style.left = `${Math.max(8, Math.min(box.width - w - 8, x + 16))}px`;
      tip.style.top = `${Math.max(8, Math.min(box.height - h - 8, y + 16))}px`;
    }

    function hideTip() { tip.classList.remove("show"); }

    /* ----- drawer ----- */

    let drawerQueued = false;

    function openDrawer(slot) {
      const r = scene.runner(slot);
      if (!r || r.q == null) {
        Judy.toast("This judge has not taken a question yet");
        return;
      }
      page.drawerSlot = slot;
      page.drawerN = r.q;
      scene.select(slot);
      renderDrawer();
      drawer.classList.add("open");
      drawer.setAttribute("aria-hidden", "false");
    }

    function closeDrawer() {
      page.drawerN = null;
      page.drawerSlot = null;
      scene.select(null);
      drawer.classList.remove("open");
      drawer.setAttribute("aria-hidden", "true");
    }

    function scheduleDrawer() {
      if (page.drawerN == null || drawerQueued) return;
      drawerQueued = true;
      requestAnimationFrame(() => { drawerQueued = false; renderDrawer(); });
    }

    function renderDrawer() {
      const q = director.model.questions.get(page.drawerN);
      if (!q) return;
      $("drawerNum").textContent = `#${q.n}`;
      const finished = q.status === "done" || q.status === "error";
      $("drawerPill").innerHTML = finished
        ? `<span class="pill ${VERDICT_PILL[q.verdict] || "wait"}">${Judy.escapeHtml(q.verdict)}</span>`
        : `<span class="pill accent">${Judy.escapeHtml(statusWord(q) || "waiting")}</span>`;

      const steps = q.steps.map((step) => Judy.stepHtml(step, q.startedAt));
      if (q.status === "agent") {
        steps.push(`<li class="live-row"><span class="dot led live"></span><span class="what">Agent · t${q.turn + 1}</span><span class="detail">waiting for reply…</span><span class="at"></span></li>`);
      } else if (q.status === "judging") {
        steps.push(`<li class="live-row"><span class="dot led live"></span><span class="what">Judge</span><span class="detail">grading turn ${q.turn}…</span><span class="at"></span></li>`);
      }
      let html = `<div class="dsec"><h4>Question</h4><p class="dq" dir="auto">${Judy.escapeHtml(q.text || "")}</p></div>`;
      html += `<div class="dsec"><h4>Timeline</h4><ol class="timeline">${steps.join("") || `<li><span class="dot"></span><span class="what">Queued</span><span class="detail">starting…</span><span class="at"></span></li>`}</ol></div>`;
      if (finished) {
        html += `<div class="dsec"><h4>Judge findings</h4><div class="qfindings">${Judy.findingsHtml(q.findings, { emptyText: (q.explanation || "").trim() || "אין בעיות מהותיות" })}</div></div>`;
      }
      const body = $("drawerBody");
      const keep = body.scrollTop;
      body.innerHTML = html;
      body.scrollTop = keep;

      const report = $("drawerReport");
      const file = page.outputFile || director.model.run.file || page.replayName;
      if (file) {
        report.href = `/report?run=${encodeURIComponent(String(file).split("/").pop())}`;
        report.removeAttribute("aria-disabled");
      } else {
        report.href = "#";
        report.setAttribute("aria-disabled", "true");
      }
    }

    $("drawerClose").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

    /* ----- feeding the director ----- */

    function ingest(line, stream, now) {
      if (page.startedAt == null && now != null) page.startedAt = now;
      director.ingest(line, stream, now);
      scheduleDrawer();
      renderHud();
    }

    function finishRun(payload) {
      if (page.finished) return;
      page.finished = true;
      page.running = false;
      page.endedAt = payload.endedAt || (page.mode === "replay" ? null : Date.now());
      if (payload.outputFile) page.outputFile = payload.outputFile;
      const { summary } = director.finish(payload);
      const stopped = payload.status === "STOPPED";
      const failed = director.model.run.fatal.length || (!stopped && payload.code);
      // Announce the outcome only once the office has caught up with the log.
      const announce = () => {
        if (page.mode === "replay") setStatus("ok", "Replay finished");
        else if (stopped) setStatus("partial", "Stopped");
        else if (failed) setStatus("false", "Failed");
        else setStatus("ok", summary ? `Done · ${summary.passRate}% pass` : "Done");
      };
      if (stopped || !director.isBusy()) announce();
      else director.whenIdle().then(announce);
      syncControls();
      scheduleDrawer();
      renderHud();
    }

    /* ----- live source ----- */

    let eventSource = null;

    function connectLive() {
      if (eventSource) return;
      setStatus("", "Connecting");
      eventSource = new EventSource("/api/eval/stream");
      eventSource.onmessage = (event) => {
        let payload;
        try { payload = JSON.parse(event.data); } catch { return; }
        if (page.mode !== "live") return;

        if (payload.type === "status") {
          if (payload.status === "RUNNING") {
            page.running = true;
            setStatus("live", "Running");
          } else if (!page.running && !page.finished) {
            setStatus("", "Idle");
          }
          syncControls();
          return;
        }

        if (payload.type === "replay") {
          // Joined mid-run (or after one): rebuild from the log, then catch up silently.
          resetPage(true);
          director.setSilent(true);
          for (const entry of payload.lines || []) director.ingest(entry.line, entry.stream, null);
          director.setSilent(false);
          const tally = director.model.tally();
          scene.restore(director.slots, { OK: tally.OK, PARTIAL: tally.PARTIAL, FALSE: tally.FALSE, ERROR: tally.ERROR });
          page.startedAt = payload.startedAt || null;
          page.running = !payload.exit;
          if (!payload.exit) setStatus("live", "Running");
          if (payload.exit) finishRun(payload.exit);
          syncControls();
          renderHud();
          return;
        }

        if (payload.type === "log") {
          if (page.finished) resetPage(true);
          if (!page.running) { page.running = true; setStatus("live", "Running"); syncControls(); }
          ingest(payload.line, payload.stream, Date.now());
          return;
        }

        if (payload.type === "exit") finishRun(payload);
      };
      eventSource.onerror = () => {
        if (page.mode === "live") setStatus("partial", "Reconnecting");
      };
    }

    function disconnectLive() {
      if (eventSource) eventSource.close();
      eventSource = null;
    }

    /* ----- replay source ----- */

    const replay = createReplaySource({
      line: (entry) => ingest(entry.l, entry.s, entry.t),
      busy: () => director.isBusy(),
      end: () => {
        finishRun({ status: "DONE", summary: director.model.run.summary, code: 0 });
        syncControls();
      },
    });

    async function loadReplay(name) {
      disconnectLive();
      replay.cancel();
      page.mode = "replay";
      page.replayName = name;
      resetPage(true);
      setStatus("", "Loading log");
      let data;
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(name)}/log`);
        data = await res.json();
      } catch (err) {
        setStatus("false", "Could not load log");
        return;
      }
      if (!data.lines || !data.lines.length) {
        els.emptyText.textContent = "This run has no saved log, so it cannot be replayed.";
        els.empty.classList.remove("hidden");
        setStatus("partial", "No log saved");
        syncControls();
        return;
      }
      replay.load(data.lines.map((l) => ({ t: l.t, s: l.s, l: l.l })));
      page.startedAt = replay.t0;
      scene.setClock(replay.speed);
      setStatus("live", "Replaying");
      page.paused = false;
      scene.pause(false);
      replay.play();
      syncControls();
    }

    /* ----- controls ----- */

    function syncControls() {
      const replaying = page.mode === "replay";
      els.speed.classList.toggle("hidden", !replaying);
      els.play.classList.toggle("hidden", !replaying);
      els.restart.classList.toggle("hidden", !replaying);
      els.stop.classList.toggle("hidden", !(page.mode === "live" && page.running));
      els.playLabel.textContent = page.paused ? "Resume" : "Pause";
      for (const b of els.speed.querySelectorAll("button")) {
        b.setAttribute("aria-pressed", String(Number(b.dataset.speed) === replay.speed));
      }
    }

    els.mode.addEventListener("change", () => {
      const value = els.mode.value;
      replay.cancel();
      if (value === "live") {
        page.mode = "live";
        page.replayName = null;
        page.paused = false;
        scene.pause(false);
        scene.setClock(1);
        resetPage(true);
        disconnectLive();
        connectLive();
        syncControls();
      } else {
        loadReplay(value);
      }
    });

    els.speed.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-speed]");
      if (!b) return;
      replay.setSpeed(Number(b.dataset.speed));
      scene.setClock(replay.speed);
      syncControls();
    });

    els.play.addEventListener("click", () => {
      page.paused = !page.paused;
      scene.pause(page.paused);
      if (page.paused) replay.pause(); else replay.play();
      syncControls();
    });

    els.restart.addEventListener("click", () => {
      if (page.replayName) loadReplay(page.replayName);
    });

    els.stop.addEventListener("click", async () => {
      els.stop.disabled = true;
      try {
        const res = await fetch("/api/eval/stop", { method: "POST" });
        if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      } catch (err) {
        Judy.toast(`Stop failed: ${err.message}`, "warn");
      } finally {
        els.stop.disabled = false;
      }
    });

    els.fs.addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    });

    async function loadRunList() {
      try {
        const res = await fetch("/api/runs");
        const data = await res.json();
        for (const run of data.runs || []) {
          if (!/\.json$|\.xlsx$/i.test(run.name)) continue;
          const opt = document.createElement("option");
          opt.value = run.name;
          const rate = run.summary && run.summary.passRate != null ? ` · ${run.summary.passRate}%` : "";
          const when = run.mtimeMs ? new Date(run.mtimeMs).toLocaleString() : run.name;
          opt.textContent = `Replay ${when}${rate}`;
          els.mode.appendChild(opt);
        }
      } catch { /* the live view still works without the list */ }
    }

    const wanted = new URLSearchParams(location.search).get("run");
    loadRunList().then(() => {
      if (wanted && Array.from(els.mode.options).some((o) => o.value === wanted)) {
        els.mode.value = wanted;
        loadReplay(wanted);
      }
    });
    if (!wanted) connectLive();

    syncControls();
    renderHud();
    root.JudyLive.page = { scene, director, replay, state: page };
  }

  /* Called by the module entry in live.html with the 3D scene factory. */
  JudyLive.boot = function boot(createScene) {
    if (!hasDom) return Promise.resolve();
    if (document.readyState === "loading") {
      return new Promise((resolve) => {
        document.addEventListener("DOMContentLoaded", () => resolve(bootPage(createScene)));
      });
    }
    return bootPage(createScene);
  };
})(typeof window !== "undefined" ? window : globalThis);
