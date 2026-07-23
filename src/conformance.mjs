/**
 * conformance.mjs — read-only schema-conformance scanner (CP0).
 *
 * Walks Claude Code JSONL transcripts and classifies every structural surface
 * (line types, roles, usage keys, content-block kinds, tool names, system
 * subtypes) against the registry in schema.mjs. It computes NO metrics — this is
 * pure structural inspection, kept deliberately separate from interpretation.
 *
 * Contract:
 *   - never writes anything, never mutates input files;
 *   - never throws on a malformed line — counts it and moves on;
 *   - `ok` is false iff any surface in FAIL_ON_UNKNOWN carried an unknown value.
 *
 * The point is to make schema drift a loud, catchable event instead of the
 * silent data loss a naive skip-unknown-and-move-on parser would exhibit.
 */
import {
  LINE_TYPES, ROLES, USAGE_KEYS, CONTENT_BLOCKS, SYSTEM_SUBTYPES, KNOWN_TOOLS,
} from './schema.mjs';
import { readRecords } from './parse.mjs';

function tallyInc(map, key, bucket) {
  const e = map.get(key) ?? { count: 0, bucket };
  e.count++;
  map.set(key, e);
}

/**
 * Scan one or more files. Returns a structured, machine-readable report.
 * `files` may be a single path (file or dir) or an array of paths.
 */
export function scanConformance(files) {
  const { files: scannedFiles, records, lines, parsed, unparseable } = readRecords(files);

  const lineTypes = new Map();      // type -> { count, bucket: handled|ignored|UNKNOWN }
  const roles = new Map();          // role -> { count, bucket }
  const usageKeys = new Map();      // key  -> { count, bucket: priced|recognizedUnused|UNKNOWN }
  const contentBlocks = new Map();  // kind -> { count, bucket }
  const systemSubtypes = new Map(); // subtype -> { count, bucket }
  const tools = new Map();          // name -> { count, bucket: known|unregistered }

  const drift = [];                 // human-readable drift notes worth surfacing
  const seenDrift = new Set();
  const noteDrift = (msg) => { if (!seenDrift.has(msg)) { seenDrift.add(msg); drift.push(msg); } };

  {
    for (const obj of records) {
      const type = obj?.type;
      const known = Object.prototype.hasOwnProperty.call(LINE_TYPES, type);
      tallyInc(lineTypes, String(type), known ? LINE_TYPES[type].status : 'UNKNOWN');
      if (known && LINE_TYPES[type].drift) noteDrift(LINE_TYPES[type].drift);

      if (type === 'system') {
        const sub = obj.subtype;
        if (sub != null) {
          const k = Object.prototype.hasOwnProperty.call(SYSTEM_SUBTYPES, sub);
          tallyInc(systemSubtypes, String(sub), k ? 'known' : 'unregistered');
        }
      }

      const m = obj?.message;
      if (m && typeof m === 'object') {
        if (m.role != null) {
          const k = Object.prototype.hasOwnProperty.call(ROLES, m.role);
          tallyInc(roles, String(m.role), k ? ROLES[m.role].status : 'UNKNOWN');
        }
        if (m.usage && typeof m.usage === 'object') {
          for (const key of Object.keys(m.usage)) {
            const k = Object.prototype.hasOwnProperty.call(USAGE_KEYS, key);
            tallyInc(usageKeys, key, k ? USAGE_KEYS[key].status : 'UNKNOWN');
          }
        }
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (!b || typeof b !== 'object') continue;
            const bt = b.type ?? 'text';
            const k = Object.prototype.hasOwnProperty.call(CONTENT_BLOCKS, bt);
            tallyInc(contentBlocks, String(bt), k ? CONTENT_BLOCKS[bt].status : 'UNKNOWN');
            if (bt === 'tool_use' && b.name != null) {
              tallyInc(tools, String(b.name), KNOWN_TOOLS.has(b.name) ? 'known' : 'unregistered');
            }
          }
        }
      }
    }
  }

  const unknowns = {
    lineType: [...lineTypes].filter(([, v]) => v.bucket === 'UNKNOWN').map(([k]) => k),
    role: [...roles].filter(([, v]) => v.bucket === 'UNKNOWN').map(([k]) => k),
    usageKey: [...usageKeys].filter(([, v]) => v.bucket === 'UNKNOWN').map(([k]) => k),
    contentBlock: [...contentBlocks].filter(([, v]) => v.bucket === 'UNKNOWN').map(([k]) => k),
  };
  const ok = Object.values(unknowns).every((a) => a.length === 0);

  const asObj = (map) => Object.fromEntries([...map].sort((a, b) => b[1].count - a[1].count));

  return {
    ok,
    scannedFiles,
    lines,
    parsed,
    unparseable,
    unknowns,
    drift,
    surfaces: {
      lineTypes: asObj(lineTypes),
      roles: asObj(roles),
      usageKeys: asObj(usageKeys),
      contentBlocks: asObj(contentBlocks),
      systemSubtypes: asObj(systemSubtypes),
      tools: asObj(tools),
    },
  };
}

/** Render a scan report as a compact human-readable string for the CLI. */
export function formatReport(r) {
  const L = [];
  L.push(`sediment doctor — schema conformance`);
  L.push(`  files ${r.scannedFiles}  lines ${r.lines}  parsed ${r.parsed}  unparseable ${r.unparseable}`);
  const line = (label, map, showBucket = true) => {
    const entries = Object.entries(map);
    if (!entries.length) return;
    L.push(`  ${label}:`);
    for (const [k, v] of entries) {
      L.push(`    ${String(v.count).padStart(6)}  ${k}${showBucket ? `  [${v.bucket}]` : ''}`);
    }
  };
  line('line types', r.surfaces.lineTypes);
  line('roles', r.surfaces.roles);
  line('usage keys', r.surfaces.usageKeys);
  line('content blocks', r.surfaces.contentBlocks);
  line('system subtypes', r.surfaces.systemSubtypes);
  line('tools', r.surfaces.tools);
  if (r.drift.length) {
    L.push(`  drift notes:`);
    for (const d of r.drift) L.push(`    • ${d}`);
  }
  L.push(r.ok
    ? `  RESULT: ok — every fail-critical surface is recognized`
    : `  RESULT: DRIFT — unknown ${JSON.stringify(r.unknowns)}`);
  return L.join('\n');
}
