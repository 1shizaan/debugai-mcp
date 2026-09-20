/**
 * Local source resolution.
 *
 * Two things are being locked here and they pull in opposite directions:
 *
 *   1. It must actually READ the file the trace names, or the feature is
 *      decoration and agents keep getting "Insufficient context" at 20%.
 *   2. It must never read anything else. The input is a string the model
 *      produced; turning that into filesystem reads is the risky part, so the
 *      refusals get as much coverage as the successes.
 *
 * Real temp directories and real files throughout — mocking `fs` would only
 * assert that the mock returned what the test told it to, and every bug worth
 * catching here (symlinks, realpath, `..` normalisation) lives in the real
 * filesystem semantics a mock replaces.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractFrames,
  isInsideRoot,
  isReadableSource,
  resolveSourceContext,
  formatSnippet,
  MAX_FILES,
} from '../src/sourceContext.js';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'debugai-src-'));
  outside = mkdtempSync(join(tmpdir(), 'debugai-out-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function write(rel: string, body: string, base = root): string {
  const full = join(base, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
  return full;
}

function numbered(n: number, marker = ''): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}${i + 1 === 50 ? marker : ''}`).join('\n');
}

// ── Frame ordering — the regression the extension already shipped once ───────

describe('extractFrames — ordering', () => {
  it('JavaScript: innermost frame is FIRST', () => {
    const frames = extractFrames(
      'TypeError: x is not a function\n' +
      '    at inner (src/deep.ts:5:1)\n' +
      '    at outer (src/app.ts:20:1)',
    );
    expect(frames[0]).toEqual({ path: 'src/deep.ts', line: 5 });
  });

  it('Python: innermost frame is LAST, so the list is reversed', () => {
    const frames = extractFrames(
      'Traceback (most recent call last):\n' +
      '  File "app/main.py", line 20, in handler\n' +
      '    do_work()\n' +
      '  File "app/work.py", line 7, in do_work\n' +
      '    raise ValueError\n' +
      'ValueError',
    );
    expect(frames[0]).toEqual({ path: 'app/work.py', line: 7 });
  });

  it('skips vendored frames in both languages', () => {
    const frames = extractFrames(
      '    at handler (node_modules/express/lib/router.js:2:1)\n' +
      '    at mine (src/app.ts:9:3)\n' +
      '  File "/usr/lib/python3/site-packages/requests/api.py", line 4, in get',
    );
    expect(frames.map((f) => f.path)).toEqual(['src/app.ts']);
  });

  it('keeps the line number, because the window is built around it', () => {
    expect(extractFrames('at f (a.js:412:8)')[0].line).toBe(412);
  });

  it('reads Go/Rust-style bare frames too', () => {
    const frames = extractFrames('panic: nil map\n\tmain.go:31 +0x1d');
    expect(frames[0]).toEqual({ path: 'main.go', line: 31 });
  });

  it('returns nothing for text that names no file', () => {
    expect(extractFrames('Segmentation fault (core dumped)')).toEqual([]);
  });
});

// ── Refusals ─────────────────────────────────────────────────────────────────

describe('what it refuses to read', () => {
  it('a traversal path that escapes the root', () => {
    write('secret.js', 'const password = 1', outside);
    const res = resolveSourceContext({
      errorText: `at f (../${join('..', outside, 'secret.js')}:1:1)`,
      root,
    });
    expect(res).toBeNull();
  });

  it('a symlink inside the root that points outside it', () => {
    write('real.js', 'const leaked = 1', outside);
    symlinkSync(join(outside, 'real.js'), join(root, 'innocent.js'));
    // The path is inside the root; only realpath reveals that the bytes are not.
    const res = resolveSourceContext({ errorText: 'at f (innocent.js:1:1)', root });
    expect(res).toBeNull();
  });

  it('an absolute path outside the root', () => {
    const p = write('elsewhere.js', 'const x = 1', outside);
    expect(resolveSourceContext({ errorText: `at f (${p}:1:1)`, root })).toBeNull();
  });

  it('.env and friends, even sitting inside the root', () => {
    for (const name of ['.env', '.env.local', '.npmrc', 'id_rsa', 'server.pem', 'creds.key']) {
      expect(isReadableSource(join(root, name))).toBe(false);
    }
  });

  it('but env.ts IS readable — it is a source file, not a secret', () => {
    // A denylist regex here matched `^\.?env(\..+)?$`, which catches `env.ts`
    // as well as `.env`. `src/env.ts` is the standard name for a typed
    // environment schema and is the file a config error names most often, so
    // that rule dropped the single most useful file while adding nothing the
    // extension allowlist did not already refuse. Keep this test: it is the
    // reason the denylist is gone.
    expect(isReadableSource(join(root, 'src/env.ts'))).toBe(true);
    expect(isReadableSource(join(root, 'env.js'))).toBe(true);
  });

  it('an actual .env inside the root is not reached even when a frame names it', () => {
    write('.env', 'SECRET=hunter2');
    // No source extension, so it never becomes a candidate. End to end, not
    // just the predicate, because the predicate is what would get "simplified".
    expect(resolveSourceContext({ errorText: 'at f (.env:1:1)', root })).toBeNull();
  });

  it('non-source files inside the root', () => {
    for (const name of ['dump.sql', 'notes.txt', 'photo.png', 'archive.zip']) {
      expect(isReadableSource(join(root, name))).toBe(false);
    }
  });

  it('a path that does not exist at all', () => {
    expect(isInsideRoot(join(root, 'ghost.ts'), root)).toBe(false);
  });

  it('the root itself is not "inside" the root', () => {
    // Guards the relative('')  === '' case, which would otherwise read a dir.
    expect(isInsideRoot(root, root)).toBe(false);
  });
});

// ── Reading ──────────────────────────────────────────────────────────────────

describe('what it reads', () => {
  it('resolves a relative frame against the project root', () => {
    write('src/bad.js', 'const arr = null\nconsole.log(arr.length)');
    const res = resolveSourceContext({ errorText: "at f (src/bad.js:2:12)", root });
    expect(res?.files[0].label).toBe(join('src', 'bad.js'));
    expect(res?.snippet).toContain('arr.length');
  });

  it('resolves an absolute frame that is inside the root', () => {
    const p = write('src/bad.js', 'const arr = null');
    const res = resolveSourceContext({ errorText: `at f (${p}:1:1)`, root });
    expect(res?.snippet).toContain('const arr = null');
  });

  it('windows a large file around the failing line instead of sending all of it', () => {
    write('big.ts', numbered(400, '  // THE BUG'));
    const res = resolveSourceContext({ errorText: 'at f (big.ts:50:1)', root });
    expect(res?.files[0].windowed).toBe(true);
    expect(res?.snippet).toContain('// THE BUG');
    expect(res?.snippet).not.toContain('line 300');
  });

  it('sends a small file whole, and does not claim it was windowed', () => {
    write('small.ts', 'export const a = 1\nexport const b = 2');
    const res = resolveSourceContext({ errorText: 'at f (small.ts:2:1)', root });
    expect(res?.files[0].windowed).toBe(false);
    expect(res?.snippet).toContain('export const a = 1');
  });

  it('an explicit filePath outranks anything parsed out of the text', () => {
    write('src/named.ts', 'const named = true');
    write('src/parsed.ts', 'const parsed = true');
    const res = resolveSourceContext({
      errorText: 'at f (src/parsed.ts:1:1)',
      filePath: 'src/named.ts',
      root,
    });
    expect(res?.files[0].label).toBe(join('src', 'named.ts'));
  });

  it('reads the cause AND its caller, not only one frame', () => {
    write('src/deep.ts', 'throw new Error("boom")');
    write('src/app.ts', 'deep()');
    const res = resolveSourceContext({
      errorText: 'at deep (src/deep.ts:1:1)\n    at app (src/app.ts:1:1)',
      root,
    });
    expect(res?.files.map((f) => f.label)).toEqual([join('src', 'deep.ts'), join('src', 'app.ts')]);
  });

  it('stops at MAX_FILES however many frames the trace carries', () => {
    const text = Array.from({ length: 12 }, (_, i) => {
      write(`f${i}.ts`, `export const n = ${i}`);
      return `    at fn (f${i}.ts:1:1)`;
    }).join('\n');
    expect(resolveSourceContext({ errorText: text, root })?.files).toHaveLength(MAX_FILES);
  });

  it('never returns the same file twice, even when two frames name it', () => {
    write('src/loop.ts', 'recurse()');
    const res = resolveSourceContext({
      errorText: 'at r (src/loop.ts:1:1)\n    at r (src/loop.ts:1:1)',
      root,
    });
    expect(res?.files).toHaveLength(1);
  });

  it('returns null when the trace names files that are not there', () => {
    expect(resolveSourceContext({ errorText: 'at f (nope/gone.ts:1:1)', root })).toBeNull();
  });

  it('returns null for an error with no file in it at all', () => {
    expect(resolveSourceContext({ errorText: 'ECONNREFUSED 127.0.0.1:5432', root })).toBeNull();
  });
});

// ── The label ────────────────────────────────────────────────────────────────

describe('formatSnippet', () => {
  it('labels each block with a path the agent can actually open', () => {
    // The engine derives machine-applicable edits from what it was sent. An
    // edit naming a path the agent cannot resolve is worse than no edit.
    const out = formatSnippet([
      { label: 'src/api.ts', line: 12, text: 'const x = 1', windowed: false },
    ]);
    expect(out).toContain('--- src/api.ts:12 ---');
    expect(out).toContain('const x = 1');
  });

  it('says so when a file was truncated, rather than passing a window off as the file', () => {
    const out = formatSnippet([
      { label: 'big.ts', line: 900, text: 'x', windowed: true },
    ]);
    expect(out).toMatch(/truncated/i);
  });

  // 2026-09-07: "Line 4 calls setWordWrap(True)" about a call on line 539. The
  // header said "lines around 539" and never where the window began, so the
  // engine numbered the whole snippet from 1 - and told the model those were
  // the file's own numbers.
  it('states where a window starts, so the engine can number it with real lines', () => {
    const out = formatSnippet([
      { label: 'app.py', line: 539, text: 'a\nb\nc', windowed: true, start: 499 },
    ]);
    expect(out).toContain('--- app.py:539 (lines 499-501; file truncated for context budget) ---');
  });

  it('carries the real range end to end, from a file on disk', () => {
    write('src/big.py', numbered(1062));
    const ctx = resolveSourceContext({
      errorText: `Traceback (most recent call last):\n  File "${join(root, 'src/big.py')}", line 539, in <module>\nAttributeError: x`,
      root,
    });
    expect(ctx).not.toBeNull();
    const first = ctx!.snippet.split('\n')[0];
    expect(first).toMatch(/\(lines 499-579; file truncated for context budget\)/);
    // And the first line of the window really is file line 499.
    expect(ctx!.snippet.split('\n')[1]).toBe(numbered(1062).split('\n')[498]);
  });

  it('keeps the old wording only when the start is unknown', () => {
    const out = formatSnippet([{ label: 'big.ts', line: 900, text: 'x', windowed: true }]);
    expect(out).toContain('(lines around 900;');
  });
});

// ── Windows paths with spaces ───────────────────────────────────────────────
// 2026-09-13: one account's project lived in `...\OneDrive\Desktop\Axiom
// Workspace\...` and every frame class in this repo stopped at the first space.
// Fixed in four places on one commit — the engine's retrieval, the extension's
// write target, and both copies of this file. Here the cost is an agent being
// told "Insufficient context" about a file that is on the disk it is standing on.
describe('a Windows project path contains spaces', () => {
    const WIN = 'C:\\Users\\Rayanne\\OneDrive\\Desktop\\Axiom Workspace\\site\\src\\App.tsx';

    it('keeps a parenthesised frame whole, with its line', () => {
        const f = extractFrames(`Error: x\n    at foo (${WIN}:969:5)`);
        expect(f[0]).toEqual({ path: WIN, line: 969 });
    });

    it('keeps a bare frame whole', () => {
        expect(extractFrames(`Error: x\n    at ${WIN}:12:3`)[0].path).toBe(WIN);
    });

    it('strips a V8 file: URL and decodes its escaped spaces', () => {
        const url = 'file:///C:/Users/R/Axiom%20Workspace/src/App.tsx';
        expect(extractFrames(`Error\n    at h (${url}:12:3)`)[0].path)
            .toBe('C:/Users/R/Axiom Workspace/src/App.tsx');
    });

    it('removes a leading slash sitting before the drive letter', () => {
        expect(extractFrames('Error\n    at f (/C:/Users/R/A B/src/x.ts:3:1)')[0].path)
            .toBe('C:/Users/R/A B/src/x.ts');
    });

    it('still finds the bare vitest arrow shape, which carries no "at "', () => {
        expect(extractFrames('FAIL\n ❯ src/lib/money.ts:9:11')[0].path).toBe('src/lib/money.ts');
    });

    it('still skips vendored code on a Windows path', () => {
        const dep = 'C:\\Users\\R\\A B\\node_modules\\rollup\\dist\\x.js';
        const own = 'C:\\Users\\R\\A B\\src\\app.ts';
        const paths = extractFrames(`Error\n    at e (${dep}:3:1)\n    at f (${own}:9:2)`).map(f => f.path);
        expect(paths).toContain(own);
        expect(paths.some(p => p.includes('node_modules'))).toBe(false);
    });

    it('does not mistake a function name for a path', () => {
        expect(extractFrames('Error\n    at Object.handler (src/app.ts:12:3)')[0].path).toBe('src/app.ts');
    });

    it('a real directory with a space in it is still bounded by its root', () => {
        // Real files on disk: isInsideRoot resolves through realpathSync, so a
        // path that does not exist is refused before containment is even
        // considered. The space in the directory name is the new part, and it
        // must not weaken the guard — widening the extractor must not widen
        // what can be READ.
        const root = mkdtempSync(join(tmpdir(), 'axiom ws-'));
        try {
            mkdirSync(join(root, 'src'));
            writeFileSync(join(root, 'src', 'x.ts'), 'export {};');
            const outside = mkdtempSync(join(tmpdir(), 'other-'));
            writeFileSync(join(outside, 'y.ts'), 'export {};');

            expect(isInsideRoot(join(root, 'src', 'x.ts'), root)).toBe(true);
            expect(isInsideRoot(join(outside, 'y.ts'), root)).toBe(false);
            expect(isInsideRoot(join(root, 'src', '..', '..', 'etc'), root)).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

// ── Every toolchain, not two (2026-09-20) ────────────────────────────────────
//
// This module decides which files are READ OFF DISK and sent, so a shape it
// cannot see costs the answer its real source. The engine's half of this gap
// was measured at trace_files=0 on 115 of 153 production rows; these are the
// shapes that were missing on the client side.
describe('extractFrames across toolchains', () => {
  const paths = (t: string): string[] => extractFrames(t).map((f) => f.path);

  it('reads an MSBuild diagnostic, which has no :line at all', () => {
    expect(paths('Catalog.Infrastructure/Persistence.cs(44,126): error CS1729: nope'))
      .toContain('Catalog.Infrastructure/Persistence.cs');
  });

  it('reads a javac/Maven bracket position', () => {
    expect(paths('/p/src/main/java/com/acme/EmployeeDto.java:[42,8] duplicate class'))
      .toContain('/p/src/main/java/com/acme/EmployeeDto.java');
  });

  it('reads a .NET runtime frame, where "line" sits where a number should', () => {
    expect(paths('   at Catalog.Api.Program.Main() in C:\\proj\\src\\Program.cs:line 42'))
      .toContain('C:\\proj\\src\\Program.cs');
  });

  it('reads a PowerShell position, spaces in the path included', () => {
    expect(paths('At C:\\Users\\Bob\\My Scripts\\yara tool.ps1:42 char:5'))
      .toContain('C:\\Users\\Bob\\My Scripts\\yara tool.ps1');
  });

  it('reads the Gradle build file a failure is about', () => {
    expect(paths("* Where:\nBuild file '/home/u/proj/app/build.gradle' line: 23"))
      .toContain('/home/u/proj/app/build.gradle');
  });

  it('keeps the line number, because the window is built around it', () => {
    const [frame] = extractFrames('Catalog/Persistence.cs(44,126): error CS1729: nope');
    expect(frame).toEqual({ path: 'Catalog/Persistence.cs', line: 44 });
  });

  it('strips a file:// scheme so a Kotlin path is not welded to it', () => {
    expect(paths('e: file:///home/u/app/Main.kt:18:9 Unresolved reference'))
      .toContain('/home/u/app/Main.kt');
    expect(paths('at x (file:///C:/proj/src/App.tsx:3:1)')).toContain('C:/proj/src/App.tsx');
  });

  it('does not send the agent looking for the JDK', () => {
    // A JVM frame prints the basename alone, so only the package says whose
    // file it is. Per FILE, not per frame: a user frame rescues the name.
    const java = [
      'at com.acme.svc.OrderService.load(OrderService.java:44)',
      'at org.springframework.web.filter.OncePerRequestFilter.doFilter(OncePerRequestFilter.java:116)',
      'at java.base/java.lang.Thread.run(Thread.java:840)',
    ].join('\n');
    const got = paths(java);
    expect(got).toContain('OrderService.java');
    expect(got).not.toContain('Thread.java');
    expect(got).not.toContain('OncePerRequestFilter.java');

    expect(paths([
      'at org.apache.tool.Runner.run(Runner.java:12)',
      'at com.acme.app.Runner.start(Runner.java:40)',
    ].join('\n'))).toContain('Runner.java');
  });

  it('still refuses to open anything that is not a source extension', () => {
    // The allowlist grew; it is still an allowlist. A manifest has no source
    // extension and `.env` has none either, which is what keeps them out.
    expect(isReadableSource('/p/.env')).toBe(false);
    expect(isReadableSource('/p/appsettings.json')).toBe(false);
    expect(isReadableSource('/p/app/build.gradle')).toBe(true);
    expect(isReadableSource('/p/tool.ps1')).toBe(true);
  });
});

describe('a loose pattern does not turn prose into a path', () => {
  // PowerShell without a script file writes `At line:1 char:1`, which is its
  // commonest shape; Gradle quotes whatever it has. Each yielded a one-word
  // "path". isReadableSource refused them, but that is a different guard
  // catching it by accident - the engine refuses them on purpose and so does
  // this now (error_location._looks_like_file).
  it.each([
    ['powershell with no script file', 'At line:1 char:1\n+ Get-Evt'],
    ['prose that reads like .NET', 'The value was set in config:line 4 of the doc'],
    ['gradle quoting a non-path', "Build file 'unknown' line: 2"],
    ['a python pseudo-file', 'File "<string>", line 1'],
  ])('%s yields no frame', (_name, text) => {
    expect(extractFrames(text)).toEqual([]);
  });

  it('still reads the real thing in each of those shapes', () => {
    expect(extractFrames('At C:\\scripts\\tool.ps1:42 char:5')[0].path)
      .toBe('C:\\scripts\\tool.ps1');
    expect(extractFrames("Build file '/home/u/app/build.gradle' line: 23")[0].path)
      .toBe('/home/u/app/build.gradle');
    expect(extractFrames('   at P.Main() in C:\\proj\\Program.cs:line 42')[0].path)
      .toBe('C:\\proj\\Program.cs');
  });
});

describe('a .NET frame in a Windows project path', () => {
  it('survives the spaces that path has', () => {
    // C:\Users\Bob\My Proj\ is the normal case on a .NET machine. A class that
    // stops at the first space is this repo's oldest path bug; the closing
    // paren of the method signature is what bounds this one safely.
    expect(extractFrames('   at P.Main(String[] a) in C:\\My Proj\\Program.cs:line 42')[0])
      .toEqual({ path: 'C:\\My Proj\\Program.cs', line: 42 });
  });

  it('does not read a sentence as one', () => {
    expect(extractFrames('described in src/notes.md:line 9 above')).toEqual([]);
    expect(extractFrames('Documented in the guide at some.path:line 4')).toEqual([]);
  });
});
