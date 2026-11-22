# Evals Pipeline — LLM-as-a-Judge Plan

**Status:** Approved, ready to implement
**Date:** 2026-05-11
**Owner:** Roman

---

## 1. Goal

Extend the eval pipeline so that for every question in `inputs.csv`:

1. The production agent (`POST /api/v1/agent/chat`) is queried.
2. Its answer is compared to the expected answer (`תשובה עדכנית פולה`) by a **judge LLM** — Claude Haiku 5.5 via AWS Bedrock.
3. The result is appended to a **per-run Excel sheet** with columns:
   `# | Question | Expected Answer | Agent Answer | Verdict (OK/FALSE) | Explanation`.

End-to-end runs from a single command: `npm run eval`.

---

## 2. Locked Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Judge model & creds | **AWS Bedrock**, reuse existing `AWS_*` env (`eu.anthropic.claude-haiku-5-5`). No new API key. |
| 2 | Script topology | **Single end-to-end script** — agent call + judge call inline per row. |
| 3 | Strictness | **Strict (3a)**. Judge sees only question, expected answer, agent answer. **Rubric notes (`פידבק בן גוריון`) are ignored.** |
| 4 | Output file | **Timestamped per run**, written to `evals/runs/judged-YYYY-MM-DD-HHmm.xlsx`. |
| 5 | Intermediate `outputs.csv` | **Skipped.** Single command does it all. The legacy `outputs.csv` is no longer written. |

---

## 3. Architecture

```
┌────────────────┐
│  inputs.csv    │  Q + תשובה עדכנית פולה
└──────┬─────────┘
       │  for each row:
       ▼
┌──────────────────┐    HTTP SSE     ┌────────────────────┐
│  Agent caller    │ ─────────────► │  Pola backend      │
│  (existing code) │ ◄───────────── │  /agent/chat       │
└──────┬───────────┘   agent answer └────────────────────┘
       │
       ▼
┌──────────────────┐   Bedrock       ┌────────────────────┐
│  Judge caller    │ ─────────────► │  Haiku 5.5         │
│  (new)           │ ◄───────────── │  (eu region)       │
└──────┬───────────┘   {verdict,     └────────────────────┘
       │               explanation}
       ▼
┌──────────────────┐
│  Excel writer    │  appends row, saves every 10 rows
│  (new)           │
└──────┬───────────┘
       ▼
   runs/judged-2026-05-11-1730.xlsx
```

Sequential execution — one question at a time — to keep within agent rate limits and preserve the existing `DELAY_MS` throttle.

---

## 4. File Changes

| File | Action | Purpose |
|------|--------|---------|
| `evals/run-eval.mjs` | **Rewrite** | Now orchestrates agent → judge → Excel per row. Drops `outputs.csv` write. |
| `evals/judge.mjs` | **New** | Bedrock client + judge prompt + JSON-strict parsing. |
| `evals/excel-writer.mjs` | **New** | `exceljs`-based incremental writer with header styling, conditional formatting (green=OK, red=FALSE), summary row. |
| `evals/package.json` | **Edit** | Add `@aws-sdk/client-bedrock-runtime` and `exceljs`. Add `eval` script. |
| `evals/.env.example` | **New** | Document all env vars. |
| `evals/.gitignore` | **New** | Ignore `runs/`, `outputs.csv`, `.env`, `node_modules/`. |
| `evals/README.md` | **New** | Quick-start: install, set env, `npm run eval`. |
| `evals/runs/` | **New dir** | Created on first run. Holds per-run `.xlsx` files. |

`outputs.csv` is left in place as a historical artifact but is no longer produced.

---

## 5. Inputs Contract

`run-eval.mjs` reads only two columns from `inputs.csv`:

| Column header (Hebrew) | Internal name | Used for |
|------------------------|---------------|----------|
| `input` | `question` | Sent to agent + shown to judge |
| `תשובה עדכנית פולה` | `expected` | Shown to judge as ground truth |

All other columns (`פידבק בן גוריון`, `שאלת המשך`, `תשובת פולה`, `הערות עילם ורויטל`) are **ignored** per strict-mode decision.

---

## 6. Judge Contract

### Inputs to judge
```
{question}    — the user's question
{expected}    — the ground-truth answer (תשובה עדכנית פולה)
{agent}       — what the production agent returned
```

