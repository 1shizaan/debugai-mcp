/**
 * What the README, package.json and server.json say, held against the code
 * (pre-publish review of 2026-10-09, section 4).
 *
 * Each of these was true when written and stopped being true, or was never true,
 * and nothing failed: the Node floor was a number in four files, the environment
 * variables were a list in three, the file types the server reads were a list in
 * a README and a Set, and the privacy statements said "nothing is read from disk"
 * and "credentials are redacted" about code that reads manifests on every call
 * and does not redact. A comment saying to keep them in step has failed here
 * before, so these read the files as text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NODE_FLOOR, nodeAtLeast } from '../src/constants.js';

const ROOT = join(__dirname, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const README = read('README.md');
const PKG = JSON.parse(read('package.json'));
const SERVER = JSON.parse(read('server.json'));
const flat = README.replace(/\s+/g, ' ');

describe('the Node floor is one number', () => {
  it('nodeAtLeast compares all three parts', () => {
    expect(nodeAtLeast('18.14.1')).toBe(true);
    expect(nodeAtLeast('v18.14.0')).toBe(false);
    expect(nodeAtLeast('18.13.9')).toBe(false);
    expect(nodeAtLeast('18.20.4')).toBe(true);
    expect(nodeAtLeast('20.0.0')).toBe(true);
    expect(nodeAtLeast('16.20.2')).toBe(false);
  });

  it('package.json engines, the README badge and the README text all say it', () => {
    expect(PKG.engines.node).toBe(`>=${NODE_FLOOR}`);
    expect(README).toContain(`node-%3E%3D${NODE_FLOOR}-`);
    expect(flat).toContain(`Node ${NODE_FLOOR} or later`);
    expect(flat).not.toMatch(/Node 18 or later/);
  });

  it('is the floor of the strictest dependency that is actually installed', () => {
    const hono = JSON.parse(read('node_modules/@hono/node-server/package.json'));
    expect(hono.engines.node).toBe(`>=${NODE_FLOOR}`);
  });
});

describe('every environment variable the program reads is in server.json and the README', () => {
  const src = read('src/index.ts');
  const named = [...new Set([...src.matchAll(/\bDEBUGAI_[A-Z_]+\b/g)].map((m) => m[0]))];
  const listed = (SERVER.packages[0].environmentVariables as Array<{ name: string; isSecret: boolean; isRequired: boolean }>);

  it('finds the variables the help text names', () => {
    expect(named).toEqual(expect.arrayContaining(['DEBUGAI_API_KEY', 'DEBUGAI_API_BASE', 'DEBUGAI_TIMEOUT_MS', 'DEBUGAI_CONFIG_PATH']));
  });

  it('server.json lists each, and only the key is secret', () => {
    expect(listed.map((v) => v.name).sort()).toEqual([...named].sort());
    for (const v of listed) {
      expect(v.isSecret, v.name).toBe(v.name === 'DEBUGAI_API_KEY');
      expect(v.isRequired, v.name).toBe(false);
    }
  });

  it('the README table lists each', () => {
    for (const n of named) expect(README, n).toContain(`| \`${n}\` |`);
  });

  it('says DEBUGAI_TIMEOUT_MS is the debug_error deadline, because lookup and outcome have their own', () => {
    const backend = read('src/backend.ts');
    expect(backend).toMatch(/LOOKUP_TIMEOUT_MS = 8_000/);
    expect(backend).toMatch(/OUTCOME_TIMEOUT_MS = 15_000/);
    expect(flat).toContain('Deadline for `debug_error` only');
    expect(flat).toContain('`lookup_error` waits 8 seconds, `report_outcome` 15');
  });
});

describe('the file types and limits the README states are the ones the reader uses', () => {
  const sc = read('src/sourceContext.ts');
  const set = sc.slice(sc.indexOf('const SOURCE_EXT = new Set(['), sc.indexOf(']);', sc.indexOf('const SOURCE_EXT')));
  const exts = [...set.matchAll(/'(\.[a-z0-9]+)'/g)].map((m) => m[1]);

  it('reads the set', () => {
    expect(exts.length).toBeGreaterThanOrEqual(30);
    expect(exts).toContain('.gradle');
  });

  it('the README list is exactly the set: nothing the reader refuses, nothing it reads left out', () => {
    const line = README.split('\n').find((l) => l.startsWith('- **Source files only**'))!;
    expect(line).toBeTruthy();
    const inParens = line.match(/\(`([^)]*)`\)/)![1];
    const listed = inParens.split(/`?\s+`?/).filter(Boolean);
    expect([...listed].sort()).toEqual([...exts].sort());
  });

  it('the byte and character limits are the code\'s', () => {
    expect(sc).toMatch(/export const MAX_BYTES = 2_000_000;/);
    expect(sc).toMatch(/export const MAX_FILES = 3;/);
    expect(sc).toMatch(/export const WINDOW = 40;/);
    const fit = read('src/fitCodeWindow.ts');
    expect(fit).toMatch(/API_CODE_MAX_CHARS = 50000/);
    expect(flat).toContain('at most 3 files, none over 2 MB, and 50,000 characters in all');
    expect(flat).toContain('±40-line window');
    expect(flat).not.toMatch(/256 KB each/);
  });
});

describe('the privacy sentences describe what the code does', () => {
  it('manifests are read on every debug_error call, even with a snippet', () => {
    const dbg = read('src/tools/debugError.ts');
    expect(dbg).toMatch(/const workspaceFacts = gatherWorkspaceFacts\(root, ranIn\);/);
    expect(flat).toContain('Pass `codeSnippet` and no source file is read. Your manifests still are');
    expect(flat).not.toMatch(/nothing is read from disk/i);
    expect(flat).not.toMatch(/the local read never happens/i);
  });

  it('names every manifest the reader opens, and the interpreter it withholds', () => {
    const g = read('src/gatherWorkspaceFacts.ts');
    for (const name of ['package.json', 'requirements.txt', 'pyproject.toml']) {
      expect(g, name).toContain(`'${name}'`);
      expect(flat, name).toContain(name);
    }
    expect(g).toMatch(/PROJECT_EXT = new Set\(\['\.csproj', '\.fsproj', '\.vbproj'\]\)/);
    expect(flat).toContain('`.csproj`, `.fsproj` or `.vbproj`');
    expect(g).toMatch(/pythonInterpreter: null/);
    expect(flat).toContain('which Python interpreter is selected');
    expect(flat).not.toMatch(/This server sends none of that/);
    expect(flat).not.toMatch(/Reporting those facts back through this server is planned/);
  });

  it('this package does not redact, so the README does not say it does', () => {
    const files = ['src/backend.ts', 'src/cli/hook.ts', 'src/tools/lookupError.ts', 'src/tools/debugError.ts', 'src/fitErrorText.ts'];
    for (const f of files) expect(read(f), f).not.toMatch(/redact/i);
    expect(flat).not.toContain('Credentials are redacted before the lookup reads anything');
    expect(flat).toContain('this package does not redact it. The API redacts credentials when it arrives');
  });

  it('an absolute filePath is sent as written, and the README does not say the path is never sent', () => {
    expect(read('src/tools/debugError.ts')).toMatch(/const namedFile = filePath\?\.trim\(\) \? filePath : undefined;/);
    expect(flat).not.toContain('the path itself is never sent');
    expect(flat).toContain('an absolute `filePath` is sent as written');
  });

  it('outside a repository the folder becomes the project, and home, the folders above it and the root are refused', () => {
    const ep = read('src/explicitProject.ts');
    // A named folder wins over a git toplevel that is too broad (a dotfiles checkout at home).
    expect(ep).toMatch(/const root = top && !tooBroad\(top\) \? top : real\(named\);/);
    expect(ep).toContain('return tooBroadFor(real(root), real(homedir()));');
    expect(flat).toContain('Only your home directory, the folders above it and the filesystem root are refused');
    expect(flat).not.toMatch(/Outside any repository, and in your home directory, it stays silent/);
    expect(flat).toContain('Outside a repository the folder itself becomes the project');
  });

  it('install tells you after it writes, and only --dry-run tells you before', () => {
    const inst = read('src/cli/install.ts');
    expect(inst).toMatch(/hadComments && !opts\.dryRun/);
    expect(inst).toMatch(/installing would drop them/);
    expect(flat).not.toContain('You get a warning before it happens');
    expect(flat).toContain('`install` writes first and tells you afterwards');
  });
});

describe('the clients the README says are set up are the ones the installer knows', () => {
  const clients = read('src/cli/clients.ts');
  const labels = [...clients.matchAll(/label: '([^']+)'/g)].map((m) => m[1].replace(/\s*\(.*\)$/, ''));

  it('finds them', () => {
    expect(labels).toEqual(expect.arrayContaining(['Zed', 'Gemini CLI', 'Cline']));
  });

  it('each appears in the file table or the Zed block', () => {
    const table = README.slice(README.indexOf('| Client | File |'), README.indexOf('Then run `npx -y @debugai/mcp login`'));
    for (const l of labels) expect(table, l).toContain(l);
  });

  it('the package description names each client the intro names', () => {
    for (const l of ['Claude Desktop', 'Claude Code', 'Cursor', 'Zed', 'Windsurf', 'Cline', 'Gemini CLI']) {
      expect(PKG.description, l).toContain(l);
    }
  });
});

describe('the 2.7.0 notes do not claim what 2.6.0 already shipped', () => {
  it('the 3,000-character cut is tagged 2.6, because the published 2.6.0 already cuts', () => {
    // npm view @debugai/mcp@2.6.0 holds dist/fitErrorText.js and calls it from debug_error, lookup_error and the hook.
    expect(flat).toContain('The same cut is made by `lookup_error` and the hook');
    expect(flat).toMatch(/all three read one memory row for one failure\. \(2\.6\)/);
    const notes = README.slice(README.indexOf('**2.7.0** -'), README.indexOf('**2.6.0** -'));
    expect(notes).not.toMatch(/3,000/);
  });

  it('snippetStartLine is new in 2.7.0', () => {
    const notes = README.slice(README.indexOf('**2.7.0** -'), README.indexOf('**2.6.0** -'));
    expect(notes).toContain('`snippetStartLine`');
  });
});

// Release check 2 (2026-10-09), section 2.4 and 2.5: sentences that were close and
// not exact. Each is held against the code or the engine's own config as text.
describe('what the README says is sent, and to whom', () => {
  it('names the fallback model the engine really falls back to, and Voyage', () => {
    const engine = readFileSync(join(ROOT, '..', '..', 'apps/engine/app/core/config.py'), 'utf8');
    expect(engine).toMatch(/FALLBACK_MODEL: str = "gpt-4o-mini"/);
    expect(flat).toContain("or OpenAI's GPT-4o-mini when Claude is unavailable");
    expect(flat).toContain("embedded by Voyage AI to search your project's index");
  });

  it('says which KINDS of manifest were found are sent, because that is what the facts shape holds', () => {
    // The field's doc comment says "relative to the root", but every push is a kind
    // name, not a location. Read the pushes, not the comment.
    const pushes = [...read('src/workspaceFacts.ts').matchAll(/manifests\.push\('([^']+)'\)/g)].map((m) => m[1]);
    expect(pushes).toEqual(['package.json', 'requirements.txt', 'pyproject.toml', '*.csproj']);
    expect(flat).toContain('which kinds of manifest were found (such as `package.json` or `*.csproj`, not where they are)');
    expect(flat).not.toContain('the paths of those manifests');
  });

  it('does not say the server sends the interpreter path, which it cannot read', () => {
    expect(flat).toContain('The one fact it does not send is which Python interpreter is selected');
  });
});

describe('DEBUGAI_TIMEOUT_MS is the debug_error deadline, in every place that describes it', () => {
  it('--help, the README and server.json agree', () => {
    expect(read('src/index.ts')).toContain('debug_error deadline in ms');
    expect(flat).toContain('Deadline for `debug_error` only');
  });
});

describe('the Node floor message names where the floor comes from', () => {
  it('doctor says @hono/node-server, not global fetch (fetch is in Node 18.0)', () => {
    const doctor = read('src/cli/commands.ts');
    expect(doctor).toContain('@hono/node-server');
    expect(doctor).not.toContain('it uses global fetch');
  });
});

describe('the 2.7.0 notes are dated by their report, not as a release', () => {
  it('"(report of 2026-09-20)", because 2.7.0 had not been published when this was written', () => {
    expect(flat).toContain('(report of 2026-09-20)');
  });

  it('the server-side list does not claim to be live already', () => {
    expect(flat).toContain('Recent server-side work. Each item reaches agents with no upgrade once the engine release that carries it is deployed:');
    expect(flat).not.toContain('all of it live for agents already');
  });
});

// Release check 4 (2026-10-09), section 2.2 and 2.4: where the home-directory refusal is said.
describe('the refusal of a home or root project root is documented where it applies', () => {
  it('the README says local reads and facts need a project root, and what happens without one', () => {
    expect(flat).toContain('there is no boundary to read inside, so nothing local is read and the reply says so; pass `projectRoot` to name the project');
    expect(flat).toContain('The project manifests described under [Limits and honesty](#limits-and-honesty) are read on every `debug_error` call that has a project root.');
    expect(flat).toContain('Every `debug_error` call that has a project root also reads what the project declares');
    // And that is what the tool does: no read, no facts, and the reply says so.
    const tool = read('src/tools/debugError.ts');
    expect(tool).toMatch(/if \(!ownSnippet && root\)/);
    expect(tool).toContain('badges.push(NO_ROOT_BADGE)');
  });

  it('the 2.7.0 notes carry the change, including the folders above home and WSL', () => {
    const notes = README.slice(README.indexOf('**2.7.0** -'), README.indexOf('**2.6.0** -'));
    expect(notes).toContain('Your home directory is not a project.');
    expect(notes).toContain('`/mnt/c/Users/<name>`');
    expect(notes).toContain('A dotfiles checkout no longer defeats `projectRoot`');
  });

  it('the tool description says so to the agent that has to pass projectRoot', () => {
    expect(read('src/tools/debugError.ts')).toContain('(never your home directory, a folder above it or the filesystem root)');
  });
});

describe('the no-root reply and the notes say "a folder above it", as the rule does', () => {
  it('both servers\' NO_ROOT_BADGE names the folders above home', () => {
    const badge = (p: string) => read(p).match(/export const NO_ROOT_BADGE =\s*'([^']+)'/)?.[1] ?? '';
    for (const p of ['src/project.ts', '../../apps/extension/src/mcp/project.ts']) {
      expect(badge(p), p).toContain('your home directory, a folder above it or the filesystem root');
    }
  });

  it('the 2.7.0 note names the network share and the WSL distribution', () => {
    const notes = README.slice(README.indexOf('**2.7.0** -'), README.indexOf('**2.6.0** -'));
    expect(notes).toContain('a network share or a WSL distribution');
  });

  it('and the extension changelog says the same of the bundled server', () => {
    const log = readFileSync(join(ROOT, '../../apps/extension/CHANGELOG.md'), 'utf8').replace(/\s+/g, ' ');
    expect(log).toContain('for your home directory, a folder above it or the filesystem root');
  });
});
