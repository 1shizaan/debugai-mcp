// End-to-end: spawn the BUILT CLI (dist/index.js) exactly as an MCP client
// would, complete the stdio handshake, and call debug_error against a local
// mock of the DebugAI API. Requires `npm run build` first (wired via pretest).
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const distEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

let api: Server;
let apiBase: string;
let lastRequest: { headers: Record<string, string | string[] | undefined>; body: any } | null = null;

beforeAll(async () => {
  api = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      lastRequest = { headers: req.headers, body: JSON.parse(raw || '{}') };

      // Device link is deliberately reachable WITHOUT a key — it is how a
      // client with no key gets one (see the skip list in apps/api/src/index.ts).
      if (req.url?.endsWith('/device-link/start')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          device_code: 'e2e-device-code',
          user_code: 'BCDF-2345',
          verification_uri: 'https://debugai.io/link',
          verification_uri_complete: 'https://debugai.io/link?code=BCDF-2345',
          expires_in: 600,
          interval: 5,
        }));
        return;
      }

      if (req.headers['x-api-key'] !== 'dbg_e2e_key') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid api key' }));
        return;
      }
      if (lastRequest.body.error_message === 'TRIGGER_QUOTA') {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ tier: 'free', limit: 10, resets_at: 'midnight UTC' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        root_cause: 'Mock root cause from e2e API.',
        fixes: [{ rank: 1, title: 'E2E fix', description: 'do the thing', confidence: 88 }],
        model_used: 'mock-model',
      }));
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api`;
});

afterAll(() => {
  api.close();
});

async function spawnServer(apiKey: string, extraEnv: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'e2e-client', version: '0.0.1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distEntry],
    env: {
      ...process.env,
      DEBUGAI_API_KEY: apiKey,
      DEBUGAI_API_BASE: apiBase,
      // Isolate from any real ~/.debugai/config.json on the host machine.
      DEBUGAI_CONFIG_PATH: join(tmpdir(), 'debugai-mcp-e2e-nonexistent', 'config.json'),
      ...extraEnv,
    },
  });
  await client.connect(transport);
  return client;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first.type === 'text' ? first.text : '';
}

describe('spawned CLI over stdio', () => {
  it('handshakes, lists debug_error, and returns a formatted analysis', async () => {
    const client = await spawnServer('dbg_e2e_key');
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['debug_error', 'report_outcome']);

      const result = await client.callTool({
        name: 'debug_error',
        arguments: { errorText: 'ReferenceError: x is not defined', language: 'javascript' },
      }) as CallToolResult;

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Mock root cause from e2e API.');
      expect(textOf(result)).toContain('**Fix 1 (88% confidence)** — E2E fix');

      expect(lastRequest?.headers['x-api-key']).toBe('dbg_e2e_key');
      expect(String(lastRequest?.headers['user-agent'])).toMatch(/^debugai-mcp\/\d+\.\d+\.\d+$/);
      expect(lastRequest?.body).toMatchObject({
        error_message: 'ReferenceError: x is not defined',
        language: 'javascript',
      });
    } finally {
      await client.close();
    }
  });

  it('surfaces quota exhaustion (402) as a non-retryable tool error', async () => {
    const client = await spawnServer('dbg_e2e_key');
    try {
      const result = await client.callTool({
        name: 'debug_error',
        arguments: { errorText: 'TRIGGER_QUOTA' },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('daily quota reached');
      expect(textOf(result)).toContain('do NOT retry');
    } finally {
      await client.close();
    }
  });

  it('with no API key, turns the first call into an in-conversation sign-in', async () => {
    // The old behavior — "go read your dashboard and edit a config file" — is
    // exactly the dead end that produced installs with no signups. A call
    // without a key must now come back with a code the agent can read out.
    const client = await spawnServer('');
    try {
      const result = await client.callTool({
        name: 'debug_error',
        arguments: { errorText: 'boom' },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain('BCDF-2345');
      expect(text).toContain('https://debugai.io/link?code=BCDF-2345');
      expect(text).toMatch(/call this tool again/i);
      expect(text).toMatch(/does NOT need restarting/i);

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.error_type).toBe('not_linked');
      expect(structured.user_code).toBe('BCDF-2345');
      expect(structured.retryable).toBe(true); // the same call works once approved
    } finally {
      await client.close();
    }
  });

  it('report_outcome is gated by the same sign-in, not a raw auth failure', async () => {
    const client = await spawnServer('');
    try {
      const result = await client.callTool({
        name: 'report_outcome',
        arguments: { debugLogId: 'x', result: 'worked' },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('BCDF-2345');
    } finally {
      await client.close();
    }
  });

  it('picks up the API key from a config file when env is unset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'debugai-mcp-e2e-config-'));
    const configFile = join(dir, 'config.json');
    writeFileSync(configFile, JSON.stringify({ api_key: 'dbg_e2e_key' }));

    const client = await spawnServer('', { DEBUGAI_CONFIG_PATH: configFile });
    try {
      const result = await client.callTool({
        name: 'debug_error',
        arguments: { errorText: 'ReferenceError: y is not defined' },
      }) as CallToolResult;

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Mock root cause from e2e API.');
      expect(lastRequest?.headers['x-api-key']).toBe('dbg_e2e_key');
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
