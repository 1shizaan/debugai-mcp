import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetClientUpdate } from '../src/clientUpdate.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.js';
import { formatFix } from '../src/tools/debugError.js';
import { NO_ROOT_BADGE } from '../src/project.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function connectedClient() {
  const server = createServer({
    apiKey: 'dbg_test_key',
    apiBase: 'https://api.example.test/api',
    version: '1.0.0-test',
  });
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first.type === 'text' ? first.text : '';
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('debug_error tool over MCP', () => {
  it('is listed with a read-only annotation and required errorText input', async () => {
    const { client } = await connectedClient();
    const { tools } = await client.listTools();

    expect(tools.map(t => t.name).sort()).toEqual(['debug_error', 'lookup_error', 'report_outcome']);
    const tool = tools.find(t => t.name === 'debug_error')!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.inputSchema.required).toContain('errorText');
    // report_outcome writes telemetry — it must NOT carry readOnlyHint
    const outcome = tools.find(t => t.name === 'report_outcome')!;
    expect(outcome.annotations?.readOnlyHint).toBeUndefined();
  });

  it('formats a successful analysis into root cause, ranked fixes, and badges', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      root_cause: 'The list is empty when .pop() is called.',
      fixes: [
        { rank: 1, title: 'Guard the pop', description: 'Check length first.', confidence: 95, code: 'if items:\n    items.pop()', line_hint: 'app.py:42' },
        { rank: 2, title: 'Use a deque', description: 'collections.deque handles this.', confidence: 70 },
      ],
      framework_detected: 'fastapi',
      model_used: 'claude-haiku-4-5-20251001',
      cached: false,
      has_project_context: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'debug_error',
      arguments: { errorText: 'IndexError: pop from empty list', language: 'python' },
    }) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain('## Root Cause');
    expect(text).toContain('The list is empty when .pop() is called.');
    expect(text).toContain('**Fix 1 (95% confidence)** — Guard the pop');
    expect(text).toContain('if items:');
    expect(text).toContain('_Location: app.py:42_');
    expect(text).toContain('**Fix 2 (70% confidence)** — Use a deque');
    expect(text).toContain('Model: claude-haiku-4-5-20251001');
    expect(text).toContain('Codebase-aware: yes');
    expect(text).toContain('Framework: fastapi');
    expect(result.structuredContent).toMatchObject({
      root_cause: 'The list is empty when .pop() is called.',
      framework_detected: 'fastapi',
      has_project_context: true,
      cached: false,
    });
  });

  // A 200 with a placeholder fix and a debug_log_id. Formatted as an analysis,
  // two of these were reported as fixes that worked after edits (2026-10-30).
  it('an answer the engine could not read is a failure, with nothing to report an outcome on', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      analysis_unavailable: true,
      root_cause: "We could not read our own analysis engine's answer for this error.",
      fixes: [{ rank: 1, title: 'Nothing was analysed - please run it again', description: 'No diagnosis was produced.', confidence: 0, code: '', line_hint: '' }],
      debug_log_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      model_used: 'claude-haiku-5-5',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'debug_error',
      arguments: { errorText: 'KeyError: user' },
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error_type: 'analysis_unavailable', retryable: true });
    expect(textOf(result)).toContain('not counted');
    expect(textOf(result)).not.toContain('## Fixes');
    expect(JSON.stringify(result)).not.toContain('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(JSON.stringify(result)).not.toContain('After applying a fix');
  });

  it('sends language only when not "auto" and never sends framework_hint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ root_cause: 'x', fixes: [] }), { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connectedClient();
    await client.callTool({ name: 'debug_error', arguments: { errorText: 'boom' } });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.language).toBeUndefined();
    expect(body).not.toHaveProperty('framework_hint');
    expect(body.error_message).toBe('boom');
  });

  // The API refuses an error_message over 3,000 characters with a 400. A long
  // pytest run or build log is the normal case for an agent, so the server
  // cuts it (both ends kept) instead of relaying the refusal, and says so.
  it('cuts an error longer than the API accepts, keeps both ends, and says it did', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ root_cause: 'x', fixes: [] }), { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const frames = Array.from({ length: 200 }, (_, i) => `    at step${i} (/app/src/s${i}.js:${i + 1}:3)`).join('\n');
    const long = "TypeError: Cannot read properties of undefined (reading 'id')\n" + frames;
    expect(long.length).toBeGreaterThan(3000);

    const { client } = await connectedClient();
    const result = await client.callTool({ name: 'debug_error', arguments: { errorText: long } }) as CallToolResult;

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.error_message.length).toBeLessThanOrEqual(3000);
    expect(body.error_message.startsWith("TypeError: Cannot read properties of undefined (reading 'id')")).toBe(true);
    expect(body.error_message.endsWith(frames.split('\n').pop()!)).toBe(true);
    expect(textOf(result)).toContain('Error text cut to 3,000 characters, start and end kept');
    expect((result.structuredContent as any).error_text_cut).toBeGreaterThan(0);

    // And an error that fits is sent exactly as given, with no badge.
    fetchMock.mockClear();
    const short = await client.callTool({ name: 'debug_error', arguments: { errorText: 'boom' } }) as CallToolResult;
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).error_message).toBe('boom');
    expect(textOf(short)).not.toContain('Error text cut');
  });

  it('maps a 402 quota response to an isError tool result instead of a protocol error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ tier: 'free', limit: 10 }), { status: 402 },
    )));

    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'debug_error',
      arguments: { errorText: 'boom' },
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('daily quota reached');
  });

  it('renders tri-state verification labels and v2 edit fields (schema 2.0)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schema_version: '2.0',
      debug_log_id: 'log-123',
      error_signature: 'sig-abc',
      root_cause: 'Renamed export.',
      fixes: [
        {
          rank: 1, title: 'Fix the import', description: 'Use the new name.', confidence: 90,
          code: "from billing.pricing import apply_discount", line_hint: 'line 1',
          verified: true, verification_reason: 'import(s) match a file in the retrieved context',
          edits: [{ file: 'billing/checkout.py', old_string: 'from billing.pricing import calculate_discount', new_string: 'from billing.pricing import apply_discount' }],
          unified_diff: '--- a/billing/checkout.py\n+++ b/billing/checkout.py\n@@ -1 +1 @@\n-from billing.pricing import calculate_discount\n+from billing.pricing import apply_discount\n',
          verify_with: 'python -m py_compile billing/checkout.py',
        },
        {
          rank: 2, title: 'Guard the call', description: 'Null-check first.', confidence: 95,
          code: 'if x: x()', line_hint: 'line 3',
          verified: null, verification_reason: "error_class='TypeError' not covered by v1 (parse/import only)",
        },
        {
          rank: 3, title: 'Broken import', description: 'Wrong name.', confidence: 15,
          code: 'from billing.pricing import nonexistent', line_hint: 'line 1',
          verified: false, verification_reason: 'import(s) not found in retrieved context: billing.pricing.nonexistent',
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'debug_error',
      arguments: { errorText: 'ImportError: cannot import name', language: 'python' },
    }) as CallToolResult;

    const text = textOf(result);
    // Three distinct states, never two (plan §1)
    expect(text).toContain('✓ Verified — import(s) match a file in the retrieved context');
    expect(text).toContain('Not verified — confidence is the model\'s own estimate');
    expect(text).toContain('✗ Failed mechanical check (confidence capped)');
    // v2 payloads surface in markdown + structuredContent. The diff repeats a
    // fix's code, so the prose carries it only for a fix WITHOUT a code block
    // (field report F12: each change was shown three times). It is never lost:
    // structuredContent keeps it whole for every fix.
    expect(text).not.toContain('```diff');
    expect((result.structuredContent as any).fixes[0].unified_diff).toContain('+from billing.pricing import apply_discount');
    expect(text).toContain('Syntax-level check after applying');
    expect(text).toContain('report_outcome with debugLogId "log-123"');
    expect(result.structuredContent).toMatchObject({
      schema_version: '2.0',
      debug_log_id: 'log-123',
      error_signature: 'sig-abc',
    });
    const fixes = (result.structuredContent as any).fixes;
    expect(fixes[0].edits[0].old_string).toContain('calculate_discount');
    expect(fixes[1].verified).toBeNull();
    expect(fixes[2].verified).toBe(false);
  });

  it('says when a fix repeats a change this project reported as failed', () => {
    const text = formatFix({
      rank: 1, title: 'Disable thinking', description: 'd', code: 'x', confidence: 60,
      previously_failed: { at: '2026-09-16 21:05', rank: 1 },
    } as any, 1);
    expect(text).toContain('reported as FAILED in this project on 2026-09-16 21:05');
    expect(formatFix({ rank: 1, title: 't', description: 'd', confidence: 90 } as any, 1)).not.toContain('FAILED');
  });

  it('still shows the diff for a fix that has no code block, because then it is the only copy', () => {
    const out = formatFix({ title: 't', description: 'd', confidence: 50, unified_diff: '--- a/x\n+++ b/x\n' } as any, 1);
    expect(out).toContain('```diff');
  });

  it('rejects a missing errorText at the schema layer without calling the backend', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'debug_error',
      arguments: {},
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('project scope and error memory', () => {
  // Before this, nothing in the package ever set project_id. The engine gates
  // Team Error Memory on it (fetch_error_memory returns None without one) and
  // the confirmed-fix promotion in feedback.ts requires ds.project_id IS NOT
  // NULL, so every agent request silently got no memory while the server
  // instructions advertised it.
  it('sends a project_id so the request is memory-scoped at all', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      root_cause: 'x', fixes: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connectedClient();
    await client.callTool({ name: 'debug_error', arguments: { errorText: 'boom' } });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.project_id).toEqual(expect.any(String));
    // The gateway rejects anything outside this shape before it reaches the engine.
    expect(body.project_id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('tells the agent when this project has hit the error before', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      root_cause: 'x',
      fixes: [{ rank: 1, title: 'f', description: 'd', confidence: 90 }],
      memory_hit: true,
      memory_times_seen: 3,
      memory_fix_confirmed: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'debug_error', arguments: { errorText: 'boom' },
    }) as CallToolResult;

    const text = textOf(result);
    expect(text).toContain('Seen before');
    expect(text).toContain('3x before in this project');
    // Not "confirmed working". A click is acceptance, not evidence, and this
    // string said otherwise until 2026-08-21. An agent reading "confirmed"
    // treats it as settled; the honest version says what actually happened.
    expect(text).toContain('accepted by a developer');
    expect(text).toContain('nothing has observed it working');
    expect(text).not.toContain('confirmed working');
    expect(result.structuredContent).toMatchObject({
      memory_hit: true, memory_times_seen: 3, memory_fix_confirmed: true,
    });
  });

  // The three states below did not exist here. A fix that had been tried and
  // FAILED rendered identically to one nobody had ever tried, so an agent
  // would re-propose the failed fix. That is the loop this closes.

  async function memoryText(extra: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      root_cause: 'x',
      fixes: [{ rank: 1, title: 'f', description: 'd', confidence: 90 }],
      memory_hit: true,
      memory_times_seen: 3,
      ...extra,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'debug_error', arguments: { errorText: 'boom' },
    }) as CallToolResult;
    return { text: textOf(result), result };
  }

  it('says a fix was verified by observation when it actually was', async () => {
    const { text } = await memoryText({
      memory_fix_confirmed: true, memory_fix_state: 'confirmed', memory_verified_count: 2,
    });
    expect(text).toContain('VERIFIED BY OBSERVATION 2x');
    expect(text).toContain('watched the error stop');
  });

  it('tells the agent a prior fix is unproven after one recurrence', async () => {
    const { text } = await memoryText({
      memory_fix_confirmed: false, memory_fix_state: 'unproven',
    });
    expect(text).toContain('RECURRED ONCE SINCE');
    expect(text).toContain('unproven');
    // Must not read as "nobody has tried anything", which is what the old
    // two-branch version said for exactly this case.
    expect(text).not.toContain('No fix has been confirmed');
  });

  it('warns the agent off a fix that was tried and kept failing', async () => {
    const { text } = await memoryText({
      memory_fix_confirmed: false, memory_fix_state: 'anti_pattern',
    });
    expect(text).toContain('THE ERROR KEPT HAPPENING');
    expect(text).toContain('did not work');
    expect(text).toContain('somewhere it does not touch');
    expect(text).not.toContain('No fix has been confirmed');
  });

  it('falls back to the boolean against an engine that sends no state', async () => {
    const { text } = await memoryText({ memory_fix_confirmed: false });
    expect(text).toContain('No fix has been confirmed for it yet');
  });

  it('distinguishes "seen before" from "seen and fixed"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      root_cause: 'x', fixes: [],
      memory_hit: true, memory_times_seen: 2, memory_fix_confirmed: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'debug_error', arguments: { errorText: 'boom' },
    }) as CallToolResult;

    expect(textOf(result)).toContain('No fix has been confirmed');
  });

  it('says nothing about memory on a first occurrence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      root_cause: 'x', fixes: [], memory_hit: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'debug_error', arguments: { errorText: 'boom' },
    }) as CallToolResult;

    expect(textOf(result)).not.toContain('Seen before');
    expect(result.structuredContent).toMatchObject({ memory_hit: false });
  });
});

