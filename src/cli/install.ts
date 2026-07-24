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

  if (opts.remove) {
    if (!(SERVER_NAME in servers)) return { client, action: 'unchanged', path };
    delete servers[SERVER_NAME];
  } else {
    if (sameEntry(servers[SERVER_NAME], desired)) return { client, action: 'unchanged', path };
    servers[SERVER_NAME] = desired;
  }

  const nextRoot = { ...root, [key]: servers };
  const contents = `${JSON.stringify(nextRoot, null, 2)}\n`;
  const warning = hadComments && !opts.dryRun
    ? 'this file had comments; JSON does not keep them, so they were dropped (the backup above still has them)'
    : undefined;

  if (opts.dryRun) {
    return {
      client,
      action: opts.remove ? 'removed' : existed ? 'updated' : 'wrote',
      path,
      preview: contents,
      warning: hadComments ? 'this file has comments; installing would drop them (a backup is written first)' : undefined,
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

/** True when the client's config already points at this server. */
export function isInstalled(client: McpClient): boolean {
  if (!client.configPath || !existsSync(client.configPath)) return false;
  try {
    const parsed = parseJsonc(readFileSync(client.configPath, 'utf8'));
    const servers = (parsed.value as Record<string, unknown>)?.[serversKey(client.shape)];
    return Boolean(servers && typeof servers === 'object' && SERVER_NAME in (servers as object));
  } catch {
    return false;
  }
}
