# Sediment — agent guide

**Thesis:** most usage tools measure the river (how many tokens flowed). Sediment
measures the *sediment* — what settled and stayed. Of the tokens you spent, what
fraction produced work that survived to the end of the session, versus was
reworked, corrected, abandoned, or spent navigating?

Read-only, local-only, zero runtime dependencies. It never connects to a vendor
account and never writes to a Claude state directory.

## Non-negotiable rules (the whole point of the project)

1. **No LLM-as-judge. No composite score.** Value (was the code good) is
   unknowable from logs and is never claimed. We measure *retention* (did the
   work survive), which is deterministic. The headline "token allocation" is an
   auditable breakdown, not a single number.
2. **Every number is traceable** to the specific log event(s) that produced it.
   Raw parsing stays separate from interpretation.
3. **Unknown structure fails loudly.** `src/schema.mjs` is the single source of
   truth for recognized log surfaces; anything absent from it is surfaced as
   drift by `sediment doctor`, never silently skipped. This is how we avoid
   silent data loss when the log format changes.
4. **Ask before** adding a dependency, making a network call, or touching files
   outside the project directory. **Never** commit secrets or a real transcript.

## Ground-truth facts (verified against a real ~/.claude transcript)

- Claude Code splits one assistant response across several JSONL lines and stamps
  the **same `usage` on each**. Token totals MUST be deduplicated by `requestId`
  before summing — naive per-line summing over-counts (~1.9× input, ~2.3× output
  on the reference file). This is the flagship correctness fix.
- Real edit ground truth lives in `toolUseResult.structuredPatch` /
  `originalFile` / `userModified` — richer and truer than the tool arguments the
  reference parses. `userModified === true` is the crown-jewel human-correction
  signal.

## Layout

- `src/schema.mjs` — declarative registry of every recognized log surface.
- `src/parse.mjs` — the one tolerant JSONL reader.
- `src/conformance.mjs` — read-only structural scanner (computes no metrics).
- `src/tokens.mjs` — deduped token accounting (dedupe by requestId).
- `src/cost.mjs` — date-scoped API-equivalent cost + coverage.
- `src/edits.mjs` — code-change reconstruction from structuredPatch.
- `src/allocation.mjs` — the token-allocation centerpiece.
- `src/report.mjs` — unified versioned snapshot + output contract (`validateReport`).
- `bin/sediment.mjs` — CLI; the UI (later) is a view over `sediment report --json`.
- `test/` — `node --test`; fixtures under `fixtures/` are synthetic and safe to
  commit. Never add a real transcript to the repo.

## Build order (checkpoint by checkpoint; eval before advancing)

CP0 schema conformance ✅ · CP1 deduped token accounting ✅ · CP2 cost engine ✅ ·
CP3 code-change reconstruction ✅ · CP4 token-allocation centerpiece ✅ ·
CP5 unified report + output contract ✅ · CP6 thin UI + guidance ⬜ (next).

## Commands

```bash
npm test                                    # node --test (49 tests)
npm run check                               # syntax check every module
node bin/sediment.mjs [path]                # full snapshot (default command)
node bin/sediment.mjs report [path] --json --out snapshot.json
node bin/sediment.mjs doctor|tokens|cost|edits|allocation [path]
node bin/sediment.mjs schema                # machine-readable output contract
```
