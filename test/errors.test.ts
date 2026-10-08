import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapBackendErrorToToolResult } from '../src/errors.js';

function backendError(status: number, message = 'err', retryAfterSeconds = 0) {
  return Object.assign(new Error(message), { status, retryAfterSeconds });
}

function textOf(result: ReturnType<typeof mapBackendErrorToToolResult>): string {
  const first = result.content[0];
  return first.type === 'text' ? first.text : '';
}

describe('mapBackendErrorToToolResult', () => {
  it('401: sends the user to sign in again, never to write the key into a client config', () => {
    // It used to say "set it as the DEBUGAI_API_KEY environment variable in
    // their MCP client config (the "env" block) ... then restart the MCP
    // client". `doctor` warns about exactly that block (a key in plain text in
    // a file that gets committed, which outranks the stored one after a
    // rotation), `install` never writes one, and the server re-reads the stored
    // key on every call, so no restart is needed either.
    const result = mapBackendErrorToToolResult(backendError(401));
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('npx -y @debugai/mcp login --force');
    expect(text).toContain('npx -y @debugai/mcp doctor');
    expect(text).toContain('debugai.io/dashboard');
    expect(text).toContain('no client restart is needed');
    expect(text).not.toMatch(/"env" block|environment variable in their MCP client config/);
    expect(text).not.toMatch(/VS Code|command palette/i);
    expect(result.structuredContent).toMatchObject({ error_type: 'auth_failed', retryable: false });
  });

  it('401: the two commands it names are ones the CLI has', () => {
    const cli = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(cli).toMatch(/case 'login':/);
    expect(cli).toMatch(/case 'doctor':/);
    expect(readFileSync(new URL('../src/cli/commands.ts', import.meta.url), 'utf8')).toContain("flag(argv, 'force')");
  });

  it('402: surfaces tier, limit, reset, upgrade URL from the response body and forbids retry', () => {
    const body = JSON.stringify({
      tier: 'free', limit: 10, resets_at: '2026-07-06T00:00:00Z', upgrade_url: 'https://debugai.io/pricing?src=mcp',
    });
    const result = mapBackendErrorToToolResult(backendError(402, body));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('free tier daily quota reached (10 debugs/day)');
    expect(textOf(result)).toContain('2026-07-06T00:00:00Z');
    expect(textOf(result)).toContain('do NOT retry');
    expect(result.structuredContent).toMatchObject({
      error_type: 'quota_exceeded',
      upgrade_url: 'https://debugai.io/pricing?src=mcp',
      retryable: false,
    });
  });

  it('404: an id the API does not know is not retryable, and is not "retry shortly"', () => {
    const result = mapBackendErrorToToolResult(backendError(404, '{"error":"not found"}'));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('did not recognise');
    expect(textOf(result)).toContain('do not retry the same one');
    expect(textOf(result)).not.toContain('retry shortly');
    expect(result.structuredContent).toMatchObject({ error_type: 'not_found', status: 404, retryable: false });
  });

  it('402 with unparseable body: falls back to free-tier defaults', () => {
    const result = mapBackendErrorToToolResult(backendError(402, 'Payment Required'));
    expect(textOf(result)).toContain('free tier daily quota reached (10 debugs/day)');
    expect(textOf(result)).toContain('https://debugai.io/pricing');
  });

  it('429: retryable with the retry-after value', () => {
    const result = mapBackendErrorToToolResult(backendError(429, 'slow down', 45));
    expect(textOf(result)).toContain('Retry after 45 seconds');
    expect(result.structuredContent).toMatchObject({
      error_type: 'rate_limited', retry_after_seconds: 45, retryable: true,
    });
  });

  it('429 with no Retry-After: the cooldown is 60s, never 0', () => {
    // backend.ts reports an absent header as 0, so `?? 60` never applied and
    // "Retry after 0 seconds" went to the agent.
    for (const absent of [0, NaN, -5]) {
      const result = mapBackendErrorToToolResult(backendError(429, '{"error":"Too many requests. Please slow down."}', absent));
      expect(textOf(result)).toContain('Retry after 60 seconds');
      expect(result.structuredContent).toMatchObject({ error_type: 'rate_limited', retry_after_seconds: 60, retryable: true });
    }
  });

  it('429: offers no upgrade for a limit no plan raises', () => {
    expect(textOf(mapBackendErrorToToolResult(backendError(429, 'slow down', 900)))).not.toMatch(/upgrade|pricing|dashboard/i);
  });

  // A paid account past PRO_ABUSE_CEILING is a 429 too, with a body naming when
  // it resets and no Retry-After (apps/api/src/usageGuard.ts). Read as a burst
  // it was "transient. Retry after 0 seconds", retryable.
  describe('429 with resets_at: the monthly ceiling', () => {
    const ceiling = JSON.stringify({
      error: 'Monthly usage ceiling reached. Contact support if this is legitimate.',
      tier: 'pro',
      resets_at: 'monthly (1st, UTC)',
    });

    it('forbids retry and is marked not retryable', () => {
      const result = mapBackendErrorToToolResult(backendError(429, ceiling, 0));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error_type: 'monthly_ceiling', tier: 'pro', resets_at: 'monthly (1st, UTC)', retryable: false,
      });
      expect(textOf(result)).toContain('do NOT retry');
      expect(textOf(result)).not.toMatch(/transient\)|Retry after/);
    });

    it('names the account, the reset and where to reach us, and sells nothing', () => {
      const result = mapBackendErrorToToolResult(backendError(429, ceiling, 0));
      expect(textOf(result)).toContain('monthly usage ceiling reached for this pro account');
      expect(textOf(result)).toContain('1st of the month (UTC)');
      expect(textOf(result)).toContain('https://debugai.io/dashboard');
      expect(textOf(result)).not.toMatch(/upgrade|pricing/i);
    });

    it('stays a ceiling even if a Retry-After came with it', () => {
      expect(mapBackendErrorToToolResult(backendError(429, ceiling, 30)).structuredContent)
        .toMatchObject({ error_type: 'monthly_ceiling', retryable: false });
    });

    it('does not need a tier to say it', () => {
      const result = mapBackendErrorToToolResult(backendError(429, '{"resets_at":"monthly (1st, UTC)","tier":7}', 0));
      expect(result.structuredContent).toMatchObject({ error_type: 'monthly_ceiling', tier: 'paid' });
    });

    it('a body without resets_at is a burst, whatever else it holds', () => {
      for (const body of ['slow down', '', 'null', '"text"', '[]', '{"tier":"pro"}', '{"resets_at":5}', '{"error":"Too many requests. Please slow down."}']) {
        expect(mapBackendErrorToToolResult(backendError(429, body, 12)).structuredContent, body)
          .toMatchObject({ error_type: 'rate_limited', retry_after_seconds: 12, retryable: true });
      }
    });
  });

  it('503/504: engine unavailable, retryable', () => {
    for (const status of [503, 504]) {
      const result = mapBackendErrorToToolResult(backendError(status));
      expect(textOf(result)).toContain(`HTTP ${status}`);
      expect(result.structuredContent).toMatchObject({ error_type: 'engine_unavailable', retryable: true });
    }
    // A model outage says the attempt was not counted. The agent hears it.
    const outage = mapBackendErrorToToolResult(backendError(503, JSON.stringify({
      detail: 'The model is busy right now. Try again in a moment - this attempt has not been counted.',
    })));
    expect(textOf(outage)).toContain('this attempt has not been counted.');
  });

  it('status 0: network error, retryable', () => {
    const result = mapBackendErrorToToolResult(backendError(0, 'Could not reach the DebugAI API at http://x'));
    expect(result.structuredContent).toMatchObject({ error_type: 'network_error', retryable: true });
    expect(textOf(result)).toContain('DEBUGAI_API_BASE');
  });

  it('400: relays the API\'s own reason and forbids an unchanged retry', () => {
    const result = mapBackendErrorToToolResult(backendError(400, JSON.stringify({ error: 'error_message is required' })));
    expect(textOf(result)).toContain('DebugAI refused this call: error_message is required.');
    expect(textOf(result)).not.toContain('retry shortly');
    expect(result.structuredContent).toMatchObject({ error_type: 'invalid_request', retryable: false });
  });

  it('400: never throws on a body it cannot read', () => {
    for (const body of ['', 'Bad Request', '{"error":{"nested":1}}', 'null', '"just a string"']) {
      const result = mapBackendErrorToToolResult(backendError(400, body));
      expect(result.isError, body).toBe(true);
      expect(textOf(result), body).toMatch(/^DebugAI refused this call: .+[.!?] Change the arguments/);
    }
  });

  it('unknown status: generic failure', () => {
    const result = mapBackendErrorToToolResult(backendError(500, 'internal'));
    expect(textOf(result)).toContain('internal');
    expect(result.structuredContent).toMatchObject({ error_type: 'unknown', status: 500 });
  });

  it('non-Error input does not throw', () => {
    const result = mapBackendErrorToToolResult('plain string failure');
    expect(result.isError).toBe(true);
  });
});
