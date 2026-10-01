/**
 * The project an agent NAMES, validated, as opposed to the one this process
 * happens to be standing in.
 *
 * 2026-09-16 field report, finding F2: an agent was started in ~/portfolio and
 * spent a session building a different repository. The server took its project
 * from its own working directory, so every error from that other repository
 * was filed under ~/portfolio, and local source resolution - bounded to the
 * same directory - could not read one of its files. All seven answers came
 * back with has_project_context false, and nothing said why.
 *
 * So the caller may say which project an error belongs to:
 *
 *   projectRoot   the repository, named outright
 *   filePath      an absolute path inside it; its git repository is used
 *                 (the npm server only - see allowFilePath below)
 *
 * Both are agent-supplied, the same trust as the error text the agent already
 * sends and less than the filesystem the agent can already read. What is
 * refused is breadth: a root must be an existing directory, and neither the
 * filesystem root nor the home directory may be one, because a root is also
 * the boundary local source reads are held inside, and "everything" is not a
 * boundary. A path that is not inside a git repository names no project from
 * filePath at all, so a stray absolute path cannot move the boundary.
 *
 * Never throws. A debug answer without memory is worth far more than no answer.
 *
 * Mirror: apps/extension/src/mcp/explicitProject.ts, byte-identical INCLUDING
 * this header (apps/extension/src/mcp/drift.test.ts).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, parse, resolve } from 'node:path';

export type ExplicitSource = 'projectRoot' | 'filePath';

export interface ExplicitProject {
  root: string;
  id: string;
  source: ExplicitSource;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function toplevel(dir: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Whether two resolved paths name one place.
 *
 * On Windows one directory arrives in two spellings. git prints
 * `C:/Users/me/repo`; VS Code hands down `c:\Users\me\repo`, drive letter
 * lower-cased; `realpathSync` keeps whichever case it was given. Compared
 * as strings they differ, and two checks here were string comparisons. Run on
 * Windows 2026-10-01: an agent naming the folder that was open got a second
 * project id for it (so its memory split in two), and the home directory,
 * spelled with a lower-case drive, was accepted as a project root.
 */
export function samePath(a: string, b: string, windows: boolean = process.platform === 'win32'): boolean {
  if (!windows) return a === b;
  const fold = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return fold(a) === fold(b);
}

/** The filesystem root or the home directory: too wide to be a boundary. */
export function tooBroad(root: string): boolean {
  const r = real(root);
  return samePath(r, parse(r).root) || samePath(r, real(homedir()));
}

const memo = new Map<string, ExplicitProject | null>();

/**
 * The project the caller named, or null to fall back to the server's own.
 *
 * `allowFilePath` is false on the extension-bundled server: that one is TOLD
 * its project by VS Code, and hashing a git toplevel there would give the same
 * repository a second id and split its memory in two.
 */
export function explicitProject(
  opts: { projectRoot?: string; filePath?: string },
  allowFilePath = true,
): ExplicitProject | null {
  const key = `${opts.projectRoot ?? ''}\u0000${allowFilePath ? opts.filePath ?? '' : ''}`;
  if (memo.has(key)) return memo.get(key) ?? null;

  let found: ExplicitProject | null = null;
  try {
    const named = opts.projectRoot?.trim();
    if (named && isAbsolute(named) && isDirectory(named)) {
      const root = toplevel(named) ?? real(named);
      if (!tooBroad(root)) found = { root, id: hashRoot(root), source: 'projectRoot' };
    }
    const file = opts.filePath?.trim();
    if (!found && allowFilePath && file && isAbsolute(file)) {
      const dir = dirname(file);
      if (isDirectory(dir)) {
        const root = toplevel(dir);
        if (root && !tooBroad(root)) found = { root, id: hashRoot(root), source: 'filePath' };
      }
    }
  } catch {
    found = null;
  }
  memo.set(key, found);
  return found;
}

/** md5 of the root path: the same id `project.ts` derives, so one repo is one memory. */
export function hashRoot(root: string): string {
  return createHash('md5').update(root).digest('hex');
}

/** Whether two paths are one directory: symlinks, trailing slashes and Windows spelling aside. */
export function sameDirectory(a: string, b: string): boolean {
  return samePath(real(a), real(b));
}

/** Test seam. */
export function __resetExplicitProjectCache(): void {
  memo.clear();
}
