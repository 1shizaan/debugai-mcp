// The Claude Code hook (hook.ts), written into ~/.claude/settings.json so that
// `setup` adds what the docs used to tell people to paste.
//
// settings.json is the whole of Claude Code's configuration: permissions, env,
// the model, every other hook. So the rules install.ts keeps for client configs,
// with its functions: merge into what is there and touch nothing else, back up
// before changing it, leave a file that does not parse alone and say so, and
// change nothing on a second run.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { backupPath, writeAtomic } from './install.js';
import { parseJsonc } from './jsonc.js';

export const HOOK_COMMAND = 'npx -y @debugai/mcp@latest hook';

/** The group the docs give. apps/docs/test/claims.test.mjs holds claude-code.mdx to it. */
export const HOOK_GROUP = {
  matcher: 'Bash|PowerShell',
  hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 20 }],
};

/** Every project's hooks. Claude Code reads the same file name in a project's .claude folder. */
export function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

// Any spelling of this package's hook: the npx line above, npx with another
// version or none, or `debugai-mcp hook` from the global install the docs
// suggest for speed. One already there is not added twice.
const OUR_HOOK = /(?:^|\s)(?:@debugai\/mcp(?:@\S+)?|debugai-mcp)\s+hook(?:\s|$)/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function hasHook(settings: unknown): boolean {
  const groups = isObject(settings) && isObject(settings.hooks) ? settings.hooks.PostToolUseFailure : undefined;
  return Array.isArray(groups) && groups.some((g) =>
    isObject(g) && Array.isArray(g.hooks) && g.hooks.some((h) =>
      isObject(h) && typeof h.command === 'string' && OUR_HOOK.test(h.command)));
}

export interface HookResult {
  action: 'wrote' | 'updated' | 'unchanged' | 'failed';
  path: string;
  backupPath?: string;
  warning?: string;
  error?: string;
  /** The hook block alone, to merge by hand. Never the whole file: settings.json can hold keys in `env`. */
  snippet: string;
}

const SNIPPET = JSON.stringify({ hooks: { PostToolUseFailure: [HOOK_GROUP] } }, null, 2);

export function applyHook(path: string, opts: { dryRun?: boolean } = {}): HookResult {
  const existed = existsSync(path);
  let root: Record<string, unknown> = {};
  let hadComments = false;
  if (existed) {
    try {
      const parsed = parseJsonc(readFileSync(path, 'utf8'));
      if (!isObject(parsed.value)) throw new Error('top level is not a JSON object');
      root = parsed.value;
      hadComments = parsed.hadComments;
    } catch (err) {
      return { action: 'failed', path, error: `could not parse (${(err as Error).message}) — left untouched`, snippet: SNIPPET };
    }
  }
  if (hasHook(root)) return { action: 'unchanged', path, snippet: SNIPPET };

  const hooks = root.hooks ?? {};
  const groups = isObject(hooks) ? hooks.PostToolUseFailure ?? [] : undefined;
  if (!isObject(hooks) || !Array.isArray(groups)) {
    return { action: 'failed', path, error: '"hooks" is not in the shape Claude Code documents — left untouched', snippet: SNIPPET };
  }
  const contents = `${JSON.stringify({ ...root, hooks: { ...hooks, PostToolUseFailure: [...groups, HOOK_GROUP] } }, null, 2)}\n`;
  const action = existed ? 'updated' : 'wrote';

  if (opts.dryRun) {
    return {
      action, path, snippet: SNIPPET,
      warning: hadComments ? 'this file has comments; adding the hook would drop them (a backup is written first)' : undefined,
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
    return { action: 'failed', path, backupPath: backup, error: (err as Error).message, snippet: SNIPPET };
  }
  return {
    action, path, backupPath: backup, snippet: SNIPPET,
    warning: hadComments ? 'this file had comments; JSON does not keep them, so they were dropped (the backup above still has them)' : undefined,
  };
}

/**
 * Every settings file that runs the hook for a session in `projectRoot`: the
 * user's, the project's and the project's local one, the three the hooks
 * reference lists. `doctor` reads all three, because the docs have long said a
 * project's own .claude/settings.json works too, and a check that reads one of
 * them would call a working hook missing.
 */
export function hookSites(projectRoot: string | null): { found: string[]; unreadable: string[] } {
  const paths = [claudeSettingsPath()];
  if (projectRoot) paths.push(join(projectRoot, '.claude', 'settings.json'), join(projectRoot, '.claude', 'settings.local.json'));
  const found: string[] = [];
  const unreadable: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      if (hasHook(parseJsonc(readFileSync(p, 'utf8')).value)) found.push(p);
    } catch {
      unreadable.push(p);
    }
  }
  return { found, unreadable };
}
