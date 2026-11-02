/**
 * `cwd` on debug_error: the folder the failing command ran in.
 *
 * About twenty answers in the 2026-10-30 audit export went wrong because the
 * command ran somewhere other than the project root and nobody said where. This
 * pins the three places the answer is used (which relative path a trace means,
 * which manifests the facts are read from, what the engine is told) and the one
 * thing that must not move: the folder has to be inside the project the caller
 * already named, because that is the boundary every read here is held to.
 *
 * Real folders throughout. The bugs that matter (a symlink out, a sibling that
 * shares a prefix, a name that merely starts with two dots) live in the real
 * filesystem and a mock would never have them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { __resetClientUpdate } from '../src/clientUpdate.js';
import { MAX_CWD_CHARS, commandCwd, sendableFolder } from '../src/commandCwd.js';
import { __resetExplicitProjectCache } from '../src/explicitProject.js';
import { __resetWorkspaceFactsCache, factsScope, gatherWorkspaceFacts } from '../src/gatherWorkspaceFacts.js';
import { createServer } from '../src/server.js';
import { resolveSourceContext } from '../src/sourceContext.js';

const made: string[] = [];
const put = (base: string, rel: string, body: string): string => {
  const full = join(base, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
  return full;
};

/** A repository with two components, as the failing answers had: a Python backend and a JS frontend. */
function monorepo(): string {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'debugai-cwd-')));
  made.push(top);
  put(top, 'utils.py', 'ROOT_UTILS = 1\n');
  put(top, 'main.py', 'ROOT_MAIN = 1\n');
  put(top, 'package.json', JSON.stringify({ dependencies: { 'root-dep': '1.0.0' } }));
  put(top, 'backend/utils.py', 'BACKEND_UTILS = 1\nraise RuntimeError("x")\n');
  put(top, 'backend/requirements.txt', 'flask==3.0.0\n');
  put(top, 'backend/app/run.py', 'import utils\n');
  put(top, 'frontend/package.json', JSON.stringify({ dependencies: { react: '^18.2.0' } }));
  put(top, 'frontend/src/App.tsx', 'export const A = 1;\n');
  put(top, 'cmd/main.go', 'package main\nfunc main() { missing() }\n');
  mkdirSync(join(top, 'tools'), { recursive: true });
  return top;
}

beforeEach(() => {
  __resetWorkspaceFactsCache();
  __resetExplicitProjectCache();
  __resetClientUpdate();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const d of made.splice(0)) { rmSync(d, { recursive: true, force: true }); }
});

