// The install path edits files a user's whole editor setup depends on. These
// tests exist to make "it clobbered my settings" impossible to ship.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseJsonc, stripJsonComments, stripTrailingCommas } from '../src/cli/jsonc.js';
import { applyToClient, isInstalled } from '../src/cli/install.js';
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
    expect(JSON.parse(readFileSync(client.configPath!, 'utf8'))).toEqual({
      mcpServers: { debugai: { command: 'npx', args: ['-y', '@debugai/mcp'] } },
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
