// What lookup_error says. See src/lookupAnswer.ts: every sentence is a stored
// fact, and each memory state gets the verb memory_state.py gives the model.
import { describe, expect, it } from 'vitest';
import { renderLookup } from '../src/lookupAnswer.js';

const FIX = 'Render PNG at scale 6\nqr.save(buf, kind="png", scale=6, border=4)';

describe('renderLookup', () => {
  it('says memory is off, why, and how to turn it on, when no project reached the API', () => {
    const text = renderLookup({ memory_enabled: false, memory_disabled_reason: 'no project was sent with this request' }, 'x');
    expect(text).toContain('memory is off');
    expect(text).toContain('no project was sent');
    expect(text).toContain('projectRoot');
    expect(text).not.toContain('Not seen before');
  });

  it('never seen: says so and names the next step', () => {
    const text = renderLookup({ memory_enabled: true, memory_hit: false }, 'airgapai');
    expect(text).toContain('Not seen before in this project (airgapai)');
    expect(text).toContain('debug_error');
  });

  it('confirmed: the fix, first, with how it was confirmed, and what to do if it comes back', () => {
    const text = renderLookup({
      memory_enabled: true, memory_hit: true, memory_times_seen: 3, last_seen_at: '2026-09-16T12:00:00+00:00',
      memory_fix_state: 'confirmed', stored_fix: FIX, memory_verified_count: 0,
    }, 'airgapai');
    expect(text).toContain('Seen 3 times before in this project (airgapai), last on 2026-09-16.');
    expect(text).toContain('Try it first');
    expect(text).toContain('not observed to work');
    expect(text).toContain('scale=6');
    expect(text).toContain('call debug_error with the new output');
  });

  it('confirmed and observed: says a live session watched it stop', () => {
    const text = renderLookup({ memory_enabled: true, memory_hit: true, memory_times_seen: 1,
      memory_fix_state: 'confirmed', stored_fix: FIX, memory_verified_count: 2 }, 'p');
    expect(text).toContain('Seen once before');
    expect(text).toContain('live session watched the error stop');
  });

  it('unproven: offered as something to check, never as the answer', () => {
    const text = renderLookup({ memory_enabled: true, memory_hit: true, memory_times_seen: 4,
      memory_fix_state: 'unproven', stored_fix: FIX }, 'p');
    expect(text).toContain('come back once since');
    expect(text).toContain('unproven');
    expect(text).not.toContain('Try it first');
  });

  it('anti_pattern: named as what NOT to do', () => {
    const text = renderLookup({ memory_enabled: true, memory_hit: true, memory_times_seen: 6,
      memory_fix_state: 'anti_pattern', memory_recurrences_after_fix: 3, stored_fix: FIX }, 'p');
    expect(text).toContain('came back 3 times after it');
    expect(text).toContain('Do NOT repeat it');
    expect(text).not.toContain('Try it first');
  });

  it('seen but never fixed', () => {
    const text = renderLookup({ memory_enabled: true, memory_hit: true, memory_times_seen: 2, memory_fix_state: 'none' }, 'p');
    expect(text).toContain('No fix was ever confirmed');
  });

  it('lists what was tried and failed here, whatever the memory state', () => {
    const text = renderLookup({ memory_enabled: true, memory_hit: false, refuted: [
      { at: '2026-09-16 14:02', rank: 1, title: 'Disable thinking in options', what_happened: 'invalid option provided option=think' },
    ] }, 'p');
    expect(text).toContain('reported as FAILED');
    expect(text).toContain('1. Disable thinking in options (fix #1, 2026-09-16 14:02): invalid option provided option=think');
  });

  it('survives a malformed answer without throwing', () => {
    expect(() => renderLookup({} as any, 'p')).not.toThrow();
    expect(() => renderLookup({ memory_enabled: true, memory_hit: true, refuted: 'nope' as any }, 'p')).not.toThrow();
  });
});