// ── The seam between sourceContext and the wire ──────────────────────────────
//
// sourceContext.test.ts proves the module reads the right file and refuses the
// wrong ones. Nothing there proves the tool CALLS it, or that what it read ends
// up in code_snippet. A tool that resolved perfectly and then sent nothing would
// pass every test in that file while shipping the exact bug this release exists
// to fix.
//
// These run against real files in this repo (cwd is packages/mcp, git toplevel
// is the repo root) rather than a temp fixture, because the thing under test is
// the default root resolution too.

describe('debug_error sends local source when the agent gave none', () => {
  function okResponse() {
    return vi.fn().mockResolvedValue(new Response(JSON.stringify({
      root_cause: 'x', fixes: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }

  it('reads the file the stack trace names and sends it as code_snippet', async () => {
    const fetchMock = okResponse();
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connectedClient();
    await client.callTool({
      name: 'debug_error',
      arguments: { errorText: 'TypeError: boom\n    at f (packages/mcp/src/constants.ts:1:1)' },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // The real contents of that file, not a placeholder or a path echo.
    expect(body.code_snippet).toContain('DEFAULT_API_BASE');
    expect(body.file_path).toContain('constants.ts');
  });

  it('names what it read, so a wrong guess is visible rather than silent', async () => {
    vi.stubGlobal('fetch', okResponse());

    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'debug_error',
      arguments: { errorText: 'at f (packages/mcp/src/constants.ts:1:1)' },
    }) as CallToolResult;

    expect(textOf(result)).toContain('Read locally:');
    expect(result.structuredContent).toMatchObject({
      local_files_read: [expect.stringContaining('constants.ts')],
    });
  });

  it('never overrides a snippet the agent supplied itself', async () => {
    // The agent knows what it was looking at. Reading over the top of that
    // would replace a deliberate choice with a guess from a regex.
    const fetchMock = okResponse();
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'debug_error',
      arguments: {
        errorText: 'at f (packages/mcp/src/constants.ts:1:1)',
        codeSnippet: 'const mine = 1',
      },
    }) as CallToolResult;

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.code_snippet).toBe('const mine = 1');
    expect(textOf(result)).not.toContain('Read locally:');
    expect(result.structuredContent).toMatchObject({ local_files_read: [] });
  });

  it('says where the agent\'s own window starts, and never where one it read itself does', async () => {
    // An agent snippet carries no header, and the engine counted it from line 1:
    // "Line 44" was answered from a 15-line window as if it began the file. A
    // window this server read says where it starts in its own section header,
    // and a second number beside that would be a second answer to one question.
    const fetchMock = okResponse();
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connectedClient();
    await client.callTool({
      name: 'debug_error',
      arguments: { errorText: 'Line 44: boom', codeSnippet: 'const mine = 1', snippetStartLine: 40 },
    });
    await client.callTool({
      name: 'debug_error',
      arguments: { errorText: 'at f (packages/mcp/src/constants.ts:1:1)', snippetStartLine: 40 },
    });

    const own = JSON.parse(fetchMock.mock.calls[0][1].body);
    const read = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(own.code_snippet_start_line).toBe(40);
    expect(read.code_snippet).toContain('DEFAULT_API_BASE');
    expect(read.code_snippet_start_line).toBeUndefined();
  });

  it('treats a blank codeSnippet as none: what it read is what it sends', async () => {
    // An agent fills an optional string with "" as readily as it leaves it
    // out. `??` took that for a snippet: the file was read, the reply said
    // "Read locally:", and the request carried no code and no file path.
    for (const blank of ['', '   ', '\n\t']) {
      const fetchMock = okResponse();
      vi.stubGlobal('fetch', fetchMock);
      const { client } = await connectedClient();
      const result = await client.callTool({
        name: 'debug_error',
        arguments: { errorText: 'at f (packages/mcp/src/constants.ts:1:1)', codeSnippet: blank, filePath: blank },
      }) as CallToolResult;

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.code_snippet, JSON.stringify(blank)).toContain('DEFAULT_API_BASE');
      expect(body.file_path, JSON.stringify(blank)).toContain('constants.ts');
      expect(textOf(result)).toContain('Read locally:');
    }
  });

  it('sends a real snippet exactly as given, its whitespace included', async () => {
    const fetchMock = okResponse();
    vi.stubGlobal('fetch', fetchMock);
    const { client } = await connectedClient();
    await client.callTool({
      name: 'debug_error',
      arguments: { errorText: 'at f (packages/mcp/src/constants.ts:1:1)', codeSnippet: '    return x\n', filePath: 'src/mine.py' },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.code_snippet).toBe('    return x\n');
    expect(body.file_path).toBe('src/mine.py');
  });

  it('sends no snippet at all when nothing resolves, rather than inventing one', async () => {
    const fetchMock = okResponse();
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connectedClient();
    await client.callTool({
      name: 'debug_error',
      arguments: { errorText: 'ECONNREFUSED 127.0.0.1:5432' },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.code_snippet).toBeUndefined();
  });
});

/*
 * `language` is a hint, never a reason to refuse the call.
 *
 * It was a closed enum until 2026-10-08: an agent that passed "markdown" was
 * told its input was invalid and had to retry with "auto" (the list had been
 * widened for "java" on 2026-09-13 for the same reason). Read off what reaches
 * the API, which is what the engine and debug_logs see.
 */
describe('the language hint', () => {
  it('keeps a known name (lowercased) and sends anything else as auto, never refusing', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ root_cause: 'x', fixes: [] }), { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = await connectedClient();

    const sent = async (language: string) => {
      const result = await client.callTool({
        name: 'debug_error', arguments: { errorText: 'boom', language },
      }) as CallToolResult;
      expect(result.isError, `language ${JSON.stringify(language)} was refused`).toBeFalsy();
      return JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body).language;
    };

    expect(await sent(' Python ')).toBe('python');
    expect(await sent('csharp')).toBe('csharp');
    expect(await sent('markdown')).toBeUndefined();
    expect(await sent('')).toBeUndefined();
    expect(await sent('auto')).toBeUndefined();
  });
});

