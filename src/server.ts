import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BackendConfig } from './backend.js';
import { registerDebugError } from './tools/debugError.js';

export function createServer(config: BackendConfig): McpServer {
  const server = new McpServer(
    { name: 'debugai', version: config.version },
    { capabilities: { tools: { listChanged: true } } },
  );

  registerDebugError(server, config);

  return server;
}
