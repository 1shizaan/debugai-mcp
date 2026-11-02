// What `setup` does after install: the DebugAI rule in the file each agent
// reads, and the Claude Code hook in ~/.claude/settings.json. Both are files
// somebody else owns, so the line install.test.ts holds holds here too: merge,
// never replace; a second run changes nothing; what does not parse is left alone.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEBUGAI_RULE, applyRule, hasRule, planRule, ruleAppended } from '../src/agentRule.js';
import { HOOK_GROUP, applyHook } from '../src/cli/claudeHook.js';
import type { McpClient } from '../src/cli/clients.js';
import { cmdSetup } from '../src/cli/commands.js';
import { askYes } from '../src/cli/ui.js';

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = join(here, '..', 'dist', 'index.js');

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'debugai-habits-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const client = (id: string, label: string): McpClient =>
  ({ id, label, shape: 'mcpServers', configPath: null, probes: [], afterInstall: '' });
const CLAUDE_CODE = client('claude-code', 'Claude Code');

describe('the hook in settings.json', () => {
  it('goes in beside every setting and every hook already there', () => {
    const path = join(dir, 'settings.json');
    const before = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'lint' }] }],
        PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'notify' }] }],
      },
    };
    writeFileSync(path, JSON.stringify(before));
    expect(applyHook(path).action).toBe('updated');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      ...before,
      hooks: { ...before.hooks, PostToolUseFailure: [...before.hooks.PostToolUseFailure, HOOK_GROUP] },
    });
  });

  it('a second run changes nothing and writes no second backup', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{"model": "opus"}');
    applyHook(path);
    const after = readFileSync(path, 'utf8');
    const files = readdirSync(dir).length;
    expect(applyHook(path).action).toBe('unchanged');
    expect(readFileSync(path, 'utf8')).toBe(after);
    expect(readdirSync(dir).length).toBe(files);
  });

  it('a hook from the global install the docs suggest counts as the hook', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({
      hooks: { PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'debugai-mcp hook' }] }] },
    }));
    expect(applyHook(path).action).toBe('unchanged');
  });

  it('the file is backed up, as it was, before it changes', () => {
    const path = join(dir, 'settings.json');
    const original = '{\n  "model": "opus"\n}\n';
    writeFileSync(path, original);
    const result = applyHook(path);
    expect(readFileSync(result.backupPath!, 'utf8')).toBe(original);
  });

  it('settings that do not parse are left byte for byte, and the hook is handed back to paste', () => {
    const path = join(dir, 'settings.json');
    const original = '{ "model": "opus", ';
    writeFileSync(path, original);
    const result = applyHook(path);
    expect(result.action).toBe('failed');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(result.snippet).toContain('@debugai/mcp@latest hook');
  });

  it('a "hooks" that is not the documented shape is left alone too', () => {
    const path = join(dir, 'settings.json');
    const original = '{"hooks": [1, 2]}';
    writeFileSync(path, original);
    expect(applyHook(path).action).toBe('failed');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
});

