/**
 * `debugai-mcp hook` — a Claude Code hook that looks every failed shell command
 * up in this project's DebugAI memory, so calling it is not left to the agent.
 *
 * 2026-09-16 field report, R12 and section 7: the agent skipped DebugAI on five
 * errors because each looked obvious or had no error text, and said so: "an
 * instant, free memory lookup removes the cost argument for trivial errors".
 * lookup_error is that lookup; this runs it without anyone deciding to.
 *
 * Wire it as a PostToolUseFailure hook (see the README). Claude Code sends the
 * failure on stdin - `tool_name`, `tool_input.command`, `cwd`, and `error`,
 * whose first line is `Exit code N` for a shell command that ran and exited -
 * and adds whatever this prints as `hookSpecificOutput.additionalContext`
 * beside the error. Read from the hooks reference on 2026-09-18
 * (code.claude.com/docs/en/hooks, PostToolUseFailure).
 *
 * It speaks only when memory has something to act on: a stored fix (confirmed,
 * unproven, or one that stopped holding) or advice this project reported as
 * failed. A miss prints nothing, because a hook that comments on every failed
 * `ls` teaches the agent to skip what it says.
 *
 * It must never get in the agent's way, so every path exits 0: no key, no
 * network, a malformed payload, an API that has not deployed the lookup, all
 * print nothing. Exit 2 would push stderr at the model and is never used. It
 * reads the stored key (`debugai-mcp login`) or DEBUGAI_API_KEY and never
 * starts a sign-in: a hook cannot answer one.
 */

import type { LookupRequest, LookupResponse } from '../backend.js';
import { callLookupBackend } from '../backend.js';
import { resolveSettings } from '../config.js';
import { DEFAULT_API_BASE } from '../constants.js';
import { explicitProject } from '../explicitProject.js';
import { renderLookup } from '../lookupAnswer.js';

/** The API's own cap on error text; the tail of long output is where errors are. */
export const HOOK_MAX_CHARS = 3000;
const MIN_OUTPUT_CHARS = 12;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// Text Claude Code writes into `error` itself, which is not the command's
// output. Left in, it changes the error's signature, and the lookup misses the
// row a debug_error of the same failure wrote. The marker lands wherever the
// cut falls, mid-line included, so it is removed wherever it appears.
const TRUNCATION_MARKER = /\.\.\. \[\d+ characters truncated\] \.\.\./g;
const CLAUDE_CODE_LINE = /^Command timed out after \d[\dhms .]*$/;
// Claude Code moves any additionalContext over 10,000 characters into a file
// and hands the agent a 2,000-character preview, which could end mid-fix
// without saying so. Cut below that, and say where the rest is.
export const HOOK_CONTEXT_MAX = 9000;
const CUT_NOTE = '\n[Cut here to fit a hook message. lookup_error returns the whole entry.]';
const PREAMBLE =
  'DebugAI project memory, looked up automatically for this failed command ' +
  '(lookup_error, no model call):\n';

export interface HookDeps {
  lookup: (req: LookupRequest) => Promise<LookupResponse>;
  project: (cwd: string) => { id: string; root: string } | null;
}

/** The failure text worth looking up, or null when this failure is not one. */
export function failureText(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  if (i.hook_event_name !== 'PostToolUseFailure') return null;
  if (typeof i.tool_name !== 'string' || !SHELL_TOOLS.has(i.tool_name)) return null;
  if (i.is_interrupt === true || typeof i.error !== 'string') return null;
  const m = /^Exit code (\d+)\r?\n([\s\S]*)$/.exec(i.error);
  if (!m || m[1] === '0') return null;
  const output = m[2]
    .replace(/\r\n?/g, '\n')
    .replace(TRUNCATION_MARKER, '\n')
    .split('\n')
    .filter((line) => !CLAUDE_CODE_LINE.test(line.trim()))
    .join('\n')
    .trim();
  if (output.length < MIN_OUTPUT_CHARS) return null;
  return output.length > HOOK_MAX_CHARS ? output.slice(-HOOK_MAX_CHARS) : output;
}

/** What to print on stdout, or null to print nothing. Never throws. */
export async function hookOutput(rawStdin: string, deps: HookDeps): Promise<string | null> {
  try {
    const input = JSON.parse(rawStdin) as Record<string, unknown>;
    const text = failureText(input);
    if (!text || typeof input.cwd !== 'string') return null;
    const project = deps.project(input.cwd);
    if (!project) return null;

    const result = await deps.lookup({ error_message: text, project_id: project.id });
    const fix = result.memory_hit && result.memory_fix_state && result.memory_fix_state !== 'none';
    const refuted = Array.isArray(result.refuted) && result.refuted.length > 0;
    if (!fix && !refuted) return null;

    const name = project.root.split(/[\\/]/).filter(Boolean).pop() || project.root;
    let context = PREAMBLE + renderLookup(result, name);
    if (context.length > HOOK_CONTEXT_MAX) {
      context = context.slice(0, HOOK_CONTEXT_MAX - CUT_NOTE.length) + CUT_NOTE;
    }
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: context },
    });
  } catch {
    return null;
  }
}

// ── The command ──────────────────────────────────────────────────────────────

const STDIN_MAX_BYTES = 2_000_000;
const STDIN_DEADLINE_MS = 5_000;

function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    // Released as soon as it is read: an open stdin keeps the process alive,
    // and a hook that never exits holds the agent until Claude Code's timeout.
    const done = () => {
      try { (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.(); } catch { /* already closed */ }
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(done, STDIN_DEADLINE_MS);
    stream.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= STDIN_MAX_BYTES) chunks.push(c);
    });
    stream.on('end', () => { clearTimeout(timer); done(); });
    stream.on('error', () => { clearTimeout(timer); done(); });
  });
}

export async function cmdHook(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
  stdin: NodeJS.ReadableStream = process.stdin,
  write: (s: string) => void = (s) => { process.stdout.write(s); },
): Promise<number> {
  try {
    const raw = await readStdin(stdin);
    // A hook cannot answer a sign-in, so no key means say nothing.
    const { apiKey, apiBase } = resolveSettings(DEFAULT_API_BASE, env, () => {});
    if (!apiKey) return 0;
    const out = await hookOutput(raw, {
      lookup: (req) => callLookupBackend(req, { apiKey, apiBase, version }),
      // The same resolution debug_error gives a projectRoot, so the hook and a
      // debug of the same failure read one memory.
      project: (cwd) => {
        const p = explicitProject({ projectRoot: cwd });
        return p ? { id: p.id, root: p.root } : null;
      },
    });
    if (out) write(`${out}\n`);
  } catch {
    // Never in the agent's way.
  }
  return 0;
}
