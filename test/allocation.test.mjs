import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate, detectAbandoned, classifyEditOutcomes, detectRetries, buildToolUseIndex } from '../src/allocation.mjs';

const U = (input, output, cr = 0, cc = 0) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: cr, cache_creation_input_tokens: cc,
});
// assistant request that issues a tool_use with a given id
const asst = (requestId, toolId, name, usage, ts = '2026-07-18T10:00:00Z', sessionId = 's1') => ({
  type: 'assistant', requestId, sessionId, timestamp: ts,
  message: { role: 'assistant', id: requestId, model: 'claude-sonnet-5', usage, content: [{ type: 'tool_use', id: toolId, name }] },
});
// user line carrying the edit result for a tool_use id
const editResult = (toolId, filePath, extra, ts = '2026-07-18T10:00:01Z', sessionId = 's1') => ({
  type: 'user', sessionId, timestamp: ts,
  toolUseResult: { filePath, userModified: false, ...extra },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] },
});
const patch = (adds, dels) => ({ structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [...Array(adds).fill('+x'), ...Array(dels).fill('-y')] }] });
// an assistant navigation request (a Read tool_use, no resulting edit)
const nav = (requestId, usage, ts = '2026-07-18T10:00:00Z', sessionId = 's1') =>
  asst(requestId, `read-${requestId}`, 'Read', usage, ts, sessionId);
const asstReply = (ts, sessionId = 's1') => ({ type: 'assistant', requestId: `final-${ts}`, sessionId, timestamp: ts, message: { role: 'assistant', id: `final-${ts}`, usage: U(0, 0), content: [{ type: 'text', text: 'done' }] } });

test('a surviving edit request lands in the surviving bucket', () => {
  const recs = [
    asst('r1', 't1', 'Edit', U(1000, 100), '2026-07-18T10:00:00Z'),
    editResult('t1', 'src/a.js', patch(3, 1)),
    asstReply('2026-07-18T10:00:05Z'), // last meaningful is assistant → not abandoned
  ];
  const a = allocate(recs);
  assert.equal(a.buckets.surviving.requests, 1);
  assert.equal(a.buckets.surviving.edits, 1);
  assert.equal(a.buckets.reworked.requests, 0);
});

test('a superseded earlier edit makes its request reworked; the final edit survives', () => {
  const recs = [
    asst('r1', 't1', 'Edit', U(1000, 100), '2026-07-18T10:00:00Z'),
    editResult('t1', 'src/a.js', patch(5, 0), '2026-07-18T10:00:01Z'),
    asst('r2', 't2', 'Edit', U(1000, 100), '2026-07-18T10:00:02Z'),
    editResult('t2', 'src/a.js', patch(2, 1), '2026-07-18T10:00:03Z'),
    asstReply('2026-07-18T10:00:05Z'),
  ];
  const a = allocate(recs);
  assert.equal(a.buckets.reworked.requests, 1);  // r1's edit was superseded
  assert.equal(a.buckets.surviving.requests, 1); // r2's edit is final
});

test('a userModified edit makes its request reworked/corrected', () => {
  const recs = [
    asst('r1', 't1', 'Edit', U(1000, 100)),
    editResult('t1', 'src/a.js', { ...patch(3, 0), userModified: true }),
    asstReply('2026-07-18T10:00:05Z'),
  ];
  const a = allocate(recs);
  assert.equal(a.buckets.reworked.requests, 1);
  assert.equal(a.buckets.surviving.requests, 0);
});

test('a request with no edit is navigation', () => {
  const recs = [nav('r1', U(500, 20))]; // Read tool_use, no edit; last meaningful is assistant → not abandoned
  const a = allocate(recs);
  assert.equal(a.buckets.navigation.requests, 1);
  assert.equal(a.buckets.navigation.tokens.freshInput, 500);
});