### Required output (JSON only, no prose)
```json
{
  "verdict": "OK" | "FALSE",
  "explanation": "string"
}
```

- `verdict = "OK"` → agent answer is **semantically equivalent** to expected. `explanation` may be empty.
- `verdict = "FALSE"` → agent answer differs in meaning, omits key facts, or contradicts the expected answer. `explanation` must be 1–3 sentences in Hebrew explaining the gap.

### Judge configuration
- Model: `eu.anthropic.claude-haiku-5-5` (resolved at runtime — see §10)
- Temperature: not sent by default. Haiku 5.5 rejects it; set `JUDGE_TEMPERATURE` only for older models. If a model rejects it, the judge retries without it.
- Max tokens: `1536`
- Response format: enforced JSON via prompt + `JSON.parse` with one repair retry.
- On parse failure twice → row gets `verdict = "ERROR"`, `explanation = "judge returned non-JSON"`.

### System prompt (strict mode)

> You are a senior content reviewer for the "Pola" admissions assistant at Ben-Gurion University. You will be given a candidate's question, the expected answer, and the agent's actual answer. Decide whether the agent's answer is semantically equivalent to the expected answer.
>
> Rules:
> - Ignore differences in wording, formatting, length, or order of points if the meaning is the same.
> - Mark `OK` only when the agent's answer covers all the substantive facts in the expected answer and contradicts none of them.
> - Mark `FALSE` if the agent omits, adds, or contradicts a substantive fact.
> - Reply in Hebrew when explaining.
> - Reply with **only** a JSON object: `{"verdict": "OK" | "FALSE", "explanation": "..."}`. No markdown, no prose around the JSON.

---

## 7. Excel Output

**Path:** `evals/runs/judged-<YYYY-MM-DD-HHmm>.xlsx`
**Sheet name:** `Eval`
**RTL:** sheet `views[0].rightToLeft = true` so Hebrew renders correctly.

### Layout

| Row | Content |
|-----|---------|
| 1 | Title row: `Pola Eval — <ISO timestamp>` (merged across A:F, bold, 14pt) |
| 2 | Summary row: `Total: N · OK: X · FALSE: Y · Errors: Z · Pass rate: P%` (merged A:F) |
| 3 | Header: `# \| Question \| Expected \| Agent \| Verdict \| Explanation` (bold, gray fill, frozen) |
| 4..N | Data rows |

### Column widths
`#` = 6, `Question` = 50, `Expected` = 60, `Agent` = 60, `Verdict` = 12, `Explanation` = 50. All cells `wrapText: true`, `vertical: top`.

### Conditional formatting on `Verdict`
- `OK` → green fill (`#C6EFCE`), dark-green text (`#006100`).
- `FALSE` → red fill (`#FFC7CE`), dark-red text (`#9C0006`).
- `ERROR` → orange fill (`#FFEB9C`), brown text (`#9C5700`).

### Persistence
- Save the workbook **after every 10 rows** and again at the end. A crash mid-run leaves a partial but openable `.xlsx`.
- The summary row (row 2) is rewritten on every save with running totals.

---

## 8. Resilience

| Failure mode | Behaviour |
|--------------|-----------|
| Agent HTTP error / SSE parse error | Row recorded with `Agent Answer = "ERROR: <msg>"`, `Verdict = "ERROR"`, judge skipped for that row. |
| Judge Bedrock error | Row recorded with `Verdict = "ERROR"`, `Explanation = "judge error: <msg>"`. |
| Judge returns non-JSON | One repair retry (re-prompt with "respond with valid JSON only"). On second failure → `Verdict = "ERROR"`. |
| Process killed mid-run | Last saved `.xlsx` is openable, includes all completed rows + summary. |
| Empty `input` cell | Skipped, not counted in totals. |

---

## 9. Configurable Env Vars

```bash
# Agent (existing)
BACKEND_URL=http://localhost:4000
API_KEY=test123
DELAY_MS=1500
LIMIT=0                  # 0 = run all rows; >0 = run first N rows

# Judge (new) — reuse backend AWS creds
AWS_REGION=eu-west-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=       # optional

JUDGE_MODEL=eu.anthropic.claude-haiku-5-5
JUDGE_TEMPERATURE=
JUDGE_MAX_TOKENS=1536
```

`evals/.env.example` documents all of these. `run-eval.mjs` loads `.env` via `node --env-file=.env` (or `dotenv` if needed).

