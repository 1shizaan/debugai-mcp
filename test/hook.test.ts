// `debugai-mcp hook`: a Claude Code PostToolUseFailure hook that looks each
// failed shell command up in project memory (field report 2026-09-16, R12).
// The input shape is the one the hooks reference documents; the last test
// spawns the BUILT CLI with that payload on stdin against a local API stub.
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HOOK_CONTEXT_MAX, cmdHook, failureText, hookOutput } from '../src/cli/hook.js';
import { API_ERROR_MAX_CHARS, fitErrorText } from '../src/fitErrorText.js';

// The example the hooks reference gives for a failed `npm test`.
const DOCS_EXAMPLE = {
  session_id: 'abc123',
  cwd: '/Users/me/app',
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Bash',
  tool_input: { command: 'npm test', description: 'Run test suite' },
  tool_use_id: 'toolu_01ABC123',
  error: "Exit code 1\nError: Cannot find module 'express'",
  is_interrupt: false,
  duration_ms: 4187,
};

const CONFIRMED = {
  memory_enabled: true, memory_hit: true, memory_times_seen: 2, memory_fix_state: 'confirmed',
  stored_fix: 'npm install express', refuted: [],
};

describe('failureText: which failures are worth a lookup', () => {
  it('takes the output of a shell command that ran and exited non-zero', () => {
    expect(failureText(DOCS_EXAMPLE)).toBe("Error: Cannot find module 'express'");
    expect(failureText({ ...DOCS_EXAMPLE, tool_name: 'PowerShell' })).not.toBeNull();
  });

  it('ignores everything else', () => {
    expect(failureText({ ...DOCS_EXAMPLE, hook_event_name: 'PostToolUse' })).toBeNull();
    expect(failureText({ ...DOCS_EXAMPLE, tool_name: 'Edit' })).toBeNull();
    expect(failureText({ ...DOCS_EXAMPLE, is_interrupt: true })).toBeNull();
    expect(failureText({ ...DOCS_EXAMPLE, error: 'Exit code 0\nall good, nothing failed' })).toBeNull();
    // Claude Code could not start the shell at all: no exit-code line.
    expect(failureText({ ...DOCS_EXAMPLE, error: 'spawn /bin/bash ENOENT' })).toBeNull();
    // Too little to look up: `test -f x` failing prints nothing.
    expect(failureText({ ...DOCS_EXAMPLE, error: 'Exit code 1\n' })).toBeNull();
    for (const junk of [null, 'x', 42, [], {}]) expect(failureText(junk)).toBeNull();
  });

  it('drops Claude Code\'s own truncation marker and cuts long output the way debug_error does', () => {
    const long = 'noise line\n'.repeat(1000) + "TypeError: Cannot read properties of undefined (reading 'id')";
    const text = failureText({ ...DOCS_EXAMPLE, error: `Exit code 1\nstart\n... [48213 characters truncated] ...\n${long}` })!;
    expect(text).not.toContain('characters truncated');
    expect(text.length).toBeLessThanOrEqual(API_ERROR_MAX_CHARS);
    // Both ends: a JavaScript error prints first, a Python one last.
    expect(text.startsWith('start\n')).toBe(true);
    expect(text.endsWith("(reading 'id')")).toBe(true);
    // Byte for byte what the tools send for the same output, so one memory row.
    // (The marker had a line of its own, so it leaves a blank one behind.)
    expect(text).toBe(fitErrorText(`start\n\n\n${long}`).text);
  });

  // The shape Claude Code actually writes, taken from a real transcript: the
  // cut lands mid-line and the marker sits between blank lines.
  it('removes the marker wherever the cut fell, so it never reaches the signature', () => {
    const error = "Exit code 1\nbuilding azure-resource-m\n\n... [18175 characters truncated] ...\n\nager\nModuleNotFoundError: No module named 'yaml'";
    const text = failureText({ ...DOCS_EXAMPLE, error })!;
    expect(text).not.toMatch(/truncated|\.\.\. \[/);
    expect(text.startsWith('building azure-resource-m')).toBe(true);
    expect(text.endsWith("No module named 'yaml'")).toBe(true);
  });

  it('drops the line Claude Code adds when it stops a command, which is not the command\'s output', () => {
    const error = "Exit code 143\nCommand timed out after 2m 0s\nError: connect ECONNREFUSED 127.0.0.1:5432";
    expect(failureText({ ...DOCS_EXAMPLE, error })).toBe('Error: connect ECONNREFUSED 127.0.0.1:5432');
    // A timeout that printed nothing else has nothing of the program's to look up.
    expect(failureText({ ...DOCS_EXAMPLE, error: 'Exit code 143\nCommand timed out after 10m 0s' })).toBeNull();
  });

  it('sends a Windows failure with the line endings a pasted error would have', () => {
    const error = 'Exit code 1\r\nnpm ERR! code ENOENT\r\nnpm ERR! syscall open\r\n';
    expect(failureText({ ...DOCS_EXAMPLE, tool_name: 'PowerShell', error })).toBe('npm ERR! code ENOENT\nnpm ERR! syscall open');
  });
});

describe('hookOutput: speaks only when memory has something to act on', () => {
  const deps = (answer: unknown, project: any = { id: 'p1', root: '/Users/me/app' }) => ({
    lookup: vi.fn(async () => { if (answer instanceof Error) throw answer; return answer as any; }),
    project: vi.fn(() => project),
  });

  it('a confirmed fix becomes additionalContext on the failure, in the documented shape', async () => {
    const d = deps(CONFIRMED);
    const out = JSON.parse((await hookOutput(JSON.stringify(DOCS_EXAMPLE), d))!);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUseFailure');
    expect(out.hookSpecificOutput.additionalContext).toContain('looked up automatically');
    expect(out.hookSpecificOutput.additionalContext).toContain('npm install express');
    expect(out.hookSpecificOutput.additionalContext).toContain('(app)');
    expect(d.lookup).toHaveBeenCalledWith({ error_message: "Error: Cannot find module 'express'", project_id: 'p1' });
    expect(d.project).toHaveBeenCalledWith('/Users/me/app');
  });

  it('advice reported as failed here is worth saying even with no stored fix', async () => {
    const out = await hookOutput(JSON.stringify(DOCS_EXAMPLE), deps({
      memory_enabled: true, memory_hit: false,
      refuted: [{ at: '2026-09-16 14:02', rank: 1, title: 'Reinstall node_modules', what_happened: 'same error' }],
    }));
    expect(out).toContain('reported as FAILED');
  });

  it('a miss, or a sighting with no fix, prints nothing', async () => {
    expect(await hookOutput(JSON.stringify(DOCS_EXAMPLE), deps({ memory_enabled: true, memory_hit: false, refuted: [] }))).toBeNull();
    expect(await hookOutput(JSON.stringify(DOCS_EXAMPLE), deps({ memory_enabled: true, memory_hit: true, memory_times_seen: 5, memory_fix_state: 'none', refuted: [] }))).toBeNull();
  });

  it('cuts a long entry below Claude Code\'s limit and says so, rather than let it be moved to a file', async () => {
    const out = JSON.parse((await hookOutput(JSON.stringify(DOCS_EXAMPLE), deps({ ...CONFIRMED, stored_fix: 'x'.repeat(20_000) })))!);
    const context: string = out.hookSpecificOutput.additionalContext;
    expect(context.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX);
    expect(context).toMatch(/lookup_error returns the whole entry\.\]$/);
    // An ordinary entry is not touched.
    const short = JSON.parse((await hookOutput(JSON.stringify(DOCS_EXAMPLE), deps(CONFIRMED)))!);
    expect(short.hookSpecificOutput.additionalContext).not.toContain('Cut here');
  });

  it('never throws and never speaks on anything unexpected', async () => {
    expect(await hookOutput('not json', deps(CONFIRMED))).toBeNull();
    expect(await hookOutput(JSON.stringify(DOCS_EXAMPLE), deps(Object.assign(new Error('Not Found'), { status: 404 })))).toBeNull();
    expect(await hookOutput(JSON.stringify(DOCS_EXAMPLE), deps(CONFIRMED, null))).toBeNull();
    expect(await hookOutput(JSON.stringify({ ...DOCS_EXAMPLE, cwd: 7 }), deps(CONFIRMED))).toBeNull();
  });
});

