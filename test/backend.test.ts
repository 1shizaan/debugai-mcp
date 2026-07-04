import { afterEach, describe, expect, it, vi } from 'vitest';
import { callDebugBackend, type BackendConfig, type BackendError } from '../src/backend.js';

const config: BackendConfig = {
  apiKey: 'dbg_test_key',
  apiBase: 'https://api.example.test/api',
  version: '1.0.0-test',
};

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callDebugBackend', () => {
  it('POSTs to /debug with api key, user agent, and request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ root_cause: 'x', fixes: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await callDebugBackend({ error_message: 'TypeError: boom', language: 'python' }, config);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/debug');
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('dbg_test_key');
    expect(init.headers['user-agent']).toBe('debugai-mcp/1.0.0-test');
    expect(JSON.parse(init.body)).toEqual({ error_message: 'TypeError: boom', language: 'python' });
  });

  it('returns the parsed response body on success', async () => {
    const body = {
      root_cause: 'Null deref',
      fixes: [{ rank: 1, title: 'Guard it', description: 'add check', confidence: 92 }],
      model_used: 'claude-haiku-4-5-20251001',
      cached: true,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)));

    const result = await callDebugBackend({ error_message: 'e' }, config);
    expect(result).toEqual(body);
  });

  it('throws BackendError with status and retry-after on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('{"error":"quota"}', { status: 402, headers: { 'retry-after': '120' } }),
    ));

    const err = await callDebugBackend({ error_message: 'e' }, config).catch((e) => e as BackendError);
    expect(err.status).toBe(402);
    expect(err.retryAfterSeconds).toBe(120);
    expect(err.message).toBe('{"error":"quota"}');
  });

  it('throws status 504 when the request exceeds the timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ));

    const err = await callDebugBackend({ error_message: 'e' }, { ...config, timeoutMs: 30 })
      .catch((e) => e as BackendError);
    expect(err.status).toBe(504);
    expect(err.message).toMatch(/timed out/);
  });

  it('throws status 0 when the network is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const err = await callDebugBackend({ error_message: 'e' }, config).catch((e) => e as BackendError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/Could not reach the DebugAI API/);
  });
});
