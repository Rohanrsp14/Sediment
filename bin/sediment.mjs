#!/usr/bin/env node
/**
 * sediment — where did your tokens go?
 *
 * CLI entry point. Grows one subcommand per checkpoint; the dashboard UI (later)
 * is a view over this CLI's JSON output, never a second source of truth.
 *
 * CP0 subcommand:
 *   sediment doctor [path]   schema-conformance scan (default path: ~/.claude/projects)
 *     --json                 emit the machine-readable report instead of text
 *
 * Exit codes:  0 = conformant   1 = schema drift found   2 = usage error
 */
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { scanConformance, formatReport } from '../src/conformance.mjs';
import { readRecords } from '../src/parse.mjs';
import { tokenAccounting, auditRequest, formatTokens } from '../src/tokens.mjs';
import { costAccounting, loadPricing, formatCost } from '../src/cost.mjs';
import { extractEdits, formatEdits } from '../src/edits.mjs';
import { allocate, formatAllocation } from '../src/allocation.mjs';
import { buildReport, validateReport, formatReport as formatFullReport, REPORT_SCHEMA, SCHEMA_VERSION } from '../src/report.mjs';
import { renderHtml } from '../src/render.mjs';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));

function flagValue(rest, name) {
  const i = rest.indexOf(name);
  return i !== -1 && rest[i + 1] ? rest[i + 1] : null;
}

function defaultClaudeRoot() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

const KNOWN_COMMANDS = new Set(['doctor', 'tokens', 'cost', 'edits', 'allocation', 'alloc', 'report', 'schema', 'help']);
const looksLikePath = (s) => typeof s === 'string' && !s.startsWith('-');

/**
 * Fail loud, not quiet: if a target path resolves to zero readable .jsonl
 * files, that's almost always a wrong/unexpanded path (e.g. a literal `~` on
 * Windows, where PowerShell doesn't expand it) rather than "genuinely no
 * data." Print a clear diagnostic instead of silently rendering an all-zero
 * report. Returns true if it printed an error (caller should exit 2).
 */
