import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configPath, loadFileConfig, resolveSettings } from '../src/config.js';

const DEFAULT_BASE = 'https://example.test/api';

let tmp: string | null = null;

function writeConfig(contents: string): NodeJS.ProcessEnv {
  tmp = mkdtempSync(join(tmpdir(), 'debugai-mcp-config-'));
  const path = join(tmp, 'config.json');
  writeFileSync(path, contents);
  return { DEBUGAI_CONFIG_PATH: path };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('configPath', () => {
  it('defaults to ~/.debugai/config.json', () => {
    expect(configPath({})).toMatch(/[/\\]\.debugai[/\\]config\.json$/);
  });

  it('honors DEBUGAI_CONFIG_PATH', () => {
    expect(configPath({ DEBUGAI_CONFIG_PATH: '/x/y.json' })).toBe('/x/y.json');
  });
});

describe('loadFileConfig', () => {
  it('returns empty config silently when the file does not exist', () => {
    const warn = vi.fn();
    const env = { DEBUGAI_CONFIG_PATH: join(tmpdir(), 'debugai-mcp-nope', 'config.json') };
    expect(loadFileConfig(env, warn)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads api_key and api_base', () => {
    const env = writeConfig('{"api_key": " dbg_file ", "api_base": "https://file.test/api"}');
    expect(loadFileConfig(env)).toEqual({ apiKey: 'dbg_file', apiBase: 'https://file.test/api' });
  });

  it('warns and ignores malformed JSON', () => {
    const warn = vi.fn();
    const env = writeConfig('{not json');
    expect(loadFileConfig(env, warn)).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed JSON'));
  });

  it('warns and ignores non-object JSON', () => {
    const warn = vi.fn();
    const env = writeConfig('["dbg_key"]');
    expect(loadFileConfig(env, warn)).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('expected a JSON object'));
  });

  it('treats empty-string values as absent', () => {
    const env = writeConfig('{"api_key": "", "api_base": "  "}');
    expect(loadFileConfig(env)).toEqual({ apiKey: undefined, apiBase: undefined });
  });
});

describe('resolveSettings', () => {
  it('env key wins over file key', () => {
    const env = { ...writeConfig('{"api_key": "dbg_file"}'), DEBUGAI_API_KEY: 'dbg_env' };
    const settings = resolveSettings(DEFAULT_BASE, env);
    expect(settings.apiKey).toBe('dbg_env');
    expect(settings.keySource).toBe('env');
  });

  it('falls back to file key when env is unset', () => {
    const env = writeConfig('{"api_key": "dbg_file"}');
    const settings = resolveSettings(DEFAULT_BASE, env);
    expect(settings.apiKey).toBe('dbg_file');
    expect(settings.keySource).toBe('file');
  });

  it('reports none when neither env nor file has a key', () => {
    const env = { DEBUGAI_CONFIG_PATH: join(tmpdir(), 'debugai-mcp-nope', 'config.json') };
    const settings = resolveSettings(DEFAULT_BASE, env);
    expect(settings.apiKey).toBe('');
    expect(settings.keySource).toBe('none');
    expect(settings.apiBase).toBe('https://example.test/api');
  });

  it('resolves api base env > file > default, stripping trailing slashes', () => {
    const fileEnv = writeConfig('{"api_base": "https://file.test/api/"}');
    expect(resolveSettings(DEFAULT_BASE, fileEnv).apiBase).toBe('https://file.test/api');
    expect(
      resolveSettings(DEFAULT_BASE, { ...fileEnv, DEBUGAI_API_BASE: 'https://env.test/api//' }).apiBase,
    ).toBe('https://env.test/api');
  });
});
