/**
 * Project identity for the MCP path.
 *
 * Team Error Memory (recurrence counts, confirmed fixes) is project-scoped in
 * the engine: a request with no project_id is never recalled and never stored.
 * Until this module existed, nothing in this package ever set project_id, so
 * every agent request went unscoped and the memory features were silently
 * inert on the MCP path while the server instructions advertised them.
 *
 * What identifies a "project" here:
 *
 *   md5(git toplevel path)  →  falling back to  md5(cwd)
 *
 * Two constraints drove that choice.
 *
 * 1. It has to MATCH the VS Code extension, which uses
 *    md5(workspaceFolder.fsPath). Someone running both against one repo should
 *    get one memory, not two. Git toplevel equals the workspace folder in the
 *    normal case, and resolving to the repo root also means an agent invoked
 *    from a subdirectory lands on the same id as one invoked from the root.
 *
 * 2. It does NOT need to be unguessable. The API gateway namespaces every
 *    incoming project_id as `u_<user.id>__<project_id>` before the engine sees
 *    it (apps/api/src/routes/debug.ts), so the authenticated user is the real
 *    tenancy boundary. A path string that collides across two users (`/app` in
 *    a devcontainer is the obvious case) still resolves to two different
 *    scoped ids server-side.
 *
 * Format note: the gateway rejects anything not matching
 * /^[A-Za-z0-9_\-]{1,64}$/, and md5 hex satisfies that.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

let cached: string | null | undefined;

/** Repo root per git, or null when this is not a git worktree. */
export function gitToplevel(cwd: string = process.cwd()): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // Not a repo, git missing, or timeout. All three mean "fall back", not "fail".
    return null;
  }
}

export function hashPath(p: string): string {
  return createHash('md5').update(p).digest('hex');
}

/**
 * Resolve the project id for this process. Never throws: a debug request
 * without memory is far better than a debug request that failed.
 */
export function resolveProjectId(cwd: string = process.cwd()): string | null {
  try {
    const root = gitToplevel(cwd) ?? cwd;
    if (!root) return null;
    return hashPath(root);
  } catch {
    return null;
  }
}

/**
 * Cached across the process. The MCP server is long-lived and its cwd does not
 * move, so shelling out to git once per debug call would be wasted work.
 */
export function getProjectId(): string | null {
  if (cached === undefined) cached = resolveProjectId();
  return cached;
}

/**
 * The directory local source resolution is allowed to read inside.
 *
 * Same value the project id is derived from — git toplevel, falling back to
 * cwd — so "the project we remember errors for" and "the project we may read
 * files from" can never be two different directories. sourceContext.ts treats
 * this as a hard boundary: a path that resolves outside it is not read, which
 * is what keeps a crafted stack trace from turning into an arbitrary file read.
 */
export function getProjectRoot(cwd: string = process.cwd()): string {
  return gitToplevel(cwd) ?? cwd;
}

/** Test seam. */
export function __resetProjectIdCache(): void {
  cached = undefined;
}