describe('cmdHook', () => {
  const NO_CONFIG = { DEBUGAI_CONFIG_PATH: join(tmpdir(), 'debugai-hook-test-nonexistent', 'config.json') };
  let repo: string;
  beforeAll(() => {
    // A real repository, so the key is the only thing that can stop the lookup.
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'debugai-hook-unit-')));
    execFileSync('git', ['init', '-q'], { cwd: repo });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  async function runWith(env: Record<string, string>) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(CONFIRMED), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const stdin = new PassThrough();
      stdin.end(JSON.stringify({ ...DOCS_EXAMPLE, cwd: repo }));
      const writes: string[] = [];
      const code = await cmdHook('9.9.9', { ...NO_CONFIG, ...env }, stdin, (s) => writes.push(s));
      return { code, writes, fetchMock };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it('with no key says nothing and asks nobody: a hook cannot answer a sign-in', async () => {
    const r = await runWith({});
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([]);
    expect(r.fetchMock).not.toHaveBeenCalled();
  });

  it('the same failure with a key is looked up, which is what makes the test above mean something', async () => {
    const r = await runWith({ DEBUGAI_API_KEY: 'dbg_unit', DEBUGAI_API_BASE: 'http://127.0.0.1:9/api' });
    expect(r.code).toBe(0);
    expect(r.fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(r.writes.join('')).hookSpecificOutput.additionalContext).toContain('npm install express');
  });
});

