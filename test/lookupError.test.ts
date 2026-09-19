// lookup_error over MCP. See src/tools/lookupError.ts (field report R10).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.js';

async function connectedClient() {
  const server = createServer({ apiKey: 'dbg_test_key', apiBase: 'https://api.example.test/api', version: '2.6.0-test' });
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

const textOf = (r: CallToolResult) => (r.content[0].type === 'text' ? r.content[0].text : '');

afterEach(() => vi.unstubAllGlobals());

describe('lookup_error tool over MCP', () => {
  it('is listed as read-only and idempotent, with errorText required', async () => {
    const client = await connectedClient();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'lookup_error')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(tool.inputSchema.required).toEqual(['errorText']);
    expect(tool.description).toContain('no model');
  });

  it('asks the lookup route, with the project debug_error would send, and renders the answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      memory_enabled: true, memory_hit: true, memory_times_seen: 2, memory_fix_state: 'confirmed',
      stored_fix: 'qr.save(buf, scale=6)', refuted: [],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = await connectedClient();
    const result = await client.callTool({ name: 'lookup_error', arguments: { errorText: 'QR does not scan' } }) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/memory/lookup');
    expect(init.headers['x-api-key']).toBe('dbg_test_key');
    const body = JSON.parse(init.body);
    expect(body.error_message).toBe('QR does not scan');
    // This repository is a git checkout, so the same id project.ts gives debug_error.
    expect(typeof body.project_id).toBe('string');
    expect(textOf(result)).toContain('Try it first');
    expect(result.structuredContent).toMatchObject({ memory_hit: true, mcp_version: '2.6.0-test' });
  });

  it('sends a long error cut exactly as debug_error cuts it, so both read one memory row', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      memory_enabled: true, memory_hit: false, refuted: [],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { fitErrorText } = await import('../src/fitErrorText.js');
    const long = 'Traceback (most recent call last):\n' +
      Array.from({ length: 150 }, (_, i) => `  File "/app/m${i}.py", line ${i + 1}, in f${i}`).join('\n') +
      "\nKeyError: 'user_id'";

    const client = await connectedClient();
    await client.callTool({ name: 'lookup_error', arguments: { errorText: long } });

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).error_message;
    expect(sent).toBe(fitErrorText(long).text);
    expect(sent.length).toBeLessThanOrEqual(3000);
    expect(sent.endsWith("KeyError: 'user_id'")).toBe(true);
  });

  it('an API without the route yet is not an error: the next step is debug_error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 })));
    const client = await connectedClient();
    const result = await client.callTool({ name: 'lookup_error', arguments: { errorText: 'x' } }) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('not available on this DebugAI server yet');
    expect(textOf(result)).toContain('debug_error');
  });

  it("relays the API's refusal, and maps auth failures like every other tool", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'error_message must be under 3000 characters' }), { status: 400 })));
    let client = await connectedClient();
    let result = await client.callTool({ name: 'lookup_error', arguments: { errorText: 'x' } }) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('under 3000 characters');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"Unauthorized"}', { status: 401 })));
    client = await connectedClient();
    result = await client.callTool({ name: 'lookup_error', arguments: { errorText: 'x' } }) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('authentication failed');
  });
});