describe('which folders a cwd is believed for', () => {
  it('says nothing when none is given', () => {
    const top = monorepo();
    for (const raw of [undefined, '', '   ']) { expect(commandCwd(raw, top)).toEqual({ kind: 'none' }); }
  });

  it('a folder inside the project, relative or absolute, is used and named relative to the root', () => {
    const top = monorepo();
    expect(commandCwd('backend', top)).toEqual({ kind: 'used', cwd: { dir: join(top, 'backend'), rel: 'backend' } });
    expect(commandCwd('./backend/app/', top)).toEqual({ kind: 'used', cwd: { dir: join(top, 'backend', 'app'), rel: 'backend/app' } });
    expect(commandCwd(join(top, 'frontend', 'src'), top)).toEqual({ kind: 'used', cwd: { dir: join(top, 'frontend', 'src'), rel: 'frontend/src' } });
  });

  it('the root itself is nothing to say', () => {
    const top = monorepo();
    for (const raw of ['.', './', top, `${top}/backend/..`]) { expect(commandCwd(raw, top), raw).toEqual({ kind: 'none' }); }
  });

  it('a folder outside the project is ignored, however it is spelled', () => {
    const top = monorepo();
    const sibling = `${top}-other`;
    mkdirSync(sibling);
    made.push(sibling);
    for (const raw of ['..', '../', 'backend/../..', tmpdir(), sibling, `../${basename(sibling)}`, '/']) {
      const got = commandCwd(raw, top);
      expect(got, raw).toEqual({ kind: 'ignored', note: 'cwd ignored: it is outside the project root' });
    }
  });

  it('a folder that merely starts with two dots is inside, not above', () => {
    const top = monorepo();
    mkdirSync(join(top, '..odd'));
    expect(commandCwd('..odd', top)).toEqual({ kind: 'used', cwd: { dir: join(top, '..odd'), rel: '..odd' } });
  });

  it('a link inside the project that leads out of it names nothing; one that leads back in is the folder it reaches', () => {
    const top = monorepo();
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'debugai-out-')));
    made.push(out);
    symlinkSync(out, join(top, 'escape'));
    symlinkSync(join(top, 'backend'), join(top, 'shortcut'));
    expect(commandCwd('escape', top)).toMatchObject({ kind: 'ignored' });
    expect(commandCwd('shortcut', top)).toEqual({ kind: 'used', cwd: { dir: join(top, 'backend'), rel: 'backend' } });
  });

  it('a file, a folder that is not there, a NUL and an enormous path are each ignored with a line saying why', () => {
    const top = monorepo();
    expect(commandCwd('utils.py', top)).toEqual({ kind: 'ignored', note: 'cwd ignored: it is not a folder' });
    expect(commandCwd('nowhere', top)).toEqual({ kind: 'ignored', note: 'cwd ignored: it is not a folder that exists' });
    expect(commandCwd('back\0end', top)).toEqual({ kind: 'ignored', note: 'cwd ignored: it is not a folder path' });
    expect(commandCwd('a'.repeat(MAX_CWD_CHARS + 1), top)).toEqual({ kind: 'ignored', note: 'cwd ignored: it is not a folder path' });
  });

  it('a folder nested too deep to name is ignored', () => {
    const top = monorepo();
    const deep = ['d'.repeat(60), 'd'.repeat(60), 'd'.repeat(60), 'd'.repeat(30)].join('/');
    mkdirSync(join(top, deep), { recursive: true });
    expect(commandCwd(deep, top)).toEqual({ kind: 'ignored', note: 'cwd ignored: it is nested too deep to name' });
    expect(commandCwd(deep.split('/').slice(0, 3).join('/'), top)).toMatchObject({ kind: 'used' });
  });

  it('with no project root there is nowhere to place it', () => {
    expect(commandCwd('backend', null)).toEqual({ kind: 'ignored', note: 'cwd ignored: there is no project root to place it in' });
    expect(commandCwd('backend', undefined)).toMatchObject({ kind: 'ignored' });
  });

  it('a root too wide to be a boundary is not made one by a cwd', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'debugai-home-')));
    made.push(home);
    mkdirSync(join(home, 'proj', 'src'), { recursive: true });
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      expect(commandCwd('proj', home)).toEqual({
        kind: 'ignored', note: 'cwd ignored: the project root is your home folder, a folder above it or the filesystem root',
      });
      expect(commandCwd('src', join(home, 'proj'))).toMatchObject({ kind: 'used' });
      expect(homedir()).toBe(home);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) { delete process.env[k]; } else { process.env[k] = v; } }
    }
  });
});

describe('a relative path in the trace means the folder the command ran in', () => {
  const pyTrace = 'Traceback (most recent call last):\n  File "utils.py", line 1, in <module>\nRuntimeError: x';

  it('utils.py from backend/ is backend/utils.py, not the utils.py at the root', () => {
    const top = monorepo();
    const got = resolveSourceContext({ errorText: pyTrace, root: top, cwd: join(top, 'backend') });
    expect(got?.files.map((f) => f.label)).toEqual(['backend/utils.py']);
    expect(got?.snippet).toContain('BACKEND_UTILS');
    expect(got?.snippet).not.toContain('ROOT_UTILS');
  });

  it('with no cwd it is the root, as it always was', () => {
    const top = monorepo();
    const got = resolveSourceContext({ errorText: pyTrace, root: top });
    expect(got?.files.map((f) => f.label)).toEqual(['utils.py']);
    expect(got?.snippet).toContain('ROOT_UTILS');
  });

  it('a path that is not under the cwd is still found from the root', () => {
    const top = monorepo();
    const got = resolveSourceContext({ errorText: 'File "main.py", line 1, in <module>', root: top, cwd: join(top, 'backend') });
    expect(got?.files.map((f) => f.label)).toEqual(['main.py']);
  });

  it('a path with .. in it, printed from a subfolder, is the project file it names', () => {
    const top = monorepo();
    const goTrace = '../cmd/main.go:2:17: undefined: missing';
    expect(resolveSourceContext({ errorText: goTrace, root: top, cwd: join(top, 'tools') })?.files.map((f) => f.label)).toEqual(['cmd/main.go']);
  });

  it('a relative path that climbs out of the project from the cwd is still refused', () => {
    const top = monorepo();
    const sibling = `${top}-outside`;
    put(sibling, 'x.py', 'OUTSIDE_SECRET = 1\n');
    made.push(sibling);
    const trace = `File "../../${basename(sibling)}/x.py", line 1, in <module>`;
    expect(resolveSourceContext({ errorText: trace, root: top, cwd: join(top, 'backend') })).toBeNull();
  });
});

