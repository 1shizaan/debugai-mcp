// Optional on-disk config so a user can set their key once instead of
// repeating it in every MCP client's env block:
//
//   ~/.debugai/config.json      { "api_key": "dbg_...", "api_base": "..." }
//
// Environment variables always win over the file. DEBUGAI_CONFIG_PATH
// overrides the file location (tests point it at a temp dir; users normally
// never set it).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface FileConfig {
  apiKey?: string;
  apiBase?: string;
}

export interface ResolvedSettings {
  apiKey: string;
  apiBase: string;
  /** Where the key came from — used only for the startup log line. */
  keySource: 'env' | 'file' | 'none';
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.DEBUGAI_CONFIG_PATH ?? '').trim();
  return override || join(homedir(), '.debugai', 'config.json');
}

export function loadFileConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = (msg) => console.error(msg),
): FileConfig {
  const path = configPath(env);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {}; // no config file is the normal case — stay silent
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      warn(`[debugai-mcp] ignoring ${path}: expected a JSON object`);
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    return { apiKey: str(record.api_key), apiBase: str(record.api_base) };
  } catch {
    warn(`[debugai-mcp] ignoring ${path}: malformed JSON`);
    return {};
  }
}

export function resolveSettings(
  defaultApiBase: string,
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = (msg) => console.error(msg),
): ResolvedSettings {
  const file = loadFileConfig(env, warn);

  const envKey = (env.DEBUGAI_API_KEY ?? '').trim();
  const apiKey = envKey || file.apiKey || '';
  const keySource: ResolvedSettings['keySource'] = envKey ? 'env' : file.apiKey ? 'file' : 'none';

  const envBase = (env.DEBUGAI_API_BASE ?? '').trim();
  const apiBase = (envBase || file.apiBase || defaultApiBase).replace(/\/+$/, '');

  return { apiKey, apiBase, keySource };
}
