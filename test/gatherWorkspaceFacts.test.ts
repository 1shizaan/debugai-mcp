/**
 * The gatherer, against a real directory tree.
 *
 * Real files rather than mocks: this module's whole job is reading a disk, and
 * a mocked `fs` would test the mock. The tree below is the shape of the
 * repository that produced the 2026-09-12 loop - a .NET solution beside a
 * Next.js app beside a React Native app - because that is the case the feature
 * exists for and the one a fixture would flatten.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gatherWorkspaceFacts, MANIFEST_FILES, MAX_CSPROJ, MAX_DIRS, __resetWorkspaceFactsCache } from '../src/gatherWorkspaceFacts.js';

let root: string;

// Each test gathers fresh: the cache is keyed by root and several tests build
// a new tree in the same test run.
beforeEach(() => { __resetWorkspaceFactsCache(); });
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dbgai-facts-'));
  outside = mkdtempSync(join(tmpdir(), 'dbgai-outside-'));

  // salman's actual stack, reduced
  mkdirSync(join(root, 'Catalog.Infrastructure'), { recursive: true });
  writeFileSync(join(root, 'Catalog.Infrastructure', 'Catalog.Infrastructure.csproj'), `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Elastic.Clients.Elasticsearch" Version="8.13.0" />
    <PackageReference Include="MediatR"><Version>12.2.0</Version></PackageReference>
    <PackageReference Include="Unpinned" />
    <PackageReference Include="FromProperty" Version="$(CommonVersion)" />
  </ItemGroup>
</Project>`);
  mkdirSync(join(root, 'Gateway.Api'), { recursive: true });
  writeFileSync(join(root, 'Gateway.Api', 'Gateway.Api.csproj'),
    `<Project><ItemGroup><PackageReference Version="2.3.0" Include="Yarp.ReverseProxy" /></ItemGroup></Project>`);

  mkdirSync(join(root, 'web'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    dependencies: { next: '15.0.0', react: '^18.2.0' },
    devDependencies: { typescript: '~5.4.0' },
  }));
  writeFileSync(join(root, 'requirements.txt'),
    'flask==3.0.0\nnumpy>=1.26\nrequests\n--extra-index-url https://user:tok@pypi.internal/simple\n');

  mkdirSync(join(root, 'infra', 'lambda'), { recursive: true });
  writeFileSync(join(root, 'infra', 'lambda', 'handler.py'), 'def h(): pass');
  writeFileSync(join(root, 'app.py'), 'x = 1');

  // must never be read, only noticed
  writeFileSync(join(root, '.env'), 'STRIPE_SECRET_KEY=rk_live_DO_NOT_READ_THIS\n');
  writeFileSync(join(root, '.env.local'), 'ALSO_SECRET=1\n');

  // must never be walked into
  mkdirSync(join(root, 'node_modules', 'evil'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'evil', 'evil.py'), 'x=1');
  writeFileSync(join(root, 'node_modules', 'evil', 'Evil.csproj'),
    `<Project><ItemGroup><PackageReference Include="SHOULD.NOT.APPEAR" Version="9.9.9"/></ItemGroup></Project>`);

  // Two symlinks out of the tree, because they are stopped by DIFFERENT things.
  // A link to a directory is never descended (Dirent.isDirectory() is false for
  // a symlink); a link to a FILE is collected and then stopped by the realpath
  // containment check. Only the second exercises that check, and a mutation
  // pass caught this test passing for the wrong reason with only the first.
  writeFileSync(join(outside, 'secrets.csproj'),
    `<Project><ItemGroup><PackageReference Include="OUTSIDE.ROOT" Version="1.0.0"/></ItemGroup></Project>`);
  writeFileSync(join(outside, 'stolen.json'), JSON.stringify({ dependencies: { 'OUTSIDE.FILE': '1.0.0' } }));
  try { symlinkSync(outside, join(root, 'escape'), 'dir'); } catch { /* windows CI */ }
  try { symlinkSync(join(outside, 'secrets.csproj'), join(root, 'linked.csproj'), 'file'); } catch { /* */ }
});

