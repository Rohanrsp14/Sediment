import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'bin', 'sediment.mjs');

function run(args) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('report on a literal "~" path (unexpanded by PowerShell) fails loud, not with a silent zero report', () => {
  // This reproduces the real bug: PowerShell does not expand ~, so the CLI
  // receives the literal string "~/.claude/projects", which does not exist.
  const r = run(['report', '~/.claude/projects', '--html', '/tmp/should-not-be-written.html']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no \.jsonl files found/);
  assert.match(r.stderr, /PowerShell does NOT expand/);
});

test('report on a nonexistent absolute path fails loud with a clear message', () => {
  const r = run(['report', '/definitely/does/not/exist/anywhere', '--json']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no \.jsonl files found/);
  assert.match(r.stderr, /does not exist on disk/);
});

test('report on a real path with data succeeds (fixtures dir)', () => {
  const fixturesDir = path.join(here, '..', 'fixtures');
  const r = run(['report', fixturesDir, '--json']);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.ok(parsed.tokens.requests > 0);
});

test('doctor, tokens, cost, edits, allocation all fail loud on a bad path', () => {
  const bad = '/nope/not/a/real/path';
  for (const cmd of ['doctor', 'tokens', 'cost', 'edits', 'allocation']) {
    const r = run([cmd, bad]);
    assert.equal(r.code, 2, `expected exit 2 for '${cmd}'`);
    assert.match(r.stderr, /no \.jsonl files found/, `expected error message for '${cmd}'`);
  }
});