describe('a folder is named to the engine only as the engine will read it', () => {
  // The engine (workspace_evidence.py, _relative_folder) strips the ends and drops
  // a backslash, a drive, a control character, an empty, `.` or `..` segment, and
  // anything past 200 characters. A name it would change or drop must not be sent:
  // the footer would name one folder while the engine called the facts the root's.
  it('refuses every name the engine would change or drop, and nothing it takes as given', () => {
    const refused = ['a\\b', 'a\tb', 'a\nb', 'a\u007fb', 'a\u0090b', 'end\u0085', 'backend ', ' backend',
      'x'.repeat(201), 'a//b', 'a/./b', 'a/../b', '../a', '/etc', 'C:/x', '', '.'];
    for (const name of refused) { expect(sendableFolder(name), JSON.stringify(name)).toBe(false); }
    for (const name of ['backend', 'backend/app', 'my app/src', 'x'.repeat(200), 'ünïcode/ok', 'a.b/c-d_e']) {
      expect(sendableFolder(name), name).toBe(true);
    }
  });

  it.skipIf(process.platform === 'win32')('a cwd whose name has a backslash or a tab is ignored, and the answer says so', () => {
    const top = monorepo();
    for (const name of ['back\\slash', 'tab\tname']) {
      mkdirSync(join(top, name), { recursive: true });
      const verdict = commandCwd(name, top);
      expect(verdict, JSON.stringify(name)).toEqual({ kind: 'ignored', note: 'cwd ignored: its name has a character DebugAI cannot pass on' });
    }
  });

  it.skipIf(process.platform === 'win32')('a manifest folder with such a name is passed over for the folder above it', () => {
    const top = monorepo();
    put(top, 'svc\\odd/package.json', JSON.stringify({ dependencies: { 'odd-dep': '1.0.0' } }));
    mkdirSync(join(top, 'svc\\odd', 'src'), { recursive: true });
    expect(factsScope(top, join(top, 'svc\\odd', 'src'))).toBe(top);
  });
});