afterAll(() => {
  for (const d of [root, outside]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
});


describe('what it finds', () => {
  it('reads the .csproj versions that would have stopped the 2026-09-12 loop', () => {
    const f = gatherWorkspaceFacts(root)!;
    expect(f.declared_versions['Yarp.ReverseProxy']).toBe('2.3.0');
    expect(f.declared_versions['Elastic.Clients.Elasticsearch']).toBe('8.13.0');
  });

  it('reads a version written as a child element, not only as an attribute', () => {
    expect(gatherWorkspaceFacts(root)!.declared_versions['MediatR']).toBe('12.2.0');
  });

  it('does not mind attribute order', () => {
    // Gateway.Api.csproj spells Version before Include.
    expect(gatherWorkspaceFacts(root)!.declared_deps).toContain('Yarp.ReverseProxy');
  });

  it('reports an unpinned package as a name with no version, never as a guess', () => {
    const f = gatherWorkspaceFacts(root)!;
    expect(f.declared_deps).toContain('Unpinned');
    expect(f.declared_versions).not.toHaveProperty('Unpinned');
  });

  it('refuses an unexpanded MSBuild property as a version', () => {
    // `$(CommonVersion)` is a string we cannot resolve. Reporting it would be
    // reporting a variable name as if it were a fact.
    const f = gatherWorkspaceFacts(root)!;
    expect(f.declared_deps).toContain('FromProperty');
    expect(f.declared_versions).not.toHaveProperty('FromProperty');
  });

  it('keeps npm ranges and exact pins distinguishable', () => {
    const v = gatherWorkspaceFacts(root)!.declared_versions;
    expect(v['next']).toBe('15.0.0');       // exact: can settle "does this API exist"
    expect(v['react']).toBe('^18.2.0');     // a range: cannot
    expect(v['typescript']).toBe('~5.4.0');
  });

  it('keeps pip specifiers as written', () => {
    const v = gatherWorkspaceFacts(root)!.declared_versions;
    expect(v['flask']).toBe('==3.0.0');
    expect(v['numpy']).toBe('>=1.26');
    expect(v).not.toHaveProperty('requests');   // declared, unpinned
  });

  it('finds local python modules for the import-vs-package question', () => {
    const f = gatherWorkspaceFacts(root)!;
    expect(f.local_modules).toContain('app');
    expect(f.local_modules).toContain('handler');
  });

  it('names every manifest it actually read', () => {
    const m = gatherWorkspaceFacts(root)!.manifests;
    expect(m).toContain('package.json');
    expect(m).toContain('requirements.txt');
    expect(m).toContain('*.csproj');
  });
});


describe('what it refuses', () => {
  it('NEVER reads a .env, but does record that one exists', () => {
    const f = gatherWorkspaceFacts(root)!;
    expect(f.has_env_file).toBe(true);
    const serialised = JSON.stringify(f);
    expect(serialised).not.toContain('rk_live');
    expect(serialised).not.toContain('STRIPE_SECRET_KEY');
    expect(serialised).not.toContain('ALSO_SECRET');
  });

  it('never leaks a private index URL out of requirements.txt', () => {
    // `--extra-index-url https://user:tok@pypi.internal/simple` is a credential.
    const serialised = JSON.stringify(gatherWorkspaceFacts(root)!);
    expect(serialised).not.toContain('pypi.internal');
    expect(serialised).not.toContain('tok@');
  });

  it('does not walk into node_modules', () => {
    const f = gatherWorkspaceFacts(root)!;
    expect(f.declared_deps).not.toContain('SHOULD.NOT.APPEAR');
    expect(f.local_modules).not.toContain('evil');
  });

  it('does not follow a symlinked DIRECTORY out of the project root', () => {
    expect(gatherWorkspaceFacts(root)!.declared_deps).not.toContain('OUTSIDE.ROOT');
  });

  it('does not read through a symlinked FILE that resolves outside the root', () => {
    // This is the one that exercises the realpath containment check: a symlink
    // to a file is collected by the walk and stopped only by `insideRoot`.
    // `linked.csproj` sits inside the root and points at `outside/secrets.csproj`.
    const f = gatherWorkspaceFacts(root)!;
    expect(f.declared_deps, 'containment check did not stop a symlinked file')
      .not.toContain('OUTSIDE.ROOT');
  });

  it('the read allowlist is exactly three manifests and none of them is .env', () => {
    // Pinned as an exact list, not a "does not contain" check. The allowlist
    // used to be decorative - reads were driven by hard-coded names elsewhere,
    // so adding .env to it changed nothing and turned no test red.
    expect([...MANIFEST_FILES]).toEqual(['package.json', 'requirements.txt', 'pyproject.toml']);
  });

  it('sends no interpreter, because this process cannot know one', () => {
    expect(gatherWorkspaceFacts(root)!.python_interpreter).toBeNull();
  });
});


describe('it never throws, on any input', () => {
  it.each([null, undefined, '', '   ', '/nonexistent/path/that/is/not/there'])(
    'returns null for %p', (bad) => {
      expect(gatherWorkspaceFacts(bad as any)).toBeNull();
    });

  it('returns null when the root is a file rather than a directory', () => {
    expect(gatherWorkspaceFacts(join(root, 'package.json'))).toBeNull();
  });

  it('survives a directory it cannot read', () => {
    const d = mkdtempSync(join(tmpdir(), 'dbgai-perm-'));
    mkdirSync(join(d, 'locked'));
    try { rmSync(join(d, 'locked'), { recursive: true }); } catch { /* */ }
    expect(() => gatherWorkspaceFacts(d)).not.toThrow();
    rmSync(d, { recursive: true, force: true });
  });

  it('an empty directory yields facts, not a crash', () => {
    const d = mkdtempSync(join(tmpdir(), 'dbgai-empty-'));
    const f = gatherWorkspaceFacts(d);
    expect(f).not.toBeNull();
    expect(f!.declared_deps).toEqual([]);
    expect(f!.manifests).toEqual([]);
    rmSync(d, { recursive: true, force: true });
  });
});


describe('caps are honest about what they hid', () => {
  it('a solution with more project files than the cap says so', () => {
    const d = mkdtempSync(join(tmpdir(), 'dbgai-many-'));
    for (let i = 0; i < MAX_CSPROJ + 3; i++) {
      mkdirSync(join(d, `svc${i}`));
      writeFileSync(join(d, `svc${i}`, `svc${i}.csproj`),
        `<Project><ItemGroup><PackageReference Include="Pkg${i}" Version="1.0.0"/></ItemGroup></Project>`);
    }
    const f = gatherWorkspaceFacts(d)!;
    expect(f.incomplete, 'a truncated csproj list must mark declared_deps incomplete')
      .toContain('declared_deps');
    rmSync(d, { recursive: true, force: true });
  });
});


describe('a monorepo keeps its dependencies in subdirectories', () => {
  let mono: string;

  beforeAll(() => {
    mono = mkdtempSync(join(tmpdir(), 'dbgai-mono-'));
    // A .NET solution at the root, a Next app under web/, python under svc/.
    // This is salman's tree: his react-dom error was about web/package.json
    // while the root of the repository is a .sln.
    writeFileSync(join(mono, 'package.json'), JSON.stringify({ dependencies: { 'root-only': '1.0.0' } }));
    mkdirSync(join(mono, 'web'));
    writeFileSync(join(mono, 'web', 'package.json'), JSON.stringify({
      dependencies: { next: '15.0.0', 'react-dom': '18.3.1' },
    }));
    mkdirSync(join(mono, 'svc'));
    writeFileSync(join(mono, 'svc', 'requirements.txt'), 'fastapi==0.115.0\n');
  });

  afterAll(() => { try { rmSync(mono, { recursive: true, force: true }); } catch { /* */ } });

  it('finds a dependency declared only in a nested package.json', () => {
    const f = gatherWorkspaceFacts(mono)!;
    expect(f.declared_deps).toContain('react-dom');
    expect(f.declared_versions['react-dom']).toBe('18.3.1');
  });

  it('keeps the root manifest as well as the nested ones', () => {
    const f = gatherWorkspaceFacts(mono)!;
    expect(f.declared_deps).toContain('root-only');
    expect(f.declared_deps).toContain('next');
  });

  it('finds a nested requirements.txt', () => {
    const f = gatherWorkspaceFacts(mono)!;
    expect(f.declared_deps).toContain('fastapi');
    expect(f.declared_versions['fastapi']).toBe('==0.115.0');
  });

  it('a root package.json that is unparseable does not lose the nested ones', () => {
    const d = mkdtempSync(join(tmpdir(), 'dbgai-badroot-'));
    writeFileSync(join(d, 'package.json'), '{ this is not json');
    mkdirSync(join(d, 'app'));
    writeFileSync(join(d, 'app', 'package.json'), JSON.stringify({ dependencies: { survivor: '2.0.0' } }));
    const f = gatherWorkspaceFacts(d)!;
    expect(f.declared_versions['survivor']).toBe('2.0.0');
    rmSync(d, { recursive: true, force: true });
  });

  it('the root declaration wins when the same name appears twice', () => {
    const d = mkdtempSync(join(tmpdir(), 'dbgai-dupe-'));
    writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { shared: '1.0.0' } }));
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'sub', 'package.json'), JSON.stringify({ dependencies: { shared: '9.9.9' } }));
    expect(gatherWorkspaceFacts(d)!.declared_versions['shared']).toBe('1.0.0');
    rmSync(d, { recursive: true, force: true });
  });

  it('still never descends into node_modules for a nested manifest', () => {
    const d = mkdtempSync(join(tmpdir(), 'dbgai-nm-'));
    mkdirSync(join(d, 'node_modules', 'lib'), { recursive: true });
    writeFileSync(join(d, 'node_modules', 'lib', 'package.json'),
      JSON.stringify({ dependencies: { 'SHOULD.NOT.APPEAR': '1.0.0' } }));
    const f = gatherWorkspaceFacts(d)!;
    expect(f.declared_deps).not.toContain('SHOULD.NOT.APPEAR');
    rmSync(d, { recursive: true, force: true });
  });
});


