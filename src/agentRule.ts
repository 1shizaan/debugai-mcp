// The DebugAI rule, in the instruction file each of the project's agents reads.
//
// `install` makes DebugAI something the agent CAN call. Whether it does is the
// agent's call, and agents skip the failures that look obvious, which are the
// ones that come back. A rule in the file the agent reads at the start of every
// session is what the docs have told people to paste by hand; `setup` offers
// to add it (cli/commands.ts).
//
// MIRRORED in apps/extension/src/mcp/agentRule.ts, which offers the same rule to
// the agent inside the editor: byte-identical below this header, pinned by
// apps/extension/src/mcp/drift.test.ts. Most agent debugs come through the
// server that extension bundles, so the decision of which file, and what never
// to write, has to be one decision and not two. That is also why the body
// imports nothing but node and explicitProject.js, which both servers carry.
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { toplevel, tooBroad } from './explicitProject.js';

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
 * A file's text with the rule after its last byte, in the file's own line
 * endings. Everything that was there stays as it was: this only ever appends.
 */
export function ruleAppended(before: string): string {
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const gap = before === '' ? '' : before.endsWith('\n') ? eol : eol + eol;
  return before + gap + DEBUGAI_RULE.replace(/\n/g, eol) + eol;
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
  const top = toplevel(cwd);
  if (tooBroad(top ?? cwd)) {
    return { refused: `${top ?? cwd} is your home folder, a folder above it or the filesystem root, which is never a project` };
  }
  if (!top) return { refused: `${cwd} is not in a git repository` };
  return { root: top };
}

/**
 * An agent the rule is for. `files` says outright which files it reads (all of
 * them, together) and which to start, for an agent whose reading is settings
 * the caller can see and this module cannot: Gemini CLI's context.fileName, or
 * VS Code's chat.useAgentsMdFile. Without `files`, `id` picks a reader below.
 */
export interface RuleClient {
  id: string;
  label: string;
  files?: { reads: string[]; create: string | null };
}

// What each agent reads, from its own documentation on 2026-11-02:
//
//   Claude Code  CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md; AGENTS.md only
//                when none of those exists (code.claude.com/docs/en/memory)
//   Cursor       AGENTS.md. Its rules page no longer lists .cursorrules
//                (cursor.com/docs/context/rules)
//   Windsurf     AGENTS.md always on, .windsurfrules as a legacy import
//                (docs.devin.ai/desktop/cascade/memories)
//   Cline        AGENTS.md (docs.cline.bot/features/cline-rules)
//   Zed          the FIRST of ZED_ORDER that exists (zed.dev/docs/preview/ai/instructions)
//   VS Code      root AGENTS.md (chat.useAgentsMdFile), .github/copilot-instructions.md
//                (github.copilot.chat.codeGeneration.useInstructionFiles) and CLAUDE.md
//                (chat.useClaudeMdFile), all on by default and read together, with no
//                precedence (code.visualstudio.com/docs/copilot/customization/custom-instructions,
//                .../reference/copilot-settings). The editor passes them as `files`.
//   Gemini CLI   GEMINI.md, or the names in context.fileName (geminicli.com/docs/cli/gemini-md);
//                the caller reads its settings and passes `files`.
//
// Claude Desktop has no project folder and reads none of them.
const CLAUDE_OWN = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];
const ZED_ORDER = [
  '.rules', '.cursorrules', '.windsurfrules', '.clinerules', '.github/copilot-instructions.md',
  'AGENT.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md',
];

interface Reader {
  /** The files at the project root this agent reads, given which exist. */
  reads: (exists: (file: string) => boolean) => string[];
  /** The file to start when it reads none, or null when there is none it would read. */
  create: string | null;
}

function readerFor(client: RuleClient): Reader | null {
  if (client.files) {
    const { reads, create } = client.files;
    return { reads: (exists) => reads.filter(exists), create };
  }
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
    case 'gemini-cli':
      return { reads: (exists) => ['GEMINI.md'].filter(exists), create: 'GEMINI.md' };
    default:
      return null;
  }
}

/** Whether this agent reads an instruction file in the project at all. */
export function readsRules(client: RuleClient): boolean {
  return readerFor(client) !== null;
}

export interface RulePlan {
  root: string;
  /** Files that already hold the rule, and the agents that read it there. */
  present: Array<{ file: string; clients: string[] }>;
  /** Files the rule goes into, whether each exists yet, and for which agents. */
  add: Array<{ file: string; exists: boolean; clients: string[] }>;
  /** A file not started because an agent would stop reading the file it reads now. */
  withheld: Array<{ file: string; clients: string[]; client: string; hides: string }>;
}

export function planRule(root: string, clients: RuleClient[]): RulePlan {
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
    const target = reads[0] ?? r.create;
    if (has) put(present, has, r.label);
    else if (target) put(add, target, r.label);
  }

  // A file started for one agent can change what another one reads. Zed with a
  // CLAUDE.md and no AGENTS.md reads CLAUDE.md; start AGENTS.md for Cursor and
  // Zed reads that instead, which holds the rule and none of the project's own
  // instructions. Such a file is not started, and the agents it was for are named.
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
 * Appends the rule to each file in the plan, straight to disk. For a process
 * with no editor buffers to respect: the editor writes through its document
 * model instead, with ruleAppended. A file is opened for append, so whatever it
 * held stays byte for byte.
 */
export function applyRule(plan: RulePlan): RuleWrite[] {
  return plan.add.map(({ file, exists }) => {
    const path = join(plan.root, file);
    try {
      const before = exists ? readFileSync(path, 'utf8') : '';
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, ruleAppended(before).slice(before.length));
      return { file, action: exists ? 'appended' : 'created' };
    } catch (err) {
      return { file, action: 'failed', error: (err as Error).message };
    }
  });
}
