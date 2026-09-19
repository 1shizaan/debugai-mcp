// Writes the DebugAI server into MCP client config files.
//
// Rules this code refuses to break, because it is editing files a user's
// whole editor setup depends on:
//   - never overwrite the file wholesale — parse, touch only our own key,
//     write everything else back untouched
//   - back up before the first modification, always, with the path printed
//   - write to a temp file in the same directory and rename over the target,
//     so a crash mid-write cannot leave a truncated config behind
//   - a file we cannot parse is left ALONE and reported, never "fixed"
//   - running twice is a no-op ("unchanged"), never a duplicate entry
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseJsonc } from './jsonc.js';
import { SERVER_NAME, serverEntry, serversKey, type McpClient } from './clients.js';

export type InstallAction = 'wrote' | 'updated' | 'unchanged' | 'removed' | 'skipped' | 'failed';

export interface InstallResult {
  client: McpClient;
  action: InstallAction;
  path: string | null;
  backupPath?: string;
  /** Non-fatal thing the user must know (dropped comments, unsupported OS). */
  warning?: string;
  error?: string;
  /** The exact JSON we would write — used by --dry-run and by failure output. */
  preview?: string;
}

function backupPath(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${path}.debugai-backup-${stamp}`;
}

function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, contents, 'utf8');
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function sameEntry(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface InstallOptions {
  dryRun?: boolean;
  /** Remove the debugai entry instead of adding it. */
  remove?: boolean;
}

export function applyToClient(client: McpClient, opts: InstallOptions = {}): InstallResult {
  const path = client.configPath;
  if (!path) {
    return {
      client,
      action: 'skipped',
      path: null,
      warning: `${client.label} has no known config location on this operating system.`,
    };
  }

  const key = serversKey(client.shape);
  const desired = serverEntry(client);

  let root: Record<string, unknown> = {};
  let hadComments = false;
  const existed = existsSync(path);

  if (existed) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      return { client, action: 'failed', path, error: `could not read: ${(err as Error).message}` };
    }
    try {
      const parsed = parseJsonc(raw);
      hadComments = parsed.hadComments;
      if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
        throw new Error('top level is not a JSON object');
      }
      root = parsed.value as Record<string, unknown>;
    } catch (err) {
      // Do NOT rewrite a file we failed to understand — that is how people
      // lose their editor settings. Report it and hand back the snippet.
      return {
        client,
        action: 'failed',
        path,
        error: `could not parse (${(err as Error).message}) — left untouched`,
        preview: JSON.stringify({ [key]: { [SERVER_NAME]: desired } }, null, 2),
      };
    }
  } else if (opts.remove) {
    return { client, action: 'unchanged', path };
  }

  const existingServers = root[key];
  const servers: Record<string, unknown> =
    typeof existingServers === 'object' && existingServers !== null && !Array.isArray(existingServers)
      ? { ...(existingServers as Record<string, unknown>) }
      : {};

  // Said out loud rather than done quietly: the entry being replaced carried a
  // key, the new one does not, and a server that starts without one asks the
  // agent to sign in on its first call. Harmless, but surprising if unannounced.
  const droppedKey = !opts.remove && entryCarriesKey(servers[SERVER_NAME]);
  if (opts.remove) {
    if (!(SERVER_NAME in servers)) return { client, action: 'unchanged', path };
    delete servers[SERVER_NAME];
  } else {
    if (sameEntry(servers[SERVER_NAME], desired)) return { client, action: 'unchanged', path };
    servers[SERVER_NAME] = desired;
  }

  const nextRoot = { ...root, [key]: servers };
  const contents = `${JSON.stringify(nextRoot, null, 2)}\n`;
  const KEY_DROPPED = 'the old entry carried DEBUGAI_API_KEY in plain text; it was not copied. The server ' +
    'now uses the key `debugai-mcp login` stores, so run that if you have not.';
  const warning = [
    hadComments && !opts.dryRun
      ? 'this file had comments; JSON does not keep them, so they were dropped (the backup above still has them)'
      : undefined,
    droppedKey && !opts.dryRun ? KEY_DROPPED : undefined,
  ].filter(Boolean).join(' Also, ') || undefined;

  if (opts.dryRun) {
    return {
      client,
      action: opts.remove ? 'removed' : existed ? 'updated' : 'wrote',
      path,
      preview: contents,
      warning: [
        hadComments ? 'this file has comments; installing would drop them (a backup is written first)' : undefined,
        droppedKey ? 'the current entry carries DEBUGAI_API_KEY in plain text; installing would not copy it (run `debugai-mcp login` first)' : undefined,
      ].filter(Boolean).join(' Also, ') || undefined,
    };
  }

  let backup: string | undefined;
  try {
    if (existed) {
      backup = backupPath(path);
      copyFileSync(path, backup);
    }
    writeAtomic(path, contents);
  } catch (err) {
    return {
      client,
      action: 'failed',
      path,
      backupPath: backup,
      error: (err as Error).message,
      preview: JSON.stringify({ [key]: { [SERVER_NAME]: desired } }, null, 2),
    };
  }

  return {
    client,
    action: opts.remove ? 'removed' : existed ? 'updated' : 'wrote',
    path,
    backupPath: backup,
    warning,
  };
}

/**
 * Where a client's config points at this server, if anywhere.
 *
 * ## Why this is not a boolean any more
 *
 * Claude Code stores MCP servers in two places in one file, and the difference
 * decides whether DebugAI works in every repo or exactly one:
 *
 *   ~/.claude.json
 *   ├── mcpServers            ← user scope. Every directory, every session.
 *   └── projects
 *       └── /home/me/thing
 *           └── mcpServers    ← local scope. That one directory only.
 *
 * `claude mcp add` writes the SECOND one, because `--scope local` is its
 * default. This function used to read only the first, so the officially
 * documented install path produced a config that `doctor` then reported as
 * missing — a diagnostic contradicting a working install, which is worse than
 * no diagnostic, because it sends somebody to re-run an installer that then
 * creates a duplicate entry in the other scope.
 *
 * Reported by an agent running a real build on 2026-08-24, who lost a whole
 * session to it. Their words: "two documented paths disagree, and the
 * diagnostic sides with the wrong one."
 *
 * The scope is returned rather than flattened away because the two are not
 * equally good. A local-scope install is the thing that makes somebody think
 * they have to reconfigure DebugAI per directory, and telling them where it
 * actually is turns that into a one-line fix.
 */
export interface InstallSite {
  /** 'user' works everywhere. 'project' works in `projectPath` only. */
  scope: 'user' | 'project';
  /** Which directory it is scoped to, for 'project'. */
  projectPath?: string;
}

export function findInstall(client: McpClient): InstallSite | null {
  if (!client.configPath || !existsSync(client.configPath)) return null;
  const has = (v: unknown): boolean =>
    Boolean(v && typeof v === 'object' && SERVER_NAME in (v as object));
  try {
    const parsed = parseJsonc(readFileSync(client.configPath, 'utf8'));
    const root = parsed.value as Record<string, unknown> | undefined;
    if (has(root?.[serversKey(client.shape)])) return { scope: 'user' };

    // Claude Code's per-directory scope. Other clients have no `projects` key,
    // so this loop simply never runs for them rather than needing a special case.
    const projects = root?.projects;
    if (projects && typeof projects === 'object') {
      for (const [dir, cfg] of Object.entries(projects as Record<string, unknown>)) {
        if (cfg && typeof cfg === 'object' && has((cfg as Record<string, unknown>).mcpServers)) {
          return { scope: 'project', projectPath: dir };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** True when the client's config points at this server in ANY scope. */
export function isInstalled(client: McpClient): boolean {
  return findInstall(client) !== null;
}

/**
 * Every scope in this client's config where our entry carries a DebugAI key in
 * plain text.
 *
 * `install` never writes one (see serverEntry), but hand-written entries and
 * older setup guides did, and on 2026-09-16 an agent found one in
 * ~/.claude.json while device-link sign-in sat unused (field report F13, R15).
 * Two costs, not one: a client config is the kind of file that gets committed
 * or pasted into a bug report, and a key in `env` outranks the one `login`
 * stores, so after a rotation that stale copy keeps failing authentication
 * while `login` reports success.
 *
 * Only a value that IS a key counts (`dbg_...`), so a `${input:...}` or other
 * indirection a client resolves at launch is left alone. Read-only, never
 * throws, an unreadable config reports nothing.
 */
/** True when an entry of ours carries a DebugAI key in plain text, in any shape. */
function entryCarriesKey(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  const envs = [e.env, (e.command && typeof e.command === 'object') ? (e.command as Record<string, unknown>).env : undefined];
  return envs.some((env) => {
    const v = env && typeof env === 'object' ? (env as Record<string, unknown>).DEBUGAI_API_KEY : undefined;
    return typeof v === 'string' && v.trim().startsWith('dbg_');
  });
}

export function plaintextKeySites(client: McpClient): InstallSite[] {
  if (!client.configPath || !existsSync(client.configPath)) return [];
  // Zed nests env inside `command`; every other shape keeps it on the entry.
  const keyIn = (servers: unknown): boolean =>
    !!servers && typeof servers === 'object' && entryCarriesKey((servers as Record<string, unknown>)[SERVER_NAME]);
  try {
    const root = parseJsonc(readFileSync(client.configPath, 'utf8')).value as Record<string, unknown> | undefined;
    const sites: InstallSite[] = [];
    if (keyIn(root?.[serversKey(client.shape)])) sites.push({ scope: 'user' });
    const projects = root?.projects;
    if (projects && typeof projects === 'object') {
      for (const [dir, cfg] of Object.entries(projects as Record<string, unknown>)) {
        if (cfg && typeof cfg === 'object' && keyIn((cfg as Record<string, unknown>).mcpServers)) {
          sites.push({ scope: 'project', projectPath: dir });
        }
      }
    }
    return sites;
  } catch {
    return [];
  }
}


/**
 * The package spec our entry runs, in the scope that governs (user first), or
 * null. `@debugai/mcp` bare means npx runs whatever copy it finds first, which
 * is how a July global install ran a whole session in September (see
 * serverEntry). Read-only, never throws.
 */
export function installedSpec(client: McpClient): string | null {
  if (!client.configPath || !existsSync(client.configPath)) return null;
  const specOf = (entry: unknown): string | null => {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    const args = Array.isArray(e.args) ? e.args
      : (e.command && typeof e.command === 'object' && Array.isArray((e.command as Record<string, unknown>).args))
        ? (e.command as Record<string, unknown>).args as unknown[] : [];
    const spec = args.find((a) => typeof a === 'string' && /^@debugai\/mcp(@|$)/.test(a));
    return typeof spec === 'string' ? spec : null;
  };
  try {
    const root = parseJsonc(readFileSync(client.configPath, 'utf8')).value as Record<string, unknown> | undefined;
    const user = root?.[serversKey(client.shape)];
    if (user && typeof user === 'object' && SERVER_NAME in (user as object)) {
      return specOf((user as Record<string, unknown>)[SERVER_NAME]);
    }
    const projects = root?.projects;
    if (projects && typeof projects === 'object') {
      for (const cfg of Object.values(projects as Record<string, unknown>)) {
        const servers = cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>).mcpServers : undefined;
        if (servers && typeof servers === 'object' && SERVER_NAME in (servers as object)) {
          return specOf((servers as Record<string, unknown>)[SERVER_NAME]);
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}
