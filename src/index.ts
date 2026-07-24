#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { DEFAULT_TIMEOUT_MS } from './backend.js';
import { AuthProvider } from './auth.js';
import { DEFAULT_API_BASE } from './constants.js';
import { configPath, resolveSettings } from './config.js';
import {
  cmdDoctor,
  cmdInstall,
  cmdLogin,
  cmdLogout,
  cmdSetup,
  cmdStatus,
  cmdUninstall,
} from './cli/commands.js';

function packageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

const VERSION = packageVersion();

const HELP = `debugai-mcp v${VERSION} — DebugAI MCP server + setup CLI

Quick start (one command, no config files to edit):
  npx -y @debugai/mcp setup

Commands:
  setup          sign in, then wire up every MCP client found on this machine
  login          sign in via browser and store the key (--key dbg_… to paste one)
  logout         remove the stored key
  status         show the active key and account
  install        add DebugAI to MCP client configs
                   --list          show every supported client and where it lives
                   --client=cursor target one client (comma-separate for several)
                   --all           every supported client, detected or not
                   --dry-run       print what would change, write nothing
                   --remove        take the entry back out
  uninstall      remove DebugAI from every client config
  doctor         diagnose setup: key, API reachability, client wiring
  (no command)   run the MCP server on stdio — this is what clients launch

Tools exposed to your agent:
  debug_error     hand it an error or stack trace, get root cause + ranked
                  fixes with machine-applicable edits (v2 contract)
  report_outcome  tell DebugAI whether an applied fix worked — failed-fix
                  follow-ups improve future answers for your codebase

Environment:
  DEBUGAI_API_KEY      your API key (dbg_…). Overrides the stored key.
  DEBUGAI_API_BASE     optional — API base URL (default: DebugAI production)
  DEBUGAI_TIMEOUT_MS   optional — per-request deadline in ms (default: ${DEFAULT_TIMEOUT_MS})
  DEBUGAI_CONFIG_PATH  optional — alternate config file location

Config file (written by login, read by every MCP client on this machine):
  ${configPath()}    {"api_key": "dbg_…"}

Docs: https://debugai.io/start?src=mcp
`;

const SUBCOMMANDS = new Set([
  'setup', 'login', 'logout', 'status', 'install', 'uninstall', 'doctor',
]);

async function runSubcommand(name: string, argv: string[]): Promise<number> {
  switch (name) {
    case 'setup':     return cmdSetup(argv);
    case 'login':     return cmdLogin(argv);
    case 'logout':    return cmdLogout(argv);
    case 'status':    return cmdStatus(argv);
    case 'install':   return cmdInstall(argv);
    case 'uninstall': return cmdUninstall(argv);
    case 'doctor':    return cmdDoctor(argv);
    default:          return 1;
  }
}

// stdout carries the MCP protocol — in server mode every human-facing line goes
// to stderr. Subcommands print to stdout and exit before any transport exists,
// so the two can never interleave.
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    process.stdout.write(HELP);
    return;
  }

  const [first, ...rest] = args;
  if (first && SUBCOMMANDS.has(first)) {
    process.exitCode = await runSubcommand(first, rest);
    return;
  }
  if (first && !first.startsWith('-')) {
    console.error(`[debugai-mcp] unknown command: ${first} (see --help)`);
    process.exitCode = 1;
    return;
  }
  if (args.length > 0) {
    console.error(`[debugai-mcp] unknown argument(s): ${args.join(' ')} (see --help)`);
    process.exitCode = 1;
    return;
  }

  // ── server mode ────────────────────────────────────────────────────────────
  const { apiKey, apiBase, keySource } = resolveSettings(DEFAULT_API_BASE);

  const rawTimeout = Number(process.env.DEBUGAI_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS;

  // The auth provider re-reads the key on every tool call and can start a
  // browser sign-in from inside a conversation, so a missing key is a
  // 20-second detour instead of a dead end. See auth.ts.
  const auth = new AuthProvider({ apiBase, clientLabel: 'DebugAI MCP server' });

  if (!apiKey) {
    console.error(
      '[debugai-mcp] no API key yet — the first tool call will hand your agent a sign-in link. ' +
      'To do it now instead, run: npx -y @debugai/mcp login',
    );
  } else if (!apiKey.startsWith('dbg_')) {
    console.error(
      '[debugai-mcp] warning: DEBUGAI_API_KEY does not look like a DebugAI key (expected dbg_ prefix).',
    );
  }

  const server = createServer({ apiKey, apiBase, version: VERSION, timeoutMs, auth });

  const shutdown = (signal: string): void => {
    console.error(`[debugai-mcp] received ${signal}, shutting down`);
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const transport = new StdioServerTransport();
  server.connect(transport).then(
    () => console.error(
      `[debugai-mcp] v${VERSION} connected on stdio (api: ${apiBase}, key: ${keySource})`,
    ),
    (err) => {
      console.error('[debugai-mcp] fatal:', err);
      process.exit(1);
    },
  );
}

void main();
