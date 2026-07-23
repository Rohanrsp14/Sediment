import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from '../src/parse.mjs';
import { tokenAccounting, usageOf, derive } from '../src/tokens.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLEAN = path.join(here, '..', 'fixtures', 'clean-session.jsonl');

const asst = (requestId, msgId, usage, blocks = []) => ({
  type: 'assistant', requestId, sessionId: 's1',
  message: { role: 'assistant', id: msgId, model: 'claude-sonnet-5', usage, content: blocks },
});
const U = (input, output, cr = 0, cc = 0) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: cr, cache_creation_input_tokens: cc,
});

test('the split-across-lines request is counted exactly once', () => {
  // clean-session.jsonl: reqA on 3 lines (identical usage) + reqB on 1 line.
  const { records } = readRecords(CLEAN);
  const acc = tokenAccounting(records);
  assert.equal(acc.assistantLines, 4);
  assert.equal(acc.requests, 2);

  // reqA usage 10/20/100/5, reqB 8/15/210/0 → deduped:
  assert.equal(acc.deduped.freshInput, 18);
  assert.equal(acc.deduped.output, 35);
  assert.equal(acc.deduped.cacheRead, 310);
  assert.equal(acc.deduped.cacheCreation, 5);
  assert.equal(acc.deduped.billedInput, 18 + 310 + 5);
  assert.equal(acc.deduped.totalTokens, 333 + 35);
});

test('the naive per-line sum over-counts, and inflation is reported', () => {
  const { records } = readRecords(CLEAN);
  const acc = tokenAccounting(records);
  // reqA counted 3x in the naive sum:
  assert.equal(acc.naive.freshInput, 10 * 3 + 8);   // 38
  assert.equal(acc.naive.output, 20 * 3 + 15);      // 75
  assert.ok(acc.naive.billedInput > acc.deduped.billedInput);
  assert.ok(acc.inflation.output > 2); // 75/35 ≈ 2.14
  assert.equal(acc.inflation.output, acc.naive.output / acc.deduped.output);
});

test('divergent per-line usage is flagged, and first-seen is kept', () => {
  const recs = [
    asst('r1', 'm1', U(100, 10)),
    asst('r1', 'm1', U(999, 999)), // same request, contradictory usage
  ];
  const acc = tokenAccounting(recs);
  assert.equal(acc.requests, 1);
  assert.equal(acc.divergentRequests, 1);
  assert.equal(acc.deduped.freshInput, 100); // first-seen wins, deterministically
  assert.equal(acc.deduped.output, 10);
});

test('a line missing requestId is counted once via fallback, never dropped', () => {
  const recs = [
    { type: 'assistant', sessionId: 's1', message: { role: 'assistant', usage: U(5, 7), content: [] } },
  ];
  const acc = tokenAccounting(recs);
  assert.equal(acc.linesMissingRequestId, 1);
  assert.equal(acc.requests, 1);
  assert.equal(acc.deduped.freshInput, 5);
  assert.equal(acc.deduped.output, 7);
});

test('dedupe by requestId and by message.id agree (independent-key cross-check)', () => {
  // Two requests, each split across 2 lines; requestId and message.id are 1:1.
  const recs = [
    asst('rA', 'mA', U(10, 2, 50)), asst('rA', 'mA', U(10, 2, 50)),
    asst('rB', 'mB', U(20, 4, 60)), asst('rB', 'mB', U(20, 4, 60)),
  ];
  const byReq = tokenAccounting(recs);
  // recompute independently keyed on message.id
  const seen = new Set(); const t = { freshInput: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  for (const r of recs) {
    const id = r.message.id; if (seen.has(id)) continue; seen.add(id);
    const u = usageOf(r); t.freshInput += u.freshInput; t.cacheRead += u.cacheRead; t.cacheCreation += u.cacheCreation; t.output += u.output;
  }
  const byMsg = derive(t);
  assert.equal(byReq.deduped.billedInput, byMsg.billedInput);
  assert.equal(byReq.deduped.output, byMsg.output);
  assert.equal(byReq.deduped.totalTokens, byMsg.totalTokens);
});

test('non-assistant records contribute no tokens', () => {
  const recs = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'system', subtype: 'turn_duration', durationMs: 10 },
    asst('r', 'm', U(3, 1)),
  ];
  const acc = tokenAccounting(recs);
  assert.equal(acc.requests, 1);
  assert.equal(acc.deduped.totalTokens, derive({ freshInput: 3, cacheRead: 0, cacheCreation: 0, output: 1 }).totalTokens);
});
