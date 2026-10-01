// Device-link state machine. Everything here is about NOT stranding a user
// mid-sign-in: a 429 must not read as a dead code, slow_down must actually
// slow down, and an approved link must land the key on disk exactly once.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FAILED_POLLS, isWebAddress, pollDeviceLink, startDeviceLink, waitForDeviceLink } from '../src/deviceLink.js';
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


// ── The address is part of the link, and it is an address (2026-10-01) ───────
describe('a sign-in answer without a usable address is no sign-in answer', () => {
  const start = (body: Record<string, unknown>) =>
    startDeviceLink({ apiBase, fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, body)) as any });
  const CODES = { device_code: 'dc', user_code: 'ABCD-2345', expires_in: 600, interval: 5 };

  it('refuses one with no address, which used to be read out as "Open undefined"', async () => {
    await expect(start(CODES)).rejects.toThrow(/incomplete sign-in response/);
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'vscode://x/y', 'debugai.io/link', '', 42, null])(
    'refuses %p: only http and https are opened or read out', async (uri) => {
      await expect(start({ ...CODES, verification_uri: uri })).rejects.toThrow(/incomplete sign-in response/);
    });

  it('falls back to the plain address when the pre-filled one is not an address', async () => {
    const s = await start({ ...CODES, verification_uri: 'https://debugai.io/link', verification_uri_complete: 'javascript:alert(1)' });
    expect(s.verificationUriComplete).toBe('https://debugai.io/link');
  });

  it('keeps the pre-filled address exactly as the API sends it, tag included', async () => {
    const s = await start({ ...CODES, verification_uri: 'https://debugai.io/link', verification_uri_complete: 'https://debugai.io/link?code=ABCD-2345&src=mcp' });
    expect(s.verificationUriComplete).toBe('https://debugai.io/link?code=ABCD-2345&src=mcp');
  });

  it('the agent is told sign-in could not start, never handed a broken link', async () => {
    const auth = new AuthProvider({ apiBase, env, fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, CODES)) as any });
    const r = await auth.ensure();
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toBe('link_unavailable');
    expect(r.text).not.toContain('undefined');
    expect(r.text).toContain('npx -y @debugai/mcp login');
  });

  it('isWebAddress', () => {
    expect(isWebAddress('https://debugai.io/link?code=A&src=mcp')).toBe(true);
    expect(isWebAddress('http://127.0.0.1:3000/link')).toBe(true);
    for (const no of ['ftp://x', 'https://', 'https://a b', undefined, {}]) expect(isWebAddress(no), String(no)).toBe(false);
  });
});

// ── A blip is not a dead code ────────────────────────────────────────────────
//
// One failed poll used to throw out of `login`: a stack trace in the terminal
// and no key, while the human was half way through confirming the code.
describe('waitForDeviceLink survives a poll that fails', () => {
  const start = {
    deviceCode: 'dc', userCode: 'ABCD-2345',
    verificationUri: 'u', verificationUriComplete: 'u', expiresIn: 600, interval: 5,
  };
  const pending = () => jsonResponse(400, { error: 'authorization_pending' });
  const html502 = () => new Response('<html>Bad Gateway</html>', { status: 502 });

  it('a dropped connection and a 502 during a deploy, then the key', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(html502())
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(jsonResponse(200, { api_key: 'dbg_after_blip' }));
    const result = await waitForDeviceLink(start, { apiBase, fetchImpl: fetchImpl as any, sleep: async () => {} });
    expect(result).toMatchObject({ status: 'linked', apiKey: 'dbg_after_blip' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('gives up on a run of failures, with the last one as the reason', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(waitForDeviceLink(start, { apiBase, fetchImpl: fetchImpl as any, sleep: async () => {} }))
      .rejects.toThrow(/Could not reach DebugAI/);
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_FAILED_POLLS);
  });

  it('counts failures in a row, not in total', async () => {
    const fetchImpl = vi.fn();
    for (let i = 0; i < MAX_FAILED_POLLS * 2; i++) {
      for (let k = 0; k < MAX_FAILED_POLLS - 1; k++) fetchImpl.mockResolvedValueOnce(html502());
      fetchImpl.mockResolvedValueOnce(pending());
    }
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, { api_key: 'dbg_ok' }));
    const result = await waitForDeviceLink(start, { apiBase, fetchImpl: fetchImpl as any, sleep: async () => {} });
    expect(result.status).toBe('linked');
  });

  it('still waits between polls that fail', async () => {
    const slept: number[] = [];
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, { api_key: 'dbg_ok' }));
    await waitForDeviceLink(start, { apiBase, fetchImpl: fetchImpl as any, sleep: async (ms) => { slept.push(ms); } });
    expect(slept).toEqual([5_000, 5_000]);
  });
});

