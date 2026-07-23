# spec_v1.md (v1.1) — Agent Analytics Dashboard (your build, Claude Code first)

Phase 1 deliverable. This specs *your* reimplementation, not the reference. It follows the pragmatic-blueprint approach we agreed: inherit what the reference does well, fix the two gaps that are cheap and defensibility-critical, cut or defer everything that doesn't move the interview. Every feature below has been run through the verifiability check. No LLM-as-judge. No metric that isn't backed by a field in the logs.

## Decisions locked (v1.1)

The nine flagged decisions are ruled on. Headlines:

- **The product has one thesis — "Where did your tokens go?"** — a deterministic **token-allocation** view (surviving work / reworked-corrected / abandoned / navigation-reasoning). This replaces the undefensible "productivity score." It is not a collapsed opaque score; it is an auditable breakdown where every slice traces to specific `requestId`s and events. This is the centerpiece and the portfolio thesis.
- **No composite score of any kind.** The allocation is a breakdown, not a single number.
- **`userModified` is the crown-jewel signal** (ground-truth human correction); the English correction regex is **cut** from v1.
- **Stack:** Node.js ESM, zero runtime deps. **UI:** thin but real, hard-timeboxed to the allocation view + a session drill-down. **Plan comparison:** kept but demoted and relabelled as price arbitrage, never the headline.
- Full ruling on all nine is in *Decisions* at the bottom.

Two facts, verified against your real `~/.claude` transcript (a real 1,081-line Claude Code transcript), shape this spec and are the spine of its eval story:

