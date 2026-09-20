/**
 * Local source resolution — read the files a stack trace names.
 *
 * ## Why this is here and not in the engine
 *
 * The engine cannot read your disk. It resolves a trace to `bad.js`, asks
 * pgvector for that file, and gets nothing back unless the project was indexed
 * first — and indexing only ever happened from the VS Code extension. So an
 * agent on the MCP path hit this, every time, on every project:
 *
 *     Fix 1 — Insufficient context for specific fix          20% confidence
 *
 * and the advice attached to it (services/context_advice.py) names
 * "DebugAI: Index Entire Workspace", a VS Code palette command. A Claude Code
 * or Cursor agent has no palette and no such command. That is the same defect
 * we fixed in the extension on 2026-08-08 — advice naming a step the reader
 * cannot take — aimed at a different audience.
 *
 * Rewording it would be the small fix. This is the real one: the MCP server is
 * a local process. It has the filesystem the engine lacks, so it can send the
 * actual source and skip the whole missing-context branch rather than write
 * better copy about it.
 *
 * ## What it does
 *
 * Reads the error text, ranks the frames it names, resolves them against the
 * project root, and returns a labelled snippet windowed around the failing
 * lines. The agent's own `codeSnippet` always wins — this only fills a gap.
 *
 * ## What it refuses to do
 *
 * This module turns text the model produced into filesystem reads, so its
 * limits are a security boundary, not tidiness:
 *
 *   - every candidate must resolve INSIDE the project root, checked after
 *     symlink resolution, so `../../.ssh/id_rsa` in a crafted error cannot
 *     walk out
 *   - secret-shaped names (.env, *.pem, id_rsa, *.key) are never read even
 *     when they sit inside the root
 *   - source extensions only, MAX_FILES files, MAX_BYTES each
 *
 * Frame ORDERING is duplicated from apps/extension/src/errorPaths.ts on
 * purpose: this package publishes to npm standalone and cannot import from the
 * extension. The rule both must keep — Python innermost LAST, JS innermost
 * FIRST — is stated in both files and tested in both.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, basename, extname } from 'node:path';

/** Files read per request. Three frames is a cause, a caller, and one spare. */
export const MAX_FILES = 3;
/** Per file. Larger than this and the window, not the file, is what we send. */
export const MAX_BYTES = 256_000;
/** Lines of context either side of the failing line. */
export const WINDOW = 40;

const SOURCE_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.rb', '.java', '.kt', '.kts', '.php', '.cs', '.swift',
  '.vue', '.svelte', '.scala', '.dart', '.groovy',
  // C family and Python stubs. Added by the parity test below on its first run:
  // the engine extracts these paths, so refusing to open them means naming a
  // file and never sending it.
  '.c', '.cc', '.cpp', '.h', '.hpp', '.pyi',
  // PowerShell and Gradle. Both arrived with the account whose 13 debugs all
  // recorded trace_files=0, and a `build.gradle` really is the file a Gradle
  // failure is about. Still an extension allowlist: no manifest, no `.env`.
  '.ps1', '.psm1', '.psd1', '.gradle',
]);

const VENDOR = /(^|\/)(node_modules|site-packages|\.venv|venv|vendor|dist|build|\.next|target)(\/|$)/;

export interface Frame {
  path: string;
  line: number | null;
}

export interface ResolvedFile {
  /** Path as it will be shown to the model — relative to the root when inside it. */
  label: string;
  line: number | null;
  text: string;
  /** True when only a window around `line` was sent, not the whole file. */
  windowed: boolean;
  /**
   * The file line `text` starts at, 1-based. Sent in the header so the engine
   * can number every line with its real position. Without it the engine
   * numbered the whole snippet from 1 and told the model those were the file's
   * numbers, so an answer said "Line 4 calls setWordWrap" about line 539
   * (2026-09-07). Optional only so a caller building one by hand still compiles.
   */
  start?: number;
}

// ── Frame extraction ─────────────────────────────────────────────────────────
//
// Same shapes as the extension's parser, but this one keeps the LINE NUMBER and
// returns every frame rather than one best guess: the window we send is built
// around the line, and a cause plus its caller is usually worth two reads.

