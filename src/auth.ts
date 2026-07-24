// Live auth for the running server.
//
// Two problems this solves, both of which used to end the funnel:
//
//  1. The key used to be read ONCE at process start. A user who fixed their
//     setup while the client was running still got auth errors until they
//     restarted the whole MCP client. Now the key is re-read from env + the
//     config file on every tool call, so `debugai-mcp login` in another
//     terminal takes effect on the next call — no restart, no reconnect.
//
//  2. A user with no key at all used to get a dead-end error. Now the server
//     starts a device link itself and hands the agent a short code plus a URL
//     to read out. The human approves in a browser; the agent retries; the
//     second call finds the key and does the real work. Signup happens inside
//     the conversation instead of in a config file the user never opens.
import { loadFileConfig, writeFileConfig } from './config.js';
import {
  DeviceLinkError,
  pollDeviceLink,
  startDeviceLink,
  type DeviceLinkStart,
} from './deviceLink.js';

export interface AuthProviderOptions {
  apiBase: string;
  env?: NodeJS.ProcessEnv;
  clientLabel?: string;
  /** Injected in tests. */
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export type EnsureAuth =
  | { ok: true; apiKey: string }
  | { ok: false; reason: 'link_pending'; text: string; userCode: string; verificationUri: string }
  | { ok: false; reason: 'link_unavailable'; text: string };

/** Minimum gap between in-session polls: one poll per tool call, at most. */
const MIN_POLL_GAP_MS = 3_000;

export class AuthProvider {
  private pending: DeviceLinkStart | null = null;
  private pendingStartedAt = 0;
  private lastPollAt = 0;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(private readonly opts: AuthProviderOptions) {
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
  }

  /** Env wins over file, re-read every call — see the header note. */
  currentKey(): string {
    const envKey = (this.env.DEBUGAI_API_KEY ?? '').trim();
    if (envKey) return envKey;
    return loadFileConfig(this.env, () => {}).apiKey ?? '';
  }

  /**
   * Returns a usable key, or the exact words the agent should say to the user.
   * Never throws: a failure to reach the link endpoint degrades to printed
   * instructions, it does not take the tool call down with it.
   */
  async ensure(): Promise<EnsureAuth> {
    const existing = this.currentKey();
    if (existing) return { ok: true, apiKey: existing };

    // A link already in flight — poll it once before minting another code, so
    // an agent retrying in a loop doesn't spray fresh codes at the user.
    if (this.pending && this.now() - this.pendingStartedAt < this.pending.expiresIn * 1000) {
      if (this.now() - this.lastPollAt >= MIN_POLL_GAP_MS) {
        this.lastPollAt = this.now();
        try {
          const result = await pollDeviceLink(this.pending.deviceCode, {
            apiBase: this.opts.apiBase,
            fetchImpl: this.opts.fetchImpl,
          });
          if (result.status === 'linked') {
            writeFileConfig({ apiKey: result.apiKey }, this.env);
            this.pending = null;
            return { ok: true, apiKey: result.apiKey };
          }
          if (result.status === 'expired' || result.status === 'denied') {
            this.pending = null; // fall through and mint a fresh code below
          }
        } catch {
          // Network hiccup mid-link: keep the pending code, repeat instructions.
        }
      }
      if (this.pending) return this.pendingResult(this.pending);
    }

    try {
      const start = await startDeviceLink({
        apiBase: this.opts.apiBase,
        clientLabel: this.opts.clientLabel,
        fetchImpl: this.opts.fetchImpl,
      });
      this.pending = start;
      this.pendingStartedAt = this.now();
      this.lastPollAt = this.now();
      return this.pendingResult(start);
    } catch (err) {
      const detail = err instanceof DeviceLinkError ? ` (${err.message})` : '';
      return {
        ok: false,
        reason: 'link_unavailable',
        text:
          'DebugAI is not connected to an account yet, and the automatic link could not be ' +
          `started${detail}. Tell the user to run this in a terminal, which signs them in and ` +
          'stores the key for every MCP client at once:\n\n' +
          '    npx -y @debugai/mcp login\n\n' +
          'It opens a browser, takes about 20 seconds, and needs no config editing. ' +
          'Then retry this tool call. No client restart needed.',
      };
    }
  }

  private pendingResult(start: DeviceLinkStart): EnsureAuth {
    return {
      ok: false,
      reason: 'link_pending',
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      text:
        'DebugAI is not connected to an account yet. This takes about 20 seconds and needs no ' +
        'config file editing.\n\n' +
        'Tell the user, verbatim:\n' +
        `  1. Open ${start.verificationUriComplete}\n` +
        `  2. Sign in (free, 10 debugs/day, no card) and confirm the code ${start.userCode}\n\n` +
        'Then call this tool again with the same arguments. The key is picked up automatically ' +
        'on the next call. The MCP client does NOT need restarting. ' +
        `The code expires in ${Math.round(start.expiresIn / 60)} minutes.`,
    };
  }
}
