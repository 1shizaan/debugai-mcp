// What report_outcome says back. See src/outcomeAck.ts for the 2026-09-18 bug
// this replaced: 'worked_modified' fell through a ternary and was answered
// "Outcome recorded: fix failed".
import { describe, expect, it } from 'vitest';
import { outcomeAck, type OutcomeResult } from '../src/outcomeAck.js';

const ALL: OutcomeResult[] = ['worked', 'worked_modified', 'failed', 'unused'];

describe('outcomeAck', () => {
  it('names the verdict it was given, and no other', () => {
    for (const result of ALL) {
      const text = outcomeAck({ result });
      expect(text.startsWith('Outcome recorded:'), result).toBe(true);
      // Only a failure report may be told it failed.
      expect(text.includes('failed'), result).toBe(result === 'failed');
    }
  });

  it('tells a worked_modified report that ITS code is what gets remembered', () => {
    const text = outcomeAck({ result: 'worked_modified', fixRank: 1, finalFix: 'x()' });
    expect(text).toContain('worked after your changes');
    expect(text).toContain('finalFix is what gets remembered');
    expect(text).not.toContain('ignored');
  });

  it('names the fix a worked report confirmed', () => {
    expect(outcomeAck({ result: 'worked', fixRank: 2 })).toContain('fix 2 worked');
    expect(outcomeAck({ result: 'worked' })).toContain('the fix worked');
  });

  it('does not claim a follow-up error was logged when none was sent', () => {
    expect(outcomeAck({ result: 'failed', newError: 'TypeError: y' })).toContain('follow-up error was logged');
    const bare = outcomeAck({ result: 'failed' });
    expect(bare).not.toContain('follow-up error was logged');
    expect(bare).toContain('No follow-up error was sent');
  });

  it('tells a failure report what memory does with it: shown to the next analyses as one not to repeat', () => {
    const text = outcomeAck({ result: 'failed', newError: 'TypeError: y' });
    expect(text).toContain('as one not to repeat');
    expect(text).toContain('for the next week');
  });

  it('thanks an unused report for the real fix only when one came with it', () => {
    expect(outcomeAck({ result: 'unused', actualFix: 'pinned numpy' })).toContain('actually worked was logged');
    expect(outcomeAck({ result: 'unused' })).toContain('send it in actualFix');
  });

  it('says out loud that finalFix was ignored on any other verdict', () => {
    for (const result of ALL.filter((r) => r !== 'worked_modified')) {
      expect(outcomeAck({ result, finalFix: 'x()' }), result).toContain('finalFix was ignored');
      expect(outcomeAck({ result }), result).not.toContain('finalFix was ignored');
    }
  });
});
