import test from 'node:test';
import assert from 'node:assert/strict';
import { costAccounting, priceUsage, rateFor } from '../src/cost.mjs';

// Self-contained test pricing so tests don't depend on shipped rates.
const PRICING = {
  currency: 'USD',
  models: [
    { id: 'sonnet', label: 'Sonnet', pattern: '^claude-sonnet-5(?:-|$)', input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
    { id: 'opus', label: 'Opus', pattern: '^claude-opus-4-8(?:-|$)', input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  ],
};

const asst = (requestId, model, usage, ts = '2026-07-18T10:00:00.000Z') => ({
  type: 'assistant', requestId, sessionId: 's1', timestamp: ts,
  message: { role: 'assistant', id: requestId, model, usage },
});
const U = (input, output, cr = 0, cc = 0) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: cr, cache_creation_input_tokens: cc,
});

test('priceUsage applies each bucket rate separately', () => {
  // 1,000,000 fresh @3 + 2,000,000 cacheRead @0.3 + 400,000 cacheCreation @3.75 + 100,000 output @15
  const b = priceUsage({ freshInput: 1_000_000, cacheRead: 2_000_000, cacheCreation: 400_000, output: 100_000 }, PRICING.models[0]);
  assert.equal(b.freshInput, 3);
  assert.equal(b.cacheRead, 0.6);
  assert.equal(b.cacheCreation, 1.5);
  assert.equal(b.output, 1.5);
  assert.equal(b.total, 3 + 0.6 + 1.5 + 1.5);
});

test('cacheRead/cacheWrite fall back to the input rate when unspecified', () => {
  const rate = { input: 4, output: 8 }; // no cache rates
  const b = priceUsage({ freshInput: 0, cacheRead: 1_000_000, cacheCreation: 1_000_000, output: 0 }, rate);
  assert.equal(b.cacheRead, 4);      // fell back to input
  assert.equal(b.cacheCreation, 4);  // fell back to input
});

test('cost is priced on deduped requests, not raw lines', () => {
  // same request on 2 lines (identical usage) must be priced once
  const recs = [
    asst('r1', 'claude-sonnet-5', U(1_000_000, 100_000)),
    asst('r1', 'claude-sonnet-5', U(1_000_000, 100_000)),
  ];
  const c = costAccounting(recs, PRICING);
  assert.equal(c.requests, 1);
  assert.equal(c.pricedRequests, 1);
  // 1M fresh @3 + 100k output @15 = 3 + 1.5
  assert.equal(c.total, 4.5);
});

test('unknown models stay unpriced, excluded from the total, and drop coverage', () => {
  const recs = [
    asst('r1', 'claude-sonnet-5', U(1_000_000, 0)),   // priced: $3
    asst('r2', 'vendor-mystery-9', U(9_000_000, 9_000_000)), // unpriced
  ];
  const c = costAccounting(recs, PRICING);
  assert.equal(c.total, 3);                 // mystery model contributes nothing
  assert.equal(c.pricedRequests, 1);
  assert.equal(c.unpricedRequests, 1);
  assert.equal(c.coverage, 0.5);
  assert.deepEqual(c.unpricedModels, { 'vendor-mystery-9': 1 });
});

test('per-bucket breakdown sums exactly to the total (traceability invariant)', () => {
  const recs = [
    asst('r1', 'claude-sonnet-5', U(500_000, 50_000, 3_000_000, 200_000)),
    asst('r2', 'claude-opus-4-8', U(100_000, 20_000, 1_000_000, 0)),
  ];
  const c = costAccounting(recs, PRICING);
  const sum = c.breakdown.freshInput + c.breakdown.cacheRead + c.breakdown.cacheCreation + c.breakdown.output;
  assert.ok(Math.abs(sum - c.total) < 1e-9);
  assert.ok(Math.abs(c.total - c.byModel.reduce((n, m) => n + m.cost, 0)) < 1e-9);
});

test('rateFor matches by regex and returns null for no match', () => {
  assert.equal(rateFor('claude-sonnet-5', PRICING).id, 'sonnet');
  assert.equal(rateFor('claude-sonnet-5-20260101', PRICING).id, 'sonnet');
  assert.equal(rateFor('gpt-9', PRICING), null);
});

test('cache efficiency is cacheRead / billed input', () => {
  const recs = [asst('r1', 'claude-sonnet-5', U(100, 0, 900, 0))]; // billed input 1000, cacheRead 900
  const c = costAccounting(recs, PRICING);
  assert.equal(c.cacheEfficiency, 0.9);
});

// Date-scoped rates: a model with a scheduled price change is priced by the
// rate in effect on each request's own date (mirrors real Sonnet 5).
const DATED = {
  currency: 'USD',
  models: [
    { id: 'intro', label: 'S5 intro', pattern: '^claude-sonnet-5(?:-|$)', effectiveUntil: '2026-09-01', input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
    { id: 'std', label: 'S5 std', pattern: '^claude-sonnet-5(?:-|$)', effectiveFrom: '2026-09-01', input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  ],
};

test('rateFor selects the introductory row before the cutoff', () => {
  const r = rateFor('claude-sonnet-5', DATED, new Date('2026-07-18'));
  assert.equal(r.id, 'intro');
});

test('rateFor selects the standard row on/after the cutoff', () => {
  const r = rateFor('claude-sonnet-5', DATED, new Date('2026-09-01'));
  assert.equal(r.id, 'std');
  assert.equal(rateFor('claude-sonnet-5', DATED, new Date('2026-10-15')).id, 'std');
});

test('a request is priced by the rate in effect on its own timestamp', () => {
  const july = costAccounting([asst('r', 'claude-sonnet-5', U(1_000_000, 0), '2026-07-18T00:00:00Z')], DATED);
  const sept = costAccounting([asst('r', 'claude-sonnet-5', U(1_000_000, 0), '2026-09-15T00:00:00Z')], DATED);
  assert.equal(july.total, 2); // intro input $2
  assert.equal(sept.total, 3); // standard input $3
});