describe('the facts come from the nearest manifests between the folder and the root', () => {
  it('a command run in backend/app reads backend, and not the root that declares something else', () => {
    const top = monorepo();
    const facts = gatherWorkspaceFacts(top, { dir: join(top, 'backend', 'app'), rel: 'backend/app' });
    expect(facts?.manifests).toEqual(['requirements.txt']);
    expect(facts?.declared_deps).toEqual(['flask']);
    expect(facts?.command_cwd).toBe('backend/app');
    // And it says which folder they came from, so a venv or .env there is not called the root's.
    expect(facts?.facts_from).toBe('backend');
    // The module list is the one for where the command ran: `utils` is importable from backend.
    expect(facts?.local_modules).toContain('utils');
  });

  it('a command run in the frontend reads the frontend', () => {
    const top = monorepo();
    const facts = gatherWorkspaceFacts(top, { dir: join(top, 'frontend', 'src'), rel: 'frontend/src' });
    expect(facts?.declared_deps).toEqual(['react']);
    expect(facts?.declared_versions).toEqual({ react: '^18.2.0' });
  });

  it('with no cwd it is the root, with no command_cwd, as before', () => {
    const top = monorepo();
    const facts = gatherWorkspaceFacts(top);
    expect(facts?.declared_deps).toContain('root-dep');
    expect(facts).not.toHaveProperty('command_cwd');
    expect(facts).not.toHaveProperty('facts_from');
  });

  it('where nothing on the way up holds a manifest, it is the root', () => {
    const top = monorepo();
    const facts = gatherWorkspaceFacts(top, { dir: join(top, 'tools'), rel: 'tools' });
    expect(facts?.declared_deps).toContain('root-dep');
    expect(facts?.command_cwd).toBe('tools');
    // The root's facts carry no facts_from: the engine then says "at the project root", which is true.
    expect(facts).not.toHaveProperty('facts_from');
    expect(factsScope(top, join(top, 'tools'))).toBe(top);
  });

  it('the nearest manifest wins over one further up, and a .NET project file counts as a manifest', () => {
    const top = monorepo();
    put(top, 'frontend/web/package.json', JSON.stringify({ dependencies: { next: '15.0.0' } }));
    expect(gatherWorkspaceFacts(top, { dir: join(top, 'frontend', 'web'), rel: 'frontend/web' })?.declared_deps).toEqual(['next']);
    put(top, 'Api/Api.csproj', '<Project><ItemGroup><PackageReference Include="MediatR" Version="12.2.0" /></ItemGroup></Project>');
    mkdirSync(join(top, 'Api', 'Controllers'), { recursive: true });
    expect(factsScope(top, join(top, 'Api', 'Controllers'))).toBe(join(top, 'Api'));
    expect(gatherWorkspaceFacts(top, { dir: join(top, 'Api', 'Controllers'), rel: 'Api/Controllers' })?.declared_deps).toEqual(['MediatR']);
  });

  it('a manifest inside a vendored or hidden folder is not a project of its own', () => {
    const top = monorepo();
    put(top, 'frontend/node_modules/left-pad/package.json', JSON.stringify({ dependencies: { 'vendored-dep': '1.0.0' } }));
    put(top, 'frontend/.cache/pkg/package.json', JSON.stringify({ dependencies: { 'hidden-dep': '1.0.0' } }));
    expect(factsScope(top, join(top, 'frontend', 'node_modules', 'left-pad'))).toBe(join(top, 'frontend'));
    expect(factsScope(top, join(top, 'frontend', '.cache', 'pkg'))).toBe(join(top, 'frontend'));
  });

  it('a folder outside the root never moves the scope', () => {
    const top = monorepo();
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'debugai-out-')));
    made.push(out);
    put(out, 'package.json', JSON.stringify({ dependencies: { 'outside-dep': '1.0.0' } }));
    expect(factsScope(top, out)).toBe(top);
    expect(factsScope(top, join(top, 'does-not-exist'))).toBe(top);
  });

  it('a .env in the folder is noticed and never read', () => {
    const top = monorepo();
    put(top, 'backend/.env', 'STRIPE_SECRET_KEY=rk_live_DO_NOT_READ_THIS\n');
    const facts = gatherWorkspaceFacts(top, { dir: join(top, 'backend'), rel: 'backend' });
    expect(facts?.has_env_file).toBe(true);
    expect(JSON.stringify(facts)).not.toContain('DO_NOT_READ_THIS');
  });

  it('a second folder in the same run is not served the facts of the first', () => {
    const top = monorepo();
    expect(gatherWorkspaceFacts(top, { dir: join(top, 'backend'), rel: 'backend' })?.declared_deps).toEqual(['flask']);
    expect(gatherWorkspaceFacts(top, { dir: join(top, 'frontend'), rel: 'frontend' })?.declared_deps).toEqual(['react']);
    expect(gatherWorkspaceFacts(top)?.declared_deps).toContain('root-dep');
  });

  it('two commands in one scope are each told their own folder, and a later one with none is told none', () => {
    const top = monorepo();
    const a = gatherWorkspaceFacts(top, { dir: join(top, 'backend'), rel: 'backend' });
    const b = gatherWorkspaceFacts(top, { dir: join(top, 'backend', 'app'), rel: 'backend/app' });
    const c = gatherWorkspaceFacts(top, null);
    expect([a?.command_cwd, b?.command_cwd]).toEqual(['backend', 'backend/app']);
    // One scope, read once and cached: both are told it, and the cached copy is not mutated.
    expect([a?.facts_from, b?.facts_from]).toEqual(['backend', 'backend']);
    expect(a?.declared_deps).toEqual(b?.declared_deps);
    expect(c).not.toHaveProperty('command_cwd');
    expect(c).not.toHaveProperty('facts_from');
    expect(c?.declared_deps).toContain('root-dep');
  });
});