// ── How the fix will be checked (field report 2026-09-16, R11) ──────────────
describe('reproCommand and expected', () => {
  it('are forwarded as repro_command and repro_expected', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ root_cause: 'r', fixes: [] }), { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = await connectedClient();
    await client.callTool({
      name: 'debug_error',
      arguments: { errorText: 'QR does not scan', reproCommand: 'pytest -k qr', expected: '1 passed' },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ repro_command: 'pytest -k qr', repro_expected: '1 passed' });
  });

  it('turn the check line into the reproduction, keeping the syntax check as optional', () => {
    const out = formatFix({
      title: 't', description: 'd', confidence: 80, code: 'x = 1',
      verify_with: 'pytest -k qr', verify_kind: 'reproduction', verify_expect: '1 passed',
      syntax_check: 'python -m py_compile a.py',
    } as any, 1);
    expect(out).toContain('_Check after applying: run `pytest -k qr`; expected: 1 passed. Then call report_outcome');
    expect(out).toContain('Quick syntax check first, if you like: `python -m py_compile a.py`');
    expect(out).not.toContain('Syntax-level check after applying');
  });

  it('leave the syntax check line exactly as it was when no reproduction was given', () => {
    const out = formatFix({ title: 't', description: 'd', confidence: 80, verify_with: 'node --check a.js' } as any, 1);
    expect(out).toContain('_Syntax-level check after applying: `node --check a.js`_');
    expect(out).not.toContain('Check after applying: run');
  });
});

