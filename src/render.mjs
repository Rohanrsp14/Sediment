/**
 * render.mjs — self-contained HTML dashboard (CP6).
 *
 * A VIEW over the report snapshot: it reads report fields and formats them into
 * a stratigraphic "core-log" — the token allocation as a sediment core
 * (navigation = overburden on top, surviving edits = bedrock at the bottom).
 * It recomputes no metrics. Output is one offline HTML file, no dependencies,
 * no network. The embedded JSON is the same snapshot `sediment report --json`
 * emits, so the file is both a dashboard and its own data.
 */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nfmt = (x) => (x == null ? '—' : Number(x).toLocaleString('en-US'));
const pct = (x) => `${((x ?? 0) * 100).toFixed(1)}%`;
const usd = (x) => `$${Number(x ?? 0).toFixed(2)}`;

const STRATA = [
  { key: 'navigation', label: 'navigation & reasoning', role: 'overburden', color: '#CBC4AC' },
  { key: 'reworked', label: 'reworked / corrected', role: 'disturbed layer', color: '#CE9A46' },
  { key: 'abandoned', label: 'abandoned', role: 'washed out', color: '#5D6E77' },
  { key: 'surviving', label: 'surviving', role: 'bedrock', color: '#3E8E7E' },
];

const SEV = { good: '#3E8E7E', info: '#8794A0', attention: '#CE9A46' };

function coreColumn(buckets) {
  // strata top→bottom; height ∝ token share; keep a hairline for zero strata
  const seg = STRATA.map((s) => {
    const b = buckets[s.key] ?? {};
    const share = b.shareOfTokens ?? 0;
    const h = Math.max(share * 100, share > 0 ? 1.2 : 0.6);
    return { ...s, share, h, tokens: b.tokens?.totalTokens ?? 0, requests: b.requests ?? 0, edits: b.edits ?? 0, lines: b.changedLines ?? 0 };
  });
  const total = seg.reduce((n, s) => n + s.h, 0) || 1;
  const bands = seg.map((s, i) => `
    <div class="stratum" style="flex:${s.h / total};--c:${s.color};animation-delay:${i * 90}ms">
      <span class="stratum-share">${pct(s.share)}</span>
    </div>`).join('');
  const legend = seg.map((s) => `
    <li class="legrow">
      <span class="chip" style="--c:${s.color}"></span>
      <span class="legname">${esc(s.label)}<em>${esc(s.role)}</em></span>
      <span class="legnum">${pct(s.share)}<em>${nfmt(s.tokens)} tok · ${s.requests} req · ${s.edits} edits</em></span>
    </li>`).join('');
  return { bands, legend };
}

