// `uninstall` and `doctor`, the BUILT CLI, in a made-up home directory.
//
// Measured 2026-10-01 on that same home: `uninstall` printed "already
// configured, nothing to change" for seven clients DebugAI had never been in,
// left the entry `install --client=vscode` had written, and left the
// per-directory entry `claude mcp add` writes. `doctor` told a machine with
// VS Code on it to run `install --client=vscode`, which duplicates what the
// extension registers, and `setup` ends by running doctor.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = join(here, '..', 'dist', 'index.js');
const linux = platform() === 'linux';       // the paths below are the Linux ones

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'debugai-home-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function cli(...args: string[]): string {
  try {
    return execFileSync(process.execPath, [distEntry, ...args], {
      env: {
        PATH: process.env.PATH, HOME: home, CI: '1', NO_COLOR: '1',
        DEBUGAI_CONFIG_PATH: join(home, 'none', 'config.json'),
        DEBUGAI_API_BASE: 'http://127.0.0.1:9/api',
      },
      encoding: 'utf8',
    });
  } catch (err) {
    return String((err as { stdout?: string }).stdout ?? '');   // a non-zero exit still printed
  }
}

describe('debugai-mcp uninstall', () => {
  it('removes the entry from VS Code, which install only writes when asked', () => {
    if (!linux) return;
    mkdirSync(join(home, '.config', 'Code', 'User'), { recursive: true });
    cli('install', '--client=vscode');
    const mcpJson = join(home, '.config', 'Code', 'User', 'mcp.json');
    expect(readFileSync(mcpJson, 'utf8')).toContain('debugai');

    const out = cli('uninstall');
    expect(readFileSync(mcpJson, 'utf8')).not.toContain('debugai');
    expect(out).toMatch(/VS Code \(native MCP\) — entry removed/);
  });

  it('removes the per-directory entry Claude Code keeps, and says which directory', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      projects: { '/home/me/thing': { mcpServers: { debugai: { command: 'npx', args: ['-y', '@debugai/mcp'] }, other: { command: 'x' } } } },
    }));
    const out = cli('uninstall');
    const after = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(after.projects['/home/me/thing'].mcpServers).toEqual({ other: { command: 'x' } });
    expect(out).toContain('also its entry for /home/me/thing');
  });

  it('never says "already configured" about a client it removed nothing from', () => {
    const out = cli('uninstall');
    expect(out).not.toContain('already configured');
    expect(out).toContain('no DebugAI entry, nothing to remove');
    // And it made no file and no backup for any of them.
    expect(readdirSync(home)).toEqual([]);
  });

  it('install still says "already configured" on a second run', () => {
    mkdirSync(join(home, '.cursor'));
    cli('install', '--client=cursor');
    expect(cli('install', '--client=cursor')).toContain('already configured, nothing to change');
  });

  it('install without a flag still stays out of VS Code', () => {
    if (!linux) return;
    mkdirSync(join(home, '.config', 'Code', 'User'), { recursive: true });
    mkdirSync(join(home, '.cursor'));
    cli('install');
    expect(existsSync(join(home, '.config', 'Code', 'User', 'mcp.json'))).toBe(false);
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(true);
    cli('install', '--all');
    expect(existsSync(join(home, '.config', 'Code', 'User', 'mcp.json'))).toBe(false);
  });
});

describe('debugai-mcp doctor', () => {
  it('does not tell a machine with VS Code on it to add what the extension registers', () => {
    if (!linux) return;
    mkdirSync(join(home, '.config', 'Code', 'User'), { recursive: true });
    mkdirSync(join(home, '.cursor'));
    const out = cli('doctor');
    expect(out).not.toContain('install --client=vscode');
    expect(out).toContain('VS Code (native MCP) — no entry here');
    // A client install does write to is still reported.
    expect(out).toContain('fix: debugai-mcp install --client=cursor');
  });

  it('still checks a VS Code entry that is there', () => {
    if (!linux) return;
    mkdirSync(join(home, '.config', 'Code', 'User'), { recursive: true });
    writeFileSync(join(home, '.config', 'Code', 'User', 'mcp.json'),
      JSON.stringify({ servers: { debugai: { type: 'stdio', command: 'npx', args: ['-y', '@debugai/mcp'] } } }));
    const out = cli('doctor');
    expect(out).toContain('VS Code (native MCP) — debugai configured');
    expect(out).toContain('runs "@debugai/mcp" without a version');
  });
});

describe('what the package ships', () => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);

  it('every built file has a source file: nothing left over from an earlier build', () => {
    // `tsc` never deletes. On 2026-10-01 dist held instructions.test.js, whose
    // source was long gone, and `npm pack` listed it for the next release.
    const dist = join(here, '..', 'dist');
    const src = join(here, '..', 'src');
    const stale = walk(dist)
      .filter((f) => f.endsWith('.js'))
      .map((f) => f.slice(dist.length + 1, -3))
      .filter((rel) => !existsSync(join(src, `${rel}.ts`)));
    expect(stale).toEqual([]);
  });

  it('the build starts from an empty output folder', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toMatch(/^node -e "require\('fs'\)\.rmSync\('dist', \{ recursive: true, force: true \}\)" && tsc /);
    expect(pkg.scripts.pretest).toBe('npm run build');
    expect(pkg.scripts.prepublishOnly).toBe('npm test');
  });
});