describe('the cache', () => {
  it('serves the same facts for the same root without walking again', () => {
    __resetWorkspaceFactsCache();
    const first = gatherWorkspaceFacts(root);
    const second = gatherWorkspaceFacts(root);
    expect(second).toBe(first);   // identity, so it cannot have re-walked
  });

  it('does not serve one project\'s manifests for another', () => {
    __resetWorkspaceFactsCache();
    const a = gatherWorkspaceFacts(root)!;
    const d = mkdtempSync(join(tmpdir(), 'dbgai-other-'));
    writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { 'only-in-b': '1.0.0' } }));
    const b = gatherWorkspaceFacts(d)!;
    expect(b.declared_deps).toContain('only-in-b');
    expect(b.declared_deps).not.toEqual(a.declared_deps);
    rmSync(d, { recursive: true, force: true });
  });

  it('does not cache a root that does not exist yet', () => {
    __resetWorkspaceFactsCache();
    const d = join(tmpdir(), 'dbgai-appears-' + Date.now());
    expect(gatherWorkspaceFacts(d)).toBeNull();
    mkdirSync(d);
    writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { later: '1.0.0' } }));
    expect(gatherWorkspaceFacts(d)!.declared_deps).toContain('later');
    rmSync(d, { recursive: true, force: true });
  });
});


