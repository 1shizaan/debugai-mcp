// `debugai-mcp login`, the BUILT CLI, against a real local server.
//
// The sign-in is the funnel. Measured 2026-10-01: one 502 while it waited (an
// API redeploy takes longer than a poll) ended it in an unhandled rejection -
// a stack trace and no key - and so did a home directory it could not write.
// CI=1 in every run here, so no browser is ever opened.
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const distEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

let api: Server;
let base: string;
let dir: string;
/** What each poll answers, in order; the last entry repeats. */
let polls: Array<'502' | 'drop' | 'pending' | 'key'>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'debugai-login-'));
  polls = ['key'];
  let n = 0;
  api = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url?.endsWith('/device-link/start')) {
        return json(200, {
          device_code: 'dc', user_code: 'ABCD-2345', verification_uri: 'https://debugai.io/link',
          verification_uri_complete: 'https://debugai.io/link?code=ABCD-2345&src=mcp', expires_in: 600, interval: 1,
        });
      }
      if (req.url?.endsWith('/device-link/poll')) {
        const answer = polls[Math.min(n++, polls.length - 1)];
        if (answer === 'drop') return void req.socket.destroy();
        if (answer === '502') { res.writeHead(502, { 'content-type': 'text/html' }); return void res.end('<html>Bad Gateway</html>'); }
        if (answer === 'pending') return json(400, { error: 'authorization_pending' });
        return json(200, { api_key: 'dbg_linked', email: 'dev@example.com', tier: 'free' });
      }
      return json(404, {});
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api`;
});

afterEach(() => {
  api.closeAllConnections?.();
  api.close();
  rmSync(dir, { recursive: true, force: true });
});

function login(configPath: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [distEntry, 'login'], {
      env: { ...process.env, CI: '1', DEBUGAI_API_KEY: '', DEBUGAI_API_BASE: base, DEBUGAI_CONFIG_PATH: configPath },
      timeout: 30_000,
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, out: `${stdout}\n${stderr}` });
    });
  });
}

const NO_STACK = /DeviceLinkError|at pollDeviceLink|at async|node:internal|Node\.js v\d/;

describe('debugai-mcp login', () => {
  it('signs in through a 502 and a dropped connection', async () => {
    polls = ['502', 'drop', 'key'];
    const cfg = join(dir, 'config.json');
    const r = await login(cfg);
    expect(r.out).toContain('Signed in as');
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(cfg, 'utf8')).api_key).toBe('dbg_linked');
    expect(r.out).not.toMatch(NO_STACK);
  }, 30_000);

  it('says it lost contact, in a sentence, when the API stays down', async () => {
    polls = ['drop'];
    const cfg = join(dir, 'config.json');
    const r = await login(cfg);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Lost contact with DebugAI while waiting');
    expect(r.out).toContain('Run "debugai-mcp login" again');
    expect(r.out).not.toMatch(NO_STACK);
    expect(existsSync(cfg)).toBe(false);
  }, 30_000);

  it('says the key could not be saved, in a sentence, and never prints it', async () => {
    writeFileSync(join(dir, 'a-file'), 'x');
    const cfg = join(dir, 'a-file', 'config.json');          // under a file: cannot be made
    const r = await login(cfg);
    expect(r.code).toBe(1);
    expect(r.out).toContain('the key could not be saved to');
    expect(r.out).toContain('DEBUGAI_CONFIG_PATH');
    expect(r.out).not.toContain('dbg_linked');
    expect(r.out).not.toMatch(NO_STACK);
  }, 30_000);

  it('prints the whole address, tag included, for a terminal that opens nothing', async () => {
    const r = await login(join(dir, 'config.json'));
    expect(r.out).toContain('https://debugai.io/link?code=ABCD-2345&src=mcp');
    expect(r.out).toContain('open that link on any device');
  }, 30_000);
});
