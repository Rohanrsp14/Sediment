/**
 * guidance.mjs — rule-based usage notes (CP6 / G1).
 *
 * Each note is produced by ONE explicit rule crossing a stated threshold, names
 * the signal it fired on, and carries the evidence (actual numbers/files) so it
 * is fully traceable. No LLM, no vibes. Notes are attached to the report so the
 * UI renders them without recomputing anything.
 *
 * Thresholds are collected in THRESHOLDS for one-place tuning / sign-off.
 * Severity: 'good' | 'info' | 'attention' (never alarmist; retention signals,
 * not judgments of code quality).
 */

export const THRESHOLDS = {
  churnHotspotOps: 4,        // a file edited >= this many times is a churn hotspot
  wellCachedShare: 0.9,      // cache-read share of billed input considered efficient
  refetchNavShare: 0.6,      // navigation share above which we check caching
  refetchCacheEff: 0.5,      // cache efficiency below which navigation looks like re-fetch
};

const tok = (b) => b?.tokens?.totalTokens ?? 0;

export function buildGuidance(report, thresholds = THRESHOLDS) {
  const notes = [];
  const a = report.allocation;
  const b = a?.buckets ?? {};
  const edits = report.edits;
  const cost = report.cost;

  // 1) More tokens went into reworked edits than into surviving ones.
  if (tok(b.reworked) > tok(b.surviving) && tok(b.reworked) > 0) {
    notes.push({
      id: 'rework-over-survival',
      severity: 'attention',
      signal: 'reworked vs surviving edit tokens',
      evidence: { reworkedTokens: tok(b.reworked), survivingTokens: tok(b.surviving) },
      message: 'More tokens went into edits that were later superseded or corrected than into edits that survived. Tightening the initial spec or scoping edits smaller tends to reduce redo cycles.',
    });
  }

  // 2) Churn hotspots — specific files edited many times.
  const hotspots = (edits?.byFile ?? []).filter((f) => f.editOps >= thresholds.churnHotspotOps);
  if (hotspots.length) {
    notes.push({
      id: 'churn-hotspots',
      severity: 'info',
      signal: `files with >= ${thresholds.churnHotspotOps} edit ops`,
      evidence: { files: hotspots.slice(0, 5).map((f) => ({ file: f.file, editOps: f.editOps, changedLines: f.changedLines })) },
      message: 'These files were reshaped repeatedly. A focused spec or a test around each tends to cut repeated passes.',
    });
  }

  // 3) Navigation-heavy AND poorly cached → context is being re-sent (real waste).
  const navShare = b.navigation?.shareOfTokens ?? 0;
  const cacheEff = cost?.cacheEfficiency ?? null;
  if (navShare > thresholds.refetchNavShare && cacheEff != null && cacheEff < thresholds.refetchCacheEff) {
    notes.push({
      id: 'context-refetch',
      severity: 'attention',
      signal: 'navigation share + cache efficiency',
      evidence: { navigationShare: navShare, cacheEfficiency: cacheEff },
      message: 'Most spend is reading/reasoning and little of it is served from cache — context is being re-sent. Keeping frequently-read files in context or reusing sessions reduces this.',
    });
  } else if (cacheEff != null && cacheEff >= thresholds.wellCachedShare) {
    // 3b) Positive: reading is dominant but efficiently cached — not waste.
    notes.push({
      id: 'well-cached',
      severity: 'good',
      signal: 'cache efficiency',
      evidence: { cacheEfficiency: cacheEff },
      message: `${(cacheEff * 100).toFixed(1)}% of billed input was served from cache. Navigation-heavy spend here is efficiently cached, not re-fetched context.`,
    });
  }

  // 4) Human-corrected edits (ground truth).
  if ((edits?.totals?.userModifiedOps ?? 0) >= 1) {
    notes.push({
      id: 'human-corrections',
      severity: 'attention',
      signal: 'userModified edits',
      evidence: { userModifiedOps: edits.totals.userModifiedOps },
      message: 'You hand-corrected some agent edits. Front-loading the constraints those corrections express usually prevents the round-trip.',
    });
  }

  // 5) Failed tool calls that were retried.
  if ((a?.retries?.retriedAfterError ?? 0) >= 1) {
    notes.push({
      id: 'tool-retries',
      severity: 'info',
      signal: 'failed-tool retries',
      evidence: { retriedAfterError: a.retries.retriedAfterError, erroredResults: a.retries.erroredResults },
      message: 'Some tool calls failed and were retried. Recurring failures on the same command are worth a closer look.',
    });
  }

  // 6) Unpriced models lowered cost coverage.
  if (cost && cost.coverage < 1) {
    notes.push({
      id: 'unpriced-models',
      severity: 'info',
      signal: 'cost coverage',
      evidence: { coverage: cost.coverage, unpricedModels: cost.unpricedModels },
      message: 'Some requests used a model with no pricing row, so their cost is excluded. Add the model to pricing.json for full coverage.',
    });
  }

  if (!notes.length) {
    notes.push({ id: 'none', severity: 'good', signal: 'all rules', evidence: {}, message: 'No usage-pattern rule crossed its threshold in this window.' });
  }
  return notes;
}
