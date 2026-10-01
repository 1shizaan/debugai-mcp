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


// ── The deadline is the whole request's, and a 200 is not always ours ────────
//
// Against a real socket, because the defect was in what happens between the
// status line and the end of the body, and a mocked fetch has no such gap.
// Measured 2026-10-01: with the timer cleared as soon as headers arrived, a
// lookup with an 8 second deadline was still waiting at 12.
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { callLookupBackend, callOutcomeBackend } from '../src/backend.js';

async function serverThat(handle: Parameters<typeof createServer>[1]): Promise<{ srv: Server; base: string }> {
  const srv = createServer(handle);
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const addr = srv.address();
  return { srv, base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api` };
}

describe('one deadline, from the first byte sent to the last byte read', () => {
  let srv: Server | undefined;
  afterEach(() => { srv?.closeAllConnections?.(); srv?.close(); srv = undefined; });

  it('a 200 whose body never finishes ends at the deadline', async () => {
    const s = await serverThat((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"root_cause":'); });
    srv = s.srv;
    const started = Date.now();
    const err = await callDebugBackend({ error_message: 'e' }, { ...config, apiBase: s.base, timeoutMs: 300 })
      .catch((e) => e as BackendError);
    expect(err.status).toBe(504);
    expect(err.message).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('an error status whose body never finishes ends at the deadline too', async () => {
    const s = await serverThat((req, res) => { req.resume(); res.writeHead(500, { 'content-type': 'text/plain' }); res.write('partial'); });
    srv = s.srv;
    const err = await callDebugBackend({ error_message: 'e' }, { ...config, apiBase: s.base, timeoutMs: 300 })
      .catch((e) => e as BackendError);
    expect(err.status).toBe(504);
  });

  it('a body cut off part way is said as that, not as a parse error', async () => {
    const s = await serverThat((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
      res.write('{"root_cause":"half', () => res.destroy());
    });
    srv = s.srv;
    const err = await callDebugBackend({ error_message: 'e' }, { ...config, apiBase: s.base, timeoutMs: 5000 })
      .catch((e) => e as BackendError);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/stopped answering part way/);
  });

  it('answers that arrive in time are untouched', async () => {
    const s = await serverThat((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"memory_hit":true,"memory_times_seen":2}'); });
    srv = s.srv;
    await expect(callLookupBackend({ error_message: 'e' }, { ...config, apiBase: s.base }))
      .resolves.toEqual({ memory_hit: true, memory_times_seen: 2 });
  });
});

describe('a 200 that is not a DebugAI response', () => {
  const HTML = '<!DOCTYPE html><html><body>Sign in to the network</body></html>';

  it.each([
    ['debug', () => callDebugBackend({ error_message: 'e' }, config)],
    ['outcome', () => callOutcomeBackend({ debug_log_id: 'x', result: 'worked', source: 'agent' }, config)],
    ['lookup', () => callLookupBackend({ error_message: 'e' }, config)],
  ] as const)('%s: a proxy page is named as one, with a status the mapper can read', async (_name, call) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } })));
    const err = await call().catch((e) => e as BackendError);
    expect(err.status).toBe(502);
    expect(err.message).toContain('not JSON');
    expect(err.message).toContain(config.apiBase);
    expect(err.message).not.toMatch(/Unexpected token|DOCTYPE/);
  });
});