1. **Token dedupe.** Claude Code splits one assistant response across multiple JSONL lines and stamps the *same* `usage` on each. Your file: 485 assistant lines, 258 unique `requestId`s. Naive per-line summing (what the reference does) inflates input+cache by **1.88×** and output by **2.29×**. We dedupe by `requestId`. This is a ground-truth correctness fix, not a heuristic.
2. **Better edit data.** Real files carry `toolUseResult.structuredPatch` (the actual applied diff), `originalFile`, and `userModified` (did the human have to change the agent's edit). The reference ignores all of it and parses tool *arguments* instead. We use the structured data, and `userModified` becomes a ground-truth rework signal.

---

## Goal

A developer on a Claude Code subscription can see, from the transcripts already on their disk and with no account connection, one honest thing above all: **where their tokens actually went** — what fraction of spend produced work that survived to the end of the session, versus what was reworked, corrected, abandoned, or spent navigating. Around that centerpiece it reports how many tokens the work consumed, what it would have cost at on-demand prices versus the plan, and the individual thrash signals that make up the allocation — each defined transparently and traceable to specific events. The tool never claims the work was "good" or assigns a productivity score; value is unknowable from logs. It measures **retention** — did the work stick — which is deterministic, and leaves the judgment of worth to the person who can see the actual code.

---

## v1 scope: Claude Code only

**In scope:** discovery + parsing of `~/.claude/projects/*/*.jsonl`; deduped token accounting; API-equivalent cost with honest coverage; code-change reconstruction from `structuredPatch`; the **token-allocation centerpiece** (surviving / reworked-corrected / abandoned / navigation) with its component thrash signals; a plan-cost comparison labelled as price arbitrage and demoted; rule-based, traceable usage guidance; a CLI with machine-readable output and a `CLAUDE.md`; a thin, hard-timeboxed read-only UI (allocation view + session drill-down).

**Explicitly deferred (named so scope can't creep):**
- Codex, OpenClaw, Hermes, and any cross-agent scoreboard. (v1 is single-agent; a "head-to-head" across agents with different token-accounting semantics is an apples-to-oranges trap we're not opening yet.)
- Sub-agent / Task sidechain reconstruction. Your file has `isSidechain: false` throughout, so we have **no** real fixture to validate it. Deferred and marked unvalidated.
- "Wrapped" slides, punch-card/heatmap, streaks, records — copy-later polish, zero interview value.
- Any composite "productivity," "risk," or "waste" *score*. The token-allocation is a breakdown, not a score — every slice is auditable. Line-level edit survival (git-blame-style) is v2; v1 retention is file-level.
- Persisted database. Compute-on-demand + a cached parse and an emitted snapshot artifact is enough for v1.

---

## The verifiability check, applied to your original brief

Your kickoff asked for five things. Here's each one, run through the check, with the honest verdict.

| You asked for | Verdict | What we build instead / how |
|---|---|---|
| Tokens used | **Deterministic** | Sum `usage`, deduped by `requestId`. Recompute against raw file. |
| Usage against plan | **Deterministic**, but relabelled | API-equivalent cost vs your plan spend. Reported as *price arbitrage* ("you'd have paid $X on-demand for a $Y plan"), **not** "ROI" or "value." |
| A defensible measure of how productive the work was | **Reframed — value cut, retention kept** | No productivity *score*. Instead, the **token-allocation view**: retention is deterministic (did the work survive vs get reworked/corrected/abandoned) and answers "productive?" in the only honest sense — output that stuck. Not a composite; an auditable breakdown. See decision #3. |
| Whether tokens are being wasted | **Proxy-heuristic, organized as allocation** | The waste signals *are* the non-surviving buckets of the allocation. Each from one log field, each defined and traceable. No composite score. |
| Concrete guidance on better usage | **Derived, rule-based** | Threshold rules over the allocation buckets. Each note names the signal that triggered it and is traceable to the underlying events. Not LLM-generated. |

The hard "no" is **value-as-a-number** — whether the code was good. That's unknowable from logs and an interviewer would dismantle it. The reframe is **retention**: value is unmeasurable, but *survival* is deterministic. "What fraction of your tokens produced work that lasted?" is a defensible question with a ground-truth answer, and it's a sharper product than either a fake productivity score or a bare list of thrash counts. That reframe is the exceptional-but-feasible core of this build.

---

## Feature list (tagged, with data source and verification method)

### Deterministic features

**D1 — Token accounting (deduped).**
Source: `assistant` lines → `message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`, deduped by `requestId` (one usage per request). Verify: a standalone script recomputes deduped totals directly from the raw file; the parser must match it exactly, and must be measurably below the naive per-line sum (regression guard that dedupe is live). Hand-audit one `requestId`.

**D2 — API-equivalent cost.**
Source: deduped tokens × per-bucket rates from an editable `pricing.json` (regex model match; separate fresh-input / cache-read / cache-write / output rates). Unknown model → unpriced, and it lowers a visible coverage %. Verify: assert cost = deduped-tokens × rate for `claude-sonnet-5` in your file; assert an unknown model stays `null` and drops coverage.

**D3 — Code-change reconstruction.**
Source: `toolUseResult.structuredPatch` (primary) → additions/deletions/hunks per `filePath`; fall back to tool-argument parsing (`Edit`/`Write` old/new strings) only when `structuredPatch` is absent or empty. Record `userModified` per edit. Verify: hand-count one real edit's added/removed lines and assert; report where structured-derived and argument-derived counts diverge. **Label honestly:** this is "lines/files changed," never "impact" or "value." Line volume is not worth; boilerplate inflates it; we say so in the UI.

**D4 — Plan-cost comparison (price arbitrage).**
Source: D2 total vs a user-entered monthly plan cost (stored locally; default noted, not assumed). Reported as "API-equivalent $X for a $Y plan" — a price statement. Verify: arithmetic assertion. No "value"/"ROI"/"return" wording anywhere.

**D5 — Cache efficiency.**
Source: `cache_read_input_tokens ÷ total input tokens` (deduped). Deterministic and doubles as a waste signal (low cache reuse = context re-sent = tokens spent re-establishing state). Verify: recompute from raw file.

**D6 — Activity basics.**
Source: timestamps (present on all user + assistant lines in your file), tool counts, files/directories touched. Per-day tokens/cost/edits, session durations. Verify: recompute counts from the raw file.

### The centerpiece — Token-allocation ("Where did your tokens go?")

The product's thesis. Deduped tokens (D1) are attributed by `requestId` to an **outcome bucket** and reported as an allocation. It is a breakdown, not a score: every bucket names its rule and links to its events.

**Attribution granularity (stated honestly):** tokens are tagged per `requestId`, not per edit. A request's whole token cost is assigned to the outcome of the edit(s) it produced; requests with no edit are navigation/reasoning. This is *request-granularity*, labelled as such in the UI.

**The four buckets:**

- **Surviving** — tokens on requests whose edits were *not* later superseded, corrected, or abandoned. The work that stuck.
- **Reworked / corrected** — tokens on edits later re-edited in the same file (component **A1**, same-file rework: `edits − 1` per file) **or** flagged `userModified === true` (component **A2**, the ground-truth human-correction signal — the crown jewel).
- **Abandoned** — tokens in user-started, non-live sessions whose last event isn't an assistant message (component **A3**).
- **Navigation & reasoning** — tokens on requests that produced no edit: reads (including repeated reads of the same `filePath`, component **A4**), Bash, thinking. Not "waste" per se, but the cost of getting to an edit; surfaced so re-fetch thrash is visible.

Plus one standalone thrash counter shown alongside (not a token bucket, because a failed call may still have produced tokens counted elsewhere):

- **A5 — Failed-tool retries:** a `tool_result` with `is_error` (or Bash non-zero exit) followed by another call to the same tool.

**Verification:** each component gets a constructed fixture with a known answer (A1 two-edit → 1; A2 constructed `userModified:true`; A3 abandoned-session case; A4 repeated-read case; A5 error-then-retry case) **and** a real-file spot-check. The allocation itself is verified by an invariant: the four buckets' tokens sum exactly to D1's deduped total (no tokens lost or double-assigned).

**Fallback (pre-planned, so attribution risk can't sink the timeline):** if request-granularity token attribution proves too noisy to defend, the *same four buckets* are reported in **edits and changed-lines** instead of tokens. Same thesis, trivially defensible unit. This is a one-line switch in the presentation layer, decided at CP4 based on the real-file result.

**Cut from v1:** the English correction regex (former P6). It is not ground truth; `userModified` (A2) does the job properly and keeping the regex near the allocation would pollute the thesis.

### Derived guidance

**G1 — Usage notes.**
Rule-based notes, each tied to one allocation component crossing a stated threshold (e.g. "A4 fired: `src/x` read N times — consider keeping it in context / narrowing scope"). Every note names its signal and links to the events. Non-LLM. Thresholds are set at CP6, not baked in silently.

---

## Checkpoints (each independently testable; eval shown before moving on)

Ordered by risk-and-value: the two things that make this defensible come first.

- **CP0 — Schema-conformance harness.** Read-only. Parser classifies every top-level `type` and every `usage` key; unknown/unhandled types fail loudly rather than being silently skipped, so schema drift is caught. **Eval:** run against your real file; assert 0 lines that are both unrecognized and silently dropped. Ground truth = the real file.
- **CP1 — Deduped token accounting (D1).** **Eval:** parser total == standalone deduped recompute; parser total < naive per-line sum by the expected factor; one `requestId` hand-audited. This is the headline correctness win — it lands first.
- **CP2 — Cost engine (D2, D4, D5).** **Eval:** known-session cost assertion; unknown-model → unpriced + coverage drop; cache-efficiency recompute.
- **CP3 — Code-change reconstruction (D3).** **Eval:** hand-counted real edit matches; structured-vs-argument divergence report; `userModified` captured.
- **CP4 — Token-allocation centerpiece (A1–A5 + buckets).** The thesis. **Eval:** each component fixture asserts its known answer; the **allocation invariant** — the four buckets' tokens sum exactly to D1's deduped total — is asserted on the real file; and the fallback decision (tokens vs edits/lines as the unit) is made here from the real-file result and recorded. Each bucket ships with its definition and a traceable event list.
- **CP5 — CLI + machine-readable output + `CLAUDE.md` (agent-native surfaces).** JSON/JSONL output with a declared schema. **Eval:** output validates against its schema; snapshot test on a fixed input.
- **CP6 — Thin read-only UI + guidance notes (G1).** A view over CP5's output, not a source of truth: the allocation view + a session drill-down, hard-timeboxed. **Eval:** UI renders from the JSON with no recomputation; each guidance note traces to its signal. Guidance thresholds are set and signed off here.

---

## Evals — philosophy

External ground truth over self-review, always. The recurring pattern: recompute a number a second, independent way directly from the raw JSONL and assert equality; assert against hand-audited known values from your real file; use constructed fixtures with known answers for the proxies. The token-dedupe eval (CP1) is the flagship — it recomputes against the raw logs and proves the deduped number is correct where naive per-line summing is ~2× wrong.

---

## Guardrails (throughout, from your kickoff)

- **Always:** raw parsing stays separate from interpretation; every waste/cost number is traceable to the event that produced it.
- **Ask first:** before adding any dependency, any network call, or touching files outside the project dir.
- **Never:** ship a heuristic as ground truth; invent a metric not backed by a log field; echo secrets — `.env` verified by line count, never by printing values.

---

## Decisions (ruled, v1.1)

Made as the distinguished-engineer call, optimizing for exceptional-but-achievable. Override any before I start CP0.

1. **Stack.** Node.js ESM, zero runtime dependencies. **Decided: yes.**
2. **Data location.** `~/.claude/projects/*/*.jsonl` + `$CLAUDE_CONFIG_DIR`; Windows `%USERPROFILE%\.claude\projects`; walk 2 levels deep. **Decided: yes.**
3. **Productivity.** No productivity *score* and no value claim. Reframed as the **token-allocation / retention view** — a deterministic, auditable breakdown of where tokens went (surviving vs reworked/corrected/abandoned/navigation). This is the product's centerpiece and thesis. **Decided.**
4. **Signal set.** Allocation components **A1** same-file rework, **A2** `userModified` (crown jewel), **A3** abandoned, **A4** repeated-reads-into-navigation, plus standalone **A5** failed-tool retries. **P6 English correction regex — cut.** **Decided.**
5. **Plan comparison.** Kept, **demoted** (never the headline), relabelled as price arbitrage; no "value/ROI/return" wording. **Decided.**
6. **Correction signal.** `userModified` is the sole correction signal; regex cut. **Decided.**
7. **Storage / output.** Compute-on-demand + parse cache by mtime/size + emitted machine-readable snapshot artifact; no database. **Decided: yes.**
8. **Guidance thresholds.** Set at CP6 with your sign-off, not hard-coded now. **Decided.**
9. **UI scope.** Thin but real, hard-timeboxed: allocation view + session drill-down only. Not deferred (a dashboard needs a dashboard), not gold-plated. **Decided.**

---

## STOP — Phase 1 gate

This is the spec (v1.1), with all nine decisions ruled. No product code has been written. If you're good with the calls — especially the retention/allocation reframe (#3) and the cut of the correction regex (#4/#6) — approve and I start at CP0, showing you the eval result before moving past each checkpoint. If you want to overturn any decision, say which and I'll revise before any code.