// ── A key is delivered once ──────────────────────────────────────────────────
//
// apps/api/src/routes/deviceLink.ts: "the code dies the moment the key goes
// out". So a key that could not be written down and was dropped is a sign-in
// the user has to do again, and with a home this process cannot write, again
// after that: measured 2026-10-01, confirm -> same code repeated -> a new code.
describe('AuthProvider keeps a key it could not write down', () => {
  const linkOnce = () => {
    let polls = 0, starts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/device-link/start')) {
        starts++;
        return jsonResponse(200, { device_code: `dc${starts}`, user_code: `CODE-${starts}`, verification_uri: 'https://debugai.io/link', expires_in: 600, interval: 5 });
      }
      polls++;
      return polls === 1 ? jsonResponse(200, { api_key: 'dbg_delivered_once' }) : jsonResponse(400, { error: 'expired_token' });
    });
    return { fetchImpl, counts: () => ({ polls, starts }) };
  };
  // A path under a FILE: no directory can be made there, on any platform.
  const unwritable = () => {
    writeFileConfig({ apiBase: 'https://x/api' }, env);
    return { DEBUGAI_CONFIG_PATH: join(dir, 'config.json', 'nested', 'config.json') };
  };

  it('uses it for this call and for every later one, and mints no second code', async () => {
    let clock = 1_000_000;
    const { fetchImpl, counts } = linkOnce();
    const warned: string[] = [];
    const auth = new AuthProvider({ apiBase, env: unwritable(), fetchImpl: fetchImpl as any, now: () => clock, warn: (m) => warned.push(m) });
    await auth.ensure();
    clock += 10_000;
    expect(await auth.ensure()).toEqual({ ok: true, apiKey: 'dbg_delivered_once' });
    clock += 10_000;
    expect(await auth.ensure()).toEqual({ ok: true, apiKey: 'dbg_delivered_once' });
    expect(counts()).toEqual({ polls: 1, starts: 1 });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('could not be saved');
    expect(warned[0]).not.toContain('dbg_delivered_once');     // a key is never printed
  });

  it('a key that WAS written is not also held in memory, so logout takes effect at once', async () => {
    let clock = 1_000_000;
    const { fetchImpl } = linkOnce();
    const auth = new AuthProvider({ apiBase, env, fetchImpl: fetchImpl as any, now: () => clock });
    await auth.ensure();
    clock += 10_000;
    expect(await auth.ensure()).toEqual({ ok: true, apiKey: 'dbg_delivered_once' });
    expect(clearStoredKey(env)).toBe(true);
    expect(auth.currentKey()).toBe('');
  });

  it('a key set in the environment later outranks the one held in memory', async () => {
    let clock = 1_000_000;
    const { fetchImpl } = linkOnce();
    const e: NodeJS.ProcessEnv = unwritable();
    const auth = new AuthProvider({ apiBase, env: e, fetchImpl: fetchImpl as any, now: () => clock, warn: () => {} });
    await auth.ensure();
    clock += 10_000;
    await auth.ensure();
    e.DEBUGAI_API_KEY = 'dbg_from_env';
    expect(auth.currentKey()).toBe('dbg_from_env');
  });

  it('so does a key stored later, once the file can be written', async () => {
    if (platform() === 'win32' || process.getuid?.() === 0) return;   // POSIX modes, and not as root
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    const e = { DEBUGAI_CONFIG_PATH: join(locked, 'config.json') };
    let clock = 1_000_000;
    const { fetchImpl } = linkOnce();
    const auth = new AuthProvider({ apiBase, env: e, fetchImpl: fetchImpl as any, now: () => clock, warn: () => {} });
    try {
      await auth.ensure();
      clock += 10_000;
      expect(await auth.ensure()).toEqual({ ok: true, apiKey: 'dbg_delivered_once' });
      expect(auth.currentKey()).toBe('dbg_delivered_once');
      chmodSync(locked, 0o755);
      writeFileConfig({ apiKey: 'dbg_login_in_another_terminal' }, e);
      expect(auth.currentKey()).toBe('dbg_login_in_another_terminal');
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});
