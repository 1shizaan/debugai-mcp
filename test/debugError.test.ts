import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.js';

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

    expect(tools.map(t => t.name).sort()).toEqual(['debug_error', 'report_outcome']);
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
    // v2 payloads surface in markdown + structuredContent
    expect(text).toContain('```diff');
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
