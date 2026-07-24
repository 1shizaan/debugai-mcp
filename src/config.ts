// Optional on-disk config so a user can set their key once instead of
// repeating it in every MCP client's env block:
//
//   ~/.debugai/config.json      { "api_key": "dbg_...", "api_base": "..." }
//
// Environment variables always win over the file. DEBUGAI_CONFIG_PATH
// overrides the file location (tests point it at a temp dir; users normally
// never set it).
//
// This file is the ONLY place the API key is ever written. `debugai-mcp
// install` deliberately does not put the key into any MCP client config:
// one secret, one file, 0600 — rotating or revoking is a single edit, and a
// shared or committed client config never carries a live key.
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

// ── Writing ──────────────────────────────────────────────────────────────────
// Merge-then-replace, so an api_base the user set by hand survives a `login`,
// and a half-written file can never be observed by a concurrently starting MCP
// server: write a temp file in the same directory, chmod it, rename over the
// target (rename is atomic within a filesystem).

/** Fields a write may touch. `undefined` leaves the existing value alone. */
export interface ConfigPatch {
  apiKey?: string;
  apiBase?: string;
}

export function writeFileConfig(
  patch: ConfigPatch,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = configPath(env);
  const existing = loadFileConfig(env, () => {}); // corrupt file → start clean

  const next: Record<string, string> = {};
  const apiKey = patch.apiKey !== undefined ? patch.apiKey : existing.apiKey;
  const apiBase = patch.apiBase !== undefined ? patch.apiBase : existing.apiBase;
  if (apiKey) next.api_key = apiKey;
  if (apiBase) next.api_base = apiBase;

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600); // umask can defeat the mode passed to writeFileSync
  } catch {
    /* non-POSIX filesystem — best effort */
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  return path;
}

/** Removes the stored key, keeping any api_base override. True if a key was there. */
export function clearStoredKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const existing = loadFileConfig(env, () => {});
  if (!existing.apiKey) return false;
  writeFileConfig({ apiKey: '' }, env);
  return true;
}

/** Keys are long secrets — never print more than their shape. */
export function maskKey(key: string): string {
  if (!key) return '(none)';
  if (key.length <= 12) return `${key.slice(0, 4)}…`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}
