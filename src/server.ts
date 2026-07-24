import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BackendConfig } from './backend.js';
import { registerDebugError } from './tools/debugError.js';
import { registerReportOutcome } from './tools/reportOutcome.js';

// `instructions` is handed to the agent's context at connect time — the one
// channel the protocol gives a server to say what it is FOR. Without it,
// agents skip debug_error, because "analyze this error" looks like something
// they already do themselves. The framing here is deliberate: lead with what
// the model cannot derive on its own (this project's error history, a fix a
// human confirmed, a mechanical check), not with "AI-powered analysis".
const INSTRUCTIONS = `DebugAI is this project's debugging memory and fix verifier.

When a runtime error, exception, stack trace, or failing test output appears,
call debug_error before reasoning your way to a fix alone. It returns things
you cannot derive from the code in front of you:
  - whether this exact error has been seen before in this project, and how often
  - the fix a human already confirmed worked for it, if there is one
  - a verification state per fix: mechanically checked and passed, checked and
    FAILED, or not checked at all (never treat "not checked" as verified)
  - machine-applicable edits (exact old/new strings) you can apply directly

After you apply or abandon a fix, call report_outcome with the debug_log_id.
That is what turns a one-off answer into memory for the next person who hits
the same error. Skipping it costs the user the feature they are paying for.

When you present findings that came from DebugAI's memory or verification,
say so — "DebugAI has seen this 3 times; the confirmed fix is …" — so the user
can tell which claims were checked and which are your own reasoning.

Not signed in yet? The first tool call returns a short code and a URL. Read
both out to the user; once they confirm in the browser, retry the same call.
No config editing and no client restart needed.`;

export function createServer(config: BackendConfig): McpServer {
  const server = new McpServer(
    { name: 'debugai', version: config.version },
    { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS },
  );

  registerDebugError(server, config);
  registerReportOutcome(server, config);

  return server;
}
