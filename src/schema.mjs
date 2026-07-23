/**
 * schema.mjs — the single source of truth for every Claude Code transcript
 * surface Sediment recognizes.
 *
 * Design principle (the CP0 thesis): unknown structure must FAIL LOUDLY, not be
 * silently skipped. A parser that silently drops any line type it doesn't
 * recognize is exactly how a new token- or edit-bearing `type` disappears
 * from the totals with no warning. Sediment declares every surface here and the
 * conformance scanner (conformance.mjs) treats anything absent from this file as
 * schema drift to surface, never to swallow.
 *
 * Every entry is verified against a real ~/.claude/projects transcript
 * (1,081 lines, Claude Code, model claude-sonnet-5). See conformance report.
 *
 * "handled"  = we extract signal from this surface.
 * "ignored"  = we deliberately drop it, with a stated reason. Still *known*.
 * absent     = drift. Scanner flags it; the build does not guess.
 */

/** Top-level line `type` values. */
export const LINE_TYPES = {
  // ── handled: signal-bearing ────────────────────────────────────────────────
  assistant: { status: 'handled', note: 'tokens, model, reasoning, tool calls (edits)' },
  user: { status: 'handled', note: 'prompts and tool results' },
  system: { status: 'handled', note: 'meta lines; carries subtypes (see SYSTEM_SUBTYPES)' },
  'ai-title': { status: 'handled', note: 'human-readable session label' },

  // ── ignored: deliberately dropped, reason recorded ─────────────────────────
  mode: { status: 'ignored', note: 'editor mode UI state; no metric value' },
  'permission-mode': { status: 'ignored', note: 'permission UI state; no metric value' },
  'last-prompt': { status: 'ignored', note: 'resume-UI echo of a user prompt; would double-count' },
  attachment: { status: 'ignored', note: 'attachment payloads; content not needed for metrics' },
  'file-history-snapshot': { status: 'ignored', note: "editor file-history feature; not the agent's edits" },
  'file-history-delta': { status: 'ignored', note: "editor file-history feature; not the agent's edits" },
  'queue-operation': {
    status: 'ignored',
    note: 'prompt-queue bookkeeping; no metric value',
    drift: "this type appears as 'queue-operation' in real transcripts, not 'queued-prompt' — worth knowing if you've seen the latter name used elsewhere",
  },
};

/** `message.role` values. */
export const ROLES = {
  user: { status: 'handled' },
  assistant: { status: 'handled' },
};

/**
 * `message.usage.*` keys.
 *   priced           = drives API-equivalent cost (CP2).
 *   recognizedUnused = present in real logs, intentionally not used (yet).
 */
export const USAGE_KEYS = {
  input_tokens: { status: 'priced' },
  output_tokens: { status: 'priced' },
  cache_read_input_tokens: { status: 'priced' },
  cache_creation_input_tokens: { status: 'priced' },
  server_tool_use: { status: 'recognizedUnused', note: 'server-side tool usage breakdown' },
  service_tier: { status: 'recognizedUnused', note: 'billing tier label' },
  cache_creation: { status: 'recognizedUnused', note: 'ephemeral cache-creation breakdown by TTL' },
  inference_geo: { status: 'recognizedUnused', note: 'inference region' },
  iterations: { status: 'recognizedUnused', note: 'internal iteration count' },
  speed: { status: 'recognizedUnused', note: 'throughput annotation' },
};

/** `message.content[].type` block kinds. */
export const CONTENT_BLOCKS = {
  text: { status: 'handled' },
  thinking: { status: 'handled', note: 'assistant reasoning' },
  redacted_thinking: { status: 'handled', note: 'reasoning withheld by the API' },
  tool_use: { status: 'handled', note: 'assistant tool call (edits live here)' },
  tool_result: { status: 'handled', note: 'result of a tool call' },
};

/**
 * `system` line subtypes. Open-ended by nature, so unknown subtypes are
 * REPORTED, not failed — losing a system subtype cannot drop tokens or edits.
 */
export const SYSTEM_SUBTYPES = {
  turn_duration: { status: 'known', note: 'wall-clock duration of a turn' },
  away_summary: { status: 'known', note: 'summary emitted after an away period' },
};

/**
 * Tool names are an open set (users add MCP tools, skills, custom commands).
 * We never fail on an unknown tool name — we report it. EDIT_TOOLS is the subset
 * whose payloads we reconstruct into code changes (used from CP3 on).
 */
export const KNOWN_TOOLS = new Set([
  'Bash', 'Edit', 'Write', 'Read', 'AskUserQuestion', 'ScheduleWakeup', 'Skill', 'PowerShell',
]);

export const EDIT_TOOLS = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
]);

/**
 * The surfaces where an unknown value means silent signal loss, and therefore
 * must fail conformance. Tool names and system subtypes are intentionally NOT
 * here: they are open sets that cannot drop tokens or edits.
 */
export const FAIL_ON_UNKNOWN = Object.freeze(['lineType', 'role', 'usageKey', 'contentBlock']);