function warnIfNoFiles(target, fileCount) {
  if (fileCount > 0) return false;
  const exists = fs.existsSync(target);
  process.stderr.write(
    `sediment: no .jsonl files found under "${target}"\n` +
    (exists
      ? '  the path exists but contains no .jsonl files (or none within 6 directory levels)\n'
      : `  this path does not exist on disk.${target.startsWith('~') ? ' note: "~" is a shell shortcut — PowerShell does NOT expand it. Use $env:USERPROFILE\\.claude\\projects on Windows, or omit the path to use the default.\n' : '\n'}`)
  );
  return true;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const json = rest.includes('--json');
  const positional = rest.filter((a) => !a.startsWith('--'));

  if (cmd === 'doctor') {
    const target = positional[0] || defaultClaudeRoot();
    const report = scanConformance(target);
    if (warnIfNoFiles(target, report.scannedFiles)) return 2;
    if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else process.stdout.write(formatReport(report) + '\n');
    return report.ok ? 0 : 1;
  }

  if (cmd === 'tokens') {
    const target = positional[0] || defaultClaudeRoot();
    const { records, files } = readRecords(target);
    if (warnIfNoFiles(target, files)) return 2;
    const acc = tokenAccounting(records);
    const auditId = flagValue(rest, '--audit');
    if (auditId) {
      const r = auditRequest(acc, auditId);
      const payload = { requestId: auditId, audit: r };
      process.stdout.write((json ? JSON.stringify(payload, null, 2) : JSON.stringify(payload.audit, null, 2)) + '\n');
      return r ? 0 : 1;
    }
    // byRequest is a Map (audit index) — drop it from serialized/summary output
    const { byRequest, ...summary } = acc;
    if (json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    else process.stdout.write(formatTokens(acc) + '\n');
    return 0;
  }

  if (cmd === 'cost') {
    const target = positional[0] || defaultClaudeRoot();
    const pricingPath = flagValue(rest, '--pricing')
      || process.env.SEDIMENT_PRICING
      || path.join(here, '..', 'pricing.json');
    const pricing = loadPricing(pricingPath);
    if (!pricing) { process.stderr.write(`could not read pricing table: ${pricingPath}\n`); return 2; }
    const { records, files } = readRecords(target);
    if (warnIfNoFiles(target, files)) return 2;
    const c = costAccounting(records, pricing);
    if (json) process.stdout.write(JSON.stringify(c, null, 2) + '\n');
    else process.stdout.write(formatCost(c) + '\n');
    return 0;
  }

  if (cmd === 'edits') {
    const target = positional[0] || defaultClaudeRoot();
    const { records, files } = readRecords(target);
    if (warnIfNoFiles(target, files)) return 2;
    const r = extractEdits(records);
    if (json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    else process.stdout.write(formatEdits(r) + '\n');
    return 0;
  }

  if (cmd === 'allocation' || cmd === 'alloc') {
    const target = positional[0] || defaultClaudeRoot();
    const { records, files } = readRecords(target);
    if (warnIfNoFiles(target, files)) return 2;
    const a = allocate(records);
    if (json) process.stdout.write(JSON.stringify(a, null, 2) + '\n');
    else process.stdout.write(formatAllocation(a) + '\n');
    return a.invariant.ok ? 0 : 1;
  }

  if (cmd === 'report' || cmd === undefined || (looksLikePath(cmd) && !KNOWN_COMMANDS.has(cmd))) {
    // `sediment report [path]`, bare `sediment`, or `sediment <path>` → full snapshot
    const target = (cmd === 'report' ? positional[0] : cmd) || defaultClaudeRoot();
    const pricingPath = flagValue(rest, '--pricing') || process.env.SEDIMENT_PRICING || path.join(here, '..', 'pricing.json');
    const pricing = loadPricing(pricingPath);
    const { records, files, lines, parsed, unparseable } = readRecords(target);
    if (warnIfNoFiles(target, files)) return 2;
    const report = buildReport(records, pricing, { files, lines, parsed, unparseable });
    const outPath = flagValue(rest, '--out');
    const htmlPath = flagValue(rest, '--html');
    if (htmlPath) { fs.writeFileSync(htmlPath, renderHtml(report)); process.stdout.write(`dashboard written: ${htmlPath}\n`); return report.allocation.invariant.ok ? 0 : 1; }
    if (outPath) { fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n'); process.stdout.write(`snapshot written: ${outPath}\n`); return 0; }
    if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else process.stdout.write(formatFullReport(report) + '\n');
    return report.allocation.invariant.ok ? 0 : 1;
  }

  if (cmd === 'schema') {
    process.stdout.write(JSON.stringify({ schemaVersion: SCHEMA_VERSION, schema: REPORT_SCHEMA }, null, 2) + '\n');
    return 0;
  }

  const help = [
    'sediment — where did your tokens go?',
    '',
    'usage:',
    '  sediment [path] [--json] [--out f]           full snapshot (default command)',
    '  sediment report [path] [--json] [--out f] [--html f]   snapshot; --html writes the dashboard',
    '  sediment doctor [path] [--json]              schema-conformance scan of Claude Code logs',
    '  sediment tokens [path] [--json]              deduped token accounting',
    '  sediment tokens [path] --audit <requestId>   collapse one request for a by-hand audit',
    '  sediment cost [path] [--json] [--pricing p]  API-equivalent cost with coverage',
    '  sediment edits [path] [--json]               code changes reconstructed from applied diffs',
    '  sediment allocation [path] [--json]          where did your tokens go? (the centerpiece)',
    '  sediment schema                              print the machine-readable output contract',
    '',
    `default path: ${defaultClaudeRoot()}`,
  ].join('\n');
  process.stdout.write(help + '\n');
  return cmd ? 2 : 0;
}

process.exit(main(process.argv.slice(2)));