export function renderHtml(report) {
  const t = report.tokens, c = report.cost, e = report.edits, a = report.allocation;
  const { bands, legend } = coreColumn(a.buckets);
  const infl = t.inflation?.totalTokens;

  const hotspots = (e.byFile ?? []).filter((f) => f.editOps >= 2).slice(0, 6).map((f) => {
    const name = f.file.split('/').pop();
    return `<li class="file"><span class="fname" title="${esc(f.file)}">${esc(name)}</span>
      <span class="fbar"><span style="width:${Math.min(100, f.editOps / 6 * 100)}%"></span></span>
      <span class="fmeta">${f.editOps} ops · +${nfmt(f.additions)} / -${nfmt(f.deletions)}</span></li>`;
  }).join('');

  const notes = (report.guidance ?? []).map((g) => `
    <li class="note note--${esc(g.severity)}">
      <span class="note-sev" style="--c:${SEV[g.severity] ?? '#8794A0'}">${esc(g.severity)}</span>
      <div><p class="note-msg">${esc(g.message)}</p>
      <p class="note-sig">signal: ${esc(g.signal)}</p></div>
    </li>`).join('');

  const embedded = JSON.stringify(report).replace(/</g, '\\u003c');
  const when = new Date(report.generatedAt).toISOString().replace('T', ' ').slice(0, 16);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sediment — where did your tokens go?</title>
<style>
  :root{
    --bg:#0E1518; --panel:#141D21; --panel2:#18232830; --ink:#E9E6DC; --muted:#8794A0;
    --hair:#26333A; --teal:#3E8E7E; --amber:#CE9A46;
    --mono:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  }
  *{box-sizing:border-box} html,body{margin:0}
  body{background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.5;
    -webkit-font-smoothing:antialiased;padding:clamp(20px,4vw,52px)}
  .wrap{max-width:1080px;margin:0 auto}
  header{display:flex;justify-content:space-between;align-items:baseline;gap:16px;
    border-bottom:1px solid var(--hair);padding-bottom:18px;flex-wrap:wrap}
  .mark{font-family:var(--mono);font-size:13px;letter-spacing:.42em;font-weight:600;text-transform:uppercase}
  .mark b{color:var(--teal)}
  .tag{color:var(--muted);font-size:13px}
  .stamp{font-family:var(--mono);color:var(--muted);font-size:11px;letter-spacing:.06em}

  .grid{display:grid;grid-template-columns:300px 1fr;gap:clamp(22px,4vw,52px);margin-top:30px}
  @media(max-width:720px){.grid{grid-template-columns:1fr}}

  /* core column */
  .core-head{font-family:var(--mono);font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}
  .core{display:flex;gap:12px;height:clamp(340px,52vh,520px)}
  .depth{display:flex;flex-direction:column;justify-content:space-between;font-family:var(--mono);
    font-size:10px;color:var(--muted);text-align:right;padding:2px 0}
  .column{position:relative;flex:1;display:flex;flex-direction:column;border:1px solid var(--hair);
    border-radius:3px;overflow:hidden;background:#0b1013}
  .stratum{position:relative;background:var(--c);min-height:2px;
    display:flex;align-items:center;justify-content:flex-end;padding-right:9px;
    box-shadow:inset 0 -1px 0 #0006, inset 0 1px 0 #ffffff14;
    transform-origin:top;animation:settle .7s cubic-bezier(.2,.7,.2,1) both}
  .stratum-share{font-family:var(--mono);font-size:11px;color:#0d1417cc;font-weight:600;
    mix-blend-mode:luminosity;opacity:.85}
  @keyframes settle{from{transform:scaleY(0);opacity:.2}to{transform:scaleY(1);opacity:1}}
  @media(prefers-reduced-motion:reduce){.stratum{animation:none}}

  ul{list-style:none;margin:0;padding:0}
  .legend{margin-top:16px}
  .legrow{display:grid;grid-template-columns:12px 1fr auto;gap:10px;align-items:start;
    padding:9px 0;border-top:1px solid var(--hair)}
  .chip{width:12px;height:12px;border-radius:2px;background:var(--c);margin-top:3px}
  .legname{font-size:13px} .legname em{display:block;color:var(--muted);font-style:normal;font-size:11px;
    font-family:var(--mono);letter-spacing:.04em;text-transform:uppercase}
  .legnum{font-family:var(--mono);font-size:13px;text-align:right}
  .legnum em{display:block;color:var(--muted);font-style:normal;font-size:11px;margin-top:2px}

  /* readouts */
  .metrics{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--hair);
    border:1px solid var(--hair);border-radius:4px;overflow:hidden}
  .metric{background:var(--panel);padding:16px 18px}
  .metric .k{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
  .metric .v{font-family:var(--mono);font-size:clamp(20px,3.4vw,26px);margin-top:6px}
  .metric .v small{font-size:13px;color:var(--muted)}

  .callout{margin-top:18px;border-left:2px solid var(--teal);background:var(--panel2);
    padding:13px 16px;border-radius:0 4px 4px 0;font-size:13px}
  .callout b{font-family:var(--mono);color:var(--ink)}

  .sec{margin-top:30px}
  .sec h2{font-family:var(--mono);font-size:11px;letter-spacing:.2em;text-transform:uppercase;
    color:var(--muted);margin:0 0 12px;font-weight:600}

  .file{display:grid;grid-template-columns:1fr 88px auto;gap:12px;align-items:center;
    padding:8px 0;border-top:1px solid var(--hair);font-size:13px}
  .fname{font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .fbar{height:5px;background:#0b1013;border-radius:3px;overflow:hidden}
  .fbar span{display:block;height:100%;background:var(--amber)}
  .fmeta{font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap}

  .note{display:grid;grid-template-columns:auto 1fr;gap:14px;align-items:start;
    padding:12px 0;border-top:1px solid var(--hair)}
  .note-sev{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;
    color:var(--c);border:1px solid var(--c);border-radius:3px;padding:2px 7px;margin-top:2px}
  .note-msg{margin:0;font-size:13.5px}
  .note-sig{margin:5px 0 0;font-family:var(--mono);font-size:11px;color:var(--muted)}

  footer{margin-top:34px;border-top:1px solid var(--hair);padding-top:16px;
    display:flex;gap:10px 22px;flex-wrap:wrap;align-items:center;
    font-family:var(--mono);font-size:11px;color:var(--muted);letter-spacing:.03em}
  .ok{color:var(--teal)} .badge{color:var(--ink)}
</style></head>
<body><div class="wrap">
  <header>
    <div><div class="mark">Sedi<b>ment</b></div><div class="tag">where did your tokens go?</div></div>
    <div class="stamp">${esc(when)} UTC · ${nfmt(report.source?.lines)} log lines</div>
  </header>

  <div class="grid">
    <section aria-label="token allocation core">
      <p class="core-head">token core · by share</p>
      <div class="core">
        <div class="depth"><span>0%</span><span>25</span><span>50</span><span>75</span><span>100</span></div>
        <div class="column">${bands}</div>
      </div>
      <ul class="legend">${legend}</ul>
    </section>

    <section>
      <div class="metrics">
        <div class="metric"><div class="k">deduped tokens</div><div class="v">${nfmt(t.deduped.totalTokens)}</div></div>
        <div class="metric"><div class="k">api-equivalent</div><div class="v">${c ? usd(c.total) : '—'} <small>${c ? esc(c.currency) : ''}</small></div></div>
        <div class="metric"><div class="k">requests</div><div class="v">${nfmt(t.requests)} <small>/ ${nfmt(t.assistantLines)} lines</small></div></div>
        <div class="metric"><div class="k">code changed</div><div class="v">${nfmt(e.totals.editOps)} <small>edits · ${nfmt(e.totals.filesTouched)} files</small></div></div>
      </div>

      <div class="callout">Counting every log line naively would report
        <b>${infl ? infl.toFixed(2) + '×' : '—'}</b> more tokens — Claude Code stamps one
        request's usage on each split line. Sediment dedupes by <b>requestId</b>
        (${nfmt(t.assistantLines)}\u2009→\u2009${nfmt(t.requests)} requests).</div>

      <div class="sec">
        <h2>most reshaped files</h2>
        <ul>${hotspots || '<li class="file"><span class="fmeta">no repeated edits</span></li>'}</ul>
      </div>

      <div class="sec">
        <h2>what the signals say</h2>
        <ul>${notes}</ul>
      </div>
    </section>
  </div>

  <footer>
    <span class="badge ${a.invariant.ok ? 'ok' : ''}">${a.invariant.ok ? '✓ allocation reconciles to token total' : '✗ invariant broken'}</span>
    <span>retries ${a.retries.retriedAfterError}/${a.retries.erroredResults}</span>
    <span>userModified ${nfmt(e.totals.userModifiedOps)}</span>
    ${c ? `<span>coverage ${pct(c.coverage)}</span><span>pricing ${esc(c.pricingUpdatedAt ?? '—')} · estimate, not an invoice</span>` : ''}
  </footer>
</div>
<script type="application/json" id="sediment-data">${embedded}</script>
</body></html>`;
}
