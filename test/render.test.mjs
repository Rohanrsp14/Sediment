import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from '../src/parse.mjs';
import { loadPricing } from '../src/cost.mjs';
import { buildReport } from '../src/report.mjs';
import { buildGuidance } from '../src/guidance.mjs';
import { renderHtml } from '../src/render.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLEAN = path.join(here, '..', 'fixtures', 'clean-session.jsonl');
const PRICING = path.join(here, '..', 'pricing.json');

function fixtureReport() {
  const { records, files, lines, parsed, unparseable } = readRecords(CLEAN);
  return buildReport(records, loadPricing(PRICING), { files, lines, parsed, unparseable }, Date.parse('2026-08-01T00:00:00Z'));
}

// minimal synthetic report skeleton for targeted guidance rules
const baseReport = (over = {}) => ({
  allocation: { buckets: { surviving: { tokens: { totalTokens: 100 }, shareOfTokens: 0.1 }, reworked: { tokens: { totalTokens: 50 }, shareOfTokens: 0.05 }, abandoned: { tokens: { totalTokens: 0 }, shareOfTokens: 0 }, navigation: { tokens: { totalTokens: 850 }, shareOfTokens: 0.85 } }, retries: { retriedAfterError: 0, erroredResults: 0 } },
  edits: { totals: { userModifiedOps: 0 }, byFile: [] },
  cost: { coverage: 1, cacheEfficiency: 0.99, unpricedModels: {} },
  ...over,
});

test('reworked>surviving tokens fires the rework-over-survival note', () => {
  const r = baseReport({ allocation: { buckets: { surviving: { tokens: { totalTokens: 100 } }, reworked: { tokens: { totalTokens: 300 } }, abandoned: { tokens: { totalTokens: 0 } }, navigation: { tokens: { totalTokens: 0 }, shareOfTokens: 0 } }, retries: { retriedAfterError: 0, erroredResults: 0 } } });
  const notes = buildGuidance(r);
  const n = notes.find((x) => x.id === 'rework-over-survival');
  assert.ok(n);
  assert.equal(n.severity, 'attention');
  assert.deepEqual(n.evidence, { reworkedTokens: 300, survivingTokens: 100 });
});

test('high cache efficiency fires the positive well-cached note, not a waste note', () => {
  const notes = buildGuidance(baseReport());
  assert.ok(notes.some((x) => x.id === 'well-cached' && x.severity === 'good'));
  assert.ok(!notes.some((x) => x.id === 'context-refetch'));
});

test('navigation-heavy AND poorly cached fires the context-refetch waste note', () => {
  const r = baseReport({ cost: { coverage: 1, cacheEfficiency: 0.2, unpricedModels: {} } });
  r.allocation.buckets.navigation.shareOfTokens = 0.85;
  const notes = buildGuidance(r);
  assert.ok(notes.some((x) => x.id === 'context-refetch' && x.severity === 'attention'));
});

test('churn hotspots name the specific files over the ops threshold', () => {
  const r = baseReport({ edits: { totals: { userModifiedOps: 0 }, byFile: [{ file: 'src/a.js', editOps: 6, changedLines: 40 }, { file: 'src/b.js', editOps: 2, changedLines: 5 }] } });
  const n = buildGuidance(r).find((x) => x.id === 'churn-hotspots');
  assert.ok(n);
  assert.equal(n.evidence.files.length, 1);       // only the >=4 file
  assert.equal(n.evidence.files[0].file, 'src/a.js');
});

test('userModified edits fire the human-corrections note', () => {
  const r = baseReport({ edits: { totals: { userModifiedOps: 3 }, byFile: [] } });
  assert.ok(buildGuidance(r).some((x) => x.id === 'human-corrections'));
});

test('every guidance note names its signal and carries evidence (traceable)', () => {
  const r = fixtureReport();
  for (const note of r.guidance) {
    assert.ok(typeof note.signal === 'string' && note.signal.length);
    assert.ok(note.evidence && typeof note.evidence === 'object');
    assert.ok(['good', 'info', 'attention'].includes(note.severity));
  }
});

test('renderHtml produces a self-contained document with the embedded snapshot', () => {
  const r = fixtureReport();
  const html = renderHtml(r);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('id="sediment-data"'));
  assert.ok(!/https?:\/\//.test(html.replace(/lang="en"/, ''))); // no external network resources
  // renders real values, and the embedded JSON round-trips
  assert.ok(html.includes(r.tokens.deduped.totalTokens.toLocaleString('en-US')));
  const m = html.match(/id="sediment-data">(.*?)<\/script>/s);
  const parsed = JSON.parse(m[1].replace(/\\u003c/g, '<'));
  assert.equal(parsed.schemaVersion, r.schemaVersion);
  assert.equal(parsed.allocation.invariant.ok, true);
});

test('renderHtml escapes angle brackets in the embedded JSON (no </script> break-out)', () => {
  const r = fixtureReport();
  r.edits.byFile.unshift({ file: 'x</script><script>bad()</script>.js', directory: '.', additions: 1, deletions: 0, changedLines: 1, editOps: 5, userModifiedOps: 0, sessions: 1 });
  const html = renderHtml(r);
  // the raw closing-script sequence from data must not appear unescaped in the data block
  const dataBlock = html.slice(html.indexOf('id="sediment-data"'));
  assert.ok(!dataBlock.includes('<script>bad()'));
});
