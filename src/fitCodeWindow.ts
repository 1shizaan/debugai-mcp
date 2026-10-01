/**
 * The code sent with a debug, cut to what the DebugAI API accepts.
 *
 * Every sender picks its code by counting lines: the editor takes the lines
 * either side of the cursor, an MCP server takes the lines either side of each
 * frame a stack trace names. The API's limit on `code_snippet` is a length. It
 * answers 400 to anything over 50,000 characters (`validateDebugRequest`), and
 * one long line inside the window is enough to cross it: a bundled file, an
 * inlined SVG, a base64 string, a data table on one line. A stack trace points
 * into exactly those files.
 *
 * Measured on 2026-10-01. In a real editor, a 60KB line two above the cursor
 * sent 60,087 characters and the user got "Something went wrong (HTTP 400)",
 * the same on every retry. From an MCP server, a five-line file with one long
 * line was read off disk and sent as 62,526 characters, and the agent was told
 * to change arguments it had never passed.
 *
 * So the window is grown outward from the line that matters, one line above
 * and one below in turn, and a side stops at the first line that does not fit.
 * The result is always one contiguous run of whole lines, which is what lets
 * it keep a start line: the engine numbers the code from that line and edits
 * are read against the file, so a window with a hole in it, or with a line cut
 * short, would put a fix on the wrong line.
 *
 * Pure, no imports. Mirror: packages/mcp/src/fitCodeWindow.ts and
 * apps/extension/src/mcp/fitCodeWindow.ts, byte-identical INCLUDING this header
 * (apps/extension/src/mcp/drift.test.ts). The editor imports the second.
 */

/**
 * What the API accepts, in characters (apps/api/src/middleware/security.ts,
 * validateDebugRequest). drift.test.ts reads the literal from there.
 */
export const API_CODE_MAX_CHARS = 50000;

export interface CodeWindow {
  text: string;
  /** 1-based line of the file the text starts on, as a stack trace counts. */
  startLine: number;
}

/**
 * @param lines     the window's lines, in file order, without line endings
 * @param firstLine 0-based file line of `lines[0]`
 * @param cursor    0-based file line the window is about
 * @param eol       the line ending to join with, so the text is the file's own
 */
export function fitCodeWindow(
  lines: readonly string[],
  firstLine: number,
  cursor: number,
  eol: string,
  cap: number = API_CODE_MAX_CHARS,
): CodeWindow {
  if (lines.length === 0) { return { text: '', startLine: firstLine + 1 }; }

  let total = eol.length * (lines.length - 1);
  for (const l of lines) { total += l.length; }
  if (total <= cap) { return { text: lines.join(eol), startLine: firstLine + 1 }; }

  const at = Math.min(Math.max(cursor - firstLine, 0), lines.length - 1);
  // The line itself is over the cap. There is no honest window around it: part
  // of a line is not code, and the lines beside it without it are not the code
  // the error is about. The debug goes without.
  if (lines[at].length > cap) { return { text: '', startLine: firstLine + at + 1 }; }

  let lo = at;
  let hi = at;
  let size = lines[at].length;
  let up = true;
  let down = true;
  while (up || down) {
    if (up) {
      const next = lo > 0 ? size + eol.length + lines[lo - 1].length : Infinity;
      if (next <= cap) { lo--; size = next; } else { up = false; }
    }
    if (down) {
      const next = hi < lines.length - 1 ? size + eol.length + lines[hi + 1].length : Infinity;
      if (next <= cap) { hi++; size = next; } else { down = false; }
    }
  }
  return { text: lines.slice(lo, hi + 1).join(eol), startLine: firstLine + lo + 1 };
}
