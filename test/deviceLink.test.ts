// Device-link state machine. Everything here is about NOT stranding a user
// mid-sign-in: a 429 must not read as a dead code, slow_down must actually
// slow down, and an approved link must land the key on disk exactly once.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollDeviceLink, startDeviceLink, waitForDeviceLink } from '../src/deviceLink.js';
import { AuthProvider } from '../src/auth.js';
import { writeFileConfig, clearStoredKey, maskKey } from '../src/config.js';

const apiBase = 'https://api.test/api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'debugai-devicelink-'));
  env = { DEBUGAI_CONFIG_PATH: join(dir, 'config.json') };
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('startDeviceLink', () => {
  it('maps the server payload onto the client shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      device_code: 'dc', user_code: 'ABCD-2345',
      verification_uri: 'https://debugai.io/link',
      verification_uri_complete: 'https://debugai.io/link?code=ABCD-2345',
      expires_in: 600, interval: 5,
    }));

    const start = await startDeviceLink({ apiBase, fetchImpl: fetchImpl as any });
    expect(start.userCode).toBe('ABCD-2345');
    expect(start.verificationUriComplete).toContain('code=ABCD-2345');
    expect(start.interval).toBe(5);
  });

  it('throws when the server answers without a code', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: 'nope' }));
    await expect(startDeviceLink({ apiBase, fetchImpl: fetchImpl as any })).rejects.toThrow(/refused|HTTP/i);
  });

  it('sends a client label so the human can see what they are approving', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      device_code: 'dc', user_code: 'ABCD-2345', verification_uri: 'https://x/link', expires_in: 600, interval: 5,
    }));
    await startDeviceLink({ apiBase, clientLabel: 'laptop (darwin)', fetchImpl: fetchImpl as any });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).client_label).toBe('laptop (darwin)');
  });
});

describe('pollDeviceLink', () => {
  const poll = (status: number, body: unknown) =>
    pollDeviceLink('dc', { apiBase, fetchImpl: vi.fn().mockResolvedValue(jsonResponse(status, body)) as any });

  it('reads each RFC 8628 error code', async () => {
    expect(await poll(400, { error: 'authorization_pending' })).toEqual({ status: 'pending' });
    expect(await poll(400, { error: 'expired_token' })).toEqual({ status: 'expired' });
    expect(await poll(400, { error: 'access_denied' })).toEqual({ status: 'denied' });
    expect(await poll(400, { error: 'slow_down', interval: 12 })).toEqual({ status: 'slow_down', interval: 12 });
  });

  it('returns the key on success', async () => {
    expect(await poll(200, { api_key: 'dbg_live', email: 'a@b.c', tier: 'free' }))
      .toEqual({ status: 'linked', apiKey: 'dbg_live', email: 'a@b.c', tier: 'free' });
  });

  it('treats a 429 as slow_down, never as a dead code', async () => {
    // A rate limiter in front of the API must not end a legitimate sign-in.
    expect(await poll(429, { error: 'Too many requests' })).toEqual({ status: 'slow_down', interval: 15 });
  });

  it('treats an unrecognised 4xx as expired rather than spinning forever', async () => {
    expect(await poll(404, { error: 'whatever' })).toEqual({ status: 'expired' });
  });
});

describe('waitForDeviceLink', () => {
  const start = {
    deviceCode: 'dc', userCode: 'ABCD-2345',
    verificationUri: 'u', verificationUriComplete: 'u', expiresIn: 600, interval: 5,
  };

  it('keeps polling through pending and returns the eventual key', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'authorization_pending' }))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'authorization_pending' }))
      .mockResolvedValueOnce(jsonResponse(200, { api_key: 'dbg_ok' }));

    const result = await waitForDeviceLink(start, { apiBase, fetchImpl: fetchImpl as any, sleep: async () => {} });
    expect(result).toMatchObject({ status: 'linked', apiKey: 'dbg_ok' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('actually backs off when told to slow down', async () => {
    const slept: number[] = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'slow_down', interval: 20 }))
      .mockResolvedValueOnce(jsonResponse(200, { api_key: 'dbg_ok' }));

    await waitForDeviceLink(start, {
      apiBase, fetchImpl: fetchImpl as any,
      sleep: async (ms) => { slept.push(ms); },
    });
    expect(slept[0]).toBe(5_000);
    expect(slept[1]).toBe(20_000); // the server's number, not ours
  });

  it('gives up at the deadline instead of polling forever', async () => {
    let clock = 0;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: 'authorization_pending' }));
    const result = await waitForDeviceLink(
      { ...start, expiresIn: 10 },
      { apiBase, fetchImpl: fetchImpl as any, sleep: async () => { clock += 6_000; }, now: () => clock },
    );
    expect(result.status).toBe('expired');
  });
});

