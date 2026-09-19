// The install path edits files a user's whole editor setup depends on. These
// tests exist to make "it clobbered my settings" impossible to ship.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseJsonc, stripJsonComments, stripTrailingCommas } from '../src/cli/jsonc.js';
import { applyToClient, findInstall, installedSpec, isInstalled, plaintextKeySites } from '../src/cli/install.js';
import { serverEntry, serversKey, type McpClient } from '../src/cli/clients.js';

let dir: string;

function clientAt(file: string, shape: McpClient['shape'] = 'mcpServers'): McpClient {
  return {
    id: 'test', label: 'Test Client', shape,
    configPath: join(dir, file), probes: [], afterInstall: 'restart it',
  };
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'debugai-install-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('jsonc', () => {
  it('strips line and block comments', () => {
    const { out, hadComments } = stripJsonComments('{\n // hi\n "a": 1 /* mid */ }');
    expect(hadComments).toBe(true);
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });

  it('never treats // inside a string as a comment', () => {
    const { out, hadComments } = stripJsonComments('{"url": "https://debugai.io/start"}');
    expect(hadComments).toBe(false);
    expect(JSON.parse(out)).toEqual({ url: 'https://debugai.io/start' });
  });

  it('keeps an escaped quote from ending the string early', () => {
    const { out } = stripJsonComments('{"a": "say \\"hi\\" // not a comment"}');
    expect(JSON.parse(out).a).toBe('say "hi" // not a comment');
  });

  it('drops trailing commas but not commas inside strings', () => {
    expect(JSON.parse(stripTrailingCommas('{"a": [1, 2,], "b": "x,",}'))).toEqual({ a: [1, 2], b: 'x,' });
  });

  it('treats an empty file as an empty object', () => {
    expect(parseJsonc('   ').value).toEqual({});
  });

  it('still throws on genuinely malformed JSON', () => {
    expect(() => parseJsonc('{"a": }')).toThrow();
  });
});

