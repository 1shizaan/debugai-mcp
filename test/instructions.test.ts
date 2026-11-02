import { describe, it, expect } from 'vitest';
import { INSTRUCTIONS_BASE, SIGN_IN, serverInstructions } from '../src/instructions.js';

// drift.test.ts reads both copies of this module as text and pins them equal.
// These are the other half: what the function actually RETURNS, since a string
// pinned by a text test can still be assembled wrong at runtime.

describe('serverInstructions', () => {
  it('gives the npm server the sign-in note, appended once', () => {
    const text = serverInstructions({ signIn: true });
    expect(text.startsWith(INSTRUCTIONS_BASE)).toBe(true);
    expect(text).toContain('short code and a URL');
    expect(text.split('short code and a URL')).toHaveLength(2);
    expect(text).toEqual(INSTRUCTIONS_BASE + SIGN_IN);
  });

  it('gives the bundled server the same text with no sign-in note', () => {
    // The extension holds the key already. Telling its agent to read a code
    // out to the user sends them looking for a flow they do not have.
    const text = serverInstructions({ signIn: false });
    expect(text).toEqual(INSTRUCTIONS_BASE);
    expect(text).not.toContain('short code and a URL');
  });

  it('says the same thing about the product to both', () => {
    const npm = serverInstructions({ signIn: true });
    const bundled = serverInstructions({ signIn: false });
    for (const claim of [
      'INCLUDING when you caused the failure',
      'call lookup_error first',
      'it resolves the',            // reads the files a stack trace names
      'as reproCommand, with expected',
      'report "worked_modified" and send the',
      'pass result "diagnosis_wrong" and put the real',   // a wrong root cause is its own verdict
    ]) {
      expect(npm, `npm instructions lost: ${claim}`).toContain(claim);
      expect(bundled, `bundled instructions lost: ${claim}`).toContain(claim);
    }
  });
});
