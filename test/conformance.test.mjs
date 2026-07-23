import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanConformance } from '../src/conformance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLEAN = path.join(here, '..', 'fixtures', 'clean-session.jsonl');

/** Write lines to a throwaway temp .jsonl and return its path. */
function tempJsonl(lines) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sediment-')), 'x.jsonl');
  fs.writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return p;
}

test('clean fixture is fully conformant', () => {
  const r = scanConformance(CLEAN);
  assert.equal(r.ok, true);
  assert.equal(r.unparseable, 0);
  assert.deepEqual(r.unknowns, { lineType: [], role: [], usageKey: [], contentBlock: [] });
});

test('every recognized surface is classified into a known bucket', () => {
  const r = scanConformance(CLEAN);
  // ignored line types stay known, not unknown
  assert.equal(r.surfaces.lineTypes['mode'].bucket, 'ignored');
  assert.equal(r.surfaces.lineTypes['ai-title'].bucket, 'handled');
  // priced vs recognized-but-unused usage keys are distinguished
  assert.equal(r.surfaces.usageKeys['input_tokens'].bucket, 'priced');
  assert.equal(r.surfaces.usageKeys['service_tier'].bucket, 'recognizedUnused');
  // content blocks all handled
  for (const b of ['thinking', 'text', 'tool_use', 'tool_result']) {
    assert.equal(r.surfaces.contentBlocks[b].bucket, 'handled');
  }
});

test('the queue-operation drift note is surfaced', () => {
  const r = scanConformance(CLEAN);
  assert.ok(r.drift.some((d) => d.includes('queue-operation')));
});

test('an unregistered tool name is reported but does NOT fail conformance', () => {
  const r = scanConformance(CLEAN);
  assert.equal(r.surfaces.tools['CustomMcpTool'].bucket, 'unregistered');
  assert.equal(r.surfaces.tools['Edit'].bucket, 'known');
  assert.equal(r.ok, true); // open tool set never fails the build
});

test('an unknown top-level type fails loudly', () => {
  const p = tempJsonl([
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'brand-new-line-type', sessionId: 's1' },
  ]);
  const r = scanConformance(p);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknowns.lineType, ['brand-new-line-type']);
});

test('an unknown usage key fails loudly', () => {
  const p = tempJsonl([
    { type: 'assistant', requestId: 'r', message: { role: 'assistant', usage: { input_tokens: 1, mystery_tokens: 9 }, content: [] } },
  ]);
  const r = scanConformance(p);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknowns.usageKey, ['mystery_tokens']);
});

test('an unknown content block fails loudly', () => {
  const p = tempJsonl([
    { type: 'assistant', requestId: 'r', message: { role: 'assistant', content: [{ type: 'hologram', data: 1 }] } },
  ]);
  const r = scanConformance(p);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknowns.contentBlock, ['hologram']);
});

test('an unknown role fails loudly', () => {
  const p = tempJsonl([
    { type: 'user', message: { role: 'oracle', content: [] } },
  ]);
  const r = scanConformance(p);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknowns.role, ['oracle']);
});

test('malformed lines are counted, never thrown, and do not by themselves fail conformance', () => {
  const p = tempJsonl([
    '{ this is not json',
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'ok' }] } }),
  ]);
  const r = scanConformance(p);
  assert.equal(r.unparseable, 1);
  assert.equal(r.parsed, 1);
  assert.equal(r.ok, true);
});
