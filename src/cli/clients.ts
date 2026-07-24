// Where every MCP client keeps its config, and what shape it wants.
//
// This registry is the thing that replaces "copy this JSON blob into the
// right file" in the README. Adding a client = one entry here; the install
// command, doctor, and `--print` output all read from it.
//
// Two config shapes exist in the wild:
//   mcpServers      { command, args, env? }                    (most clients)
//   context_servers { source, command: { path, args, env? } }  (Zed)
//   servers         { type: "stdio", command, args }           (VS Code native)
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export type ConfigShape = 'mcpServers' | 'context_servers' | 'vscode_servers';

export interface McpClient {
  id: string;
  label: string;
  shape: ConfigShape;
  /** Absolute path to the config file, or null when this OS isn't supported. */
  configPath: string | null;
  /** Directories that prove the app is installed even before any MCP config exists. */
  probes: string[];
  /** What the user must do after we write the file. */
  afterInstall: string;
  /**
   * True for clients `install` skips unless named explicitly — currently only
   * VS Code, where the DebugAI extension already registers the server and a
   * second manual entry would show the same tools twice.
   */
  optIn?: boolean;
  note?: string;
}

function appDataDir(env: NodeJS.ProcessEnv): string {
  const home = homedir();
  if (platform() === 'win32') return env.APPDATA ?? join(home, 'AppData', 'Roaming');
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME ?? join(home, '.config');
}

/** VS Code's per-user directory — Cline stores its MCP config under it too. */
function vscodeUserDir(env: NodeJS.ProcessEnv): string {
  return join(appDataDir(env), 'Code', 'User');
}

export function knownClients(env: NodeJS.ProcessEnv = process.env): McpClient[] {
  const home = homedir();
  const appData = appDataDir(env);

  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      shape: 'mcpServers',
      configPath: join(home, '.claude.json'),
      probes: [join(home, '.claude'), join(home, '.claude.json')],
      afterInstall: 'Start a new Claude Code session (or run /mcp to reconnect).',
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      shape: 'mcpServers',
      configPath: join(appData, 'Claude', 'claude_desktop_config.json'),
      probes: [join(appData, 'Claude')],
      afterInstall: 'Quit Claude Desktop completely and reopen it (closing the window is not enough).',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      shape: 'mcpServers',
      configPath: join(home, '.cursor', 'mcp.json'),
      probes: [join(home, '.cursor')],
      afterInstall: 'Cursor picks this up on its own — check Settings, MCP for a green dot.',
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      shape: 'mcpServers',
      configPath: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      probes: [join(home, '.codeium', 'windsurf'), join(home, '.codeium')],
      afterInstall: 'Open Windsurf, Settings, MCP and hit refresh.',
    },
    {
      id: 'zed',
      label: 'Zed',
      shape: 'context_servers',
      configPath: platform() === 'win32'
        ? join(appData, 'Zed', 'settings.json')
        : join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'zed', 'settings.json'),
      probes: [
        join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'zed'),
        join(appData, 'Zed'),
      ],
      afterInstall: 'Zed reloads settings on save — the server appears in the agent panel.',
    },
    {
      id: 'gemini-cli',
      label: 'Gemini CLI',
      shape: 'mcpServers',
      configPath: join(home, '.gemini', 'settings.json'),
      probes: [join(home, '.gemini')],
      afterInstall: 'Restart the Gemini CLI session.',
    },
    {
      id: 'cline',
      label: 'Cline (VS Code)',
      shape: 'mcpServers',
      configPath: join(
        vscodeUserDir(env),
        'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json',
      ),
      probes: [join(vscodeUserDir(env), 'globalStorage', 'saoudrizwan.claude-dev')],
      afterInstall: 'Open the Cline panel, MCP Servers — it reconnects without a VS Code restart.',
    },
    {
      id: 'vscode',
      label: 'VS Code (native MCP)',
      shape: 'vscode_servers',
      configPath: join(vscodeUserDir(env), 'mcp.json'),
      probes: [vscodeUserDir(env)],
      optIn: true,
      note: 'The DebugAI VS Code extension already registers this server (VS Code 1.101+), '
          + 'plus one-click fix apply and proactive scan. Only install here if you do not want the extension.',
      afterInstall: 'Run "MCP: List Servers" from the command palette to confirm.',
    },
  ];
}

export function findClient(id: string, env: NodeJS.ProcessEnv = process.env): McpClient | undefined {
  return knownClients(env).find((c) => c.id === id.toLowerCase());
}

/** A client counts as present when its config file OR its app directory exists. */
export function isDetected(client: McpClient): boolean {
  if (client.configPath && existsSync(client.configPath)) return true;
  return client.probes.some((p) => existsSync(p));
}

export function detectedClients(env: NodeJS.ProcessEnv = process.env): McpClient[] {
  return knownClients(env).filter(isDetected);
}

/**
 * The server entry itself. `npx -y` is deliberate: it self-updates on each
 * launch and needs no global install, which is the only variant that works
 * identically on a laptop, a devcontainer, and CI.
 *
 * No `env` block, ever — the key lives in ~/.debugai/config.json (see
 * config.ts). Client configs get committed to repos; keys should not.
 */
export function serverEntry(client: McpClient): Record<string, unknown> {
  const command = 'npx';
  const args = ['-y', '@debugai/mcp'];

  if (client.shape === 'context_servers') {
    return { source: 'custom', command: { path: command, args } };
  }
  if (client.shape === 'vscode_servers') {
    return { type: 'stdio', command, args };
  }
  return { command, args };
}

/** Top-level key in that client's config file where servers are listed. */
export function serversKey(shape: ConfigShape): string {
  if (shape === 'context_servers') return 'context_servers';
  if (shape === 'vscode_servers') return 'servers';
  return 'mcpServers';
}

export const SERVER_NAME = 'debugai';
