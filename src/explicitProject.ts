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
 * filesystem root, the home directory nor any folder above it (nor the Windows
 * profile as WSL shows it) may be one, because a root is also the boundary local
 * source reads are held inside, and "everything" is not a boundary. A path that is not inside a git repository names no project from
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
import { dirname, isAbsolute, resolve } from 'node:path';

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

/**
 * Whether `root` is too wide to be a boundary, given where home is. Pure strings,
 * so the editor's Debug in Browser check (anchorPath.ts, which injects home) asks
 * the same question the MCP servers do instead of keeping a second copy.
 *
 * Too wide is: the filesystem root or a drive root; the home directory; and every
 * folder ABOVE home (`/home`, `/Users`, `C:\Users`), because home is inside each
 * of them; and the Windows drive and profile as WSL shows them (`/mnt/c`,
 * `/mnt/c/Users`, `/mnt/c/Users/<name>`), where many WSL terminals start and whose
 * `.ssh`, `.aws` and AppData would otherwise be readable; and the same seen from
 * Windows: a UNC server or share (`\\server\share`) and a WSL distribution
 * (`\\wsl.localhost\Ubuntu`, its `/home` and `/home/<name>`). A project UNDER home, or
 * under `/mnt/c/Users/<name>/` or a share, is not wide and stays allowed.
 *
 * Both separators are read on any host. A drive-letter path is compared without
 * regard to case, as is everything on Windows: `git` prints `C:/Users/me` and VS
 * Code hands down `c:\Users\me`.
 */
export function tooBroadFor(root: string, home: string, windows: boolean = process.platform === 'win32'): boolean {
  const slash = (p: string): string => (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const r0 = slash(root);
  const h0 = slash(home);
  const fold = windows || /^[a-z]:/i.test(r0) || /^[a-z]:/i.test(h0);
  const r = fold ? r0.toLowerCase() : r0;
  const h = fold ? h0.toLowerCase() : h0;
  if (r === '' || /^[a-z]:$/i.test(r)) { return true; }        // `/`, `C:\`
  // A network share or a WSL distribution seen from Windows is a whole filesystem, as wide as a
  // drive: `\\server`, `\\server\share`, `\\wsl.localhost\Ubuntu`, and the Linux home folders in it.
  if (/^\/\/[^/]+(\/[^/]+)?$/.test(r0)) { return true; }
  if (/^\/\/(wsl\.localhost|wsl\$)\/[^/]+(\/home(\/[^/]+)?)?$/i.test(r0)) { return true; }
  if (h !== '' && (h === r || h.startsWith(`${r}/`))) { return true; }   // home, or a folder above it
  return /^\/mnt\/[a-z](\/users(\/[^/]+)?)?$/i.test(r0);     // WSL's view of the Windows profile
}

/** The filesystem root, the home directory, or a folder above home: too wide to be a boundary. See tooBroadFor. */
export function tooBroad(root: string): boolean {
  return tooBroadFor(real(root), real(homedir()));
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
      // A dotfiles checkout makes `~` the git toplevel of everything under it. That
      // toplevel is refused, but the folder the agent NAMED is not: fall back to it,
      // or `projectRoot=~/code/x` resolved to `~` and was refused, and the advice in
      // the reply (pass projectRoot) could never work for such a user.
      const top = toplevel(named);
      const root = top && !tooBroad(top) ? top : real(named);
      // The id stays the git toplevel's, as project.ts's resolveProjectId and a debug_error
      // with no projectRoot compute it, so the hook and a debug of one failure still share
      // one memory. Only the READ boundary narrows to the folder named.
      if (!tooBroad(root)) found = { root, id: hashRoot(top ?? root), source: 'projectRoot' };
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