describe('debug_error takes a cwd, and says what it did with it', () => {
  async function connected() {
    const server = createServer({ apiKey: 'dbg_test_key', apiBase: 'https://api.example.test/api', version: '1.0.0-test' });
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    return client;
  }
  const textOf = (r: CallToolResult): string => (r.content[0].type === 'text' ? r.content[0].text : '');

  async function debug(args: Record<string, unknown>) {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ root_cause: 'x', fixes: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = await connected();
    const result = await client.callTool({ name: 'debug_error', arguments: args }) as CallToolResult;
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    return { result, body, text: textOf(result) };
  }
  const pyTrace = 'Traceback (most recent call last):\n  File "utils.py", line 1, in <module>\nRuntimeError: x';

  it('reads the file the command meant, gathers the facts it meant, and tells the engine where it ran', async () => {
    const top = monorepo();
    const { body, text, result } = await debug({ errorText: pyTrace, projectRoot: top, cwd: 'backend' });
    expect(body.code_snippet).toContain('BACKEND_UTILS');
    expect(body.code_snippet).not.toContain('ROOT_UTILS');
    expect(body.file_path).toBe('backend/utils.py');
    expect(body.workspace_facts.command_cwd).toBe('backend');
    expect(body.workspace_facts.declared_deps).toEqual(['flask']);
    expect(text).toContain('Command ran in: backend');
    expect(text).not.toContain('cwd ignored');
    expect(result.structuredContent).toMatchObject({ command_cwd: 'backend', local_files_read: ['backend/utils.py'] });
  });

  it('with no projectRoot named, the folder the server started in is the project the cwd is inside', async () => {
    const top = monorepo();
    vi.spyOn(process, 'cwd').mockReturnValue(top);
    const { body } = await debug({ errorText: pyTrace, cwd: join(top, 'backend') });
    expect(body.workspace_facts.command_cwd).toBe('backend');
    expect(body.code_snippet).toContain('BACKEND_UTILS');
  });

  it('a folder outside the project is ignored with one line, and the answer is the one it would have been', async () => {
    const top = monorepo();
    const { body, text, result } = await debug({ errorText: pyTrace, projectRoot: top, cwd: '..' });
    expect(body.workspace_facts).not.toHaveProperty('command_cwd');
    expect(body.code_snippet).toContain('ROOT_UTILS');
    expect(body.workspace_facts.declared_deps).toContain('root-dep');
    expect(text).toContain('cwd ignored: it is outside the project root');
    expect(text).not.toContain('Command ran in');
    expect(result.structuredContent).toMatchObject({ command_cwd: null });
  });

  it('with no cwd nothing about it is said or sent', async () => {
    const top = monorepo();
    const { body, text, result } = await debug({ errorText: pyTrace, projectRoot: top });
    expect(body.workspace_facts).not.toHaveProperty('command_cwd');
    expect(text).not.toMatch(/Command ran in|cwd ignored/);
    expect(result.structuredContent).toMatchObject({ command_cwd: null });
  });

  it('the project root as the cwd is nothing to say either', async () => {
    const top = monorepo();
    const { body, text } = await debug({ errorText: pyTrace, projectRoot: top, cwd: top });
    expect(body.workspace_facts).not.toHaveProperty('command_cwd');
    expect(text).not.toMatch(/Command ran in|cwd ignored/);
  });

  it('an agent\'s own snippet still wins, and the facts still follow the folder', async () => {
    const top = monorepo();
    const { body } = await debug({ errorText: pyTrace, projectRoot: top, cwd: 'backend', codeSnippet: 'mine = 1' });
    expect(body.code_snippet).toBe('mine = 1');
    expect(body.workspace_facts.command_cwd).toBe('backend');
  });

  it('the tool still describes itself briefly: cwd is one short field, and the tool text did not grow', async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'debug_error')!;
    const props = tool.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.cwd.description?.length).toBeGreaterThan(40);
    expect(props.cwd.description?.length).toBeLessThan(300);
    expect(tool.inputSchema.required).toEqual(['errorText']);
    expect(tool.description).not.toMatch(/\bcwd\b/);
  });
});
