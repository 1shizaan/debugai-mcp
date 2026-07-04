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

    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool.name).toBe('debug_error');
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.inputSchema.required).toContain('errorText');
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