---

## 10. Bedrock Model ID Resolution

The exact Haiku 5.5 model ID for `eu-west-1` is verified at script startup:

1. Try the configured `JUDGE_MODEL`.
2. If the first invocation returns `ValidationException` for unknown model, log the error verbatim and exit with a clear message: `"Set JUDGE_MODEL to a valid Bedrock model ID for region $AWS_REGION (see Bedrock console → Model access)."`

This avoids hard-coding a model ID that may differ slightly per AWS account / region access.

---

## 11. New `package.json` Scripts

```json
{
  "scripts": {
    "eval": "node --env-file=.env run-eval.mjs",
    "eval:limit": "LIMIT=5 node --env-file=.env run-eval.mjs"
  }
}
```

`eval:limit` runs the first 5 questions — useful for sanity-checking the pipeline (~30 seconds) before kicking off a full run.

---

## 12. Console Output (per row)

```
[ 1/235] אני חושב שאני אוהב מתמטיקה פוליטיקה וממש...
   agent  → 1842 chars
   judge  → OK
[ 2/235] מתי מתחילה ההרשמה?
   agent  → 612 chars
   judge  → FALSE — חסר תאריך התחלה ספציפי, התשובה כללית מדי
...
Saved checkpoint: runs/judged-2026-05-11-1730.xlsx (10 rows)
...
Done. 235 rows · 198 OK · 35 FALSE · 2 ERROR · 84.3% pass rate
File: evals/runs/judged-2026-05-11-1730.xlsx
```

---

## 13. Acceptance Criteria

A successful implementation satisfies all of:

- [ ] `npm run eval:limit` (LIMIT=5) completes end-to-end in under 90 seconds against a running backend.
- [ ] An `.xlsx` file is created at `evals/runs/judged-<timestamp>.xlsx`.
- [ ] The file opens in Excel / Numbers / Google Sheets with Hebrew rendering correctly (RTL).
- [ ] Header row is frozen, `Verdict` cells are color-coded (green/red/orange).
- [ ] Summary row at top shows correct counts and pass rate.
- [ ] Killing the process mid-run leaves a partial but openable `.xlsx` containing all completed rows.
- [ ] An invalid `JUDGE_MODEL` produces the clear error message described in §10, not a stack trace.
- [ ] No `outputs.csv` is written by the new script.

---

## 14. Out of Scope (explicitly deferred)

- Multi-turn evals (follow-up question column `שאלת המשך` is ignored).
- Rubric-aware judging (`פידבק בן גוריון` is ignored — strict-mode decision).
- Concurrent agent calls (kept sequential to respect rate limits).
- Diff-style reporting between two runs.
- Web dashboard.

---

## 15. Implementation Steps

1. `npm install @aws-sdk/client-bedrock-runtime exceljs` in `evals/`.
2. Create `evals/judge.mjs` — Bedrock client + `judge({question, expected, agent})` function.
3. Create `evals/excel-writer.mjs` — `createWorkbook()`, `appendRow()`, `save()`, `finalize()`.
4. Rewrite `evals/run-eval.mjs` — main loop wiring agent → judge → writer.
5. Add `evals/.env.example`, `evals/.gitignore`, `evals/README.md`.
6. Run `LIMIT=5 npm run eval` against the local backend; verify the `.xlsx` against the acceptance criteria.
7. Run full eval (`npm run eval`).

---

## 16. v2 Addendum — Multi-turn Judge

The eval runner now supports agent-driven clarification flows without changing the backend:

- One `eval-*` `sessionId` is generated per CSV row and reused across all turns for that row.
- The judge returns `OK`, `PARTIAL`, `FALSE`, or `NEEDS_FOLLOWUP`. `PARTIAL` means the core answer is right but one or two key facts are missing or vague. `NEEDS_FOLLOWUP` includes a short candidate `userReply` that is sent back to Pola with the same `sessionId`.
- `JUDGE_MAX_AGENT_TURNS` defaults to `4`. Setting it to `1` restores single-turn behavior.
- When the cap is reached, the judge force-grades Pola's latest assistant message against `תשובה עדכנית פולה`.
- Excel output remains one row per CSV input and adds `Final Agent Answer`, `Transcript`, and `Turns`.
- The curated `שאלת המשך-במידה ויש` / `תשובת פולה` columns remain out of scope for this iteration.
