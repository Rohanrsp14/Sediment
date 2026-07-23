/**
 * cost.mjs — API-equivalent cost (CP2), built on deduped requests from CP1.
 *
 * Each of the four token buckets is priced at its own rate:
 *   fresh input      → rate.input
 *   cache read       → rate.cacheRead   (falls back to rate.input)
 *   cache creation   → rate.cacheWrite  (falls back to rate.input)
 *   output           → rate.output
 * Rates are USD per 1,000,000 tokens (see pricing.json).
 *
 * Pricing is per-request (each request carries its own model), so a session that
 * switches models is priced correctly. A model matching no pricing row is left
 * UNPRICED — its tokens are excluded from the dollar total and it lowers the
 * reported coverage. We never guess a rate. Every dollar is decomposed into the
 * bucket that produced it, so cost is fully traceable.
 *
 * This is an estimate, not an invoice (see pricing.json disclaimer).
 */
import fs from 'node:fs';
import { tokenAccounting } from './tokens.mjs';

export function loadPricing(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

/**
 * First pricing row whose regex matches the model AND whose effective window
 * contains `atDate` (a Date; defaults to now). A row with no effectiveFrom /
 * effectiveUntil always applies. Window is [effectiveFrom, effectiveUntil).
 * Returns null on no match.
 */
export function rateFor(model, pricing, atDate = new Date()) {
  if (!pricing?.models?.length) return null;
  const value = String(model ?? '');
  const t = atDate instanceof Date ? atDate.getTime() : new Date(atDate).getTime();
  for (const rate of pricing.models) {
    try { if (!new RegExp(rate.pattern, 'i').test(value)) continue; }
    catch { continue; } // tolerate a bad custom row
    if (rate.effectiveFrom && t < new Date(rate.effectiveFrom).getTime()) continue;
    if (rate.effectiveUntil && t >= new Date(rate.effectiveUntil).getTime()) continue;
    return rate;
  }
  return null;
}

/** Price one request's deduped usage. Returns a per-bucket dollar breakdown. */
export function priceUsage(usage, rate) {
  if (!rate) return null;
  const perM = (tokens, r) => (tokens * (r ?? 0)) / 1_000_000;
  const freshInput = perM(usage.freshInput, rate.input);
  const cacheRead = perM(usage.cacheRead, rate.cacheRead ?? rate.input);
  const cacheCreation = perM(usage.cacheCreation, rate.cacheWrite ?? rate.input);
  const output = perM(usage.output, rate.output);
  return { freshInput, cacheRead, cacheCreation, output, total: freshInput + cacheRead + cacheCreation + output };
}

const addBreakdown = (acc, b) => {
  acc.freshInput += b.freshInput; acc.cacheRead += b.cacheRead;
  acc.cacheCreation += b.cacheCreation; acc.output += b.output; acc.total += b.total;
};
const zeroBreakdown = () => ({ freshInput: 0, cacheRead: 0, cacheCreation: 0, output: 0, total: 0 });

/**
 * Full cost accounting across a set of records. Priced per request, aggregated
 * to totals, per-model, and per-session, with an explicit coverage figure.
 */
export function costAccounting(records, pricing) {
  const acc = tokenAccounting(records);
  const breakdown = zeroBreakdown();
  const byModel = new Map();
  const bySession = new Map();
  const unpricedModels = new Map();
  let pricedRequests = 0;
  let pricedBilledInput = 0, pricedOutput = 0;

  for (const [, r] of acc.byRequest) {
    const at = r.timestamp ? new Date(r.timestamp) : new Date();
    const rate = rateFor(r.model, pricing, at);
    const modelKey = r.model ?? '(no model)';
    if (!rate) {
      unpricedModels.set(modelKey, (unpricedModels.get(modelKey) ?? 0) + 1);
      continue;
    }
    const b = priceUsage(r.usage, rate);
    addBreakdown(breakdown, b);
    pricedRequests++;
    pricedBilledInput += r.usage.freshInput + r.usage.cacheRead + r.usage.cacheCreation;
    pricedOutput += r.usage.output;

    const m = byModel.get(modelKey) ?? { model: modelKey, label: rate.label ?? modelKey, requests: 0, cost: 0 };
    m.requests++; m.cost += b.total; byModel.set(modelKey, m);

    const s = bySession.get(r.sessionId) ?? { sessionId: r.sessionId, requests: 0, cost: 0 };
    s.requests++; s.cost += b.total; bySession.set(r.sessionId, s);
  }

  const requests = acc.requests;
  const cacheEfficiency = acc.deduped.billedInput ? acc.deduped.cacheRead / acc.deduped.billedInput : null; // D5

  return {
    currency: pricing?.currency ?? 'USD',
    pricingUpdatedAt: pricing?.updatedAt ?? null,
    total: breakdown.total,
    breakdown,                                   // every dollar traced to its bucket
    requests,
    pricedRequests,
    unpricedRequests: requests - pricedRequests,
    coverage: requests ? pricedRequests / requests : 0,
    unpricedModels: Object.fromEntries(unpricedModels),
    costPerRequest: pricedRequests ? breakdown.total / pricedRequests : null,
    cacheEfficiency,
    byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost),
    bySession: [...bySession.values()].sort((a, b) => b.cost - a.cost),
    tokens: acc.deduped,
  };
}

export function formatCost(c) {
  const $ = (x) => `$${x.toFixed(2)}`;
  const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
  const L = [
    'sediment cost — API-equivalent estimate (not an invoice)',
    `  total ${$(c.total)} ${c.currency}   ·   ${$(c.costPerRequest ?? 0)}/request   ·   coverage ${pct(c.coverage)} (${c.pricedRequests}/${c.requests} requests)`,
    '  by bucket (every dollar traced):',
    `    fresh input     ${$(c.breakdown.freshInput)}`,
    `    cache read      ${$(c.breakdown.cacheRead)}`,
    `    cache creation  ${$(c.breakdown.cacheCreation)}`,
    `    output          ${$(c.breakdown.output)}`,
    `  cache efficiency  ${pct(c.cacheEfficiency)} of billed input served from cache`,
  ];
  if (c.byModel.length) {
    L.push('  by model:');
    for (const m of c.byModel) L.push(`    ${$(m.cost).padStart(9)}  ${m.label}  (${m.requests} req)`);
  }
  if (Object.keys(c.unpricedModels).length) {
    L.push('  unpriced (no rate row — excluded from total):');
    for (const [k, n] of Object.entries(c.unpricedModels)) L.push(`    ${k}  (${n} req)`);
  }
  if (c.pricingUpdatedAt) L.push(`  pricing table dated ${c.pricingUpdatedAt} — verify against current vendor rates`);
  return L.join('\n');
}