// ── A short list says it is short (X41, 2026-10-01) ──────────────────────────
//
// Every case below returned a list that called itself complete, and the real
// engine fast path then answered `No module named 'fastapi'` with "`fastapi` is
// not declared in requirements.txt and is not a file in this project" and
// `pip freeze | grep -i fastapi >> requirements.txt` - about a package the
// project declares, or a module that is one of its own files. The only cap that
// was ever reported was the .csproj one, and only beside project files that had
// been read, so a repository with none had no way to say any of this.
describe('whatever the walk did not see marks the lists short', () => {
  const tree = (name: string) => mkdtempSync(join(tmpdir(), `dbgai-${name}-`));
  const put = (root: string, rel: string, body: string | Buffer) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  };

  it('more nested manifests than the cap, with no .csproj anywhere', () => {
    const d = tree('nested');
    put(d, 'requirements.txt', 'pytest==8.0.0\n');
    for (let i = 0; i < 9; i++) put(d, `svc${i}/requirements.txt`, `lib${i}==1.0\n`);
    put(d, 'deep/inner/requirements.txt', 'fastapi==0.115.0\n');
    const f = gatherWorkspaceFacts(d)!;
    expect(f.declared_deps).not.toContain('fastapi');           // it really was not read
    expect(f.incomplete).toContain('declared_deps');            // and the list says so
    rmSync(d, { recursive: true, force: true });
  });

  it('a module below the depth the walk goes to', () => {
    const d = tree('depth');
    put(d, 'requirements.txt', 'pytest==8.0.0\n');
    put(d, 'a/b/c/d/e/f/g/helper_mod.py', 'x = 1\n');
    put(d, 'main.py', 'import helper_mod\n');
    const f = gatherWorkspaceFacts(d)!;
    expect(f.local_modules).toEqual(['main']);
    expect(f.incomplete).toEqual(['declared_deps', 'local_modules']);
    rmSync(d, { recursive: true, force: true });
  });

  it('more directories than the walk visits', () => {
    const d = tree('wide');
    put(d, 'requirements.txt', 'pytest==8.0.0\n');
    for (let i = 0; i < MAX_DIRS + 5; i++) mkdirSync(join(d, `pkg${i}`));
    const f = gatherWorkspaceFacts(d)!;
    expect(f.incomplete).toEqual(['declared_deps', 'local_modules']);
    rmSync(d, { recursive: true, force: true });
  });

  it('a tree that fits inside every bound is complete', () => {
    // The other half: none of the marks above may fire on an ordinary project.
    const d = tree('fits');
    put(d, 'requirements.txt', 'pytest==8.0.0\n');
    put(d, 'a/b/c/d/e/f/deep_enough.py', 'x = 1\n');
    put(d, 'svc/requirements.txt', 'fastapi==0.115.0\n');
    const f = gatherWorkspaceFacts(d)!;
    expect(f.local_modules).toContain('deep_enough');
    expect(f.declared_deps).toContain('fastapi');
    expect(f.incomplete).toEqual([]);
    rmSync(d, { recursive: true, force: true });
  });

  it('a nested manifest that is there and too big to read', () => {
    const d = tree('big');
    put(d, 'requirements.txt', 'pytest==8.0.0\n');
    put(d, 'svc/requirements.txt', 'fastapi==0.115.0\n' + '# pad\n'.repeat(100_000));
    const f = gatherWorkspaceFacts(d)!;
    expect(f.declared_deps).toEqual(['pytest']);
    expect(f.incomplete).toContain('declared_deps');
    rmSync(d, { recursive: true, force: true });
  });

  it('a ROOT manifest that is there and too big to read, beside a nested one that was', () => {
    const d = tree('bigroot');
    put(d, 'requirements.txt', 'flask==3.0.0\n' + '# pad\n'.repeat(100_000));
    put(d, 'svc/requirements.txt', 'fastapi==0.115.0\n');
    const f = gatherWorkspaceFacts(d)!;
    expect(f.declared_deps).toEqual(['fastapi']);
    expect(f.incomplete).toContain('declared_deps');
    rmSync(d, { recursive: true, force: true });
  });

  it('a project file that is there and too big to read', () => {
    const d = tree('bigproj');
    put(d, 'A/A.csproj', '<Project><ItemGroup><PackageReference Include="Seen" Version="1.0.0"/></ItemGroup></Project>');
    put(d, 'B/B.csproj', '<Project>' + '<!-- pad -->'.repeat(60_000) + '</Project>');
    const f = gatherWorkspaceFacts(d)!;
    expect(f.declared_deps).toEqual(['Seen']);
    expect(f.incomplete).toContain('declared_deps');
    rmSync(d, { recursive: true, force: true });
  });

  it('a package.json that does not parse, at the root or below it', () => {
    for (const where of ['package.json', 'app/package.json']) {
      for (const broken of ['{ "dependencies": { "express": "4.19.2", } }', 'null', '"a string"']) {
        const d = tree('badjson');
        put(d, where, broken);
        put(d, 'other/package.json', JSON.stringify({ dependencies: { survivor: '2.0.0' } }));
        const f = gatherWorkspaceFacts(d)!;
        expect(f.declared_deps, `${where} ${broken}`).toEqual(['survivor']);
        expect(f.incomplete, `${where} ${broken}`).toContain('declared_deps');
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it('a directory it could not list', () => {
    if (process.getuid?.() === 0) return;      // root reads everything
    const d = tree('locked');
    put(d, 'requirements.txt', 'pytest==8.0.0\n');
    put(d, 'private/requirements.txt', 'fastapi==0.115.0\n');
    chmodSync(join(d, 'private'), 0o000);
    try {
      const f = gatherWorkspaceFacts(d)!;
      expect(f.declared_deps).toEqual(['pytest']);
      expect(f.incomplete).toEqual(['declared_deps', 'local_modules']);
    } finally {
      chmodSync(join(d, 'private'), 0o755);
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('a manifest is read in the encoding its own tool reads it in', () => {
  it('requirements.txt as Windows PowerShell 5.1 writes it for `pip freeze >`', () => {
    const d = mkdtempSync(join(tmpdir(), 'dbgai-utf16-'));
    const body = 'flask==3.0.0\r\nnumpy==1.26.4\r\n';
    writeFileSync(join(d, 'requirements.txt'), Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(body, 'utf16le')]));
    const f = gatherWorkspaceFacts(d)!;
    expect(f.declared_deps).toEqual(['flask', 'numpy']);
    expect(f.declared_versions['flask']).toBe('==3.0.0');
    expect(f.incomplete).toEqual([]);
    rmSync(d, { recursive: true, force: true });
  });

  it('a package.json with a UTF-8 mark in front, which npm accepts', () => {
    const d = mkdtempSync(join(tmpdir(), 'dbgai-bom-'));
    writeFileSync(join(d, 'package.json'), '\uFEFF' + JSON.stringify({ dependencies: { express: '4.19.2' } }));
    const f = gatherWorkspaceFacts(d)!;
    expect(f.declared_versions['express']).toBe('4.19.2');
    expect(f.incomplete).toEqual([]);
    rmSync(d, { recursive: true, force: true });
  });
});

describe('an env file is one something loads', () => {
  const only = (...names: string[]) => {
    const d = mkdtempSync(join(tmpdir(), 'dbgai-env-'));
    writeFileSync(join(d, 'package.json'), '{}');
    for (const n of names) writeFileSync(join(d, n), 'KEY=\n');
    const has = gatherWorkspaceFacts(d)!.has_env_file;
    rmSync(d, { recursive: true, force: true });
    return has;
  };

  it.each(['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.EXAMPLE', '.env.local.example'])(
    'a project with only %s has no env file', (name) => {
      // The row this field was added for: "one workspace had only .env.example".
      // Reported as present, the engine told the model "A `.env` file exists at
      // the project root", which is the opposite of what was wrong there.
      expect(only(name)).toBe(false);
    });

  it.each(['.env', '.env.local', '.env.production', '.env.development.local'])('%s is one', (name) => {
    expect(only(name)).toBe(true);
  });

  it('a template beside a real one changes nothing', () => {
    expect(only('.env.example', '.env')).toBe(true);
  });
});

describe('the containment test holds across Windows volumes', () => {
  // `path.relative('C:\\repo', 'D:\\x\\requirements.txt')` is the absolute
  // `D:\\x\\requirements.txt`: no `..` in front, so it read as inside. Run on
  // real Windows 2026-10-01 against a file on another volume, the old test
  // answered true. Two volumes cannot be built on this machine, so the rule is
  // pinned as text beside the same rule in sourceContext.ts.
  it('refuses an absolute relative path, in the gatherer as in the source reader', () => {
    const gather = readFileSync(new URL('../src/gatherWorkspaceFacts.ts', import.meta.url), 'utf8');
    const source = readFileSync(new URL('../src/sourceContext.ts', import.meta.url), 'utf8');
    expect(gather).toContain("return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));");
    expect(source).toContain("!rel.startsWith('..') && !isAbsolute(rel)");
  });
});
