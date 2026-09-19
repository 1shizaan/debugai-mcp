/**
 * Error text cut to the size the DebugAI API accepts, keeping both ends.
 *
 * The API refuses an error_message over 3,000 characters with a 400, and until
 * 2026-09-19 nothing on this side knew: an agent that passed a whole pytest
 * run or a long build log got "DebugAI refused this call" and had to cut the
 * text itself and call again. Agents pass long output all the time, because
 * that is what a failed command gives them.
 *
 * Both ends, because the two error conventions live at opposite ends. Python
 * prints the exception LAST, under its frames; JavaScript, Java and .NET print
 * it FIRST, above them. The error signature Team Error Memory is keyed by is
 * the class, the message and the top user frame, so a cut that keeps only one
 * end files half the world's errors under the wrong signature. The middle is
 * what goes: repeated frames and build noise.
 *
 * Cuts fall on line boundaries where there is one near, so no half line is
 * left to be read as a label. The marker is constant, so two cuts of the same
 * failure are the same text and name the same memory row.
 *
 * One function for every sender in this server - debug_error, lookup_error and
 * the Claude Code hook - because a lookup and a debug of one failure must send
 * the same text or they read two different memory rows.
 *
 * Pure, no imports. Mirror: packages/mcp/src/fitErrorText.ts and
 * apps/extension/src/mcp/fitErrorText.ts, byte-identical INCLUDING this header
 * (apps/extension/src/mcp/drift.test.ts).
 */

/** What the API accepts (apps/api/src/middleware/security.ts, validateDebugRequest). */
export const API_ERROR_MAX_CHARS = 3000;

/** How much of the start survives: the first line and the first frames under it. */
const HEAD_CHARS = 1200;

/** How far back from a cut point a line break is looked for. */
const LINE_SLACK = 200;

export const CUT_MARKER = '\n[... the middle of this output was cut to fit ...]\n';

export interface FittedError {
  text: string;
  /** How many characters were removed; 0 when the text already fit. */
  cut: number;
}

export function fitErrorText(text: string, max: number = API_ERROR_MAX_CHARS): FittedError {
  if (typeof text !== 'string') return { text: '', cut: 0 };
  if (text.length <= max) return { text, cut: 0 };

  const tailBudget = max - HEAD_CHARS - CUT_MARKER.length;
  // A cap too small to hold both ends keeps the end, where most output errs.
  if (tailBudget <= 0) return { text: text.slice(-max), cut: text.length - max };
  // End the head at the last line break inside its budget, if one is close.
  let headEnd = HEAD_CHARS;
  const nl = text.lastIndexOf('\n', HEAD_CHARS - 1);
  if (nl >= HEAD_CHARS - LINE_SLACK) headEnd = nl;
  // Start the tail at the first line break inside its budget, if one is close.
  let tailStart = text.length - tailBudget;
  const next = text.indexOf('\n', tailStart);
  if (next !== -1 && next < tailStart + LINE_SLACK) tailStart = next + 1;

  const fitted = text.slice(0, headEnd) + CUT_MARKER + text.slice(tailStart);
  return { text: fitted, cut: tailStart - headEnd };
}