describe('AuthProvider', () => {
  it('prefers the env key and never touches the network', async () => {
    const fetchImpl = vi.fn();
    const auth = new AuthProvider({ apiBase, env: { ...env, DEBUGAI_API_KEY: 'dbg_env' }, fetchImpl: fetchImpl as any });
    expect(await auth.ensure()).toEqual({ ok: true, apiKey: 'dbg_env' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('picks up a key written after the process started — no restart needed', async () => {
    const auth = new AuthProvider({ apiBase, env });
    expect(auth.currentKey()).toBe('');
    writeFileConfig({ apiKey: 'dbg_later' }, env);
    expect(auth.currentKey()).toBe('dbg_later'); // re-read, not cached at construction
  });

  it('starts a link and returns instructions naming the code and URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      device_code: 'dc', user_code: 'ABCD-2345',
      verification_uri: 'https://debugai.io/link',
      verification_uri_complete: 'https://debugai.io/link?code=ABCD-2345',
      expires_in: 600, interval: 5,
    }));

    const auth = new AuthProvider({ apiBase, env, fetchImpl: fetchImpl as any });
    const result = await auth.ensure();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('link_pending');
    expect(result.text).toContain('ABCD-2345');
    expect(result.text).toContain('https://debugai.io/link?code=ABCD-2345');
    expect(result.text).toMatch(/does NOT need restarting|not need restarting/i);
  });

  it('polls the pending link on the next call and stores the key when approved', async () => {
    let clock = 1_000_000;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        device_code: 'dc', user_code: 'ABCD-2345', verification_uri: 'https://x/link', expires_in: 600, interval: 5,
      }))
      .mockResolvedValueOnce(jsonResponse(200, { api_key: 'dbg_from_link', email: 'a@b.c' }));

    const auth = new AuthProvider({ apiBase, env, fetchImpl: fetchImpl as any, now: () => clock });
    await auth.ensure();               // starts the link
    clock += 10_000;                   // the human approves in the browser
    const second = await auth.ensure();

    expect(second).toEqual({ ok: true, apiKey: 'dbg_from_link' });
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).api_key).toBe('dbg_from_link');
  });

  it('does not mint a second code while one is still pending', async () => {
    let clock = 1_000_000;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        device_code: 'dc', user_code: 'ABCD-2345', verification_uri: 'https://x/link', expires_in: 600, interval: 5,
      }))
      .mockResolvedValue(jsonResponse(400, { error: 'authorization_pending' }));

    const auth = new AuthProvider({ apiBase, env, fetchImpl: fetchImpl as any, now: () => clock });
    const first = await auth.ensure();
    clock += 10_000;
    const second = await auth.ensure();

    if (first.ok || second.ok) throw new Error('expected both to be unlinked');
    expect(second.reason).toBe('link_pending');
    expect(second.userCode).toBe('ABCD-2345'); // same code, not a fresh one
  });

  it('degrades to printed instructions when the link endpoint is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const auth = new AuthProvider({ apiBase, env, fetchImpl: fetchImpl as any });
    const result = await auth.ensure();
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('link_unavailable');
    expect(result.text).toContain('npx -y @debugai/mcp login');
  });
});

describe('config writing', () => {
  it('writes 0600 so another user on the box cannot read the key', () => {
    if (platform() === 'win32') return; // POSIX modes only
    const path = writeFileConfig({ apiKey: 'dbg_secret' }, env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('keeps an api_base the user set by hand when storing a key', () => {
    writeFileConfig({ apiBase: 'https://self.hosted/api' }, env);
    writeFileConfig({ apiKey: 'dbg_x' }, env);
    const written = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(written).toEqual({ api_key: 'dbg_x', api_base: 'https://self.hosted/api' });
  });

  it('logout removes the key but keeps the api_base', () => {
    writeFileConfig({ apiKey: 'dbg_x', apiBase: 'https://self.hosted/api' }, env);
    expect(clearStoredKey(env)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toEqual({ api_base: 'https://self.hosted/api' });
    expect(clearStoredKey(env)).toBe(false); // nothing left to clear
  });

  it('masks keys instead of printing them', () => {
    expect(maskKey('dbg_abcdef1234567890')).toBe('dbg_abcd…7890');
    expect(maskKey('')).toBe('(none)');
  });
});
