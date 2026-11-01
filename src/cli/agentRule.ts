// The DebugAI rule, in the instruction file each of the project's agents reads.
//
// `install` makes DebugAI something the agent CAN call. Whether it does is the
// agent's call, and agents skip the failures that look obvious, which are the
// ones that come back. A rule in the file the agent reads at the start of every
// session is what the docs have told people to paste by hand; `setup` now offers
// to add it.
//
// Which file is a different answer per client, and a wrong answer costs more
// than no answer: a new CLAUDE.md stops Claude Code reading the AGENTS.md a
// project already relies on, and Zed reads only the first file on its list, so a
// new file earlier on that list hides the one it reads now. What each client
// reads was taken from its own documentation on 2026-11-02:
//
//   Claude Code  CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md; AGENTS.md only
//                when none of those exists (code.claude.com/docs/en/memory)
//   Cursor       AGENTS.md. Its rules page no longer lists .cursorrules
//                (cursor.com/docs/context/rules)
//   Windsurf     AGENTS.md always on, .windsurfrules as a legacy import
//                (docs.devin.ai/desktop/cascade/memories)
//   Cline        AGENTS.md (docs.cline.bot/features/cline-rules)
//   Zed          the FIRST of ZED_ORDER that exists (zed.dev/docs/preview/ai/instructions)
//   Gemini CLI   GEMINI.md, or the names in context.fileName (geminicli.com/docs/cli/gemini-md)
//   VS Code      AGENTS.md, chat.useAgentsMdFile being on by default
//                (code.visualstudio.com/docs/copilot/customization/custom-instructions)
//
// Claude Desktop has no project folder and reads none of them.
//
// The file is only ever appended to. A rule already there, however it was
// wrapped, counts as there, so a second run adds nothing.
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tooBroad } from '../explicitProject.js';
import { gitToplevel } from '../project.js';
import type { McpClient } from './clients.js';
import { parseJsonc } from './jsonc.js';

/** The rule as the docs give it. apps/docs/test/claims.test.mjs holds every page to this text. */
export const DEBUGAI_RULE = [
  'When a command fails, call the debugai lookup_error tool first: it is',
  'instant and free. If it has no confirmed fix, call debug_error before',
  'attempting your own, and pass the command that reproduces the failure',
  'as reproCommand. After applying a fix, call report_outcome so the',
  "project's error memory stays accurate.",
].join('\n');

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Whether `text` already holds the rule, wrapped any way: the docs print it on one line and on five. */
export function hasRule(text: string): boolean {
  return flat(text).includes(flat(DEBUGAI_RULE));
}

/**
 * The project the rule goes into: the git repository the command runs in.
 *
 * Stricter than the server's own root (project.ts falls back to the working
 * directory), because this one writes. `setup` is run from wherever a terminal
 * happens to open, and a CLAUDE.md left in ~/Downloads helps nobody. The home
 * folder, the folders above it and the filesystem root are refused by the same
 * test the server uses, and so is a dotfiles checkout that makes home a repository.
 */
export function ruleRoot(cwd: string): { root: string } | { refused: string } {
  const top = gitToplevel(cwd);
  if (tooBroad(top ?? cwd)) {
    return { refused: `${top ?? cwd} is your home folder, a folder above it or the filesystem root, which is never a project` };
  }
  if (!top) return { refused: `${cwd} is not in a git repository` };
  return { root: top };
}

const CLAUDE_OWN = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];
const ZED_ORDER = [
  '.rules', '.cursorrules', '.windsurfrules', '.clinerules', '.github/copilot-instructions.md',
  'AGENT.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md',
];

interface Reader {
  /** The files at the project root this client reads, given which exist. */
  reads: (exists: (file: string) => boolean) => string[];
  /** The file to start when it reads none. */
  create: string;
}

/** Gemini CLI reads GEMINI.md unless its settings name other files. Plain names only: these are joined to the root. */
function geminiNames(settingsPath: string | null): string[] {
  try {
    const value = (parseJsonc(readFileSync(settingsPath ?? '', 'utf8')).value as { context?: { fileName?: unknown } } | null)
      ?.context?.fileName;
    const names = (Array.isArray(value) ? value : [value])
      .filter((n): n is string => typeof n === 'string' && n.trim() !== '' && !/[\\/]/.test(n) && n !== '..');
    if (names.length) return names;
  } catch { /* no settings file, or one that does not parse: Gemini's default */ }
  return ['GEMINI.md'];
}