describe('which builds answered (field report 2026-09-16, R1)', () => {
  it('names the engine build beside the MCP version, in prose and in structuredContent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ root_cause: 'r', fixes: [], engine_version: 'debug-v7+4ba459f' }), { status: 200 },
    )));
    const { client } = await connectedClient();
    const result = await client.callTool({ name: 'debug_error', arguments: { errorText: 'TypeError: x' } }) as CallToolResult;
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toContain('DebugAI MCP 1.0.0-test · Engine debug-v7+4ba459f');
    expect(result.structuredContent).toMatchObject({ engine_version: 'debug-v7+4ba459f' });
  });
});

// ── The stale-client notice reaches the agent, through the real handler ──────
//
// A19: a correct decision nothing on the request path reaches has shipped in
// this repo before. The API sets `client_update`; this asserts the tool the
// agent actually calls renders it, above the diagnosis, once.
describe('client_update', () => {
  const answer = (extra: Record<string, unknown>) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify({
      root_cause: 'The list is empty when .pop() is called.',
      fixes: [],
      ...extra,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

  it('is rendered above the root cause on the first answer that carries it', async () => {
    __resetClientUpdate();
    vi.stubGlobal('fetch', answer({
      client_update: { current: '2.1.1', latest: '2.7.0', command: 'npx -y @debugai/mcp@latest install' },
    }));
    const { client } = await connectedClient();
    const result = await client.callTool({ name: 'debug_error', arguments: { errorText: 'boom' } }) as CallToolResult;
    const text = (result.content as { text: string }[])[0].text;

    expect(text).toContain('2.1.1');
    expect(text).toContain('npx -y @debugai/mcp@latest install');
    expect(text.indexOf('This is DebugAI MCP')).toBeLessThan(text.indexOf('## Root Cause'));
  });

  it('is not repeated on the next answer in the same process', async () => {
    __resetClientUpdate();
    vi.stubGlobal('fetch', answer({ client_update: { current: '2.1.1', latest: '2.7.0' } }));
    const { client } = await connectedClient();
    const first = await client.callTool({ name: 'debug_error', arguments: { errorText: 'a' } }) as CallToolResult;
    const second = await client.callTool({ name: 'debug_error', arguments: { errorText: 'b' } }) as CallToolResult;
    expect((first.content as { text: string }[])[0].text).toContain('This is DebugAI MCP');
    expect((second.content as { text: string }[])[0].text).not.toContain('This is DebugAI MCP');
  });

  it('says nothing at all when the API sent no update, which is the normal case', async () => {
    __resetClientUpdate();
    vi.stubGlobal('fetch', answer({}));
    const { client } = await connectedClient();
    const result = await client.callTool({ name: 'debug_error', arguments: { errorText: 'boom' } }) as CallToolResult;
    const text = (result.content as { text: string }[])[0].text;
    expect(text).not.toContain('is published');
    expect(text.startsWith('## Root Cause')).toBe(true);
  });
});

// A server started in the home directory outside any repository used to make the
// home directory its project root, so a stack trace naming ~/anything was read and
// sent, and the facts walk ran under it. This drives the tool the agent calls, with
// only the HTTP edge faked, and reads the request that would have left the machine.
describe('debug_error started in the home directory', () => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const cleanup: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A fake home holding a project folder with a source file and a manifest of its own. */
  function fakeHome() {
    const home = mkdtempSync(join(tmpdir(), 'debugai-home-'));
    cleanup.push(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mkdirSync(join(home, 'proj', 'src'), { recursive: true });
    writeFileSync(join(home, 'src-secret.js'), 'const SECRET_LINE = 1;\nthrow new Error("boom");\n');
    writeFileSync(join(home, 'package.json'), JSON.stringify({ dependencies: { 'home-only-dep': '1.0.0' } }));
    writeFileSync(join(home, 'proj', 'src', 'app.js'), 'const PROJECT_LINE = 1;\nthrow new Error("boom");\n');
    writeFileSync(join(home, 'proj', 'package.json'), JSON.stringify({ dependencies: { 'project-dep': '1.0.0' } }));
    return home;
  }

  const okBody = () => vi.fn().mockResolvedValue(new Response(JSON.stringify({ root_cause: 'x', fixes: [] }),
    { status: 200, headers: { 'content-type': 'application/json' } }));

  it('reads no file, gathers no facts, and says why', async () => {
    const home = fakeHome();
    vi.spyOn(process, 'cwd').mockReturnValue(home);
    const fetchMock = okBody();
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'debug_error',
      arguments: { errorText: 'Error: boom\n    at f (src-secret.js:1:1)' },
    }) as CallToolResult;

    const raw = fetchMock.mock.calls[0][1].body as string;
    const body = JSON.parse(raw);
    expect(body.code_snippet, 'read a file under the home directory').toBeUndefined();
    expect(body.workspace_facts, 'walked the home directory for manifests').toBeUndefined();
    expect(raw).not.toContain('SECRET_LINE');
    expect(raw).not.toContain('home-only-dep');
    expect(textOf(result)).not.toContain('Read locally:');
    expect(textOf(result)).toContain(NO_ROOT_BADGE);
    expect(result.structuredContent).toMatchObject({ local_files_read: [], project: { root: null } });
  });

  it('still reads when the same server is started in a project folder under home', async () => {
    // The control: without it the test above would pass for a server that reads nothing at all.
    const home = fakeHome();
    vi.spyOn(process, 'cwd').mockReturnValue(join(home, 'proj'));
    const fetchMock = okBody();
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'debug_error',
      arguments: { errorText: 'Error: boom\n    at f (src/app.js:1:1)' },
    }) as CallToolResult;

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.code_snippet).toContain('PROJECT_LINE');
    expect(body.workspace_facts.declared_deps).toEqual(['project-dep']);
    expect(textOf(result)).toContain('Read locally:');
    expect(textOf(result)).not.toContain(NO_ROOT_BADGE);
  });
});
