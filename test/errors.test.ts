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
  it('401: points to the dashboard and the DEBUGAI_API_KEY env var, never VS Code', () => {
    const result = mapBackendErrorToToolResult(backendError(401));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('debugai.io/dashboard');
    expect(textOf(result)).toContain('DEBUGAI_API_KEY');
    expect(textOf(result)).not.toMatch(/VS Code|command palette/i);
    expect(result.structuredContent).toMatchObject({ error_type: 'auth_failed', retryable: false });
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

  it('503/504: engine unavailable, retryable', () => {
    for (const status of [503, 504]) {
      const result = mapBackendErrorToToolResult(backendError(status));
      expect(textOf(result)).toContain(`HTTP ${status}`);
      expect(result.structuredContent).toMatchObject({ error_type: 'engine_unavailable', retryable: true });
    }
  });

  it('status 0: network error, retryable', () => {
    const result = mapBackendErrorToToolResult(backendError(0, 'Could not reach the DebugAI API at http://x'));
    expect(result.structuredContent).toMatchObject({ error_type: 'network_error', retryable: true });
    expect(textOf(result)).toContain('DEBUGAI_API_BASE');
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
