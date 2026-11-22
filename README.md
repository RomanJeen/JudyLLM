# Pola Evals

Runs each question from a file in `input/` through the local Pola backend, lets the judge continue short clarification flows when needed, judges the final agent answer against `תשובה עדכנית פולה` with Claude Haiku 5.5 on AWS Bedrock (`eu.anthropic.claude-haiku-5-5`), and writes a timestamped JSON report under `runs/`. Excel, CSV, or JSON downloads are generated from that file only when requested.

## Setup

```bash
cd evals
npm install
cp .env.example .env
```

Fill `.env` with the same `AWS_*` values used by `askpola-backend/.env`.

Set `EVAL_TARGET=local` or `EVAL_TARGET=dev` to choose credentials from `LOCAL_*` / `DEV_*` in `.env`. Set `CLIENT_ID` to send that client ID for every target; it wins over the per-target keys. Leave it empty to keep the old `LOCAL_API_KEY` / `DEV_API_KEY` behavior.

For local runs the backend must be reachable at `LOCAL_BACKEND_URL`. For remote/dev runs use `npm run eval:dev` (uses `DEV_BACKEND_URL` + `DEV_API_KEY`, unless `CLIENT_ID` is set).

Multi-turn evals require the backend to be running with PostgresSaver enabled, which is the default startup config. If running with an in-memory checkpointer, set `JUDGE_MAX_AGENT_TURNS=1` to force single-turn mode.

The eval runner processes up to `CONCURRENCY=2` questions at the same time by default. The Judy UI exposes this as **Parallel** and max agent turns as **Max turns** under the collapsed **Advanced** section. CLI runs still read `CONCURRENCY` and `JUDGE_MAX_AGENT_TURNS` from `.env`. Chat POSTs are spaced by `STAGGER_MS` (default 3000ms) so sustained traffic stays under AskPola's ~20/min dev quota. Each question gets its own chat session (a server-issued token on AskPola, or a legacy `eval-*` id on backends without `POST /api/v1/agent/session`). `DELAY_MS` is not used by the parallel eval runner. Set `STAGGER_MS=0` to send chats as soon as a worker is ready.

Set `CHAT_SESSION_MODE=auto` (default), `required`, or `off` if you need to force session minting or the old no-token path.

If the backend returns `HTTP 429`, the active question waits and retries inside its worker slot instead of failing immediately or allowing the runner to start another question. Tune this with `AGENT_MAX_RETRIES`, `AGENT_RETRY_BASE_MS`, and `AGENT_RETRY_MAX_MS`.

## Run

### From the browser

```bash
npm run ui
```

Open http://127.0.0.1:8787. The first card, **What to judge**, holds a named Judy scenario from `prompts/` (starts with `default.md`). Pick a scenario, edit the prompt, then Save or Save as new. Then pick an input `.xlsx` / `.csv` from `input/`, choose an agent and environment (Pola or Mitve Miluim on local, dev, or stg; each one sends its own client ID to its own backend), or use 'Other' for another project's backend URL and client ID, optionally open Advanced to set a row limit and concurrency, then press Start run. Logs stream the scenario name plus a short sha256. The **Previous runs** list can be filtered by input file, judge prompt, and endpoint (the `EVAL_TARGET` the run used, or the URL for custom backends); runs saved before this was recorded get it from their `.log.jsonl` when available. To download a report, pick a format (Excel, CSV, or JSON) next to the run and click Download; Copy path and Delete live in the run's ... menu. Clicking a run card opens its report. Excel downloads include a `Judge Prompt` sheet with the scenario name and exact prompt used.

### Live view

Open http://127.0.0.1:8787/live (or press **Watch live** next to **Current run**) to watch a run as a 3D isometric office (three.js, no build step). The tested agent is a hologram robot on a raised pod, labelled with the agent and environment (for example "Mitve Miluim · dev"), with a floating screen that shows typing dots, "429", or the final pass rate. There is one Judy judge per **Parallel** slot: a chunky mini character in a black robe with its own accent colour and a gavel. Each judge takes a question to the agent, waits at the pod (a judge that hits HTTP 429 queues at the door with a countdown), carries the answer back to a desk with a pile of documents, reads it, and either writes a follow-up note and walks back to the agent or stamps the verdict (OK, PARTIAL or FALSE) and sends the sheet to one of four outbox bins. An ERROR shows a smoke puff and a torn page. When the run ends the judges walk to the front, confetti flies, and the pod shows the pass rate.

The camera auto-fits 1 to 32 judges. You can orbit a little, scroll to zoom, and press **Reset view** to go back. Art is CC0 (Kenney Mini Characters and Furniture Kit) plus Microsoft Fluent Emoji (MIT), committed under `public/assets/` with credits in `public/assets/LICENSES.md`. `three` is the only runtime npm dependency of the page; the server serves it from `node_modules` under `/vendor/three/`. The page needs WebGL.

