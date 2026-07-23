import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from '../src/parse.mjs';
import { extractEdits, editFromRecord, countPatch, lineCount } from '../src/edits.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLEAN = path.join(here, '..', 'fixtures', 'clean-session.jsonl');

// a user record carrying a toolUseResult for an edit
const editResult = (filePath, tur, sessionId = 's1', ts = '2026-07-18T10:00:00Z') => ({
  type: 'user', sessionId, timestamp: ts, toolUseResult: { filePath, ...tur },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
});
const hunk = (lines) => ({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines });

test('lineCount ignores a single trailing newline', () => {
  assert.equal(lineCount('a\nb\nc'), 3);
  assert.equal(lineCount('a\nb\nc\n'), 3);
  assert.equal(lineCount(''), 0);
});

test('countPatch counts + and - lines, ignoring context', () => {
  const sp = [hunk([' ctx', '-old', '+new1', '+new2'])];
  assert.deepEqual(countPatch(sp), { additions: 2, deletions: 1 });
});

test('an Edit is reconstructed from its structuredPatch', () => {
  const rec = editResult('src/a.js', {
    oldString: 'x', newString: 'y', originalFile: 'x\n', userModified: false,
    structuredPatch: [hunk([' keep', '-old', '+new', '+extra'])],
  });
  const e = editFromRecord(rec);
  assert.equal(e.method, 'structuredPatch');
  assert.equal(e.additions, 2);
  assert.equal(e.deletions, 1);
  assert.equal(e.file, 'src/a.js');
  assert.equal(e.toolUseId, 't1');
});

test('a new-file Write (empty patch, content) counts content lines as additions', () => {
  const rec = editResult('src/new.js', {
    type: 'create', content: 'line1\nline2\nline3', userModified: false, structuredPatch: [],
  });
  const e = editFromRecord(rec);
  assert.equal(e.method, 'new-file');
  assert.equal(e.additions, 3);
  assert.equal(e.deletions, 0);
  assert.equal(e.op, 'create');
});

test('userModified is captured as a ground-truth signal', () => {
  const rec = editResult('src/a.js', { userModified: true, structuredPatch: [hunk(['+x'])] });
  assert.equal(editFromRecord(rec).userModified, true);
});

test('non-edit results (no filePath) are ignored', () => {
  const bash = { type: 'user', sessionId: 's', toolUseResult: { stdout: 'hi', stderr: '', interrupted: false } };
  const read = { type: 'user', sessionId: 's', toolUseResult: { file: 'x', type: 'text' } };
  assert.equal(editFromRecord(bash), null);
  assert.equal(editFromRecord(read), null);
});

test('edits aggregate by file with sessions and userModified counts', () => {
  const recs = [
    editResult('src/a.js', { structuredPatch: [hunk(['+1', '+2', '-3'])], userModified: false }, 's1'),
    editResult('src/a.js', { structuredPatch: [hunk(['+4'])], userModified: true }, 's2'),
    editResult('src/b.js', { type: 'create', content: 'x\ny', structuredPatch: [] }, 's1'),
  ];
  const r = extractEdits(recs);
  assert.equal(r.totals.editOps, 3);
  assert.equal(r.totals.filesTouched, 2);
  assert.equal(r.totals.additions, 2 + 1 + 2); // 5
  assert.equal(r.totals.deletions, 1);
  assert.equal(r.totals.userModifiedOps, 1);
  const a = r.byFile.find((f) => f.file === 'src/a.js');
  assert.equal(a.editOps, 2);
  assert.equal(a.sessions, 2);       // touched across two sessions
  assert.equal(a.userModifiedOps, 1);
});

test('the clean fixture Edit reconstructs to +2/-1', () => {
  const { records } = readRecords(CLEAN);
  const r = extractEdits(records);
  assert.equal(r.totals.editOps, 1);
  const f = r.byFile[0];
  assert.equal(f.file, 'src/parser.js');
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 1);
});
