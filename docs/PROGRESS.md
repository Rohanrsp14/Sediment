# Sediment — build progress & handoff

Living status log. Read `docs/spec_v1.md` (decisions + thesis) and `CLAUDE.md`
(rules + ground-truth facts) first; this file records **where we are** and what
was learned that isn't in the spec.

## How we work (do not drop this)

- Spec-first, eval-driven, one checkpoint at a time. **Verify the foundation
  against the real transcript BEFORE building each checkpoint** — do not assume
  from the spec or from memory of similar tools. This is the core discipline.
- Every checkpoint ends at a STOP gate: show the eval result, then wait.
- Evals use **external ground truth** (recompute independently from the raw
  logs; assert against hand-audited values), never self-review.
- Repo stays private-data-clean: fixtures under `fixtures/` are synthetic. The
  real transcript is used for evals but NEVER committed. Verify after each stage.
- Product thesis: "where did your tokens go?" — a deterministic token-retention
  allocation. No LLM-as-judge, no composite score, every number traceable.

## Status

| CP | What | State | Eval result on the real transcript |
|----|------|-------|-------------------------------------|
| CP0 | Schema-conformance harness (`schema.mjs`, `conformance.mjs`) | ✅ done | 1,081 lines, 0 unknown surfaces, `queue-operation` drift note fired |
| CP1 | Deduped token accounting (`tokens.mjs`) | ✅ done | 485 lines → 258 requests; billed-input 43,091,037 / output 164,322; naive over-counts 1.88×/2.29× |
| CP2 | Cost engine + date-scoped pricing (`cost.mjs`, `pricing.json`) | ✅ done | $10.86 (Sonnet 5 intro rate, verified vs Anthropic docs); matches independent recompute to the cent |
| CP3 | Code-change reconstruction (`edits.mjs`) | ✅ done | 39 edits / 16 files / +1,566 −36; structuredPatch vs args diverge on 19/24 edits (reference over-counts) |
| CP4 | Token-allocation centerpiece (`allocation.mjs`) | ✅ done | surviving 6.2% / reworked 7.7% / abandoned 0% / navigation 86.1%; invariant holds exactly; retries 3/5 |
| CP5 | Unified report + output contract (`report.mjs`) | ✅ done | real-file report validates against contract; `--out` writes snapshot; 49/49 tests |
| CP6 | Guidance notes + HTML dashboard (`guidance.mjs`, `render.mjs`) | ✅ done | 4 notes fired correctly (no false positives); self-contained core-log dashboard via `--html`; 57/57 tests |

**v1 complete (CP0–CP6).** Tests: **61/61 passing** (`npm test`). CLI: `report`
(default; `--out` JSON, `--html` dashboard), `doctor`, `tokens` (+`--audit`),
`cost` (+`--pricing`), `edits`, `allocation`, `schema`. All support `--json`.
The dashboard (`--html`) is a self-contained offline file and a pure view over
the snapshot — it recomputes nothing.

**Post-v1 fix (real-world use):** the user ran `report ~/.claude/projects` on
Windows PowerShell, which does NOT expand `~` — the CLI silently discovered 0
files and rendered a confident-looking all-zero dashboard instead of erroring.
Fixed: every records-reading command now fails loud (exit 2, clear stderr
message, and a specific note when the path starts with `~`) when it resolves
to zero files. This is the same fail-loud principle as CP0's schema
conformance, applied to a gap that only a real-user run surfaced. 4 new CLI
regression tests lock the behavior (`test/cli.test.mjs`), including an exact
repro of the literal-tilde case.

## Facts learned during the build (not in the original spec)

- **Assistant lines split across content blocks share one `requestId` with
  identical usage.** Verified: 0 lines missing requestId, 0 divergent-usage
  requests, and dedup-by-`requestId` == dedup-by-`message.id` (independent-key
  cross-check). Dedup key chain: `requestId → message.id → per-line`.
- **Pricing was corrected & date-scoped.** Sonnet 5 is on introductory pricing
  $2/$10 per MTok **through 2026-08-31**, then $3/$15. Cache: 5m-write 1.25×,
  cache-read 0.1× of base input. Source: platform.claude.com/docs/en/about-claude/pricing
  (verified 2026-07-21). Each request is priced by the rate in effect on its own
  timestamp, so the tool stays correct across the Sep 1 boundary.
- **Edit ground truth is `toolUseResult`, not tool arguments.** `structuredPatch`
  (applied minimal diff) for edits; `content` line-count for new-file writes;
  `userModified` is the ground-truth human-correction signal. Reference's
  argument-based counting over-counts additions ~2.2× and deletions ~5×. Each
  edit records its `method`; unreconstructable edits are visible, not silent.
  `toolUseId` on each edit links it to its request (used by CP4).
- **Abandonment must be judged from the last MEANINGFUL event** (user/assistant),
  not the last raw line — the real session ends on a `last-prompt` meta line and
  would be falsely flagged abandoned otherwise. It is a completed session.
- **This user's real session:** `userModified` = 0 (no hand-corrections), heavy
  same-file rework (models.py 6 ops, app.py 5, features.py 5). Allocation on it:
  navigation 86.1% / reworked 7.7% / surviving 6.2% / abandoned 0%. Honest and
  striking — most spend is context, not edits.

## CP6 — what to build next (from spec §checkpoints)

Thin, hard-timeboxed read-only UI that renders `sediment report --json` (the
snapshot from `report.mjs`) — the allocation view + a session drill-down — plus
rule-based guidance notes (G1). Constraints:

- **The UI is a VIEW over the JSON snapshot.** It must not recompute anything;
  it reads the report object and renders. This keeps one source of truth.
- **Guidance notes are rule-based and traceable**, each tied to one allocation
  component crossing a stated threshold (thresholds set here with sign-off). No
  LLM-generated advice. Every note names its signal and links to its events.
- Frontend uses the `frontend-design` skill; keep it minimal — allocation bars,
  the headline numbers, top reworked files, retries. Not gold-plated.

## First move in the new chat (if continuing elsewhere)

Re-upload the real `.jsonl` transcript (a fresh instance won't have it), confirm
`npm test` is green (49/49), then generate a snapshot with
`node bin/sediment.mjs report <path> --json` and build the UI against THAT, not
against a recomputation.
