import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.js';
import { formatFix } from '../src/tools/debugError.js';

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
 * The languages production actually sends.
 *
 * `language` was a six-value enum until 2026-09-13 and four of the ten
 * highest-volume accounts were debugging something it refused. One of them
 * said so in an outcome report: "the tool's Java language enum rejected
 * 'java'; auto detection was required."
 *
 * Read off the PUBLISHED schema through a connected server, because that is
 * the artefact an agent validates against - not the zod object, which could
 * be correct while the thing on the wire is not.
 *
 * Pinned by the evidence rather than by taste, so shrinking the set means
 * deleting a row somebody's real session is named in.
 */
describe('the language enum covers what people actually debug', () => {
  const OBSERVED: Array<[string, string]> = [
    ['java', 'chumaneshkatta, 16 debugs, Spring Boot + Maven'],
    ['csharp', 'wavoinfinity + salmankabir, 15 debugs, .NET / MSBuild / YARP'],
    ['css', 'santamark14, 13 debugs, @font-face'],
    ['lua', 'jtearnest94, 8 debugs, FiveM'],
    ['html', 'santamark14, the same sessions as the css rows'],
    ['powershell', 'rayanne, santamark14, salmankabir - the most common shell in the data'],
  ];

  async function languageSchema(): Promise<{ enum?: string[]; default?: string }> {
    const { client } = await connectedClient();
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'debug_error')!;
    return (tool.inputSchema.properties as Record<string, { enum?: string[]; default?: string }>).language;
  }

  it.each(OBSERVED)('accepts %s', async (lang, _why) => {
    const schema = await languageSchema();
    expect(schema.enum).toContain(lang);
  });

  it('still defaults to auto, because the server decides and the client only hints', async () => {
    expect((await languageSchema()).default).toBe('auto');
  });

  it('is still a closed set - widening is not opening', async () => {
    const schema = await languageSchema();
    expect(Array.isArray(schema.enum)).toBe(true);
    expect(schema.enum).not.toContain('klingon');
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