function readerFor(client: McpClient): Reader | null {
  switch (client.id) {
    case 'claude-code':
      return {
        reads: (exists) => {
          const own = CLAUDE_OWN.filter(exists);
          return own.length ? own : ['AGENTS.md'].filter(exists);
        },
        create: 'CLAUDE.md',
      };
    case 'cursor':
    case 'cline':
    case 'vscode':
      return { reads: (exists) => ['AGENTS.md'].filter(exists), create: 'AGENTS.md' };
    case 'windsurf':
      return { reads: (exists) => ['AGENTS.md', '.windsurfrules'].filter(exists), create: 'AGENTS.md' };
    case 'zed':
      return { reads: (exists) => ZED_ORDER.filter(exists).slice(0, 1), create: 'AGENTS.md' };
    case 'gemini-cli': {
      const names = geminiNames(client.configPath);
      return { reads: (exists) => names.filter(exists), create: names[0] };
    }
    default:
      return null;
  }
}

/** Whether this client reads an instruction file in the project at all. */
export function readsRules(client: McpClient): boolean {
  return readerFor(client) !== null;
}

export interface RulePlan {
  root: string;
  /** Files that already hold the rule, and the clients that read it there. */
  present: Array<{ file: string; clients: string[] }>;
  /** Files the rule goes into, whether each exists yet, and for which clients. */
  add: Array<{ file: string; exists: boolean; clients: string[] }>;
  /** A file not started because a client would stop reading the file it reads now. */
  withheld: Array<{ file: string; clients: string[]; client: string; hides: string }>;
}

export function planRule(root: string, clients: McpClient[]): RulePlan {
  const exists = (file: string): boolean => {
    try { return statSync(join(root, file)).isFile(); } catch { return false; }
  };
  const holdsRule = (file: string): boolean => {
    try { return hasRule(readFileSync(join(root, file), 'utf8')); } catch { return false; }
  };
  const readers = clients.flatMap((c) => {
    const r = readerFor(c);
    return r ? [{ label: c.label, ...r }] : [];
  });

  const present = new Map<string, string[]>();
  const add = new Map<string, string[]>();
  const put = (m: Map<string, string[]>, file: string, label: string): void => {
    m.set(file, [...(m.get(file) ?? []), label]);
  };
  for (const r of readers) {
    const reads = r.reads(exists);
    const has = reads.find(holdsRule);
    if (has) put(present, has, r.label);
    else put(add, reads[0] ?? r.create, r.label);
  }

  // A file started for one client can change what another one reads. Zed with a
  // CLAUDE.md and no AGENTS.md reads CLAUDE.md; start AGENTS.md for Cursor and
  // Zed reads that instead, which holds the rule and none of the project's own
  // instructions. Such a file is not started, and the clients it was for are named.
  const withheld: RulePlan['withheld'] = [];
  for (const [file, labels] of [...add]) {
    if (exists(file)) continue;
    const withFile = (f: string): boolean => f === file || exists(f);
    for (const r of readers) {
      const hides = r.reads(exists).find((f) => !r.reads(withFile).includes(f));
      if (hides) {
        withheld.push({ file, clients: labels, client: r.label, hides });
        add.delete(file);
        break;
      }
    }
  }

  return {
    root,
    present: [...present].map(([file, c]) => ({ file, clients: c })),
    add: [...add].map(([file, c]) => ({ file, exists: exists(file), clients: c })),
    withheld,
  };
}

export interface RuleWrite {
  file: string;
  action: 'appended' | 'created' | 'failed';
  error?: string;
}

/**
 * Appends the rule to each file in the plan. Never rewrites one: a file is
 * opened for append, so whatever it held stays byte for byte, and its line
 * endings are followed.
 */
export function applyRule(plan: RulePlan): RuleWrite[] {
  return plan.add.map(({ file, exists }) => {
    const path = join(plan.root, file);
    try {
      const before = exists ? readFileSync(path, 'utf8') : '';
      const eol = before.includes('\r\n') ? '\r\n' : '\n';
      const gap = before === '' ? '' : before.endsWith('\n') ? eol : eol + eol;
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, gap + DEBUGAI_RULE.replace(/\n/g, eol) + eol);
      return { file, action: exists ? 'appended' : 'created' };
    } catch (err) {
      return { file, action: 'failed', error: (err as Error).message };
    }
  });
}
