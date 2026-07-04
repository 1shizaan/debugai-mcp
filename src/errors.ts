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
          'DebugAI authentication failed: API key missing, invalid, or expired. ' +
          `Tell the user to get their API key at ${DASHBOARD_URL} and set it as the ` +
          'DEBUGAI_API_KEY environment variable in their MCP client config (the "env" block ' +
          'for the debugai server entry), then restart the MCP client and retry.',
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

  if (status === 429) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          `DebugAI rate limit hit (transient). Retry after ${retry} seconds. ` +
          `Do NOT retry this call immediately — inform the user and wait for the cooldown. ` +
          `Upgrade for higher limits: ${DASHBOARD_URL}`,
      }],
      structuredContent: {
        error_type: 'rate_limited',
        retry_after_seconds: retry,
        retryable: true,
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
