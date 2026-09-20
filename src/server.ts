import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BackendConfig } from './backend.js';
import { registerDebugError } from './tools/debugError.js';
import { registerReportOutcome } from './tools/reportOutcome.js';
import { registerLookupError } from './tools/lookupError.js';
import { serverInstructions } from './instructions.js';

export function createServer(config: BackendConfig): McpServer {
  const server = new McpServer(
    { name: 'debugai', version: config.version },
    { capabilities: { tools: { listChanged: true } }, instructions: serverInstructions({ signIn: true }) },
  );

  registerDebugError(server, config);
  registerReportOutcome(server, config);
  registerLookupError(server, config);

  return server;
}
