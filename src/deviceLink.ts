// Device-link client — the API-key-paste killer.
//
// Modeled on the OAuth 2.0 Device Authorization Grant (RFC 8628), which
// exists for exactly this shape of problem: a program that can't own a
// browser redirect needs a credential a human holds. Same three moves:
//
//   1. start  → server mints a long secret (device_code) + a short
//               human-typeable code (user_code) and a verification URL
//   2. human  → opens the URL in a real browser, signs in, confirms the code
//   3. poll   → the program exchanges device_code for the credential
//
// Deviations from RFC 8628, on purpose: this returns a DebugAI API key
// rather than an OAuth access token (no token endpoint, no refresh cycle,
// and the key is the same one the extension and dashboard already use), and
// there is no client_id — the npm package is the only client.
//
// Poll statuses mirror the RFC's error codes so the state machine is
// familiar: authorization_pending, slow_down, expired_token, access_denied.

export interface DeviceLinkStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** URL with the code pre-filled — what we actually open / print first. */
  verificationUriComplete: string;
  expiresIn: number;
  /** Minimum seconds between polls, per the server. */
  interval: number;
}

export type DeviceLinkPoll =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'linked'; apiKey: string; email?: string; tier?: string };

export interface DeviceLinkOptions {
  apiBase: string;
  /** Shown on the approval page so the human knows what they're authorizing. */
  clientLabel?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const START_TIMEOUT_MS = 15_000;
const POLL_TIMEOUT_MS = 15_000;

export class DeviceLinkError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = 'DeviceLinkError';
  }
}

async function postJson(
  url: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ status: number; json: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    return { status: res.status, json };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new DeviceLinkError(`DebugAI did not answer within ${Math.round(timeoutMs / 1000)}s`, 504);
    }
    throw new DeviceLinkError(
      `Could not reach DebugAI at ${url}: ${(err as Error)?.message ?? String(err)}`,
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function startDeviceLink(opts: DeviceLinkOptions): Promise<DeviceLinkStart> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { status, json } = await postJson(
    `${opts.apiBase}/device-link/start`,
    { client_label: opts.clientLabel ?? 'DebugAI MCP server' },
    opts.timeoutMs ?? START_TIMEOUT_MS,
    fetchImpl,
  );

  if (status !== 200 || !json?.device_code || !json?.user_code) {
    throw new DeviceLinkError(
      json?.error
        ? `DebugAI refused to start the link: ${json.error}`
        : `DebugAI returned HTTP ${status} when starting the link`,
      status,
    );
  }

  return {
    deviceCode:              String(json.device_code),
    userCode:                String(json.user_code),
    verificationUri:         String(json.verification_uri),
    verificationUriComplete: String(json.verification_uri_complete ?? json.verification_uri),
    expiresIn:               Number(json.expires_in) || 600,
    interval:                Number(json.interval) || 5,
  };
}

/** One poll. Never throws on a normal pending/expired answer — those are statuses. */
export async function pollDeviceLink(
  deviceCode: string,
  opts: DeviceLinkOptions,
): Promise<DeviceLinkPoll> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { status, json } = await postJson(
    `${opts.apiBase}/device-link/poll`,
    { device_code: deviceCode },
    opts.timeoutMs ?? POLL_TIMEOUT_MS,
    fetchImpl,
  );

  if (status === 200 && json?.api_key) {
    return { status: 'linked', apiKey: String(json.api_key), email: json.email, tier: json.tier };
  }

  // A proxy or rate limiter answering 429 means "you are early", never "this
  // code is dead" — treating it as expired would kill a perfectly good login.
  if (status === 429) {
    return { status: 'slow_down', interval: Number(json?.interval) || 15 };
  }

  switch (json?.error) {
    case 'authorization_pending': return { status: 'pending' };
    case 'slow_down':             return { status: 'slow_down', interval: Number(json.interval) || 10 };
    case 'expired_token':         return { status: 'expired' };
    case 'access_denied':         return { status: 'denied' };
    default:
      // An unknown 4xx means this device_code will never succeed — treat it as
      // expired rather than spinning forever against a dead code.
      if (status >= 400 && status < 500) return { status: 'expired' };
      throw new DeviceLinkError(`Unexpected response while polling (HTTP ${status})`, status);
  }
}

export interface WaitOptions extends DeviceLinkOptions {
  /** Called once per state change so a CLI can show progress. */
  onTick?: (secondsLeft: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Blocks until the human approves, denies, or the code expires. Honors the
 * server's interval and backs off when told to (`slow_down`) — a client that
 * ignores that is how a device flow turns into a self-inflicted DoS.
 */
export async function waitForDeviceLink(
  start: DeviceLinkStart,
  opts: WaitOptions,
): Promise<DeviceLinkPoll> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + start.expiresIn * 1000;
  let interval = Math.max(1, start.interval);

  for (;;) {
    if (now() >= deadline) return { status: 'expired' };
    await sleep(interval * 1000);

    const result = await pollDeviceLink(start.deviceCode, opts);
    if (result.status === 'slow_down') {
      interval = Math.max(interval + 5, result.interval);
      continue;
    }
    if (result.status !== 'pending') return result;

    opts.onTick?.(Math.max(0, Math.round((deadline - now()) / 1000)));
  }
}
