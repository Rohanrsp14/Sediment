/**
 * tokens.mjs — deduped token accounting (CP1). The flagship correctness fix.
 *
 * Claude Code splits one assistant API response across several JSONL lines (one
 * per content block) and stamps the SAME `usage` on each line. Summing usage
 * per line therefore multiplies a request's tokens by its line count. Verified
 * on a real transcript: 485 assistant lines collapse to 258 requests, and the
 * naive per-line sum over-counts billed input ~1.88x and output ~2.29x.
 *
 * We deduplicate by `requestId` (one API request = one billing event), keeping
 * exactly one usage per request. Verified invariant on real data: every line of
 * a given requestId carries identical usage, so first-seen is exact — but we
 * still detect and count any divergence rather than assume it can't happen.
 *
 * Fallback key order: requestId -> message.id -> a per-line unique key (so a
 * line lacking both is counted once, never silently dropped).
 *
 * This module interprets; it does not read files. Feed it records from parse.mjs.
 */

const ZERO = () => ({ freshInput: 0, cacheRead: 0, cacheCreation: 0, output: 0 });

/** Extract the four priced usage counts from an assistant record, or null. */
export function usageOf(rec) {
  if (rec?.type !== 'assistant') return null;
  const u = rec.message?.usage;
  if (!u || typeof u !== 'object') return null;
  return {
    freshInput: u.input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheCreation: u.cache_creation_input_tokens || 0,
    output: u.output_tokens || 0,
  };
}

const addInto = (acc, u) => {
  acc.freshInput += u.freshInput; acc.cacheRead += u.cacheRead;
  acc.cacheCreation += u.cacheCreation; acc.output += u.output;
};

const sig = (u) => `${u.freshInput}|${u.cacheRead}|${u.cacheCreation}|${u.output}`;

/** Derived totals so no caller has to recombine the buckets by hand. */
export function derive(t) {
  const billedInput = t.freshInput + t.cacheRead + t.cacheCreation;
  return { ...t, billedInput, totalTokens: billedInput + t.output };
}

/**
 * Core accounting. Returns deduped totals (the truth), the naive per-line sum
 * (kept only as a regression guard proving dedupe is active), the inflation
 * factors between them, a per-session breakdown, and a per-request index for
 * auditing a single requestId by hand.
 */
export function tokenAccounting(records) {
  const deduped = ZERO();
  const naive = ZERO();
  const seen = new Map();          // key -> usage signature (first seen)
  const byRequest = new Map();     // key -> { requestId, sessionId, model, lines, usage }
  const bySession = new Map();     // sessionId -> { deduped, requests:Set }
  let assistantLines = 0;
  let linesMissingRequestId = 0;
  let divergentRequests = 0;

  records.forEach((rec, i) => {
    const u = usageOf(rec);
    if (!u) return;
    assistantLines++;
    addInto(naive, u); // every line, unconditionally — this is the "wrong" number

    if (!rec.requestId) linesMissingRequestId++;
    const key = rec.requestId ?? rec.message?.id ?? `__line_${i}`;

    if (!seen.has(key)) {
      seen.set(key, sig(u));
      addInto(deduped, u);
      const sid = rec.sessionId ?? '(no-session)';
      byRequest.set(key, { requestId: rec.requestId ?? null, sessionId: sid, model: rec.message?.model ?? null, timestamp: rec.timestamp ?? null, lines: 1, usage: u });
      const s = bySession.get(sid) ?? { deduped: ZERO(), requests: new Set() };
      addInto(s.deduped, u); s.requests.add(key); bySession.set(sid, s);
    } else {
      byRequest.get(key).lines++;
      if (seen.get(key) !== sig(u)) divergentRequests++; // first-seen wins; we just flag it
    }
  });

  const requests = seen.size;
  const factor = (a, b) => (b > 0 ? a / b : null);
  const dd = derive(deduped);
  const nv = derive(naive);

  return {
    assistantLines,
    requests,
    linesMissingRequestId,
    divergentRequests,
    deduped: dd,
    naive: nv,
    inflation: {
      billedInput: factor(nv.billedInput, dd.billedInput),
      output: factor(nv.output, dd.output),
      totalTokens: factor(nv.totalTokens, dd.totalTokens),
    },
    bySession: [...bySession].map(([sessionId, v]) => ({
      sessionId, requests: v.requests.size, ...derive(v.deduped),
    })).sort((a, b) => b.totalTokens - a.totalTokens),
    byRequest,
  };
}

/** Pull one request's collapsed usage for a by-hand audit. */
export function auditRequest(acc, requestId) {
  for (const [, r] of acc.byRequest) if (r.requestId === requestId) return r;
  return null;
}

/** Compact human-readable rendering for the CLI. */
export function formatTokens(acc) {
  const n = (x) => x.toLocaleString('en-US');
  const x = (f) => (f == null ? '—' : `${f.toFixed(2)}x`);
  return [
    'sediment tokens — deduped accounting',
    `  assistant lines ${n(acc.assistantLines)}  →  requests ${n(acc.requests)}   (dedup by requestId)`,
    acc.linesMissingRequestId ? `  lines missing requestId (used fallback key): ${n(acc.linesMissingRequestId)}` : '  lines missing requestId: 0',
    acc.divergentRequests ? `  ⚠ requests with divergent per-line usage: ${n(acc.divergentRequests)} (first-seen kept)` : '  divergent per-line usage: none',
    '',
    '  DEDUPED (the real numbers):',
    `    fresh input      ${n(acc.deduped.freshInput)}`,
    `    cache read       ${n(acc.deduped.cacheRead)}`,
    `    cache creation   ${n(acc.deduped.cacheCreation)}`,
    `    billed input     ${n(acc.deduped.billedInput)}`,
    `    output           ${n(acc.deduped.output)}`,
    `    total tokens     ${n(acc.deduped.totalTokens)}`,
    '',
    '  NAIVE per-line sum (what the reference ships) and inflation:',
    `    billed input     ${n(acc.naive.billedInput)}   (${x(acc.inflation.billedInput)})`,
    `    output           ${n(acc.naive.output)}   (${x(acc.inflation.output)})`,
    `    total tokens     ${n(acc.naive.totalTokens)}   (${x(acc.inflation.totalTokens)})`,
  ].join('\n');
}
