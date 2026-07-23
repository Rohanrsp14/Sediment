/**
 * allocation.mjs — the token-allocation centerpiece (CP4). The product thesis:
 * "where did your tokens go?"
 *
 * Every deduped request's tokens are attributed to exactly ONE outcome bucket,
 * so the buckets sum precisely to the CP1 deduped total (asserted invariant).
 * This is a breakdown, not a score — each bucket is auditable to its requests.
 *
 * Buckets:
 *   surviving   — request produced edit(s), none reworked/corrected, session
 *                 completed. The work that stuck.
 *   reworked    — request produced an edit later superseded by a same-file edit
 *                 (A1) OR flagged userModified (A2, human had to fix it).
 *   abandoned   — request produced edit(s) in a session left hanging (its last
 *                 MEANINGFUL event was not an assistant reply, and not live) (A3).
 *   navigation  — request produced no edit: reads, bash, reasoning (A4). Not
 *                 waste per se — the cost of getting to an edit.
 * Plus a standalone counter (not a token bucket): A5 failed-tool retries.
 *
 * Attribution granularity is per-request: a request that both read files and
 * edited has ALL its tokens attributed to its edit's outcome. Stated honestly in
 * output. Precedence when a request has mixed edits: abandoned > reworked >
 * surviving (worst outcome wins), navigation only when there is no edit at all.
 *
 * Interprets records; reads no files.
 */
import { tokenAccounting, derive } from './tokens.mjs';
import { extractEdits } from './edits.mjs';

const MEANINGFUL = new Set(['user', 'assistant']);
const LIVE_MS = 5 * 60 * 1000;

/** tool_use block id -> { requestId, tool } from assistant lines. */
export function buildToolUseIndex(records) {
  const idToReq = new Map();
  const idToTool = new Map();
  for (const r of records) {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    for (const b of r.message.content) {
      if (b?.type === 'tool_use' && b.id) { idToReq.set(b.id, r.requestId); idToTool.set(b.id, b.name); }
    }
  }
  return { idToReq, idToTool };
}

/** Set of sessionIds that were abandoned (last meaningful event not an assistant reply, not live). */
export function detectAbandoned(records, now = Date.now()) {
  const lastMeaningful = new Map();
  const lastTs = new Map();
  const hasUser = new Map();
  for (const r of records) {
    if (r.sessionId && r.timestamp) {
      const t = Date.parse(r.timestamp);
      if (!Number.isNaN(t)) lastTs.set(r.sessionId, Math.max(lastTs.get(r.sessionId) ?? 0, t));
    }
    if (!MEANINGFUL.has(r.type)) continue;
    lastMeaningful.set(r.sessionId, r);
    if (r.message?.role === 'user') hasUser.set(r.sessionId, true);
  }
  const abandoned = new Set();
  for (const [sid, last] of lastMeaningful) {
    const live = (now - (lastTs.get(sid) ?? 0)) < LIVE_MS;
    if (hasUser.get(sid) && last.message?.role !== 'assistant' && !live) abandoned.add(sid);
  }
  return abandoned;
}

/**
 * Annotate each edit with an outcome: 'superseded' | 'corrected' | 'final'.
 * Within a (session, file), the last edit by timestamp is 'final'; earlier ones
 * are 'superseded'. Any userModified edit is 'corrected' regardless of position.
 */
export function classifyEditOutcomes(edits) {
  const groups = new Map();
  edits.forEach((e, i) => {
    const k = `${e.sessionId}::${e.file}`;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(i);
  });
  const outcome = new Array(edits.length).fill('final');
  for (const idxs of groups.values()) {
    idxs.sort((a, b) => {
      const ta = Date.parse(edits[a].timestamp ?? '') || 0;
      const tb = Date.parse(edits[b].timestamp ?? '') || 0;
      return ta - tb;
    });
    for (let j = 0; j < idxs.length - 1; j++) outcome[idxs[j]] = 'superseded';
  }
  edits.forEach((e, i) => { if (e.userModified) outcome[i] = 'corrected'; });
  return outcome;
}

const BUCKETS = ['surviving', 'reworked', 'abandoned', 'navigation'];

