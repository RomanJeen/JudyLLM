/* JUDY shared UI runtime: theme, motion, chart theming, text/markdown helpers,
   findings parsing and the eval log model. Plain script, exposes window.Judy. */
(function (root) {
  "use strict";

  const Judy = (root.Judy = root.Judy || {});
  const hasDom = typeof document !== "undefined";

  /* ---------- text + markdown ---------- */

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function textHtml(raw, query) {
    const escaped = escapeHtml(raw);
    const q = String(query || "").trim();
    if (!q) return escaped;
    const re = new RegExp(escapeRegExp(escapeHtml(q)), "gi");
    return escaped.replace(re, (m) => `<mark>${m}</mark>`);
  }

  function safeHref(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
    } catch {
      return null;
    }
    return null;
  }

  function linkHtml(href, label, query) {
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${textHtml(label, query)}</a>`;
  }

  function renderInline(raw, query) {
    const text = String(raw ?? "");
    const re = /(\*\*[^*]+\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s<]+)/g;
    let html = "";
    let last = 0;
    let match;
    while ((match = re.exec(text))) {
      html += textHtml(text.slice(last, match.index), query);
      if (match[0].startsWith("**")) {
        html += `<strong>${textHtml(match[0].slice(2, -2), query)}</strong>`;
      } else if (match[0].startsWith("[")) {
        const href = safeHref(match[3]);
        html += href ? linkHtml(href, match[2], query) : textHtml(match[0], query);
      } else {
        const trimmed = match[0].replace(/[),.;]+$/, "");
        const trailing = match[0].slice(trimmed.length);
        const href = safeHref(trimmed);
        html += href ? linkHtml(href, trimmed, query) + textHtml(trailing, query) : textHtml(match[0], query);
      }
      last = re.lastIndex;
    }
    return html + textHtml(text.slice(last), query);
  }

  function isHeadingLine(line) {
    const trimmed = line.trim();
    return trimmed.length > 1 && trimmed.length <= 48 && /[:：]$/.test(trimmed) && !/^https?:/.test(trimmed);
  }

  function renderMarkdown(raw, options = {}) {
    const { headings = false, query = "" } = options;
    const lines = String(raw ?? "").split(/\r?\n/);
    const blocks = [];
    let list = [];
    let para = [];

    const flushPara = () => {
      if (!para.length) return;
      const text = para.join("\n").trim();
      if (text) blocks.push(`<p>${renderInline(text, query).replace(/\n/g, "<br>")}</p>`);
      para = [];
    };
    const flushList = () => {
      if (!list.length) return;
      blocks.push(`<ul>${list.map((item) => `<li>${renderInline(item, query)}</li>`).join("")}</ul>`);
      list = [];
    };

    for (const line of lines) {
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushList();
        flushPara();
        blocks.push("<hr>");
        continue;
      }
      const heading = line.match(/^\s*#{1,6}\s+(.+)/);
      if (heading || (headings && isHeadingLine(line))) {
        flushList();
        flushPara();
        const text = heading ? heading[1] : line.trim().replace(/[:：]$/, "");
        blocks.push(`<h4>${renderInline(text, query)}</h4>`);
        continue;
      }
      const listMatch = line.match(/^\s*(?:[-*]|•|\d+[.)])\s+(.+)/);
      if (listMatch) {
        flushPara();
        list.push(listMatch[1]);
        continue;
      }
      if (!line.trim()) {
        flushList();
        flushPara();
        continue;
      }
      flushList();
      para.push(line);
    }
    flushList();
    flushPara();
    return blocks.join("") || `<p class="lead">—</p>`;
  }

  /* ---------- verdicts + findings ---------- */

  const VERDICTS = ["OK", "PARTIAL", "FALSE", "ERROR"];

  const ISSUE_TYPES = {
    contra: { he: "סתירה", en: "contradicts", cls: "t-contra" },
    missing: { he: "חסר", en: "missing", cls: "t-missing" },
    partial: { he: "חלקי", en: "partial", cls: "t-partial" },
    added: { he: "הוסיף", en: "added", cls: "t-added" },
    note: { he: "הערה", en: "note", cls: "t-note" },
    error: { he: "שגיאה", en: "error", cls: "t-error" },
  };
  const ISSUE_ORDER = ["contra", "missing", "partial", "added", "note", "error"];
  const PREFIX_TO_TYPE = { "חסר": "missing", "חלקי": "partial", "הוסיף": "added", "סתירה": "contra" };

  function verdictBucket(verdict) {
    const normalized = String(verdict || "").trim().toUpperCase();
    return VERDICTS.includes(normalized) ? normalized : "ERROR";
  }

  function verdictClass(verdict) {
    return verdictBucket(verdict).toLowerCase();
  }

  function classifyFinding(text) {
    const match = text.match(/^(חסר|חלקי|הוסיף|סתירה)\s*[:：\-–—]?\s*([\s\S]*)$/);
    if (match) return { type: PREFIX_TO_TYPE[match[1]], text: match[2].trim() || text };
    return { type: "note", text };
  }

  function isNoIssue(finding) {
    return finding.type === "note" && /^אין בעיות מהותיות\.?$/.test(finding.text);
  }

  function parseFindings(row) {
    const raw = String(row?.explanation ?? "").trim();
    if (!raw) return [];

    if (verdictBucket(row.verdict) === "ERROR") {
      return [{ type: "error", text: raw.replace(/^error\s*:\s*/i, "") }];
    }

    let items = null;
    if (raw.startsWith("[")) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) items = parsed;
      } catch {
        items = null;
      }
    }

    if (!items) {
      const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const bulleted = lines.filter((line) => /^(?:[-*•]|\d+[.)])\s+/.test(line));
      if (bulleted.length && bulleted.length === lines.length) {
        items = lines.map((line) => line.replace(/^(?:[-*•]|\d+[.)])\s+/, ""));
      } else {
        items = [raw];
      }
    }

    return items
      .map((item) => classifyFinding(String(item).trim()))
      .filter((item) => item.text && !isNoIssue(item));
  }

  function countFindings(findings) {
    const counts = {};
    for (const finding of findings) counts[finding.type] = (counts[finding.type] || 0) + 1;
    return counts;
  }

  function parseTranscript(raw) {
    const text = String(raw ?? "").trim();
    if (!text) return [];
    const turns = [];
    for (const part of text.split(/\n\n+/)) {
      const match = part.match(/^(מועמד|פולה)\s*:\s*([\s\S]*)$/);
      if (match) turns.push({ speaker: match[1], text: match[2] });
      else if (turns.length) turns[turns.length - 1].text += `\n\n${part}`;
      else turns.push({ speaker: "", text: part });
    }
    return turns;
  }

  function findingsHtml(findings, { query = "", emptyText = "אין בעיות מהותיות" } = {}) {
    if (!findings.length) {
      return `<ul class="finding-list"><li class="finding"><span class="finding-type t-note">✓<small>clean</small></span><div class="finding-text" dir="auto">${textHtml(emptyText, query)}</div></li></ul>`;
    }
    return `<ul class="finding-list">${findings
      .map((finding) => {
        const info = ISSUE_TYPES[finding.type] || ISSUE_TYPES.note;
        return `<li class="finding"><span class="finding-type ${info.cls}">${info.he}<small>${info.en}</small></span><div class="finding-text md" dir="auto">${renderMarkdown(finding.text, { query })}</div></li>`;
      })
      .join("")}</ul>`;
  }

  function findingMinis(counts) {
    return ["contra", "missing", "partial", "added"]
      .filter((type) => counts[type])
      .map((type) => `<span class="mini ${ISSUE_TYPES[type].cls}">${counts[type]} ${ISSUE_TYPES[type].he}</span>`)
      .join("");
  }

  /* ---------- formatting ---------- */

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  }

  /* ---------- icons ---------- */

  const ICONS = {
    play: `<polygon points="6 3 20 12 6 21 6 3" fill="currentColor"/>`,
    stop: `<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>`,
    save: `<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>`,
    download: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>`,
    trash: `<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>`,
    copy: `<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`,
    more: `<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>`,
    "chevron-down": `<path d="m6 9 6 6 6-6"/>`,
    "chevron-up": `<path d="m18 15-6-6-6 6"/>`,
    "chevron-left": `<path d="m15 18-6-6 6-6"/>`,
    "chevron-right": `<path d="m9 18 6-6-6-6"/>`,
    "arrow-left": `<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>`,
    refresh: `<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>`,
    sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>`,
    moon: `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`,
    file: `<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/>`,
    external: `<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`,
    edit: `<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>`,
    activity: `<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`,
    list: `<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>`,
    eye: `<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>`,
    expand: `<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>`,
    collapse: `<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>`,
    search: `<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`,
    check: `<path d="M20 6 9 17l-5-5"/>`,
    inbox: `<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>`,
    chart: `<path d="M3 3v18h18"/><path d="M7 15v3M12 9v9M17 5v13"/>`,
  };

  function icon(name) {
    return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  }

  /* ---------- overflow menu ---------- */

  let openMenu = null;

  function closeOpenMenu() {
    if (openMenu) openMenu.close();
  }

  // items: array, or a function returning an array, of
  // { label, icon, onClick, href, danger, disabled } | { separator: true }
  function menu(button, items) {
    if (!hasDom || !button) return null;
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    let el = null;

    function close({ focus = false } = {}) {
      if (!el) return;
      el.remove();
      el = null;
      button.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
      if (openMenu === api) openMenu = null;
      if (focus) button.focus();
    }

    const onOutside = (event) => {
      if (el && !el.contains(event.target) && !button.contains(event.target)) close();
    };
    // Keep the menu attached to its button while the page scrolls or resizes.
    const onReflow = (event) => {
      if (!el) return;
      if (event && event.target && el.contains(event.target)) return;
      const rect = button.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        close();
        return;
      }
      place();
    };

    function place() {
      const rect = button.getBoundingClientRect();
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      let top = rect.bottom + 6;
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }
    const onKey = (event) => {
      if (!el) return;
      const entries = [...el.querySelectorAll(".menu-item:not(:disabled)")];
      const at = entries.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        close({ focus: true });
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        entries[(at + 1) % entries.length]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        entries[(at - 1 + entries.length) % entries.length]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        entries[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        entries[entries.length - 1]?.focus();
      } else if (event.key === "Tab") {
        close();
      }
    };

    function open() {
      closeOpenMenu();
      const list = typeof items === "function" ? items() : items;
      el = document.createElement("div");
      el.className = "menu";
      el.setAttribute("role", "menu");
      for (const item of list.filter(Boolean)) {
        if (item.separator) {
          const sep = document.createElement("div");
          sep.className = "menu-sep";
          sep.setAttribute("role", "separator");
          el.appendChild(sep);
          continue;
        }
        const node = document.createElement(item.href ? "a" : "button");
        node.className = `menu-item${item.danger ? " danger" : ""}`;
        node.setAttribute("role", "menuitem");
        if (item.href) node.href = item.href;
        else node.type = "button";
        if (item.disabled) node.disabled = true;
        node.innerHTML = `${item.icon ? icon(item.icon) : ""}<span>${escapeHtml(item.label)}</span>`;
        node.addEventListener("click", () => {
          close();
          if (typeof item.onClick === "function") item.onClick();
        });
        el.appendChild(node);
      }
      document.body.appendChild(el);

      place();

      button.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", onOutside, true);
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("resize", onReflow);
      window.addEventListener("scroll", onReflow, true);
      el.querySelector(".menu-item:not(:disabled)")?.focus();
    }

    const api = { close, open };
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (el) close();
      else {
        open();
        openMenu = api;
      }
    });
    return api;
  }

  /* ---------- confirm dialog + toast ---------- */

  let dialogSeq = 0;

  function confirmDialog({ title, body = "", detail = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = {}) {
    if (!hasDom || typeof root.HTMLDialogElement === "undefined") {
      return Promise.resolve(Boolean(root.confirm && root.confirm([title, detail, body].filter(Boolean).join("\n\n"))));
    }
    return new Promise((resolve) => {
      const dlg = document.createElement("dialog");
      const titleId = `dlg-title-${++dialogSeq}`;
      dlg.className = "dlg";
      dlg.setAttribute("aria-labelledby", titleId);
      dlg.innerHTML = `
        <form method="dialog" class="dlg-card">
          <h2 id="${titleId}">${escapeHtml(title)}</h2>
          ${detail ? `<code class="dlg-detail">${escapeHtml(detail)}</code>` : ""}
          ${body ? `<p>${escapeHtml(body)}</p>` : ""}
          <div class="dlg-actions">
            <button type="submit" value="cancel" class="btn" data-cancel>${escapeHtml(cancelLabel)}</button>
            <button type="submit" value="ok" class="btn ${danger ? "btn-danger" : "btn-primary"}">${escapeHtml(confirmLabel)}</button>
          </div>
        </form>`;
      dlg.addEventListener("close", () => {
        const ok = dlg.returnValue === "ok";
        dlg.remove();
        resolve(ok);
      });
      dlg.addEventListener("click", (event) => {
        if (event.target === dlg) dlg.close("cancel");
      });
      document.body.appendChild(dlg);
      dlg.showModal();
      dlg.querySelector("[data-cancel]")?.focus();
    });
  }

  function toast(message, tone = "") {
    if (!hasDom) return;
    let host = document.querySelector(".toast-host");
    if (!host) {
      host = document.createElement("div");
      host.className = "toast-host";
      host.setAttribute("role", "status");
      document.body.appendChild(host);
    }
    const node = document.createElement("div");
    node.className = `toast${tone ? ` ${tone}` : ""}`;
    node.textContent = message;
    host.appendChild(node);
    setTimeout(() => node.remove(), 2700);
  }

  async function deleteRun(name) {
    const confirmed = await confirmDialog({
      title: "Delete this run?",
      detail: name,
      body: "The report, its log and its metadata are removed from runs/. This cannot be undone.",
      confirmLabel: "Delete run",
      danger: true,
    });
    if (!confirmed) return false;
    const res = await fetch(`/api/runs/${encodeURIComponent(name)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(`Delete failed: ${data.error || `HTTP ${res.status}`}`, "error");
      return false;
    }
    return true;
  }

  function stepHtml(step, startedAt) {
    const at = startedAt != null && step.at != null ? `+${formatDuration(step.at - startedAt)}` : "";
    const row = (cls, what, detail, detailCls = "") =>
      `<li${cls ? ` class="${cls}"` : ""}><span class="dot"></span><span class="what">${what}</span><span class="detail${detailCls}">${detail}</span><span class="at">${at}</span></li>`;
    switch (step.kind) {
      case "agent":
        return row("agent", `Agent · t${step.turn}`, `replied ${Number(step.chars).toLocaleString()} chars`);
      case "followup":
        return row("followup", "Follow-up", `<span dir="auto">${escapeHtml(step.text)}</span>`, " read");
      case "retry":
        return row("retry", "HTTP 429", `retry ${step.attempt}/${step.of} in ${formatDuration(step.delayMs)}`);
      case "verdict":
        return row(`verdict-${verdictClass(step.verdict)}`, "Judge", escapeHtml(step.verdict));
      case "error":
        return row("error", `${escapeHtml(step.stage)} error`, escapeHtml(step.text));
      default:
        return row("", "Note", escapeHtml(step.text));
    }
  }

  function formatTime(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
  }

  /* ---------- choice dialog ---------- */

  // choices: [{ label, value, tone: "primary" | "danger" | "", cancel?: boolean }]
  // Resolves with the chosen `value`, or null when dismissed (Esc, backdrop click).
  function choiceDialog({ title, body = "", detail = "", choices = [] } = {}) {
    if (!hasDom || typeof root.HTMLDialogElement === "undefined") return Promise.resolve(null);
    return new Promise((resolve) => {
      const dlg = document.createElement("dialog");
      const titleId = `dlg-title-${++dialogSeq}`;
      dlg.className = "dlg";
      dlg.setAttribute("aria-labelledby", titleId);
      const buttons = choices
        .map((choice, i) => {
          const tone = choice.tone === "primary" ? "btn-primary" : choice.tone === "danger" ? "btn-danger" : "";
          return `<button type="submit" value="${i}" class="btn ${tone}"${choice.cancel ? " data-cancel" : ""}>${escapeHtml(choice.label)}</button>`;
        })
        .join("");
      dlg.innerHTML = `
        <form method="dialog" class="dlg-card">
          <h2 id="${titleId}">${escapeHtml(title)}</h2>
          ${detail ? `<code class="dlg-detail">${escapeHtml(detail)}</code>` : ""}
          ${body ? `<p>${escapeHtml(body)}</p>` : ""}
          <div class="dlg-actions">${buttons}</div>
        </form>`;
      dlg.addEventListener("close", () => {
        const choice = choices[Number(dlg.returnValue)];
        dlg.remove();
        resolve(dlg.returnValue !== "" && choice ? choice.value : null);
      });
      dlg.addEventListener("click", (event) => {
        if (event.target === dlg) dlg.close("");
      });
      document.body.appendChild(dlg);
      dlg.showModal();
      (dlg.querySelector("[data-cancel]") || dlg.querySelector("button"))?.focus();
    });
  }

  /* ---------- run cards, tags and filters (console + reports page) ---------- */

  function runStatus(run) {
    if (run?.partial) return "Partial";
    if (run?.complete === false) return "Running";
    return "Complete";
  }

  function runFilterValue(run, key) {
    if (key === "status") return runStatus(run);
    return run?.meta?.[key] || "";
  }

  function runTagValues(run) {
    const tags = [];
    const inputFile = run?.meta?.inputFile || "";
    const promptName = run?.meta?.promptName || "";
    if (inputFile) tags.push({ key: "inputFile", value: inputFile });
    if (promptName && promptName !== inputFile) tags.push({ key: "promptName", value: promptName });
    const endpoint = run?.meta?.endpoint || "";
    if (endpoint) tags.push({ key: "endpoint", value: endpoint, title: run?.meta?.backendUrl || "" });
    return tags;
  }

  // With `onToggle` the tags are filter buttons; without it they are plain labels.
  function renderRunTags(container, run, { selected = null, onToggle = null } = {}) {
    const tags = runTagValues(run);
    container.innerHTML = "";
    if (!tags.length) {
      container.classList.add("hidden");
      return;
    }
    container.classList.remove("hidden");
    for (const tag of tags) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "run-tag";
      button.textContent = tag.value;
      if (!onToggle) {
        button.classList.add("static");
        button.tabIndex = -1;
        button.title = tag.title || tag.value;
      } else {
        if (selected?.[tag.key]?.has(tag.value)) button.classList.add("active");
        button.title = tag.title ? `Filter by ${tag.value} (${tag.title})` : `Filter by ${tag.value}`;
        button.addEventListener("click", () => onToggle(tag.key, tag.value));
      }
      container.appendChild(button);
    }
  }

  function appendCount(parent, className, text) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    parent.appendChild(span);
  }

  function renderRunCounts(summary) {
    const counts = document.createElement("div");
    counts.className = "run-counts";
    counts.append(`${summary.total} rows · `);
    appendCount(counts, "ok", `${summary.ok} OK`);
    counts.append(" · ");
    appendCount(counts, "partial", `${summary.partial ?? 0} PARTIAL`);
    counts.append(" · ");
    appendCount(counts, "false", `${summary.false} FALSE`);
    counts.append(" · ");
    appendCount(counts, "error", `${summary.error} ERROR`);
    return counts;
  }

  function renderMiniBar(summary) {
    const bar = document.createElement("div");
    bar.className = "minibar";
    const total = summary.total || 0;
    for (const key of ["ok", "partial", "false", "error"]) {
      const n = summary[key] || 0;
      if (!n || !total) continue;
      const seg = document.createElement("span");
      seg.style.width = `${(n / total) * 100}%`;
      seg.style.background = `var(--${key})`;
      bar.appendChild(seg);
    }
    return bar;
  }

  async function copyPath(path, button) {
    const value = String(path || "").trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const input = document.createElement("textarea");
      input.value = value;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.left = "-9999px";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    if (button) {
      const original = button.dataset.label || button.textContent;
      button.dataset.label = original;
      button.textContent = "Copied";
      root.setTimeout(() => { button.textContent = button.dataset.label; }, 1200);
    }
    toast("Path copied to clipboard");
  }

  function partialLabel(run) {
    const done = run.summary?.total ?? 0;
    return run.plannedTotal ? `Partial · ${done} of ${run.plannedTotal}` : `Partial · ${done} rows`;
  }

  function renderRunCard(run, { selected = null, onToggle = null, onDelete = null } = {}) {
    const li = document.createElement("li");
    li.className = `run-card${run.partial ? " is-partial" : ""}`;

    const rate = document.createElement("div");
    rate.className = `run-rate${run.summary ? "" : " none"}`;
    if (run.summary) {
      rate.append(document.createTextNode(`${run.summary.passRate}%`));
      const unit = document.createElement("span");
      unit.className = "unit";
      unit.textContent = "pass rate";
      rate.appendChild(unit);
    } else {
      rate.textContent = "—";
    }

    const main = document.createElement("div");
    main.className = "run-main";
    const name = document.createElement("div");
    name.className = "run-name";
    const link = document.createElement("a");
    link.className = "run-link";
    link.href = `/report?run=${encodeURIComponent(run.name)}`;
    link.textContent = run.name;
    link.title = `Open report for ${run.name}`;
    name.appendChild(link);
    const status = runStatus(run);
    if (status !== "Complete") {
      const state = document.createElement("span");
      state.className = "run-state";
      const pill = document.createElement("span");
      pill.className = `pill ${status === "Partial" ? "partial" : "accent"}`;
      pill.textContent = status === "Partial" ? partialLabel(run) : status;
      pill.title = status === "Partial"
        ? "Stopped before every question was judged. Only the judged rows are saved."
        : "This run is still in progress";
      state.appendChild(pill);
      name.appendChild(state);
    }
    main.appendChild(name);

    const sub = document.createElement("div");
    sub.className = "run-sub";
    const mtime = document.createElement("span");
    mtime.textContent = formatTime(run.mtime);
    sub.appendChild(mtime);
    if (run.summary) sub.appendChild(renderRunCounts(run.summary));
    main.appendChild(sub);
    if (run.summary) main.appendChild(renderMiniBar(run.summary));

    const tags = document.createElement("div");
    tags.className = "run-tags";
    renderRunTags(tags, run, { selected, onToggle });
    if (!tags.classList.contains("hidden")) main.appendChild(tags);

    const actions = document.createElement("div");
    actions.className = "run-actions";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "btn btn-ghost btn-sm btn-icon";
    more.innerHTML = icon("more");
    more.setAttribute("aria-label", `More actions for ${run.name}`);
    more.title = "More actions";
    menu(more, () => [
      { label: "Open report", icon: "file", href: `/report?run=${encodeURIComponent(run.name)}` },
      run.path ? { label: "Copy file path", icon: "copy", onClick: () => copyPath(run.path, null) } : null,
      { separator: true },
      { label: "Delete run", icon: "trash", danger: true, onClick: () => onDelete?.(run.name) },
    ]);
    actions.append(downloadControl(run.name, { small: true }), more);

    li.append(rate, main, actions);
    return li;
  }

  // Filterable list of run cards. Filters are Status, File, Prompt and Endpoint.
  const RUN_FILTER_ROWS = [
    ["status", "Status"],
    ["inputFile", "File"],
    ["promptName", "Prompt"],
    ["endpoint", "Endpoint"],
  ];

  function createRunBrowser({ listEl, filtersEl, countEl = null, emptyEl = null, onDelete = null } = {}) {
    const selected = Object.fromEntries(RUN_FILTER_ROWS.map(([key]) => [key, new Set()]));
    let runs = [];

    function valuesFor(key) {
      const values = [...new Set(runs.map((run) => runFilterValue(run, key)).filter(Boolean))];
      return key === "status" ? values.sort().reverse() : values.sort((a, b) => a.localeCompare(b));
    }

    function toggle(key, value) {
      if (selected[key].has(value)) selected[key].delete(value);
      else selected[key].add(value);
      render();
    }

    function matches(run) {
      return RUN_FILTER_ROWS.every(([key]) => !selected[key].size || selected[key].has(runFilterValue(run, key)));
    }

    function filterButton(key, value) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "run-tag";
      if (selected[key].has(value)) button.classList.add("active");
      button.textContent = value;
      button.title = `Show runs tagged ${value}`;
      button.addEventListener("click", () => toggle(key, value));
      return button;
    }

    function renderFilters() {
      filtersEl.innerHTML = "";
      let any = false;
      for (const [key, label] of RUN_FILTER_ROWS) {
        const values = valuesFor(key);
        // A single status value is not worth a filter row.
        if (!values.length || (key === "status" && values.length < 2 && !selected.status.size)) continue;
        any = true;
        const row = document.createElement("div");
        row.className = "run-filter-row";
        const name = document.createElement("span");
        name.className = "run-filter-label";
        name.textContent = label;
        row.appendChild(name);
        for (const value of values) row.appendChild(filterButton(key, value));
        filtersEl.appendChild(row);
      }
      filtersEl.classList.toggle("hidden", !any);
    }

    function render() {
      for (const [key] of RUN_FILTER_ROWS) {
        const present = new Set(valuesFor(key));
        for (const value of [...selected[key]]) if (!present.has(value)) selected[key].delete(value);
      }
      renderFilters();
      const visible = runs.filter(matches);
      if (countEl) countEl.textContent = runs.length ? `${visible.length} of ${runs.length}` : "";
      listEl.innerHTML = "";
      for (const run of visible) listEl.appendChild(renderRunCard(run, { selected, onToggle: toggle, onDelete: remove }));
      if (emptyEl) {
        emptyEl.textContent = runs.length ? "No reports match these filters." : "No reports yet. Finished runs are saved here automatically.";
        emptyEl.classList.toggle("hidden", visible.length > 0);
      }
    }

    async function remove(name) {
      if (onDelete && !(await onDelete(name))) return;
      runs = runs.filter((run) => run.name !== name);
      render();
    }

    return {
      setRuns(next) { runs = Array.isArray(next) ? next : []; render(); },
    };
  }

  /* ---------- eval log model ---------- */

  const PREFIX_RE = /^\[\s*(\d+)\s*\/\s*(\d+)\s*\]\s?(.*)$/;

  function createLogModel() {
    const model = {
      total: 0,
      questions: new Map(),
      run: {
        fields: {},
        fatal: [],
        notes: [],
        summary: null,
        file: "",
        startedAt: null,
      },
      completions: [],
      collecting: null,
    };

    function question(n, now) {
      let q = model.questions.get(n);
      if (!q) {
        q = {
          n,
          text: "",
          status: "waiting",
          turn: 0,
          maxTurns: Number(model.run.fields.maxTurns) || 0,
          verdict: "",
          explanation: "",
          findings: [],
          counts: {},
          steps: [],
          retries: 0,
          startedAt: null,
          endedAt: null,
        };
        model.questions.set(n, q);
      }
      if (now != null && q.startedAt == null && q.status === "waiting") q.startedAt = now;
      return q;
    }

    function finish(q, verdict, explanation, now) {
      q.verdict = verdict;
      q.explanation = explanation || "";
      q.status = verdict === "ERROR" ? "error" : "done";
      q.endedAt = now;
      q.findings = parseFindings({ verdict, explanation: q.explanation });
      q.counts = countFindings(q.findings);
      if (now != null) model.completions.push(now);
    }

    function ingestQuestion(q, rest, now) {
      let m;
      if (/^Skipping empty input/i.test(rest)) {
        q.status = "skipped";
        q.endedAt = now;
        return;
      }
      if ((m = rest.match(/^turn\s+(\d+)\s*\/\s*(\d+):\s*agent\s*->\s*(\d+)\s*chars/i))) {
        q.turn = Number(m[1]);
        q.maxTurns = Number(m[2]);
        q.status = "judging";
        q.steps.push({ kind: "agent", turn: q.turn, chars: Number(m[3]), at: now });
        return;
      }
      if ((m = rest.match(/^agent\s*->\s*HTTP\s+429,\s*retry\s+(\d+)\s*\/\s*(\d+)\s+in\s+(\d+)ms/i))) {
        q.retries += 1;
        q.steps.push({ kind: "retry", attempt: Number(m[1]), of: Number(m[2]), delayMs: Number(m[3]), at: now });
        return;
      }
      if ((m = rest.match(/^judge\s*->\s*NEEDS_FOLLOWUP\s*\|\s*user\s*->\s*(.*)$/i))) {
        q.status = "agent";
        q.steps.push({ kind: "followup", text: m[1], at: now });
        return;
      }
      if ((m = rest.match(/^judge\s*->\s*(OK|PARTIAL|FALSE)\b(?:\s*-\s*([\s\S]*))?$/i))) {
        finish(q, m[1].toUpperCase(), m[2] || "", now);
        q.steps.push({ kind: "verdict", verdict: q.verdict, at: now });
        model.collecting = q;
        return;
      }
      if ((m = rest.match(/^(session|agent|judge)\s*->\s*(ERROR|FATAL)\b\s*[-:]?\s*([\s\S]*)$/i))) {
        const message = m[3].replace(/^(?:ERROR|judge error)\s*:\s*/i, "").trim();
        finish(q, "ERROR", `ERROR: ${message || m[2]}`, now);
        q.fatal = m[2].toUpperCase() === "FATAL";
        q.stage = m[1].toLowerCase();
        q.steps.push({ kind: "error", stage: q.stage, text: message, at: now });
        return;
      }
      if (!q.text) {
        q.text = rest.trim();
        q.status = "agent";
        if (q.startedAt == null) q.startedAt = now;
        return;
      }
      if (rest.trim()) q.steps.push({ kind: "note", text: rest.trim(), at: now });
    }

    function ingestRun(line, stream, now) {
      const run = model.run;
      const trimmed = line.trim();
      let m;
      if ((m = trimmed.match(/^Loaded\s+(\d+)\s+questions\s+from\s+(.+?)\s+\(running\s+(\d+)\)/i))) {
        run.fields.loaded = Number(m[1]);
        run.fields.input = m[2];
        model.total = Math.max(model.total, Number(m[3]));
        if (run.startedAt == null) run.startedAt = now;
        return "run";
      }
      if ((m = trimmed.match(/^Target:\s*(.+)$/i))) { run.fields.target = m[1]; return "run"; }
      if ((m = trimmed.match(/^Backend:\s*(.+)$/i))) { run.fields.backend = m[1]; return "run"; }
      if ((m = trimmed.match(/^Concurrency:\s*(\d+)/i))) { run.fields.concurrency = Number(m[1]); return "run"; }
      if ((m = trimmed.match(/^Max agent turns per row:\s*(\d+)/i))) { run.fields.maxTurns = Number(m[1]); return "run"; }
      if ((m = trimmed.match(/^Judge prompt:\s*(.+?)\s*\((\d+)\s*chars,\s*sha256:([0-9a-f]+)\)/i))) {
        run.fields.prompt = m[1];
        run.fields.promptChars = Number(m[2]);
        run.fields.promptSha = m[3];
        return "run";
      }
      if ((m = trimmed.match(/^Human feedback to judge:\s*(on|off)\b/i))) { run.fields.humanFeedback = m[1].toLowerCase(); return "run"; }
      if ((m = trimmed.match(/^File:\s+(.+\.(?:json|xlsx))\s*$/i))) { run.file = m[1]; return "run"; }
      const summary = parseDoneLine(trimmed);
      if (summary) { run.summary = summary; return "run"; }
      if (/^(Fatal error|spawn error)/i.test(trimmed)) {
        run.fatal.push(trimmed);
        return "run";
      }
      if (!trimmed) return null;
      const tone = stream === "stderr" || /\b(fail|failed|error)\b/i.test(trimmed) ? "warn" : "";
      run.notes.push({ text: trimmed, tone, at: now });
      return "run";
    }

    model.ingest = function ingest(line, stream = "stdout", now = Date.now()) {
      const text = String(line ?? "");
      const m = text.match(PREFIX_RE);
      if (m) {
        model.collecting = null;
        const n = Number(m[1]);
        model.total = Math.max(model.total, Number(m[2]));
        const q = question(n, null);
        ingestQuestion(q, m[3], now);
        return { q: n };
      }

      if (model.collecting) {
        if (!text.trim()) {
          model.collecting = null;
          return { q: null, run: false };
        }
        const q = model.collecting;
        q.explanation = q.explanation ? `${q.explanation}\n${text}` : text;
        q.findings = parseFindings({ verdict: q.verdict, explanation: q.explanation });
        q.counts = countFindings(q.findings);
        return { q: q.n };
      }

      return { q: null, run: ingestRun(text, stream, now) === "run" };
    };

    model.interrupt = function interrupt(reason, now = Date.now()) {
      const touched = [];
      for (const q of model.questions.values()) {
        if (q.status !== "agent" && q.status !== "judging") continue;
        q.stage = "run";
        q.steps.push({ kind: "error", stage: "run", text: reason, at: now });
        finish(q, "ERROR", reason, now);
        touched.push(q.n);
      }
      return touched;
    };

    model.tally = function tally() {
      const counts = { OK: 0, PARTIAL: 0, FALSE: 0, ERROR: 0, running: 0, waiting: 0, skipped: 0, done: 0 };
      for (let n = 1; n <= model.total; n += 1) {
        const q = model.questions.get(n);
        if (!q || q.status === "waiting") counts.waiting += 1;
        else if (q.status === "skipped") { counts.skipped += 1; counts.done += 1; }
        else if (q.status === "done" || q.status === "error") {
          counts[verdictBucket(q.verdict)] += 1;
          counts.done += 1;
        } else counts.running += 1;
      }
      return counts;
    };

    return model;
  }

  function parseDoneLine(line) {
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

  /* ---------- theme ---------- */

  const THEME_KEY = "judy-theme";

  function cssVar(name) {
    if (!hasDom) return "";
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  const themeListeners = new Set();

  const theme = {
    get() {
      return (hasDom && document.documentElement.dataset.theme) || "light";
    },
    set(next) {
      if (!hasDom) return;
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
      for (const fn of themeListeners) fn(next);
    },
    onChange(fn) {
      themeListeners.add(fn);
      return () => themeListeners.delete(fn);
    },
    mountToggle(button) {
      if (!button) return;
      const sync = () => {
        const dark = theme.get() === "dark";
        button.setAttribute("aria-pressed", dark ? "false" : "true");
        button.title = dark ? "Switch to light theme" : "Switch to dark theme";
        button.innerHTML = dark ? `${icon("sun")}<span>Light theme</span>` : `${icon("moon")}<span>Dark theme</span>`;
      };
      button.addEventListener("click", () => {
        theme.set(theme.get() === "dark" ? "light" : "dark");
        sync();
      });
      sync();
    },
  };

  /* ---------- motion (GSAP, optional) ---------- */

  const reduceMotion =
    hasDom && typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function gsapReady() {
    return !reduceMotion && hasDom && typeof root.gsap !== "undefined";
  }

  const motion = {
    get enabled() {
      return gsapReady();
    },
    reveal(nodes, opts = {}) {
      if (!gsapReady() || !nodes) return;
      const list = Array.from(nodes.length != null ? nodes : [nodes]).filter(Boolean);
      if (!list.length) return;
      root.gsap.from(list, {
        opacity: 0,
        y: opts.y ?? 14,
        duration: opts.duration ?? 0.55,
        stagger: opts.stagger ?? 0.06,
        ease: "power3.out",
        clearProps: "opacity,transform",
      });
    },
    count(el, to, opts = {}) {
      if (!el) return;
      const decimals = opts.decimals ?? 0;
      const suffix = opts.suffix ?? "";
      const format = (v) => `${Number(v).toFixed(decimals)}${suffix}`;
      const target = Number(to);
      if (!gsapReady() || !Number.isFinite(target)) {
        el.textContent = Number.isFinite(target) ? format(target) : String(to);
        return;
      }
      const from = Number(el.dataset.countValue ?? 0);
      const state = { v: Number.isFinite(from) ? from : 0 };
      el.dataset.countValue = String(target);
      root.gsap.to(state, {
        v: target,
        duration: opts.duration ?? 0.9,
        ease: "power2.out",
        onUpdate: () => { el.textContent = format(state.v); },
      });
    },
    flash(el, signal = "accent") {
      if (!gsapReady() || !el) return;
      const color = cssVar(`--${signal}`) || cssVar("--accent");
      const soft = /^#[0-9a-f]{6}$/i.test(color) ? `${color}66` : color;
      root.gsap.fromTo(
        el,
        { boxShadow: `0 0 0 4px ${soft}` },
        { boxShadow: `0 0 0 0px transparent`, duration: 1.1, ease: "power2.out", clearProps: "boxShadow" },
      );
    },
    fillCell(el) {
      if (!gsapReady() || !el) return;
      root.gsap.fromTo(el, { scale: 0.3 }, { scale: 1, duration: 0.4, ease: "back.out(3)", clearProps: "transform" });
    },
  };

  /* ---------- charts (Chart.js, optional) ---------- */

  const charts = {
    get available() {
      return hasDom && typeof root.Chart !== "undefined";
    },
    signal(name) {
      return cssVar(`--${name}`);
    },
    applyDefaults() {
      if (!charts.available) return;
      const C = root.Chart;
      C.defaults.font.family = cssVar("--f-ui") || "Rubik, system-ui, sans-serif";
      C.defaults.font.size = 12;
      C.defaults.color = cssVar("--muted");
      C.defaults.borderColor = cssVar("--hair");
      C.defaults.plugins.legend.display = false;
      C.defaults.plugins.tooltip.backgroundColor = cssVar("--raised");
      C.defaults.plugins.tooltip.borderColor = cssVar("--hair-strong");
      C.defaults.plugins.tooltip.borderWidth = 1;
      C.defaults.plugins.tooltip.titleColor = cssVar("--text");
      C.defaults.plugins.tooltip.bodyColor = cssVar("--text-soft");
      C.defaults.plugins.tooltip.cornerRadius = 6;
      C.defaults.animation.duration = reduceMotion ? 0 : 700;
    },
    instances: new Set(),
    track(chart, retheme) {
      charts.instances.add({ chart, retheme });
      return chart;
    },
    untrack(chart) {
      for (const entry of charts.instances) {
        if (entry.chart === chart) charts.instances.delete(entry);
      }
    },
  };

  theme.onChange(() => {
    charts.applyDefaults();
    for (const { chart, retheme } of charts.instances) {
      if (typeof retheme === "function") retheme(chart);
      chart.update("none");
    }
  });

  /* ---------- small DOM helpers ---------- */

  function startClock(el) {
    if (!el) return;
    const tick = () => {
      el.textContent = new Date().toLocaleTimeString([], { hour12: false });
    };
    tick();
    setInterval(tick, 1000);
  }

  /* ---------- report download ---------- */

  const DOWNLOAD_FORMATS = [
    ["xlsx", "Excel"],
    ["csv", "CSV"],
    ["json", "JSON"],
  ];
  const DOWNLOAD_FORMAT_KEY = "judy-download-format";

  function storedDownloadFormat() {
    try {
      const value = localStorage.getItem(DOWNLOAD_FORMAT_KEY);
      if (DOWNLOAD_FORMATS.some(([id]) => id === value)) return value;
    } catch { /* storage unavailable */ }
    return "xlsx";
  }

  function downloadUrl(runName, format) {
    return `/api/runs/${encodeURIComponent(runName)}/download?format=${encodeURIComponent(format)}`;
  }

  function downloadControl(runName, { small = false } = {}) {
    const wrap = document.createElement("span");
    wrap.className = `download-control${small ? " sm" : ""}`;

    const select = document.createElement("select");
    select.setAttribute("aria-label", "Download format");
    for (const [id, label] of DOWNLOAD_FORMATS) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = storedDownloadFormat();

    const link = document.createElement("a");
    link.className = `btn${small ? " btn-sm" : ""}`;
    link.innerHTML = `${icon("download")}<span>Download</span>`;

    const sync = () => {
      link.href = downloadUrl(wrap.dataset.run || "", select.value);
    };
    select.addEventListener("change", () => {
      try { localStorage.setItem(DOWNLOAD_FORMAT_KEY, select.value); } catch { /* storage unavailable */ }
      sync();
    });

    wrap.setRun = (name) => {
      wrap.dataset.run = name || "";
      sync();
    };
    wrap.setRun(runName);
    wrap.append(select, link);
    return wrap;
  }

  Object.assign(Judy, {
    escapeHtml,
    textHtml,
    safeHref,
    renderInline,
    renderMarkdown,
    VERDICTS,
    ISSUE_TYPES,
    ISSUE_ORDER,
    verdictBucket,
    verdictClass,
    classifyFinding,
    parseFindings,
    countFindings,
    parseTranscript,
    findingsHtml,
    findingMinis,
    plural,
    formatDuration,
    formatTime,
    stepHtml,
    deleteRun,
    icon,
    menu,
    confirmDialog,
    choiceDialog,
    renderRunTags,
    renderRunCard,
    createRunBrowser,
    copyPath,
    toast,
    createLogModel,
    parseDoneLine,
    theme,
    motion,
    charts,
    cssVar,
    startClock,
    downloadUrl,
    downloadControl,
  });

  if (hasDom) charts.applyDefaults();
})(typeof window !== "undefined" ? window : globalThis);
