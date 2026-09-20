import { beforeEach, describe, expect, it } from 'vitest';
import { clientUpdateBanner, __resetClientUpdate } from '../src/clientUpdate.js';

const UPDATE = { current: '2.1.1', latest: '2.7.0', command: 'npx -y @debugai/mcp@latest install' };

beforeEach(() => { __resetClientUpdate(); });

describe('clientUpdateBanner', () => {
  it('names both versions and the command to run', () => {
    const text = clientUpdateBanner(UPDATE)!;
    expect(text).toContain('2.1.1');
    expect(text).toContain('2.7.0');
    expect(text).toContain('npx -y @debugai/mcp@latest install');
  });

  it('says it ONCE per process, however many answers carry it', () => {
    // The whole reason this moved off the API's daily-per-account claim. A
    // process is a session; an account is not. An agent that hears it three
    // times in one session learns to skip it, which is what happened.
    expect(clientUpdateBanner(UPDATE)).not.toBeNull();
    expect(clientUpdateBanner(UPDATE)).toBeNull();
    expect(clientUpdateBanner({ ...UPDATE, latest: '9.9.9' })).toBeNull();
  });

  it('says nothing when the API sent nothing, which is the normal case', () => {
    expect(clientUpdateBanner(undefined)).toBeNull();
    expect(clientUpdateBanner(null)).toBeNull();
    // Still silent afterwards, so a no-op never burns the one announcement.
    expect(clientUpdateBanner(UPDATE)).not.toBeNull();
  });

  it('refuses a payload that is not the shape it claims, and stays quiet', () => {
    for (const bad of ['2.7.0', 42, [], {}, { current: '2.1.1' }, { latest: '2.7.0' },
                       { current: '', latest: '2.7.0' }, { current: '2.1.1', latest: 7 }]) {
      expect(clientUpdateBanner(bad as unknown), `announced for ${JSON.stringify(bad)}`).toBeNull();
    }
    // None of those consumed the latch either.
    expect(clientUpdateBanner(UPDATE)).not.toBeNull();
  });

  it('falls back to the published command when the API sent none', () => {
    const text = clientUpdateBanner({ current: '2.1.1', latest: '2.7.0' })!;
    expect(text).toContain('npx -y @debugai/mcp@latest install');
  });

  it('is a quote block, so it cannot read as part of the diagnosis', () => {
    // It used to arrive appended to root_cause, which is the field an agent
    // quotes to its user. Being visibly not-the-answer is the point.
    const text = clientUpdateBanner(UPDATE)!;
    for (const line of text.trimEnd().split('\n')) {
      expect(line.startsWith('>'), `not a quoted line: ${line}`).toBe(true);
    }
  });
});
