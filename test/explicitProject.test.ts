// The project an agent names, validated. See src/explicitProject.ts for the
// 2026-09-16 session that filed a whole build under the wrong repository.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { statSync } from 'node:fs';

const isDirectoryNow = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
import {
  __resetExplicitProjectCache,
  explicitProject,
  hashRoot,
  sameDirectory,
  tooBroad,
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
