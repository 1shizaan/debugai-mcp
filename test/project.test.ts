import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gitToplevel, hashPath, resolveProjectId, __resetProjectIdCache } from '../src/project.js';

// Real temp directories and a real `git init`, not mocks. The whole point of
// this module is what git actually reports on disk, and a mocked execFileSync
// would only test that the mock returns what the test told it to.

let root: string;

beforeEach(() => {
  __resetProjectIdCache();
  root = mkdtempSync(join(tmpdir(), 'debugai-proj-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('hashPath', () => {
  it('is md5 hex, matching the VS Code extension so one repo means one memory', () => {
    // apps/extension/src/extension.ts getProjectId():
    //   crypto.createHash('md5').update(folders[0].uri.fsPath).digest('hex')
    const p = '/home/dev/projects/app';
    expect(hashPath(p)).toBe(createHash('md5').update(p).digest('hex'));
  });

  it('produces a value the API gateway will accept', () => {
    // apps/api/src/routes/debug.ts rejects anything not /^[A-Za-z0-9_\-]{1,64}$/
    expect(hashPath('/any/path')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('is stable for the same path and different for another', () => {
    expect(hashPath('/a')).toBe(hashPath('/a'));
    expect(hashPath('/a')).not.toBe(hashPath('/b'));
  });
});

describe('gitToplevel', () => {
  it('returns null outside a git worktree instead of throwing', () => {
    expect(gitToplevel(root)).toBeNull();
  });

  it('returns the repo root from inside a repo', () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const found = gitToplevel(root);
    expect(found).not.toBeNull();
    // macOS resolves /var -> /private/var, so compare basenames rather than
    // asserting an exact string that is correct on Linux and wrong on a Mac.
    expect(found!.split('/').pop()).toBe(root.split('/').pop());
  });

  // This is the behaviour that makes an agent invoked from a subdirectory land
  // on the same memory as one invoked from the repo root.
  it('returns the same root from a nested subdirectory', () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const nested = join(root, 'src', 'deep', 'nested');
    mkdirSync(nested, { recursive: true });
    expect(gitToplevel(nested)).toBe(gitToplevel(root));
  });
});

describe('resolveProjectId', () => {
  it('falls back to hashing cwd when there is no repo', () => {
    expect(resolveProjectId(root)).toBe(hashPath(root));
  });

  it('hashes the repo root, so subdirectories share one project id', () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const nested = join(root, 'packages', 'thing');
    mkdirSync(nested, { recursive: true });

    const fromRoot = resolveProjectId(root);
    const fromNested = resolveProjectId(nested);

    expect(fromNested).toBe(fromRoot);
    // and it is the ROOT that was hashed, not the nested path
    expect(fromNested).not.toBe(hashPath(nested));
  });

  it('never throws on a path that does not exist', () => {
    expect(() => resolveProjectId(join(root, 'gone'))).not.toThrow();
  });
});
