// `debugai-mcp try` makes the project "Your first debug" walks through. That
// page prints the traceback these files produce and says what the answer should
// name, so the files `try` writes must be the page's, byte for byte. Read from
// the page itself, the way listing.test.ts reads the API and the extension.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = join(here, '..', 'dist', 'index.js');
const PAGE = join(here, '..', '..', '..', 'apps', 'docs', 'content', 'docs', 'first-debug.mdx');

/** The files the page has you create in one language: every code block with a title, by its fence. */
function pageFiles(fence: string): Record<string, string> {
  const page = readFileSync(PAGE, 'utf8');
  return Object.fromEntries([...page.matchAll(/```(\w+) title="([^"]+)"\n([\s\S]*?)```/g)]
    .filter((m) => m[1] === fence)
    .map((m) => [m[2], m[3]]));
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'debugai-try-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function tryCli(...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [distEntry, 'try', ...args], {
      cwd: dir, env: { PATH: process.env.PATH, NO_COLOR: '1' }, encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { code: e.status ?? -1, out: String(e.stdout ?? '') };
  }
}

describe('debugai-mcp try', () => {
  for (const [lang, fence] of [['python', 'python'], ['js', 'js']]) {
    it(`--lang ${lang} writes the page's files, byte for byte`, () => {
      const want = pageFiles(fence);
      expect(Object.keys(want)).toHaveLength(3);
      expect(tryCli('--lang', lang).code).toBe(0);
      const folder = join(dir, 'debugai-first-bug');
      expect(Object.fromEntries(readdirSync(folder).map((f) => [f, readFileSync(join(folder, f), 'utf8')]))).toEqual(want);
    });
  }

  it('never writes into a folder that is already there', () => {
    const folder = join(dir, 'debugai-first-bug');
    mkdirSync(folder);
    writeFileSync(join(folder, 'notes.txt'), 'mine');
    const { code, out } = tryCli();
    expect(code).toBe(1);
    expect(readdirSync(folder)).toEqual(['notes.txt']);
    expect(out).toContain('already exists');
  });
});
