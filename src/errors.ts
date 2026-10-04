import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const PRICING_URL = 'https://debugai.io/pricing';
const DASHBOARD_URL = 'https://debugai.io/dashboard';

interface QuotaBody {
  error?: string;
  limit?: number;
  tier?: string;
  resets_at?: string;
  upgrade_url?: string;
}

function tryParseJson(text: string): QuotaBody | null {
  try { return JSON.parse(text) as QuotaBody; } catch { return null; }
}

export function mapBackendErrorToToolResult(err: unknown): CallToolResult {
  const status  = (err as any)?.status     as number ?? 0;
  const message = (err as any)?.message    as string ?? String(err);
  const retry   = (err as any)?.retryAfterSeconds as number ?? 60;

  if (status === 401 || status === 403) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          'DebugAI authentication failed: the API key this server has was rejected ' +
          '(rotated, revoked, or mistyped). Tell the user to run this in a terminal, which ' +
          'signs them in through the browser and replaces the stored key:\n\n' +
          '    npx -y @debugai/mcp login --force\n\n' +
          'Then retry this call; no client restart is needed. If it is refused again, ' +
          '`npx -y @debugai/mcp doctor` shows where an old key is still written into a ' +
          `client config. Their account and key are at ${DASHBOARD_URL}.`,
      }],
      structuredContent: {
        error_type: 'auth_failed',
        dashboard_url: DASHBOARD_URL,
        retryable: false,
      },
    };
  }

  // 402 Payment Required — quota exhausted (NOT a transient rate limit).
  // Agents must NOT retry. They must surface the upgrade URL to the user.
  if (status === 402) {
    const body = tryParseJson(message) ?? {};
    const tier = body.tier ?? 'free';
    const limit = body.limit ?? 10;
    const resets = body.resets_at ?? 'midnight UTC';
    const upgrade = body.upgrade_url ?? PRICING_URL;

    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          `DebugAI ${tier} tier daily quota reached (${limit} debugs/day). ` +
          `Resets at ${resets}. ` +
          `IMPORTANT: This is NOT a transient rate limit — do NOT retry this call. ` +
          `Tell the user to upgrade to Pro for more debugging: ${upgrade}. ` +
          `Pro is $12/month, lifts the daily cap, and gives unlimited sessions (soft cap 1,000/mo).`,
      }],
      structuredContent: {
        error_type: 'quota_exceeded',
        tier,
        daily_limit: limit,
        resets_at: resets,
        upgrade_url: upgrade,
        retryable: false,
      },
    };
  }

  // 400: the API refused the arguments, and its body says why. Retrying the
  // same call cannot help and changing the arguments can, so this is the one
  // failure that must not say "retry shortly". Relayed rather than re-derived:
  // the rule lives in the API, and a copy of it here would drift.
  if (status === 400) {
    // Never throws: a body whose `error` is not text falls back to the raw
    // body, and an empty one to a sentence, so this cannot fail the tool call.
    const body = tryParseJson(String(message));
    const stated = (typeof body?.error === 'string' && body.error.trim() ? body.error : String(message ?? '')).trim()
      || 'the request was malformed';
    const reason = /[.!?]$/.test(stated) ? stated : `${stated}.`;
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          `DebugAI refused this call: ${reason} ` +
          'Change the arguments and call again. The same call unchanged is refused the same way.',
      }],
      structuredContent: {
        error_type: 'invalid_request',
        reason,
        retryable: false,
      },
    };
  }

  // 429 is two different things. A burst (express-rate-limit) carries a
  // Retry-After and clears by itself. A paid account past its monthly ceiling
  // does not: the API's body names when it resets (`resets_at`, written in
  // apps/api/src/usageGuard.ts) and sends no Retry-After. Read as a burst it
  // said "transient. Retry after 0 seconds", retryable, and offered an upgrade
  // to an account that already pays, so an agent had every reason to call
  // again at once, for the rest of the month.
  if (status === 429) {
    const ceiling = tryParseJson(String(message));
    if (typeof ceiling?.resets_at === 'string') {
      const tier = typeof ceiling.tier === 'string' && ceiling.tier ? ceiling.tier : 'paid';
      return {
        isError: true,
        content: [{
          type: 'text',
          text:
            `DebugAI monthly usage ceiling reached for this ${tier} account. It resets on the 1st of the month (UTC). ` +
            'IMPORTANT: This is NOT a transient rate limit — do NOT retry this call; it is refused the same way until then. ' +
            `Tell the user. If this usage is legitimate, they can message DebugAI from ${DASHBOARD_URL}.`,
        }],
        structuredContent: {
          error_type: 'monthly_ceiling',
          tier,
          resets_at: ceiling.resets_at,
          retryable: false,
        },
      };
    }
    // The backend reports a missing Retry-After as 0, never as undefined, so
    // the `?? 60` above does not catch it. Zero seconds is not a cooldown.
    const wait = retry > 0 ? retry : 60;
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          `DebugAI rate limit hit (transient). Retry after ${wait} seconds. ` +
          // No upgrade link. The limiters behind this (one per network
          // address, one per account on lookups) are not raised by any plan.
          'Do NOT retry this call immediately — inform the user and wait for the cooldown.',
      }],
      structuredContent: {
        error_type: 'rate_limited',
        retry_after_seconds: wait,
        retryable: true,
      },
    };
  }

  // 404: the API does not know what the call named. In practice a debug_log_id
  // this account never received (report_outcome), and the same call unchanged
  // is refused the same way, so it must not fall through to "retry shortly"
  // and send an agent round a loop that cannot end. A wrong DEBUGAI_API_BASE
  // looks the same from here, so the text names both.
  if (status === 404) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          'DebugAI did not recognise what this call referred to (HTTP 404). For report_outcome ' +
          'that means the debug_log_id is not one this account was given: use the debug_log_id ' +
          'from the debug_error answer in this session, and do not retry the same one. If every ' +
          'call is answered this way, DEBUGAI_API_BASE may be wrong.',
      }],
      structuredContent: {
        error_type: 'not_found',
        status,
        retryable: false,
      },
    };
  }

  if (status === 503 || status === 504) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          `DebugAI engine temporarily unavailable (HTTP ${status}). ` +
          `Tell the user this is a transient issue and to retry in 30-60 seconds. ` +
          `Check status at https://status.debugai.io if it persists.`,
      }],
      structuredContent: {
        error_type: 'engine_unavailable',
        status,
        retryable: true,
      },
    };
  }

  // status 0 — the request never reached the API (DNS, refused, offline)
  if (status === 0) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          `${message}. The user may be offline, behind a proxy, or DEBUGAI_API_BASE may be ` +
          `misconfigured. Retry once the network is available.`,
      }],
      structuredContent: {
        error_type: 'network_error',
        retryable: true,
      },
    };
  }

  return {
    isError: true,
    content: [{
      type: 'text',
      text: `DebugAI request failed: ${message}. The user can retry shortly.`,
    }],
    structuredContent: {
      error_type: 'unknown',
      status,
      retryable: true,
    },
  };
}
