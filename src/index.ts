#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { DEFAULT_TIMEOUT_MS } from './backend.js';
import { configPath, resolveSettings } from './config.js';

const DEFAULT_API_BASE = 'https://debugai-mvp-production.up.railway.app/api';

function packageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

const VERSION = packageVersion();

const HELP = `debugai-mcp v${VERSION} — DebugAI MCP server (stdio)

Exposes two tools to any MCP client:
  debug_error     hand it an error or stack trace, get root cause + ranked
                  fixes with machine-applicable edits (v2 contract)
  report_outcome  tell DebugAI whether an applied fix worked — failed-fix
                  follow-ups improve future answers for your codebase

Usage:
  npx @debugai/mcp                # start the server (stdio transport)
  npx @debugai/mcp --version
  npx @debugai/mcp --help

Environment:
  DEBUGAI_API_KEY      your API key (dbg_...) from https://debugai.io/dashboard
  DEBUGAI_API_BASE     optional — API base URL (default: DebugAI production)
  DEBUGAI_TIMEOUT_MS   optional — per-request deadline in ms (default: ${DEFAULT_TIMEOUT_MS})

Config file (set the key once, every MCP client picks it up):
  ~/.debugai/config.json    {"api_key": "dbg_..."}
  Env vars win over the file. api_base is also accepted.

This is a stdio MCP server: it is meant to be launched BY an MCP client
(Claude Desktop, Claude Code, Cursor, Zed, ...), not run interactively.
Config snippets: https://www.npmjs.com/package/@debugai/mcp
`;

// stdout carries the MCP protocol — every human-facing line goes to stderr.
function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (args.length > 0) {
    console.error(`[debugai-mcp] unknown argument(s): ${args.join(' ')} (see --help)`);
    process.exitCode = 1;
    return;
  }

  const { apiKey, apiBase, keySource } = resolveSettings(DEFAULT_API_BASE);

  const rawTimeout = Number(process.env.DEBUGAI_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS;

  if (!apiKey) {
    console.error(
      '[debugai-mcp] no API key found — tools will return auth errors. ' +
      'Get a key at https://debugai.io/dashboard, then either set DEBUGAI_API_KEY in your ' +
      `MCP client config or write it once to ${configPath()} as {"api_key": "dbg_..."}.`,
    );
  } else if (!apiKey.startsWith('dbg_')) {
    console.error(
      '[debugai-mcp] warning: DEBUGAI_API_KEY does not look like a DebugAI key (expected dbg_ prefix).',
    );
  }

  const server = createServer({ apiKey, apiBase, version: VERSION, timeoutMs });

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

main();