The page is view-only apart from a **Stop run** button. It follows the same stream as the console, so it can be opened in the middle of a run and catches up. Hover a judge to read the question (right-to-left text is handled), click a judge or desk for the question's timeline, findings, and a link to the report. The source picker above the scene replays any past run that has a saved `.log.jsonl` at 1x, 4x, or 16x, so you can see the office without sending traffic to the backend. `/live?run=<file>.json` opens a replay directly. If the OS asks for reduced motion, the scene shows states without travel animation.

### From the CLI

Small smoke run:

```bash
npm run eval:limit
```

Full run:

```bash
npm run eval
```

Each run writes a new JSON file holding the run metadata, judge prompt, summary, and every row:

```text
runs/judged-YYYY-MM-DD-HHmmss.json
```

Rows are written in the original input order even if later questions finish first. The `#` column uses the original question number from the input slice. The file is checkpointed every 10 completed rows and marked `"complete": true` when the run finishes.

To convert a run without the UI:

```bash
npm run export -- judged-YYYY-MM-DD-HHmmss.json --format xlsx   # or csv / json
```

Older runs saved as `judged-*.xlsx` (with a `.meta.json` sidecar) still show in the UI and can be downloaded in any format.

## Multi-turn Behavior

Each CSV row gets one chat session. On AskPola that is a server-issued `sessionId` plus `x-pola-session-token`. On backends without `POST /api/v1/agent/session`, the runner falls back to a generated `eval-*` id. If Pola answers with a clarifying question, the judge returns `NEEDS_FOLLOWUP` plus a short candidate reply, and the runner sends that reply back to the backend with the same session.

`JUDGE_MAX_AGENT_TURNS` controls the cap. It defaults to `4`; set it to `1` to restore the previous strict single-turn behavior. If the cap is reached, the judge force-grades Pola's latest assistant message against the expected answer.

Clarification turns may trigger backend tool calls and analytics rows just like real production chats. Legacy eval traffic keeps the `eval-` prefix so it can be filtered or cleaned up later. Example cleanup shape:

```sql
-- Adjust table names/foreign keys to match the local database before running.
DELETE FROM session_analytics WHERE session_id LIKE 'eval-%';
```

## Prompts

Named Judy scenarios live in `prompts/` as `.md` files. `default.md` is the built-in judge rules. `advice-flow.md` grades the undecided-candidate advice interview (fork in the first two Pola replies, then a field recommendation that fits hidden interest tags). Selecting `advice-flow` in the UI prefills `advice-flow-scenarios.csv`, concurrency 2, and max turns 12. The UI dropdown lists those files; **Save** writes the current scenario, **Save as** creates a new one. CLI runs can still override with `JUDGE_SYSTEM_PROMPT` and optionally tag the run with `JUDGE_PROMPT_NAME`.

`pola-v3.md` grades the quality of Pola's answers and the candidate experience instead of agreement with the expected answer. It treats the old expected answer only as a topic hint and never penalises missing items or time-sensitive facts (registration status, dates, thresholds). It has no feedback rules, so use it with the feedback toggle off.

**Send human feedback to judge** (UI toggle in the **What to judge** card, off by default, remembered in the browser) controls whether each row's human feedback note is included in the judge input. Off removes the feedback block and relabels the expected answer as an outdated reference. CLI runs use `JUDGE_INCLUDE_FEEDBACK=0` to turn it off; unset means on. The setting is stored in the run's `meta.humanFeedback`, runs with it off get the `feedback-off` tag, and the Excel `Judge Prompt` sheet states it. Runs from before the toggle count as feedback on. Compare runs only when the toggle and prompt match.

## Inputs

Put eval datasets in `input/`. The runner and UI pick files by basename (`INPUT_FILE=pola_test_rag.xlsx`).

The script reads these columns from the input `.xlsx` / `.csv`:

- `שאלה` (or `input`) — sent to the agent and shown to the judge as the question.
- `תשובה` (or `תשובה עדכנית פולה`) — expected answer used as the strict ground truth.
- `מקור / ציטוט` (or `הערות עילם ורויטל`) — optional notes shown to the judge as context. The judge should use them only when they contain concrete correctness information, not as ground truth by default.

Other columns are ignored. See `input/input_example.csv` for the preferred header names.

## Output Columns

- `#`
- `Question`
- `Expected`
- `Human Feedback`
- `Final Agent Answer`
- `Transcript`
- `Turns`
- `Verdict` (`OK`, `PARTIAL`, `FALSE`, or `ERROR`). `PARTIAL` means the core answer is right but one or two key facts are missing or vague.
- `Explanation`

The Excel export is RTL-friendly, freezes the header, and color-codes verdict cells. The CSV export has the same columns and a UTF-8 BOM so Hebrew opens correctly in Excel.
