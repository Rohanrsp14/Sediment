/**
 * parse.mjs — the one tolerant JSONL reader shared by every module.
 *
 * Read-only. Never throws on a malformed line: it counts it. This is the single
 * place raw bytes become objects; everything downstream (conformance, tokens,
 * cost, edits) consumes the result and never re-reads the file itself.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Recursively collect *.jsonl files under a file or directory (read-only). */
export function discoverJsonl(target, depth = 6) {
  let st;
  try { st = fs.statSync(target); } catch { return []; }
  if (st.isFile()) return target.endsWith('.jsonl') ? [target] : [];
  if (!st.isDirectory() || depth < 0) return [];
  let names = [];
  try { names = fs.readdirSync(target); } catch { return []; }
  return names.flatMap((n) => discoverJsonl(path.join(target, n), depth - 1));
}

/**
 * Read one file into parsed records.
 * Returns { records, lines, parsed, unparseable }.
 */
export function readFileRecords(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { records: [], lines: 0, parsed: 0, unparseable: 0 }; }
  const records = [];
  let lines = 0, unparseable = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    lines++;
    try { records.push(JSON.parse(line)); } catch { unparseable++; }
  }
  return { records, lines, parsed: records.length, unparseable };
}

/**
 * Read one or more paths (files or dirs) into a flat record list, tagging each
 * record with its source `__file` for traceability without mutating semantics.
 */
export function readRecords(target) {
  const files = (Array.isArray(target) ? target : [target]).flatMap((t) => discoverJsonl(t));
  const out = { files: files.length, records: [], lines: 0, parsed: 0, unparseable: 0 };
  for (const file of files) {
    const r = readFileRecords(file);
    for (const rec of r.records) { rec.__file = file; out.records.push(rec); }
    out.lines += r.lines; out.parsed += r.parsed; out.unparseable += r.unparseable;
  }
  return out;
}
