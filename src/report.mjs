/**
 * report.mjs — the unified, versioned snapshot (CP5).
 *
 * Combines every analysis (tokens, cost, edits, allocation) into ONE
 * machine-readable object with a declared schema. This snapshot is the single
 * source the UI (CP6) and any external consumer reads — the dashboard is a view
 * over this, never a second computation.
 *
 * The output contract (REPORT_SCHEMA + validateReport) is checked in tests so
 * the shape can't silently drift. It is intentionally dependency-free: a small
 * structural validator, not an imported JSON-Schema engine.
 */
import { tokenAccounting } from './tokens.mjs';
import { costAccounting } from './cost.mjs';
import { extractEdits } from './edits.mjs';
import { allocate } from './allocation.mjs';
import { buildGuidance } from './guidance.mjs';

export const SCHEMA_VERSION = '1.0';

/**
 * Build the full snapshot from raw records. `meta` carries source counts from
 * the reader (files/lines/parsed/unparseable) for provenance.
 */
export function buildReport(records, pricing, meta = {}, now = Date.now()) {
  const { byRequest, ...tokens } = tokenAccounting(records);
  const cost = pricing ? costAccounting(records, pricing) : null;
  const editsData = extractEdits(records);
  const alloc = allocate(records, now);

  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    source: {
      files: meta.files ?? null,
      lines: meta.lines ?? null,
      parsed: meta.parsed ?? null,
      unparseable: meta.unparseable ?? null,
    },
    tokens: {
      assistantLines: tokens.assistantLines,
      requests: tokens.requests,
      linesMissingRequestId: tokens.linesMissingRequestId,
      divergentRequests: tokens.divergentRequests,
      deduped: tokens.deduped,
      naive: tokens.naive,
      inflation: tokens.inflation,
    },
    cost: cost && {
      currency: cost.currency,
      pricingUpdatedAt: cost.pricingUpdatedAt,
      total: cost.total,
      costPerRequest: cost.costPerRequest,
      coverage: cost.coverage,
      pricedRequests: cost.pricedRequests,
      unpricedRequests: cost.unpricedRequests,
      unpricedModels: cost.unpricedModels,
      cacheEfficiency: cost.cacheEfficiency,
      breakdown: cost.breakdown,
      byModel: cost.byModel,
    },
    edits: {
      totals: editsData.totals,
      byFile: editsData.byFile.slice(0, 25),
      byDirectory: editsData.byDirectory.slice(0, 25),
    },
    allocation: {
      attribution: alloc.attribution,
      totalTokens: alloc.totalTokens,
      requests: alloc.requests,
      buckets: alloc.buckets,
      invariant: alloc.invariant,
      retries: alloc.retries,
    },
  };

  report.guidance = buildGuidance(report);
  return report;
}

/**
 * The output contract. Value = expected typeof (or 'array'); nested objects
 * describe required sub-keys. This is the machine-readable schema `sediment
 * schema` emits and `validateReport` enforces.
 */
export const REPORT_SCHEMA = {
  schemaVersion: 'string',
  generatedAt: 'string',
  source: { files: 'number?', lines: 'number?', parsed: 'number?', unparseable: 'number?' },
  tokens: {
    assistantLines: 'number', requests: 'number',
    deduped: 'object', naive: 'object', inflation: 'object',
  },
  cost: 'object?', // null when no pricing supplied
  edits: { totals: 'object', byFile: 'array', byDirectory: 'array' },
  allocation: {
    attribution: 'string', totalTokens: 'number',
    buckets: 'object', invariant: 'object', retries: 'object',
  },
  guidance: 'array',
};

function checkShape(value, schema, pathPrefix, errors) {
  for (const [key, spec] of Object.entries(schema)) {
    const optional = typeof spec === 'string' && spec.endsWith('?');
    const type = typeof spec === 'string' ? spec.replace('?', '') : 'object';
    const v = value?.[key];
    const p = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (v == null) { if (!optional) errors.push(`missing ${p}`); continue; }
    if (typeof spec === 'object') { checkShape(v, spec, p, errors); continue; }
    const actual = Array.isArray(v) ? 'array' : typeof v;
    if (actual !== type) errors.push(`${p}: expected ${type}, got ${actual}`);
  }
}

/**
 * Validate a report against REPORT_SCHEMA plus semantic invariants that matter:
 *   - the allocation token invariant holds;
 *   - bucket shares sum to ~1;
 *   - cost coverage (when present) is a fraction in [0, 1].
 * Returns { ok, errors }.
 */
export function validateReport(report) {
  const errors = [];
  if (report?.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  checkShape(report, REPORT_SCHEMA, '', errors);

  const inv = report?.allocation?.invariant;
  if (inv && inv.ok !== true) errors.push(`allocation invariant broken: ${inv.bucketTokenSum} != ${inv.dedupedTotal}`);

  const buckets = report?.allocation?.buckets;
  if (buckets) {
    const shareSum = Object.values(buckets).reduce((n, b) => n + (b.shareOfTokens ?? 0), 0);
    if (report.allocation.totalTokens > 0 && Math.abs(shareSum - 1) > 1e-6) {
      errors.push(`bucket shares sum to ${shareSum}, expected 1`);
    }
  }
  if (report?.cost && (report.cost.coverage < 0 || report.cost.coverage > 1)) {
    errors.push(`cost.coverage out of range: ${report.cost.coverage}`);
  }
  return { ok: errors.length === 0, errors };
}

export function formatReport(r) {
  const n = (x) => (x == null ? '—' : x.toLocaleString('en-US'));
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const $ = (x) => `$${x.toFixed(2)}`;
  const L = [
    'SEDIMENT — where did your tokens go?',
    `  ${n(r.tokens.deduped.totalTokens)} deduped tokens · ${n(r.tokens.requests)} requests · ${n(r.edits.totals.editOps)} edits across ${n(r.edits.totals.filesTouched)} files`,
  ];
  if (r.cost) L.push(`  API-equivalent ${$(r.cost.total)} ${r.cost.currency} (coverage ${pct(r.cost.coverage)}) · naive per-line summing would inflate tokens ${r.tokens.inflation.totalTokens?.toFixed(2)}x`);
  L.push('');
  L.push('  token allocation:');
  const labels = { surviving: 'surviving', reworked: 'reworked/corrected', abandoned: 'abandoned', navigation: 'navigation/reasoning' };
  for (const k of ['surviving', 'reworked', 'abandoned', 'navigation']) {
    const b = r.allocation.buckets[k];
    const bar = '█'.repeat(Math.round(b.shareOfTokens * 24)).padEnd(24, '·');
    L.push(`    ${labels[k].padEnd(20)} ${bar} ${pct(b.shareOfTokens).padStart(6)}  ${n(b.tokens.totalTokens)} tok`);
  }
  L.push('');
  L.push(`  invariant ${r.allocation.invariant.ok ? 'OK' : 'BROKEN'} · retries ${r.allocation.retries.retriedAfterError}/${r.allocation.retries.erroredResults} · userModified edits ${n(r.edits.totals.userModifiedOps)}`);
  return L.join('\n');
}