export function allocate(records, now = Date.now()) {
  const acc = tokenAccounting(records);
  const { edits } = extractEdits(records);
  const { idToReq, idToTool } = buildToolUseIndex(records);
  const abandoned = detectAbandoned(records, now);
  const outcomes = classifyEditOutcomes(edits);

  // requestId -> list of edit outcomes it produced
  const editsByReq = new Map();
  edits.forEach((e, i) => {
    const rid = e.toolUseId ? idToReq.get(e.toolUseId) : undefined;
    if (rid == null) return;
    (editsByReq.get(rid) ?? editsByReq.set(rid, []).get(rid)).push({ outcome: outcomes[i], changed: e.changedLines });
  });

  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, {
    requests: 0, edits: 0, changedLines: 0,
    tok: { freshInput: 0, cacheRead: 0, cacheCreation: 0, output: 0 },
  }]));

  const classify = (rid, sessionId) => {
    const es = editsByReq.get(rid);
    if (!es || es.length === 0) return 'navigation';
    if (abandoned.has(sessionId)) return 'abandoned';
    if (es.some((e) => e.outcome === 'superseded' || e.outcome === 'corrected')) return 'reworked';
    return 'surviving';
  };

  for (const [, r] of acc.byRequest) {
    const bucket = classify(r.requestId, r.sessionId);
    const b = buckets[bucket];
    b.requests += 1;
    const es = editsByReq.get(r.requestId) ?? [];
    b.edits += es.length;
    b.changedLines += es.reduce((n, e) => n + e.changed, 0);
    b.tok.freshInput += r.usage.freshInput; b.tok.cacheRead += r.usage.cacheRead;
    b.tok.cacheCreation += r.usage.cacheCreation; b.tok.output += r.usage.output;
  }

  // finalize derived token fields + shares
  const total = acc.deduped.totalTokens;
  const out = {};
  let bucketSum = 0;
  for (const name of BUCKETS) {
    const b = buckets[name];
    const d = derive(b.tok);
    bucketSum += d.totalTokens;
    out[name] = {
      requests: b.requests, edits: b.edits, changedLines: b.changedLines,
      tokens: d, shareOfTokens: total ? d.totalTokens / total : 0,
    };
  }

  // A5 — failed-tool retries (standalone; not a token bucket)
  const retries = detectRetries(records, idToTool);

  return {
    thesis: 'where did your tokens go',
    attribution: 'request-granularity (a request\'s full token cost is attributed to its edit outcome; no-edit requests are navigation)',
    totalTokens: total,
    requests: acc.requests,
    buckets: out,
    invariant: { bucketTokenSum: bucketSum, dedupedTotal: total, ok: bucketSum === total },
    retries,
  };
}

/** A5: errored tool results, and how many were retried (same tool later in session). */
export function detectRetries(records, idToTool) {
  let erroredResults = 0, retriedAfterError = 0;
  // collect, per session, the ordered list of tool_use (name) and errored tool_use_ids
  const bySession = new Map();
  for (const r of records) {
    if (!Array.isArray(r.message?.content)) continue;
    const s = bySession.get(r.sessionId) ?? { uses: [], errors: [] };
    for (const b of r.message.content) {
      if (b?.type === 'tool_use' && b.name) s.uses.push(b.name);
      if (b?.type === 'tool_result' && b.is_error === true) {
        erroredResults++;
        s.errors.push({ tool: idToTool.get(b.tool_use_id), atUseIndex: s.uses.length });
      }
    }
    bySession.set(r.sessionId, s);
  }
  for (const s of bySession.values()) {
    for (const err of s.errors) {
      if (err.tool && s.uses.slice(err.atUseIndex).includes(err.tool)) retriedAfterError++;
    }
  }
  return { erroredResults, retriedAfterError };
}

export function formatAllocation(a) {
  const n = (x) => x.toLocaleString('en-US');
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const bar = (share) => '█'.repeat(Math.round(share * 30)).padEnd(30, '·');
  const L = [
    'sediment allocation — where did your tokens go?',
    `  ${n(a.totalTokens)} deduped tokens across ${n(a.requests)} requests`,
    `  attribution: ${a.attribution}`,
    '',
  ];
  const order = ['surviving', 'reworked', 'abandoned', 'navigation'];
  const labels = { surviving: 'surviving', reworked: 'reworked/corrected', abandoned: 'abandoned', navigation: 'navigation/reasoning' };
  for (const k of order) {
    const b = a.buckets[k];
    L.push(`  ${labels[k].padEnd(20)} ${bar(b.shareOfTokens)} ${pct(b.shareOfTokens).padStart(6)}  ${n(b.tokens.totalTokens).padStart(12)} tok  ·  ${b.requests} req, ${b.edits} edits, ${n(b.changedLines)} lines`);
  }
  L.push('');
  L.push(`  invariant: buckets sum to deduped total — ${a.invariant.ok ? 'OK' : 'MISMATCH ' + a.invariant.bucketTokenSum + ' vs ' + a.invariant.dedupedTotal}`);
  L.push(`  failed-tool retries: ${a.retries.retriedAfterError} retried of ${a.retries.erroredResults} errored results`);
  return L.join('\n');
}