test('abandonment is judged from the last MEANINGFUL event, ignoring meta lines', () => {
  const recs = [
    asst('r1', 't1', 'Edit', U(1000, 100), '2026-07-18T10:00:00Z'),
    editResult('t1', 'src/a.js', patch(3, 0)),
    { type: 'user', sessionId: 's1', timestamp: '2026-07-18T10:00:02Z', message: { role: 'user', content: [{ type: 'text', text: 'do more' }] } },
    { type: 'last-prompt', sessionId: 's1', timestamp: '2026-07-18T10:00:03Z' }, // meta, ignored
  ];
  const abandoned = detectAbandoned(recs, Date.parse('2026-08-01T00:00:00Z')); // well after → not live
  assert.ok(abandoned.has('s1')); // last meaningful is the user "do more", unanswered
  const a = allocate(recs, Date.parse('2026-08-01T00:00:00Z'));
  assert.equal(a.buckets.abandoned.requests, 1); // the edit request lands in abandoned
});

test('a completed session (last meaningful is assistant) is not abandoned', () => {
  const recs = [
    asst('r1', 't1', 'Edit', U(1000, 100), '2026-07-18T10:00:00Z'),
    editResult('t1', 'src/a.js', patch(3, 0)),
    asstReply('2026-07-18T10:00:05Z'),
    { type: 'last-prompt', sessionId: 's1', timestamp: '2026-07-18T10:00:06Z' },
  ];
  const abandoned = detectAbandoned(recs, Date.parse('2026-08-01T00:00:00Z'));
  assert.equal(abandoned.size, 0);
});

test('THE INVARIANT: bucket tokens sum exactly to the deduped total', () => {
  const recs = [
    asst('r1', 't1', 'Edit', U(1000, 100, 5000, 200), '2026-07-18T10:00:00Z'),
    editResult('t1', 'src/a.js', patch(5, 0), '2026-07-18T10:00:01Z'),
    asst('r2', 't2', 'Edit', U(800, 90, 4000, 0), '2026-07-18T10:00:02Z'),
    editResult('t2', 'src/a.js', patch(2, 1), '2026-07-18T10:00:03Z'),   // supersedes r1
    nav('r3', U(300, 10, 9000, 0), '2026-07-18T10:00:04Z'),
    asstReply('2026-07-18T10:00:06Z'),
  ];
  const a = allocate(recs);
  assert.equal(a.invariant.ok, true);
  assert.equal(a.invariant.bucketTokenSum, a.invariant.dedupedTotal);
  // no request lost
  const reqSum = Object.values(a.buckets).reduce((n, b) => n + b.requests, 0);
  assert.equal(reqSum, a.requests);
});

test('duplicate assistant lines (same requestId) are not double-attributed', () => {
  const usage = U(1000, 100);
  const recs = [
    // one request, split across two assistant lines (thinking + tool_use), identical usage
    { type: 'assistant', requestId: 'r1', sessionId: 's1', timestamp: '2026-07-18T10:00:00Z', message: { role: 'assistant', id: 'r1', usage, content: [{ type: 'thinking', thinking: '...' }] } },
    asst('r1', 't1', 'Edit', usage, '2026-07-18T10:00:00Z'),
    editResult('t1', 'src/a.js', patch(3, 0)),
    asstReply('2026-07-18T10:00:05Z'),
  ];
  const a = allocate(recs);
  assert.equal(a.requests, 2); // r1 + the final reply
  assert.equal(a.invariant.ok, true);
  assert.equal(a.buckets.surviving.tokens.freshInput, 1000); // counted once, not 2000
});

test('failed-tool retries are counted (A5)', () => {
  const recs = [
    { type: 'assistant', requestId: 'r1', sessionId: 's1', timestamp: '2026-07-18T10:00:00Z', message: { role: 'assistant', id: 'r1', usage: U(1, 1), content: [{ type: 'tool_use', id: 'b1', name: 'Bash' }] } },
    { type: 'user', sessionId: 's1', timestamp: '2026-07-18T10:00:01Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'boom' }] } },
    { type: 'assistant', requestId: 'r2', sessionId: 's1', timestamp: '2026-07-18T10:00:02Z', message: { role: 'assistant', id: 'r2', usage: U(1, 1), content: [{ type: 'tool_use', id: 'b2', name: 'Bash' }] } }, // retry
    { type: 'user', sessionId: 's1', timestamp: '2026-07-18T10:00:03Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b2', content: 'ok' }] } },
  ];
  const { idToTool } = buildToolUseIndex(recs);
  const r = detectRetries(recs, idToTool);
  assert.equal(r.erroredResults, 1);
  assert.equal(r.retriedAfterError, 1);
});
