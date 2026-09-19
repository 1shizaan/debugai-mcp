// The API refuses an error_message over 3,000 characters. fitErrorText cuts
// the middle so both conventions keep their error: Python's at the end,
// JavaScript's at the start. See src/fitErrorText.ts.
import { describe, expect, it } from 'vitest';
import { API_ERROR_MAX_CHARS, CUT_MARKER, fitErrorText } from '../src/fitErrorText.js';

const frames = (n: number, indent = '    ') =>
  Array.from({ length: n }, (_, i) => `${indent}at handler${i} (/app/src/module${i}.js:${i + 10}:5)`).join('\n');

describe('fitErrorText', () => {
  it('leaves text that fits exactly as it is', () => {
    const short = "TypeError: Cannot read properties of undefined (reading 'id')\n" + frames(3);
    expect(fitErrorText(short)).toEqual({ text: short, cut: 0 });
    const edge = 'x'.repeat(API_ERROR_MAX_CHARS);
    expect(fitErrorText(edge)).toEqual({ text: edge, cut: 0 });
  });

  it('always fits what the API accepts', () => {
    for (const n of [3001, 5000, 20_000, 200_000]) {
      const { text, cut } = fitErrorText('y'.repeat(n));
      expect(text.length).toBeLessThanOrEqual(API_ERROR_MAX_CHARS);
      expect(cut).toBeGreaterThan(0);
    }
  });

  it("keeps a JavaScript error's first line and a Python error's last line", () => {
    const js = "TypeError: Cannot read properties of undefined (reading 'id')\n" + frames(120);
    const fittedJs = fitErrorText(js).text;
    expect(fittedJs.startsWith("TypeError: Cannot read properties of undefined (reading 'id')\n    at handler0")).toBe(true);

    const py = 'Traceback (most recent call last):\n' +
      Array.from({ length: 120 }, (_, i) => `  File "/app/m${i}.py", line ${i + 1}, in f${i}\n    g${i}()`).join('\n') +
      "\nKeyError: 'user_id'";
    const fittedPy = fitErrorText(py).text;
    expect(fittedPy.endsWith("KeyError: 'user_id'")).toBe(true);
    expect(fittedPy.startsWith('Traceback (most recent call last):')).toBe(true);
  });

  it('cuts on line boundaries, so no half line is left either side of the marker', () => {
    const text = "Error: boom\n" + frames(200);
    const { text: fitted } = fitErrorText(text);
    const [head, tail] = fitted.split(CUT_MARKER);
    expect(text.startsWith(head + '\n')).toBe(true);
    expect(text.endsWith('\n' + tail)).toBe(true);
  });

  it('is deterministic, so a lookup and a debug of one failure send one text', () => {
    const text = "Error: boom\n" + frames(300);
    expect(fitErrorText(text)).toEqual(fitErrorText(text));
    // The marker carries no count, so two lengths of one failure cut alike.
    expect(CUT_MARKER).not.toMatch(/\d/);
  });

  it('never throws, whatever it is handed', () => {
    for (const junk of [undefined, null, 42, {}] as unknown[]) {
      expect(fitErrorText(junk as string)).toEqual({ text: '', cut: 0 });
    }
    expect(fitErrorText('z'.repeat(50), 10).text).toBe('z'.repeat(10));
  });
});
