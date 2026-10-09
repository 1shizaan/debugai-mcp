// The project an agent names, validated. See src/explicitProject.ts for the
// 2026-09-16 session that filed a whole build under the wrong repository.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { statSync } from 'node:fs';

const isDirectoryNow = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
import {
  __resetExplicitProjectCache,
  explicitProject,
  hashRoot,
  sameDirectory,
  samePath,
  tooBroad,
  tooBroadFor,
} from '../src/explicitProject.js';
import { gitToplevel, hashPath } from '../src/project.js';

let base: string;
let repo: string;

function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

beforeEach(() => {
  __resetExplicitProjectCache();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'debugai-explicit-')));
  repo = gitRepo(join(base, 'airgapai'));
  mkdirSync(join(repo, 'backend', 'app'), { recursive: true });
  writeFileSync(join(repo, 'backend', 'app', 'totp.py'), 'x = 1\n');
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('a named project root', () => {
  it('is used, at its git toplevel, when it is a directory', () => {
    const p = explicitProject({ projectRoot: join(repo, 'backend') });
    expect(p).not.toBeNull();
    expect(sameDirectory(p!.root, repo)).toBe(true);
    expect(p!.source).toBe('projectRoot');
  });

  it('gives the SAME id project.ts gives the same repository, so one repo is one memory', () => {
    const p = explicitProject({ projectRoot: repo });
    expect(p!.id).toBe(hashPath(gitToplevel(repo)!));
    expect(p!.id).toBe(hashRoot(p!.root));
  });

  it('is refused when relative, missing, or a file', () => {
    // A relative path that DOES resolve from here, so only the absoluteness
    // rule can be what refuses it: "relative to what" is the agent's cwd, which
    // is exactly the thing this module exists not to trust.
    const rel = relative(process.cwd(), repo);
    expect(isDirectoryNow(rel)).toBe(true);
    expect(explicitProject({ projectRoot: rel })).toBeNull();
    expect(explicitProject({ projectRoot: join(base, 'nope') })).toBeNull();
    expect(explicitProject({ projectRoot: join(repo, 'backend', 'app', 'totp.py') })).toBeNull();
  });

  it('is refused when it would make the whole disk or the home directory the boundary', () => {
    expect(tooBroad('/')).toBe(true);
    expect(tooBroad(homedir())).toBe(true);
    expect(explicitProject({ projectRoot: '/' })).toBeNull();
    // Home is refused whether or not it is itself a git repository.
    const p = explicitProject({ projectRoot: homedir() });
    expect(p === null || !sameDirectory(p.root, homedir())).toBe(true);
  });
});

describe('an absolute file path', () => {
  it('names the git repository it sits in', () => {
    const p = explicitProject({ filePath: join(repo, 'backend', 'app', 'totp.py') });
    expect(sameDirectory(p!.root, repo)).toBe(true);
    expect(p!.source).toBe('filePath');
  });

  it('names nothing outside a git repository, so a stray path cannot move the boundary', () => {
    const loose = join(base, 'scratch');
    mkdirSync(loose);
    writeFileSync(join(loose, 'probe.py'), 'x = 1\n');
    expect(explicitProject({ filePath: join(loose, 'probe.py') })).toBeNull();
  });

  it('names nothing when relative', () => {
    expect(explicitProject({ filePath: 'backend/app/totp.py' })).toBeNull();
  });

  it('is ignored where the server is told its project (the bundled one)', () => {
    expect(explicitProject({ filePath: join(repo, 'backend', 'app', 'totp.py') }, false)).toBeNull();
  });

  it('loses to a named root when both are given', () => {
    const other = gitRepo(join(base, 'other'));
    const p = explicitProject({ projectRoot: other, filePath: join(repo, 'backend', 'app', 'totp.py') });
    expect(sameDirectory(p!.root, other)).toBe(true);
    expect(p!.source).toBe('projectRoot');
  });
});

describe('never throws', () => {
  it('answers null for anything malformed', () => {
    expect(explicitProject({})).toBeNull();
    expect(explicitProject({ projectRoot: '', filePath: '' })).toBeNull();
    expect(explicitProject({ projectRoot: '\u0000bad' })).toBeNull();
  });
});


