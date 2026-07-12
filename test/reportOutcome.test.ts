import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.js';

async function connectedClient() {
  const server = createServer({
    apiKey: 'dbg_test_key',
    apiBase: 'https://api.example.test/api',
    version: '2.0.0-test',
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

describe('report_outcome tool over MCP', () => {
  it('posts a worked outcome to the unified feedback route with source=agent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: true }), { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'report_outcome',
      arguments: { debugLogId: 'log-123', result: 'worked', fixRank: 1 },
    }) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('fix worked');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/user/debug-feedback');
    expect(init.headers['x-api-key']).toBe('dbg_test_key');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      debug_log_id: 'log-123',
      result: 'worked',
      fix_rank: 1,
      source: 'agent',
    });
  });

  it('carries the follow-up error text on a failed outcome', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: true }), { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'report_outcome',
      arguments: {
        debugLogId: 'log-123',
        result: 'failed',
        fixRank: 2,
        newError: 'TypeError: y is undefined',
      },
    }) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('fix failed');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.new_error).toBe('TypeError: y is undefined');
    expect(body.source).toBe('agent');
  });

  it('maps auth failures to an isError tool result, not a protocol error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'Unauthorized' }), { status: 401 },
    )));

    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'report_outcome',
      arguments: { debugLogId: 'log-123', result: 'worked' },
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('authentication failed');
  });

  it('rejects an invalid result value at the schema layer without calling the backend', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'report_outcome',
      arguments: { debugLogId: 'log-123', result: 'maybe' },
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a missing debugLogId at the schema layer', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await connectedClient();
    const result = await client.callTool({
      name: 'report_outcome',
      arguments: { result: 'worked' },
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
