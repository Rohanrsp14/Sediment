import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from '../src/parse.mjs';
import { loadPricing } from '../src/cost.mjs';
import { buildReport, validateReport, SCHEMA_VERSION } from '../src/report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLEAN = path.join(here, '..', 'fixtures', 'clean-session.jsonl');
const PRICING = path.join(here, '..', 'pricing.json');

function reportFromFixture() {
  const { records, files, lines, parsed, unparseable } = readRecords(CLEAN);
  const pricing = loadPricing(PRICING);
  // fixed `now` so generatedAt and abandonment are deterministic
  return buildReport(records, pricing, { files, lines, parsed, unparseable }, Date.parse('2026-08-01T00:00:00Z'));
}

test('a report built from the fixture validates against the output contract', () => {
  const r = reportFromFixture();
  const { ok, errors } = validateReport(r);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('snapshot: fixed-input report has stable headline values', () => {
  const r = reportFromFixture();
  assert.equal(r.schemaVersion, SCHEMA_VERSION);
  // clean fixture: reqA (split ×3) + reqB → 2 requests, 4 assistant lines
  assert.equal(r.tokens.requests, 2);
  assert.equal(r.tokens.assistantLines, 4);
  assert.equal(r.tokens.deduped.freshInput, 18);
  assert.equal(r.tokens.deduped.output, 35);
  // one Edit reconstructed: +2 / -1
  assert.equal(r.edits.totals.editOps, 1);
  assert.equal(r.edits.totals.additions, 2);
  assert.equal(r.edits.totals.deletions, 1);
  // allocation invariant holds and buckets sum to the deduped total
  assert.equal(r.allocation.invariant.ok, true);
  assert.equal(r.allocation.totalTokens, r.tokens.deduped.totalTokens);
  const bucketReqs = Object.values(r.allocation.buckets).reduce((n, b) => n + b.requests, 0);
  assert.equal(bucketReqs, r.tokens.requests);
});

test('cost is present when pricing is supplied, and Sonnet 5 intro rate is applied', () => {
  const r = reportFromFixture();
  assert.ok(r.cost);
  assert.equal(r.cost.coverage, 1);          // clean fixture is all claude-sonnet-5
  assert.ok(r.cost.total > 0);
});

test('a report built WITHOUT pricing still validates (cost is optional/null)', () => {
  const { records } = readRecords(CLEAN);
  const r = buildReport(records, null, {}, Date.parse('2026-08-01T00:00:00Z'));
  assert.equal(r.cost, null);
  assert.equal(validateReport(r).ok, true);
});

test('validateReport catches a broken allocation invariant', () => {
  const r = reportFromFixture();
  r.allocation.invariant.ok = false;
  r.allocation.invariant.bucketTokenSum = 1;
  r.allocation.invariant.dedupedTotal = 2;
  const { ok, errors } = validateReport(r);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('invariant')));
});

test('validateReport catches a missing required field (contract drift)', () => {
  const r = reportFromFixture();
  delete r.tokens.deduped;
  const { ok, errors } = validateReport(r);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('tokens.deduped')));
});

test('validateReport catches out-of-range cost coverage', () => {
  const r = reportFromFixture();
  r.cost.coverage = 1.5;
  const { ok, errors } = validateReport(r);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('coverage')));
});