// ── One directory, two spellings (Windows) ───────────────────────────────────
//
// Run on Windows 2026-10-01 with real git and the built module. git printed
// `C:/Users/mohiu/.../My Repo`, VS Code hands down `c:\Users\mohiu\...\My Repo`,
// and realpathSync keeps the drive letter's case as given. sameDirectory
// answered false for the folder that was open, so the bundled server filed an
// agent's error under a second project id; and tooBroad answered false for the
// home directory spelled with a lower-case drive, so it was taken as a root.
describe('samePath', () => {
  const GIT = 'C:/Users/mohiu/AppData/Local/Temp/dbgai-a/My Repo';
  const VSCODE = 'c:\\Users\\mohiu\\AppData\\Local\\Temp\\dbgai-a\\My Repo';
  const REAL = 'C:\\Users\\mohiu\\AppData\\Local\\Temp\\dbgai-a\\My Repo';

  it('on Windows, the three spellings of one directory are one directory', () => {
    expect(samePath(GIT, VSCODE, true)).toBe(true);
    expect(samePath(REAL, VSCODE, true)).toBe(true);
    expect(samePath(REAL, GIT, true)).toBe(true);
    expect(samePath(REAL + '\\', VSCODE, true)).toBe(true);
  });

  it('on Windows, a different directory is still a different directory', () => {
    expect(samePath(REAL, REAL + ' 2', true)).toBe(false);
    expect(samePath(REAL, 'D' + REAL.slice(1), true)).toBe(false);
    expect(samePath('C:\\Users\\mohiu', 'C:\\Users', true)).toBe(false);
  });

  it('on Windows, a drive root is not the drive\'s first folder, and equals itself in either case', () => {
    expect(samePath('C:\\', 'c:\\', true)).toBe(true);
    expect(samePath('C:\\', 'C:\\Users', true)).toBe(false);
    expect(samePath('\\\\server\\share\\', '\\\\SERVER\\share', true)).toBe(true);
  });

  it('everywhere else a path is compared as it is: Foo and foo are two directories', () => {
    expect(samePath('/home/u/Foo', '/home/u/foo', false)).toBe(false);
    expect(samePath('/home/u/foo', '/home/u/foo', false)).toBe(true);
    expect(samePath('/home/u/a\\b', '/home/u/a/b', false)).toBe(false);
  });

  it('this platform is the default', () => {
    expect(samePath('/a/B', '/a/b')).toBe(process.platform === 'win32');
  });

  it('both checks that compare directories go through a case-folding comparison', () => {
    // Text, because the two spellings cannot be produced on this machine. Whether a directory is
    // the same one goes through samePath; whether it is too broad goes through tooBroadFor, which
    // folds drive-letter case itself and is pure so the editor can ask it with an injected home.
    const src = readFileSync(new URL('../src/explicitProject.ts', import.meta.url), 'utf8');
    expect(src).toContain('return tooBroadFor(real(root), real(homedir()));');
    expect(src).toContain('return samePath(real(a), real(b));');
    expect(src).not.toMatch(/real\([ab]\) === real\(/);
    expect(src).not.toMatch(/r === (parse|real)\(/);
  });
});

// "Too broad" is the filesystem root, home, and everything that CONTAINS home, plus
// the Windows profile as WSL shows it. It was the first two only, so a server started
// in /mnt/c/Users/<name> (where many WSL terminals begin) could read .ssh, .aws and
// AppData, and /home, /Users and C:\Users were accepted as project roots.
describe('tooBroadFor: pure strings, so the editor can ask the same question', () => {
  const HOME = '/home/me';

  it.each([
    '/', '', '/home', '/home/me', '/home/me/', 'C:\\', 'D:/',
    '/mnt/c', '/mnt/d', '/mnt/c/Users', '/mnt/c/Users/me', '/mnt/c/users/ME', '/MNT/C/USERS',
  ])('%s is too broad', (p) => {
    expect(tooBroadFor(p, HOME, false), p).toBe(true);
  });

  it.each([
    '/home/me/code', '/home/me/code/x', '/home/other', '/srv/app', '/workspaces/proj',
    '/mnt/c/Users/me/projects/app', '/mnt/c/code', '/mnt/wsl/stuff', '/tmp/x',
  ])('%s is a project', (p) => {
    expect(tooBroadFor(p, HOME, false), p).toBe(false);
  });

  it('every folder above a Windows home is too broad, in either slash and any drive-letter case', () => {
    const WHOME = 'C:\\Users\\me';
    for (const p of ['C:\\Users', 'c:/users', 'C:\\Users\\me', 'c:\\users\\me\\', 'C:\\']) {
      expect(tooBroadFor(p, WHOME, false), p).toBe(true);
    }
    for (const p of ['C:\\Users\\me\\code', 'c:/users/me/code/x', 'D:\\work', 'C:\\Users\\other']) {
      expect(tooBroadFor(p, WHOME, false), p).toBe(false);
    }
  });

  it('without a home it still refuses the roots and the WSL profile, and nothing else', () => {
    expect(tooBroadFor('/', '', false)).toBe(true);
    expect(tooBroadFor('/mnt/c/Users/me', '', false)).toBe(true);
    expect(tooBroadFor('/home', '', false)).toBe(false);
  });

  it('on Windows every path is compared without regard to case', () => {
    expect(tooBroadFor('\\\\SERVER\\Share\\Me', '\\\\server\\share\\me', true)).toBe(true);
  });

  it('tooBroad asks it with the real home directory and resolves symlinks first', () => {
    expect(tooBroad(homedir())).toBe(true);
    expect(tooBroad(parentOf(homedir()))).toBe(true);
    expect(tooBroad(join(base, 'airgapai'))).toBe(false);
  });
});

const parentOf = (p: string): string => join(p, '..');

describe('a named root inside a dotfiles checkout', () => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('is the folder named, not refused because the git toplevel is home', () => {
    // ~ is a repository (a dotfiles checkout) and the agent names ~/code/x. Its toplevel is ~,
    // which is refused, so it resolved to ~ and was refused: the reply's own advice (pass
    // projectRoot) could never work for this user.
    process.env.HOME = base;
    process.env.USERPROFILE = base;
    execFileSync('git', ['init', '-q'], { cwd: base });
    const proj = join(base, 'code', 'x');
    mkdirSync(proj, { recursive: true });
    const p = explicitProject({ projectRoot: proj });
    expect(p).not.toBeNull();
    expect(sameDirectory(p!.root, proj)).toBe(true);
    expect(p!.id).toBe(hashRoot(p!.root));
  });

  it('home itself, named, is still refused', () => {
    process.env.HOME = base;
    process.env.USERPROFILE = base;
    execFileSync('git', ['init', '-q'], { cwd: base });
    expect(explicitProject({ projectRoot: base })).toBeNull();
  });
});