describe('the rule', () => {
  it('a second run adds nothing', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Shop\n');
    applyRule(planRule(dir, [CLAUDE_CODE]));
    const once = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(hasRule(once)).toBe(true);
    applyRule(planRule(dir, [CLAUDE_CODE]));
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe(once);
  });

  it('a rule wrapped another way is still the rule, so a second run adds nothing', () => {
    for (const wrapped of [DEBUGAI_RULE.replace(/\n/g, ' '), DEBUGAI_RULE.replace(/\n/g, '\n\n')]) {
      writeFileSync(join(dir, 'CLAUDE.md'), `# Shop\n\n${wrapped}\n`);
      const plan = planRule(dir, [CLAUDE_CODE]);
      expect(plan.add).toEqual([]);
      expect(plan.present).toEqual([{ file: 'CLAUDE.md', clients: ['Claude Code'] }]);
    }
  });

  it('goes after the last byte of the file, in the file\'s own line endings', () => {
    const before = '# Shop\r\n\r\nUse pnpm.';
    writeFileSync(join(dir, 'CLAUDE.md'), before);
    applyRule(planRule(dir, [CLAUDE_CODE]));
    const after = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(after.slice(0, before.length)).toBe(before);
    expect(after.slice(before.length)).toBe(`\r\n\r\n${DEBUGAI_RULE.replace(/\n/g, '\r\n')}\r\n`);
  });

  it('setup appends the same bytes the editor writes through its document model', () => {
    // The editor cannot append to a buffer, so it writes ruleAppended(text) whole;
    // setup appends the tail. One of them changing alone would leave two files
    // the same rule with different spacing, or line endings, depending on who added it.
    for (const before of ['', '# Shop\n', '# Shop', '# Shop\r\n', '# Shop\r\n\r\nUse pnpm.', '\n']) {
      const path = join(dir, 'CLAUDE.md');
      writeFileSync(path, before);
      applyRule(planRule(dir, [CLAUDE_CODE]));
      expect(readFileSync(path, 'utf8')).toBe(ruleAppended(before));
      rmSync(path);
    }
  });

  it('Claude Code reading an AGENTS.md gets the rule there, and no CLAUDE.md that would hide it', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# Agents\n');
    applyRule(planRule(dir, [CLAUDE_CODE]));
    expect(hasRule(readFileSync(join(dir, 'AGENTS.md'), 'utf8'))).toBe(true);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
  });

  it('no file is started that Zed would read in place of the one it reads now', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Shop\n');
    const plan = planRule(dir, [client('zed', 'Zed'), client('cursor', 'Cursor')]);
    expect(plan.add.map((a) => a.file)).toEqual(['CLAUDE.md']);
    expect(plan.withheld).toEqual([{ file: 'AGENTS.md', clients: ['Cursor'], client: 'Zed', hides: 'CLAUDE.md' }]);
  });
});

