/**
 * edits.mjs — code-change reconstruction (CP3).
 *
 * Ground truth for what an agent actually changed lives in the tool RESULT, not
 * the tool arguments the reference parses. Claude Code writes, per edit, a
 * `toolUseResult` carrying:
 *   - filePath        the file touched (its presence is what marks an edit)
 *   - structuredPatch the applied unified-diff hunks (the real minimal diff)
 *   - originalFile    prior contents (present for updates)
 *   - content         full new contents (present for writes/creates)
 *   - userModified    whether the human then changed the agent's output  ← CP4 crown jewel
 *   - type            'create' | 'update' | (absent for Edit)
 *
 * Reconstruction rule (each edit records the `method` used, for traceability):
 *   1. non-empty structuredPatch → additions = '+' lines, deletions = '-' lines
 *      across all hunks. This is the actual applied diff.               [structuredPatch]
 *   2. empty patch + content (new file) → additions = content lines, deletions = 0. [new-file]
 *   3. empty patch, no content → 0/0, recorded as unreconstructed.      [empty]
 *
 * We never guess from tool arguments: on real Claude Code data every edit has a
 * structured result. If a future format lacks one, method='empty' makes that
 * visible rather than silently miscounting.
 *
 * Interprets records from parse.mjs; reads no files itself.
 */

export function lineCount(value) {
  if (typeof value !== 'string' || value.length === 0) return 0;
  const s = value.replace(/\r\n/g, '\n');
  const n = s.split('\n').length;
  return s.endsWith('\n') ? n - 1 : n;
}

/** additions/deletions from a structuredPatch (array of hunks with `lines`). */
export function countPatch(structuredPatch) {
  let additions = 0, deletions = 0;
  for (const hunk of structuredPatch ?? []) {
    for (const line of hunk.lines ?? []) {
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }
  }
  return { additions, deletions };
}

const dirOf = (p) => {
  const norm = String(p).replaceAll('\\', '/');
  const i = norm.lastIndexOf('/');
  return i <= 0 ? '.' : norm.slice(0, i);
};

/** Reconstruct one edit from a record whose toolUseResult has a filePath. */
export function editFromRecord(rec) {
  const tur = rec.toolUseResult;
  if (!tur || typeof tur !== 'object' || typeof tur.filePath !== 'string') return null;

  const patch = Array.isArray(tur.structuredPatch) ? tur.structuredPatch : null;
  let additions = 0, deletions = 0, method;
  if (patch && patch.length) {
    ({ additions, deletions } = countPatch(patch));
    method = 'structuredPatch';
  } else if (typeof tur.content === 'string' && !tur.originalFile) {
    additions = lineCount(tur.content); deletions = 0; method = 'new-file';
  } else {
    method = 'empty'; // empty patch with no reconstructable content
  }

  // op: prefer the result's declared type; else infer from shape
  const op = tur.type ?? (('newString' in tur || 'oldString' in tur) ? 'edit' : 'write');

  // link to the originating tool_use (for CP4 token attribution) via tool_result block
  let toolUseId = null;
  const content = rec.message?.content;
  if (Array.isArray(content)) {
    const tr = content.find((b) => b && (b.type === 'tool_result') && b.tool_use_id);
    if (tr) toolUseId = tr.tool_use_id;
  }

  return {
    file: tur.filePath.replaceAll('\\', '/'),
    directory: dirOf(tur.filePath),
    sessionId: rec.sessionId ?? '(no-session)',
    timestamp: rec.timestamp ?? null,
    op,
    additions,
    deletions,
    changedLines: additions + deletions,
    userModified: Boolean(tur.userModified),
    method,
    toolUseId,
  };
}

/** Reconstruct all edits and aggregate by file and directory. */
export function extractEdits(records) {
  const edits = [];
  for (const rec of records) {
    const e = editFromRecord(rec);
    if (e) edits.push(e);
  }

  const files = new Map();
  const dirs = new Map();
  for (const e of edits) {
    const f = files.get(e.file) ?? { file: e.file, directory: e.directory, additions: 0, deletions: 0, editOps: 0, userModifiedOps: 0, sessions: new Set() };
    f.additions += e.additions; f.deletions += e.deletions; f.editOps += 1;
    if (e.userModified) f.userModifiedOps += 1;
    f.sessions.add(e.sessionId);
    files.set(e.file, f);

    const d = dirs.get(e.directory) ?? { directory: e.directory, additions: 0, deletions: 0, editOps: 0, files: new Set() };
    d.additions += e.additions; d.deletions += e.deletions; d.editOps += 1; d.files.add(e.file);
    dirs.set(e.directory, d);
  }

  const byFile = [...files.values()].map((f) => ({
    file: f.file, directory: f.directory, additions: f.additions, deletions: f.deletions,
    changedLines: f.additions + f.deletions, editOps: f.editOps, userModifiedOps: f.userModifiedOps,
    sessions: f.sessions.size,
  })).sort((a, b) => b.changedLines - a.changedLines || b.editOps - a.editOps);

  const byDirectory = [...dirs.values()].map((d) => ({
    directory: d.directory, additions: d.additions, deletions: d.deletions,
    changedLines: d.additions + d.deletions, editOps: d.editOps, files: d.files.size,
  })).sort((a, b) => b.changedLines - a.changedLines);

  const totals = {
    editOps: edits.length,
    filesTouched: files.size,
    additions: edits.reduce((n, e) => n + e.additions, 0),
    deletions: edits.reduce((n, e) => n + e.deletions, 0),
    changedLines: edits.reduce((n, e) => n + e.changedLines, 0),
    userModifiedOps: edits.filter((e) => e.userModified).length,
    byMethod: edits.reduce((m, e) => { m[e.method] = (m[e.method] ?? 0) + 1; return m; }, {}),
  };

  return { edits, byFile, byDirectory, totals };
}

export function formatEdits(r) {
  const n = (x) => x.toLocaleString('en-US');
  const t = r.totals;
  const L = [
    'sediment edits — code changes reconstructed from applied diffs',
    `  ${n(t.editOps)} edit ops · ${n(t.filesTouched)} files · +${n(t.additions)} / -${n(t.deletions)} lines`,
    `  human-modified edits (userModified): ${n(t.userModifiedOps)}`,
    `  reconstruction method: ${Object.entries(t.byMethod).map(([k, v]) => `${k}=${v}`).join('  ')}`,
    '  top files by lines changed:',
  ];
  for (const f of r.byFile.slice(0, 10)) {
    L.push(`    +${String(f.additions).padStart(5)} / -${String(f.deletions).padStart(5)}  ${f.file}  (${f.editOps} ops${f.userModifiedOps ? `, ${f.userModifiedOps} human-modified` : ''})`);
  }
  return L.join('\n');
}
