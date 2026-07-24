// Minimal JSONC tolerance for editor config files.
//
// Zed's settings.json and VS Code's mcp.json ship WITH comments and often
// carry trailing commas. `JSON.parse` throws on both, and a naive regex
// stripper corrupts any string containing "//" — e.g. every URL in the file.
// So this walks the text character by character with a string-state machine.
//
// Round-tripping comments is out of scope: we detect them (`hadComments`) so
// the caller can warn the user and back the file up before rewriting.

export interface ParsedJsonc {
  value: unknown;
  hadComments: boolean;
}

export function stripJsonComments(text: string): { out: string; hadComments: boolean } {
  let out = '';
  let hadComments = false;
  let i = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') { inLineComment = false; out += ch; }
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue; }
      if (ch === '\n') out += ch; // keep line numbers honest for error messages
      i++;
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; i++; continue; }
    if (ch === '/' && next === '/') { inLineComment = true; hadComments = true; i += 2; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; hadComments = true; i += 2; continue; }

    out += ch;
    i++;
  }

  return { out, hadComments };
}

/** Removes trailing commas before } or ] — legal in JSONC, fatal to JSON.parse. */
export function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] ?? ''; i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ',') {
      // Look ahead past whitespace for a closer.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue; // drop this comma
    }
    out += ch;
  }
  return out;
}

/** Parses JSON or JSONC. Throws the underlying SyntaxError on real malformed input. */
export function parseJsonc(text: string): ParsedJsonc {
  const trimmed = text.trim();
  if (trimmed === '') return { value: {}, hadComments: false };

  const { out, hadComments } = stripJsonComments(text);
  return { value: JSON.parse(stripTrailingCommas(out)), hadComments };
}