describe('at a terminal', () => {
  it('Enter alone is yes, and n is no', async () => {
    const answer = async (typed: string): Promise<boolean> => {
      const input = new PassThrough();
      const pending = askYes('Add it?', input, new PassThrough());
      input.write(typed);
      return pending;
    };
    expect(await answer('\n')).toBe(true);
    expect(await answer('n\n')).toBe(false);
  });

  it('setup asks, and a yes adds the rule and the hook', async () => {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      process.env.HOME = dir;
      process.env.USERPROFILE = dir;
      mkdirSync(join(dir, '.claude'));
      const project = join(dir, 'shop');
      mkdirSync(project);
      execFileSync('git', ['init', '-q'], { cwd: project });
      const asked: string[] = [];
      await cmdSetup([], {
        DEBUGAI_API_KEY: 'dbg_test', DEBUGAI_API_BASE: 'http://127.0.0.1:9/api',
        DEBUGAI_CONFIG_PATH: join(dir, 'none', 'config.json'),
      }, { canAsk: () => true, ask: async (q) => { asked.push(q); return true; } }, project);
      expect(asked).toEqual(['Add the rule?', 'Add the hook?']);
      expect(hasRule(readFileSync(join(project, 'CLAUDE.md'), 'utf8'))).toBe(true);
      expect(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).toContain('@debugai/mcp@latest hook');
    } finally {
      write.mockRestore();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

// The BUILT CLI, in a made-up home, as cli.e2e.test.ts runs it. Its stdin is a
// pipe, so there is nobody at a terminal to ask.
describe('setup, run without a terminal', () => {
  let home: string;
  let project: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'debugai-home-'));
    mkdirSync(join(home, '.claude'));
    project = join(home, 'code', 'shop');
    mkdirSync(project, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: project });
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  function cli(cwd: string, ...args: string[]): string {
    try {
      return execFileSync(process.execPath, [distEntry, ...args], {
        cwd,
        env: {
          PATH: process.env.PATH, HOME: home, USERPROFILE: home, CI: '1', NO_COLOR: '1',
          DEBUGAI_API_KEY: 'dbg_test', DEBUGAI_API_BASE: 'http://127.0.0.1:9/api',
          DEBUGAI_CONFIG_PATH: join(home, 'none', 'config.json'),
        },
        encoding: 'utf8',
      });
    } catch (err) {
      return String((err as { stdout?: string }).stdout ?? '');   // doctor exits 1: no API here
    }
  }
  const setup = (cwd: string, ...args: string[]): string => cli(cwd, 'setup', ...args);
  const settings = (): string => join(home, '.claude', 'settings.json');

  it('with no flag, writes neither and prints the command for each', () => {
    const out = setup(project);
    expect(existsSync(join(project, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(settings())).toBe(false);
    expect(out).toContain('no terminal to ask in. To add it, run this here: npx -y @debugai/mcp setup --rules');
    expect(out).toContain('no terminal to ask in. To add it: npx -y @debugai/mcp setup --hook');
  });

  it('--rules and --hook add both without asking', () => {
    setup(project, '--rules', '--hook');
    expect(hasRule(readFileSync(join(project, 'CLAUDE.md'), 'utf8'))).toBe(true);
    expect(readFileSync(settings(), 'utf8')).toContain('@debugai/mcp@latest hook');
  });

  it('Gemini CLI gets the rule in the file its settings name, and the first name when none exists', () => {
    mkdirSync(join(home, '.gemini'));
    writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({ context: { fileName: ['TEAM.md', 'GEMINI.md'] } }));
    setup(project, '--rules', '--no-hook');
    expect(hasRule(readFileSync(join(project, 'TEAM.md'), 'utf8'))).toBe(true);
    expect(existsSync(join(project, 'GEMINI.md'))).toBe(false);
    expect(hasRule(readFileSync(join(project, 'CLAUDE.md'), 'utf8'))).toBe(true);
  });

  it('Gemini CLI reads GEMINI.md by default, and a settings name that leaves the project is ignored', () => {
    mkdirSync(join(home, '.gemini'));
    writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({ context: { fileName: ['../outside.md', 'sub/dir.md'] } }));
    setup(project, '--rules', '--no-hook');
    expect(hasRule(readFileSync(join(project, 'GEMINI.md'), 'utf8'))).toBe(true);
    expect(existsSync(join(home, 'code', 'outside.md'))).toBe(false);
    expect(existsSync(join(project, 'sub'))).toBe(false);
  });

  it('--dry-run writes neither', () => {
    setup(project, '--dry-run', '--rules', '--hook');
    expect(existsSync(join(project, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(settings())).toBe(false);
  });

  it('adds nothing outside a git repository, and says so', () => {
    const plain = join(home, 'code', 'notes');
    mkdirSync(plain, { recursive: true });
    const out = setup(plain, '--rules', '--no-hook');
    expect(existsSync(join(plain, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(plain, 'AGENTS.md'))).toBe(false);
    expect(out).toContain('is not in a git repository');
  });

  it('refuses the home folder as a project', () => {
    const out = setup(home, '--rules', '--no-hook');
    expect(existsSync(join(home, 'CLAUDE.md'))).toBe(false);
    expect(out).toContain('is your home folder, a folder above it or the filesystem root, which is never a project');
  });

  it('doctor names the files the rule and the hook are in, a project\'s own settings included', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { debugai: { command: 'npx', args: ['-y', '@debugai/mcp@latest'] } } }));
    writeFileSync(join(project, 'CLAUDE.md'), `${DEBUGAI_RULE}\n`);
    mkdirSync(join(project, '.claude'));
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUseFailure: [HOOK_GROUP] } }));
    const out = cli(project, 'doctor');
    expect(out).toContain('✓ Rule — in CLAUDE.md');
    expect(out).toContain(`✓ Claude Code hook — in ${join(project, '.claude', 'settings.json')}`);
  });
});
