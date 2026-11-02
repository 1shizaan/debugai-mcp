/**
 * Where the failing command ran, when the caller says so.
 *
 * 2026-10-30 audit export, from the reader's notes on the user report: about
 * twenty answers went wrong because the command ran in a different folder than
 * `projectRoot`. A local module behind a cwd issue was answered "pip install";
 * a dotenv cwd problem was answered wrongly twice; "create a venv" came back at
 * 95 while the venv existed in the subfolder the command ran in; a cmake build
 * was run from the parent folder and answered wrongly twice; the same wrong
 * root dir came back twice, missing `frontend/package.json`. The server knew the
 * project and nobody told it where inside it the command ran.
 *
 * So `debug_error` takes an optional `cwd`, and this decides whether to believe
 * it. It is agent-supplied, the same trust as the error text, and it moves two
 * things only: which relative paths a trace resolves against (sourceContext.ts)
 * and which manifests the facts are read from (gatherWorkspaceFacts.ts). Both
 * stay inside the project root, so the boundary is the one `projectRoot` set.
 *
 * Used or ignored, never an error. A debug answer without this is the answer
 * the caller had before it existed, so a bad value costs one line saying it was
 * ignored and nothing else.
 *
 * Mirror: apps/extension/src/mcp/commandCwd.ts, byte-identical INCLUDING this
 * header (apps/extension/src/mcp/drift.test.ts).
 */
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { tooBroad } from './explicitProject.js';

/** A path longer than this is not a folder anyone ran a command in. */
export const MAX_CWD_CHARS = 1000;

export interface CommandCwd {
  /** The folder's real path: inside the project root, and not the root itself. */
  dir: string;
  /** Relative to the root, `/`-separated on every platform. What the engine is told. */
  rel: string;
}

export type CwdVerdict =
  /** Not given, or the project root itself: there is nothing to say. */
  | { kind: 'none' }
  | { kind: 'used'; cwd: CommandCwd }
  /** Given and refused. `note` is one short line for the answer. */
  | { kind: 'ignored'; note: string };

const ignored = (why: string): CwdVerdict => ({ kind: 'ignored', note: `cwd ignored: ${why}` });

/**
 * Absolute, or relative to `root`. Realpath-contained in `root` after symlinks,
 * so a link inside the project that points out of it names nothing. A root too
 * broad to be a boundary (home, a folder above it, the filesystem root) is
 * refused here as it is everywhere else, so a cwd can never be what makes one
 * acceptable.
 */
export function commandCwd(raw: string | undefined, root: string | null | undefined): CwdVerdict {
  const named = raw?.trim();
  if (!named) return { kind: 'none' };
  if (!root) return ignored('there is no project root to place it in');
  if (named.length > MAX_CWD_CHARS || named.includes('\0')) return ignored('it is not a folder path');
  try {
    const realRoot = realpathSync(root);
    if (tooBroad(realRoot)) return ignored('the project root is your home folder, a folder above it or the filesystem root');
    const target = realpathSync(isAbsolute(named) ? named : resolve(realRoot, named));
    if (!statSync(target).isDirectory()) return ignored('it is not a folder');
    const rel = relative(realRoot, target);
    if (rel === '') return { kind: 'none' };
    const parts = rel.split(sep);
    // `relative` answers an absolute path when the two are on different Windows
    // volumes, and `..` for anything outside: neither is inside.
    if (isAbsolute(rel) || parts[0] === '..') return ignored('it is outside the project root');
    const posix = parts.join('/');
    if (posix.length > 200) return ignored('it is nested too deep to name');
    return { kind: 'used', cwd: { dir: target, rel: posix } };
  } catch {
    return ignored('it is not a folder that exists');
  }
}