describe('applyToClient', () => {
  it('creates the file (and parent dirs) when nothing exists', () => {
    const client = clientAt('nested/deep/mcp.json');
    const result = applyToClient(client);
    expect(result.action).toBe('wrote');
    // @latest, so an old global install cannot shadow the release (field
    // report F1/F11: a July 2.1.1 ran a whole session in September).
    expect(JSON.parse(readFileSync(client.configPath!, 'utf8'))).toEqual({
      mcpServers: { debugai: { command: 'npx', args: ['-y', '@debugai/mcp@latest'] } },
    });
  });

  it('preserves every unrelated key and every other server', () => {
    const client = clientAt('mcp.json');
    writeFileSync(client.configPath!, JSON.stringify({
      theme: 'dark',
      mcpServers: { other: { command: 'foo' } },
    }));

    applyToClient(client);
    const after = JSON.parse(readFileSync(client.configPath!, 'utf8'));
    expect(after.theme).toBe('dark');
    expect(after.mcpServers.other).toEqual({ command: 'foo' });
    expect(after.mcpServers.debugai).toBeDefined();
  });

  it('backs the file up before modifying it', () => {
    const client = clientAt('mcp.json');
    writeFileSync(client.configPath!, JSON.stringify({ mcpServers: {} }));
    const result = applyToClient(client);
    expect(result.backupPath).toBeTruthy();
    expect(readdirSync(dir).some((f) => f.includes('debugai-backup'))).toBe(true);
  });

  it('is idempotent — a second run reports unchanged and writes no new backup', () => {
    const client = clientAt('mcp.json');
    applyToClient(client);
    const backupsAfterFirst = readdirSync(dir).filter((f) => f.includes('backup')).length;

    const second = applyToClient(client);
    expect(second.action).toBe('unchanged');
    expect(readdirSync(dir).filter((f) => f.includes('backup')).length).toBe(backupsAfterFirst);
  });

  it('survives a config file with comments, and says the comments were dropped', () => {
    const client = clientAt('settings.json');
    writeFileSync(client.configPath!, '{\n  // keep me?\n  "theme": "dark",\n}\n');
    const result = applyToClient(client);
    expect(result.action).toBe('updated');
    expect(result.warning).toMatch(/comments/i);
    expect(JSON.parse(readFileSync(client.configPath!, 'utf8')).theme).toBe('dark');
  });

  it('refuses to rewrite a file it cannot parse, and leaves it byte-identical', () => {
    const client = clientAt('broken.json');
    const original = '{ this is not json at all ';
    writeFileSync(client.configPath!, original);

    const result = applyToClient(client);
    expect(result.action).toBe('failed');
    expect(readFileSync(client.configPath!, 'utf8')).toBe(original);
    expect(result.preview).toContain('debugai'); // hands back a snippet to merge by hand
  });

  it('replaces a stale entry rather than duplicating it', () => {
    const client = clientAt('mcp.json');
    writeFileSync(client.configPath!, JSON.stringify({
      mcpServers: { debugai: { command: 'node', args: ['/old/path/index.js'] } },
    }));

    applyToClient(client);
    const after = JSON.parse(readFileSync(client.configPath!, 'utf8'));
    expect(Object.keys(after.mcpServers)).toEqual(['debugai']);
    expect(after.mcpServers.debugai.command).toBe('npx');
  });

  it('dry run writes nothing at all', () => {
    const client = clientAt('mcp.json');
    const result = applyToClient(client, { dryRun: true });
    expect(result.preview).toContain('debugai');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('remove takes only our entry out', () => {
    const client = clientAt('mcp.json');
    writeFileSync(client.configPath!, JSON.stringify({ mcpServers: { other: { command: 'foo' } } }));
    applyToClient(client);

    const removed = applyToClient(client, { remove: true });
    expect(removed.action).toBe('removed');
    const after = JSON.parse(readFileSync(client.configPath!, 'utf8'));
    expect(after.mcpServers).toEqual({ other: { command: 'foo' } });
  });

  it('remove on a file that never had us is a no-op', () => {
    const client = clientAt('absent.json');
    expect(applyToClient(client, { remove: true }).action).toBe('unchanged');
  });

  it('writes Zed under context_servers with its nested command shape', () => {
    const client = clientAt('zed.json', 'context_servers');
    applyToClient(client);
    const after = JSON.parse(readFileSync(client.configPath!, 'utf8'));
    expect(after.context_servers.debugai.command.path).toBe('npx');
    expect(after.mcpServers).toBeUndefined();
  });

  it('writes VS Code under servers with a stdio type', () => {
    const client = clientAt('vscode.json', 'vscode_servers');
    applyToClient(client);
    const after = JSON.parse(readFileSync(client.configPath!, 'utf8'));
    expect(after.servers.debugai.type).toBe('stdio');
  });

  it('never writes an API key into a client config, in any shape', () => {
    for (const shape of ['mcpServers', 'context_servers', 'vscode_servers'] as const) {
      const entry = JSON.stringify(serverEntry(clientAt('x.json', shape)));
      expect(entry).not.toMatch(/dbg_|api.?key/i);
      expect(entry).not.toContain('env');
      expect(serversKey(shape)).toBeTruthy();
    }
  });

  it('runs @latest in every shape, never a bare name an old global install can shadow', () => {
    for (const shape of ['mcpServers', 'context_servers', 'vscode_servers'] as const) {
      expect(JSON.stringify(serverEntry(clientAt('x.json', shape)))).toContain('"@debugai/mcp@latest"');
    }
  });

  it('says so when the entry it replaces carried a key, and does not copy the key', () => {
    const client = clientAt('mcp.json');
    writeFileSync(client.configPath!, JSON.stringify({
      mcpServers: { debugai: { command: 'npx', args: ['-y', '@debugai/mcp'], env: { DEBUGAI_API_KEY: 'dbg_live_abc' } } },
    }));
    const dry = applyToClient(client, { dryRun: true });
    expect(dry.warning).toContain('DEBUGAI_API_KEY');
    const result = applyToClient(client);
    expect(result.action).toBe('updated');
    expect(result.warning).toContain('debugai-mcp login');
    expect(readFileSync(client.configPath!, 'utf8')).not.toContain('dbg_live_abc');
    // And nothing to say when there was no key.
    expect(applyToClient(clientAt('fresh.json')).warning).toBeUndefined();
  });

  it('isInstalled reflects reality before and after', () => {
    const client = clientAt('mcp.json');
    expect(isInstalled(client)).toBe(false);
    applyToClient(client);
    expect(isInstalled(client)).toBe(true);
    applyToClient(client, { remove: true });
    expect(isInstalled(client)).toBe(false);
  });

  it('reports skipped when the OS has no known path for that client', () => {
    const client: McpClient = {
      id: 'nope', label: 'No Path', shape: 'mcpServers',
      configPath: null, probes: [], afterInstall: '',
    };
    expect(applyToClient(client).action).toBe('skipped');
  });

  it('does not leave a temp file behind on a normal write', () => {
    mkdirSync(join(dir, 'sub'));
    applyToClient(clientAt('sub/mcp.json'));
    expect(readdirSync(join(dir, 'sub')).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});

// ── Config scope ─────────────────────────────────────────────────────────────
//
// Claude Code keeps MCP servers in two places in one file. `claude mcp add`
// defaults to the per-directory one, which is why a user who followed our own
// README ended up with a working install that `doctor` called missing, and
// concluded DebugAI had to be reconfigured for every repo.

describe('finding an install in either scope', () => {
  function writeClaude(body: unknown): McpClient {
    const c = clientAt('claude.json');
    writeFileSync(c.configPath!, JSON.stringify(body, null, 2));
    return c;
  }

  const ENTRY = { debugai: { command: 'npx', args: ['-y', '@debugai/mcp'] } };

  it('finds a user-scope entry and calls it user scope', () => {
    const site = findInstall(writeClaude({ mcpServers: ENTRY }));
    expect(site).toEqual({ scope: 'user' });
  });

  it('finds a project-scope entry, which the old check reported as missing', () => {
    // The exact shape `claude mcp add` writes with its default --scope local.
    const site = findInstall(writeClaude({
      projects: { '/home/me/thing': { mcpServers: ENTRY } },
    }));
    expect(site).toEqual({ scope: 'project', projectPath: '/home/me/thing' });
  });

  it('names the directory, because that is what makes the fix obvious', () => {
    // "configured somewhere" is not actionable. "configured for /home/me/thing"
    // tells somebody why it stopped working when they cd'd elsewhere.
    const site = findInstall(writeClaude({
      projects: { '/a/one': {}, '/b/two': { mcpServers: ENTRY } },
    }));
    expect(site?.projectPath).toBe('/b/two');
  });

  it('prefers user scope when both exist', () => {
    // The duplicate state the old install created: a project entry already
    // there, then `debugai-mcp install` silently adding a second one at root.
    // User scope is the one that actually governs every directory.
    const site = findInstall(writeClaude({
      mcpServers: ENTRY,
      projects: { '/home/me/thing': { mcpServers: ENTRY } },
    }));
    expect(site?.scope).toBe('user');
  });

  it('is null when neither scope has it', () => {
    expect(findInstall(writeClaude({
      mcpServers: { other: {} },
      projects: { '/home/me/thing': { mcpServers: { other: {} } } },
    }))).toBeNull();
  });

  it('tolerates a projects key that is junk rather than throwing', () => {
    // Read on every doctor run against a file we do not own.
    for (const projects of [null, 'nope', 42, [], { x: null }, { x: { mcpServers: 'no' } }]) {
      expect(() => findInstall(writeClaude({ projects }))).not.toThrow();
    }
  });

  it('isInstalled stays true for either scope, so nothing downstream regressed', () => {
    expect(isInstalled(writeClaude({ mcpServers: ENTRY }))).toBe(true);
    expect(isInstalled(writeClaude({ projects: { '/x': { mcpServers: ENTRY } } }))).toBe(true);
    expect(isInstalled(writeClaude({ mcpServers: {} }))).toBe(false);
  });
});

// ── A key written into a client config ──────────────────────────────────────
// Field report 2026-09-16, F13: ~/.claude.json held DEBUGAI_API_KEY for one
// project while device-link sign-in sat unused. `install` never writes one;
// doctor now says where a hand-written one is.
describe('finding a plain-text key in a client config', () => {
  function write(file: string, body: unknown, shape: McpClient['shape'] = 'mcpServers'): McpClient {
    const c = clientAt(file, shape);
    writeFileSync(c.configPath!, JSON.stringify(body, null, 2));
    return c;
  }
  const KEYED = { debugai: { command: 'npx', args: ['-y', '@debugai/mcp'], env: { DEBUGAI_API_KEY: 'dbg_live_abc123' } } };

  it('finds one in the project scope, named by directory, as it sat on 2026-09-16', () => {
    const c = write('claude.json', {
      mcpServers: { debugai: { command: 'npx', args: ['-y', '@debugai/mcp'] } },
      projects: { '/home/me/debugai-mvp': { mcpServers: KEYED } },
    });
    expect(plaintextKeySites(c)).toEqual([{ scope: 'project', projectPath: '/home/me/debugai-mvp' }]);
  });

  it('finds one in the user scope, and in Zed\'s nested command shape', () => {
    expect(plaintextKeySites(write('a.json', { mcpServers: KEYED }))).toEqual([{ scope: 'user' }]);
    const zed = write('zed.json', {
      context_servers: { debugai: { source: 'custom', command: { path: 'npx', args: [], env: { DEBUGAI_API_KEY: 'dbg_x' } } } },
    }, 'context_servers');
    expect(plaintextKeySites(zed)).toEqual([{ scope: 'user' }]);
  });

  it('leaves an indirection alone: only a value that is a key counts', () => {
    for (const value of ['${input:debugai-key}', '${env:DEBUGAI_API_KEY}', '', '   ']) {
      const c = write('b.json', { mcpServers: { debugai: { command: 'npx', env: { DEBUGAI_API_KEY: value } } } });
      expect(plaintextKeySites(c), value).toEqual([]);
    }
  });

  it('ignores other servers\' keys and what install itself writes', () => {
    const c = write('c.json', {
      mcpServers: { other: { env: { DEBUGAI_API_KEY: 'dbg_not_ours' } }, debugai: serverEntry(clientAt('c.json')) },
    });
    expect(plaintextKeySites(c)).toEqual([]);
  });

  it('never throws on a config it cannot read', () => {
    const c = clientAt('broken.json');
    writeFileSync(c.configPath!, '{ nope');
    expect(plaintextKeySites(c)).toEqual([]);
    expect(plaintextKeySites(clientAt('missing.json'))).toEqual([]);
    for (const projects of [null, 'x', [], { a: null }, { a: { mcpServers: { debugai: { env: 7 } } } }]) {
      expect(plaintextKeySites(write('d.json', { projects }))).toEqual([]);
    }
  });
});

describe('which package spec an installed entry runs', () => {
  function write(file: string, body: unknown, shape: McpClient['shape'] = 'mcpServers'): McpClient {
    const c = clientAt(file, shape);
    writeFileSync(c.configPath!, JSON.stringify(body, null, 2));
    return c;
  }
  const entry = (spec: string) => ({ debugai: { command: 'npx', args: ['-y', spec] } });

  it('reads the spec from the scope that governs, user first', () => {
    expect(installedSpec(write('a.json', { mcpServers: entry('@debugai/mcp') }))).toBe('@debugai/mcp');
    expect(installedSpec(write('b.json', { mcpServers: entry('@debugai/mcp@latest') }))).toBe('@debugai/mcp@latest');
    expect(installedSpec(write('c.json', { mcpServers: entry('@debugai/mcp@2.1.1') }))).toBe('@debugai/mcp@2.1.1');
    expect(installedSpec(write('d.json', {
      mcpServers: entry('@debugai/mcp@latest'),
      projects: { '/x': { mcpServers: entry('@debugai/mcp') } },
    }))).toBe('@debugai/mcp@latest');
    expect(installedSpec(write('e.json', { projects: { '/x': { mcpServers: entry('@debugai/mcp') } } }))).toBe('@debugai/mcp');
  });

  it("reads Zed's nested command shape", () => {
    const c = write('zed.json', { context_servers: { debugai: { source: 'custom', command: { path: 'npx', args: ['-y', '@debugai/mcp'] } } } }, 'context_servers');
    expect(installedSpec(c)).toBe('@debugai/mcp');
  });

  it('is null for no entry, a hand-built entry, junk, or an unreadable file', () => {
    expect(installedSpec(write('f.json', { mcpServers: { other: {} } }))).toBeNull();
    expect(installedSpec(write('g.json', { mcpServers: { debugai: { command: 'node', args: ['/x/index.js'] } } }))).toBeNull();
    expect(installedSpec(write('h.json', { mcpServers: { debugai: { args: 'nope' } } }))).toBeNull();
    expect(installedSpec(clientAt('missing.json'))).toBeNull();
    const broken = clientAt('broken.json');
    writeFileSync(broken.configPath!, '{ nope');
    expect(installedSpec(broken)).toBeNull();
    // A different package whose name starts the same way is not ours.
    expect(installedSpec(write('i.json', { mcpServers: entry('@debugai/mcp-extras') }))).toBeNull();
  });
});