const PY_FRAME   = /File ["']([^"'\r\n]+\.py)["'],\s*line\s*(\d+)/g;
const PY_TEST_ID = /([\w./\\-]+\.py)::/g;
const PY_LINE_REF = /(?:^|\s)([\w./\\-]+\.py):(\d+):/gm;
// THE PATH CLASS MAY NOT EXCLUDE A SPACE. `[^\s()]+` did, and a Windows
// project path has several — `OneDrive\Desktop`, `My Documents`, and in the
// account that found this, `Axiom Workspace`. The drive-letter prefix here was
// already an attempt at Windows support; it did not help, because the class
// still stopped at the first space and returned a headless fragment that
// resolves to nothing. This module READS FILES OFF DISK, so the cost is the
// agent getting "Insufficient context" for a file that is sitting right there.
//
// Split in two because the two frame shapes bound a path differently: inside
// parens the `)` terminates it, so spaces are safe; the bare shape matches
// after any whitespace and keeps the narrow class, or "Error in my file.ts:1"
// would resolve to a path.
const JS_FRAME   = /at\s+(?:[^\n(]*\(\s*)?([^\n()]+?\.(?:js|ts|jsx|tsx|mjs|cjs)):(\d+)/g;
const JS_BARE    = /(?:^|[\s❯>|►])((?:[A-Za-z]:)?[\w./\\-]+\.(?:js|ts|jsx|tsx|mjs|cjs)):(\d+)/g;
/** Go, Rust, Ruby, Java and friends: `path/file.ext:123` on its own. */
const GENERIC    = /(?:^|[\s(])((?:[A-Za-z]:)?[^\s():]+\.(?:go|rs|rb|java|kt|kts|php|cs|swift|vue|svelte|scala|dart|groovy|ps1|psm1|psd1)):(\d+)/g;

// ── The shapes `:line` cannot express ────────────────────────────────────────
//
// Every pattern above wants `path:123`. Four toolchains do not write one, and
// between them they are most of what a non-JS, non-Python agent sends. The
// engine reads all four (apps/engine/app/services/error_location.py); this is
// the client half, and it is the half that decides which files get READ OFF
// DISK and sent, so a miss here costs the answer its real source.

/** MSBuild, Roslyn and tsc: `Catalog/Persistence.cs(44,126): error CS1729`. */
const PAREN_POS  = /(?:^|[\s(])((?:[A-Za-z]:)?[^\s():]+\.[A-Za-z][A-Za-z0-9]{0,9})\((\d+)(?:,\d+)?\)\s*:/gm;
/** javac and the Maven compiler plugin: `EmployeeDto.java:[42,8]`. */
const BRACKET_POS = /(?:^|[\s(])((?:[A-Za-z]:)?[^\s():]+\.[A-Za-z][A-Za-z0-9]{0,9}):\[(\d+),\d+\]/gm;
/** A .NET runtime frame: `... in C:\proj\src\Program.cs:line 42`. */
const DOTNET_IN  = /\bin\s+((?:[A-Za-z]:)?[^\r\n(){}"'<>|*?]+?):line\s+(\d+)/g;
/**
 * PowerShell: `At C:\Users\Bob\My Scripts\tool.ps1:42 char:5`.
 * The class admits spaces, which GENERIC may never do because it matches
 * mid-line and would read a sentence as a path. This shape is bounded at both
 * ends, so it can.
 */
const PS_POS     = /^\s*At\s+((?:[A-Za-z]:)?[^\r\n(){}"'<>|*?]+?):(\d+)\s+char:\d+/gm;
/** Gradle: `Build file '/home/u/proj/app/build.gradle' line: 23`. */
const GRADLE_POS = /(?:Build file|Settings file|Script)\s+'([^'\r\n]+)'\s+line:\s*(\d+)/gi;

/**
 * A JVM frame names a BASENAME only, so the path cannot say whose file it is:
 * `Thread.java` and `OrderService.java` look identical once the frame is gone,
 * and VENDOR has no directory to match. The package is sitting one character to
 * the left. Without this, an ordinary Spring traceback sends the agent looking
 * on disk for the JDK.
 */
const JVM_FRAME  = /\bat\s+([\w$.]+(?:\/[\w$.]+)?)\.[\w$<>]+\s*\(([^\s()/\\]+\.(?:java|kt|kts|scala|groovy)):(\d+)\)/g;
const JVM_VENDOR = /^(?:java|javax|jdk|sun|jakarta|kotlin|kotlinx|scala|groovy|android|androidx|com\.(?:sun|google|fasterxml|intellij)|org\.(?:springframework|apache|junit|gradle|jetbrains|slf4j|hibernate|eclipse|testng|mockito|assertj|graalvm|w3c|xml)|io\.(?:netty|micronaut|quarkus|vertx|reactivex))\b/i;

/** Basenames named only by runtime or framework frames. */
function jvmVendorFiles(text: string): Set<string> {
  const vendor = new Set<string>();
  const owned = new Set<string>();
  for (const m of text.matchAll(JVM_FRAME)) {
    // `java.base/java.lang.Thread` - the module prefix is not the package.
    const pkg = m[1].split('/').pop() ?? '';
    (JVM_VENDOR.test(pkg) ? vendor : owned).add(m[2]);
  }
  for (const name of owned) { vendor.delete(name); }
  return vendor;
}

/**
 * `file:///home/u/Main.kt` and `file:///C:/proj/x.ts` both arrive here, from V8
 * and from the Kotlin compiler. No pattern above can span the scheme's colon,
 * so it comes off the text first and a POSIX path keeps its leading slash while
 * a Windows one presents its drive letter like any other path. `normalisePath`
 * still strips it too, for a path that reached us some other way.
 */
const FILE_SCHEME = /\bfile:\/\/(?:localhost)?\/*/gi;

// A V8 stack on Windows prints a file: URL, not a path:
//   file:///C:/Users/R/Axiom%20Workspace/src/App.tsx
// The scheme, the slash before the drive letter and the percent-encoding all
// have to come off before this is handed to a filesystem. Kept in step with
// _normalise_trace_path() in apps/engine/app/services/error_signature.py and
// normalisePath() in apps/extension/src/errorPaths.ts.
const PCT = /%[0-9A-Fa-f]{2}/;
function normalisePath(fp: string): string {
  try {
    let p = fp.replace(/^file:\/\/(?:localhost)?\/?/i, '').trim();
    p = p.replace(/^\/([A-Za-z]:)/, '$1');
    if (PCT.test(p)) { p = decodeURIComponent(p); }
    return p || fp;
  } catch { return fp; }
}

function collect(text: string, re: RegExp, withLine: boolean): Frame[] {
  return [...text.matchAll(re)].map((m) => ({
    path: normalisePath(m[1]),
    line: withLine && m[2] ? Number(m[2]) : null,
  }));
}

function isVendor(p: string): boolean {
  return VENDOR.test(p.replace(/\\/g, '/'));
}

/**
 * Frames in the order worth reading: innermost user frame first.
 *
 * Python tracebacks print outermost-first, so the interesting frame is LAST and
 * the list is reversed. JS stacks print innermost-first and are read forward.
 * Getting this backwards names the caller instead of the bug — the exact
 * regression the extension shipped and had to fix.
 */
export function extractFrames(errorText: string): Frame[] {
  if (!errorText) return [];

  const text = errorText.replace(FILE_SCHEME, '/');
  const skip = jvmVendorFiles(text);

  const out: Frame[] = [];
  const seen = new Set<string>();
  const push = (f: Frame): void => {
    const key = `${f.path}:${f.line ?? ''}`;
    if (!isVendor(f.path) && !skip.has(f.path) && !seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  };

  collect(text, PY_FRAME, true).reverse().forEach(push);
  collect(text, JS_FRAME, true).forEach(push);
  collect(text, JS_BARE, true).forEach(push);
  collect(text, PAREN_POS, true).forEach(push);
  collect(text, BRACKET_POS, true).forEach(push);
  collect(text, DOTNET_IN, true).forEach(push);
  collect(text, PS_POS, true).forEach(push);
  collect(text, GRADLE_POS, true).forEach(push);
  collect(text, GENERIC, true).forEach(push);
  // Test-runner shapes carry no frame at all. Last, because a pytest node id
  // names the TEST file, which is a weaker guess than any real frame.
  collect(text, PY_LINE_REF, true).forEach(push);
  collect(text, PY_TEST_ID, false).forEach(push);

  return out;
}

// ── Safety ───────────────────────────────────────────────────────────────────

/** Inside `root` after symlinks resolve? The check that stops `../../.ssh/…`. */
export function isInsideRoot(candidate: string, root: string): boolean {
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    // Not a real file. Nothing to read, so nothing to allow.
    return false;
  }
  const rel = relative(realRoot, realCandidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * The extension ALLOWLIST is the mechanism — there is deliberately no secret
 * denylist beside it.
 *
 * A denylist was written here first and deleted. Everything it caught was
 * already unreachable: `.env`, `id_rsa` and `credentials` have no extension,
 * `.env.local` extends to `.local`, `server.pem` to `.pem` — none are in
 * SOURCE_EXT, so all four were refused before the denylist was consulted. It
 * bought nothing.
 *
 * What it did buy was a bug. `^\.?env(\..+)?$` also matches `env.js` and
 * `env.ts`, and `src/env.ts` is a real, common source file (it is the standard
 * name for typed environment schemas). A config error names that file more
 * often than any other, and the denylist would have silently dropped it while
 * looking like a security control.
 *
 * If a denylist is ever wanted back, it needs a case the allowlist does not
 * already cover, and a test proving it.
 */
export function isReadableSource(p: string): boolean {
  return SOURCE_EXT.has(extname(p).toLowerCase());
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * Candidate absolute paths for one frame, best first.
 *
 * A trace may carry an absolute path (already correct), a path relative to the
 * root, or a path relative to a subdirectory the process ran from. All three
 * are tried; the first that exists and passes the root check wins.
 */
function candidatesFor(frame: Frame, root: string, cwd: string): string[] {
  const p = frame.path.replace(/^file:\/\//, '');
  if (isAbsolute(p)) return [p];
  const out = [join(root, p), join(cwd, p)];
  // `src/app/x.ts` printed from inside `src/` — strip one leading segment.
  const stripped = p.split('/').slice(1).join('/');
  if (stripped) out.push(join(root, stripped));
  return out;
}

function windowAround(
  text: string,
  line: number | null,
): { text: string; windowed: boolean; start: number } {
  if (line === null) {
    const lines = text.split('\n');
    if (lines.length <= WINDOW * 2 + 1) return { text, windowed: false, start: 1 };
    return { text: lines.slice(0, WINDOW * 2 + 1).join('\n'), windowed: true, start: 1 };
  }
  const lines = text.split('\n');
  if (lines.length <= WINDOW * 2 + 1) return { text, windowed: false, start: 1 };
  const start = Math.max(0, line - 1 - WINDOW);
  const end = Math.min(lines.length, line + WINDOW);
  return { text: lines.slice(start, end).join('\n'), windowed: true, start: start + 1 };
}

function readOne(frame: Frame, root: string, cwd: string): ResolvedFile | null {
  for (const candidate of candidatesFor(frame, root, cwd)) {
    if (!isReadableSource(candidate)) continue;
    if (!isInsideRoot(candidate, root)) continue;
    try {
      const st = statSync(candidate);
      if (!st.isFile()) continue;
      const raw = st.size > MAX_BYTES
        ? readFileSync(candidate, 'utf8').slice(0, MAX_BYTES)
        : readFileSync(candidate, 'utf8');
      const win = windowAround(raw, frame.line);
      const real = realpathSync(candidate);
      const rel = relative(realpathSync(root), real);
      return {
        label: rel || basename(real),
        line: frame.line,
        text: win.text,
        windowed: win.windowed,
        start: win.start,
      };
    } catch {
      continue; // unreadable, binary, permissions — try the next candidate
    }
  }
  return null;
}

/**
 * Read the source behind an error. Returns null when there is nothing honest to
 * send, which is a real answer: a wrong file is worse than no file, and the
 * engine's own advice path handles the empty case.
 *
 * Never throws. A debug request that loses local context is worth far more than
 * one that fails because a path was odd.
 */
export function resolveSourceContext(opts: {
  errorText: string;
  filePath?: string;
  root: string;
  cwd?: string;
  maxFiles?: number;
}): { snippet: string; files: ResolvedFile[] } | null {
  const cwd = opts.cwd ?? opts.root;
  const maxFiles = opts.maxFiles ?? MAX_FILES;

  try {
    const frames: Frame[] = [];
    // An explicit filePath from the agent outranks anything parsed out of text.
    // Its line, if the trace names one for the same file, comes along.
    if (opts.filePath) {
      const fromText = extractFrames(opts.errorText)
        .find((f) => f.path.endsWith(basename(opts.filePath!)));
      frames.push({ path: opts.filePath, line: fromText?.line ?? null });
    }
    frames.push(...extractFrames(opts.errorText));

    const files: ResolvedFile[] = [];
    const takenLabels = new Set<string>();
    for (const frame of frames) {
      if (files.length >= maxFiles) break;
      const got = readOne(frame, opts.root, cwd);
      if (got && !takenLabels.has(got.label)) {
        takenLabels.add(got.label);
        files.push(got);
      }
    }

    if (files.length === 0) return null;
    return { snippet: formatSnippet(files), files };
  } catch {
    return null;
  }
}

/**
 * One block per file, labelled with the path and the failing line.
 *
 * The label matters as much as the code: the engine's v2 contract derives
 * machine-applicable edits from what it was sent, and an edit is only
 * applicable if the file it names is the file the agent can open.
 */
export function formatSnippet(files: ResolvedFile[]): string {
  return files
    .map((f) => {
      const where = f.line !== null ? `${f.label}:${f.line}` : f.label;
      // The window's real range, which the engine numbers every line from.
      // apps/engine/app/services/prompt_assembly.py parses exactly this shape;
      // tests/test_snippet_section_numbers.py reads this file to pin it.
      const note = !f.windowed
        ? ''
        : typeof f.start === 'number'
          ? ` (lines ${f.start}-${f.start + f.text.split('\n').length - 1}; file truncated for context budget)`
          : ` (lines around ${f.line ?? 1}; file truncated for context budget)`;
      return `--- ${where}${note} ---\n${f.text}`;
    })
    .join('\n\n');
}