// ── The built CLI, as Claude Code runs it ────────────────────────────────────
describe('spawned: `debugai-mcp hook` with a failure on stdin', () => {
  const distEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
  let api: Server;
  let apiBase: string;
  let seen: any = null;
  let repo: string;

  beforeAll(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'debugai-hook-repo-')));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    api = createHttpServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seen = { url: req.url, key: req.headers['x-api-key'], body: JSON.parse(raw || '{}') };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(CONFIRMED));
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api`;
  });

  afterAll(() => { api.close(); rmSync(repo, { recursive: true, force: true }); });

  function run(payload: unknown, env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [distEntry, 'hook'], {
        env: { ...process.env, DEBUGAI_CONFIG_PATH: join(tmpdir(), 'debugai-hook-e2e-nonexistent', 'config.json'), ...env },
      });
      let stdout = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.on('close', (code) => resolve({ code, stdout }));
      child.stdin.end(JSON.stringify(payload));
    });
  }

  it('looks the failure up for the repository it ran in and prints the context', async () => {
    const r = await run({ ...DOCS_EXAMPLE, cwd: repo }, { DEBUGAI_API_KEY: 'dbg_hook_key', DEBUGAI_API_BASE: apiBase });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain('npm install express');
    expect(seen.url).toBe('/api/memory/lookup');
    expect(seen.key).toBe('dbg_hook_key');
    expect(seen.body.error_message).toBe("Error: Cannot find module 'express'");
    expect(typeof seen.body.project_id).toBe('string');
  });

  it('exits 0 with nothing on stdout when the API cannot be reached', async () => {
    const r = await run({ ...DOCS_EXAMPLE, cwd: repo }, { DEBUGAI_API_KEY: 'dbg_hook_key', DEBUGAI_API_BASE: 'http://127.0.0.1:9/api' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });
});
