import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BackendConfig } from './backend.js';
import { registerDebugError } from './tools/debugError.js';
import { registerReportOutcome } from './tools/reportOutcome.js';
import { registerLookupError } from './tools/lookupError.js';

// `instructions` is handed to the agent's context at connect time — the one
// channel the protocol gives a server to say what it is FOR. Without it,
// agents skip debug_error, because "analyze this error" looks like something
// they already do themselves. The framing here is deliberate: lead with what
// the model cannot derive on its own (this project's error history, a fix a
// human confirmed, a mechanical check), not with "AI-powered analysis".
const INSTRUCTIONS = `DebugAI is this project's debugging memory and fix verifier.

When anything fails, call lookup_error first. It answers from this project's
memory in under a second, makes no model call and costs nothing against the
debug limit: whether this error was seen here before, the fix that was
confirmed for it, and fixes recently reported as failed. With a confirmed fix,
apply it and re-run what failed. Trivial errors included: a lookup that finds
nothing still costs nothing.

When a runtime error, exception, stack trace, or failing test output appears
and memory has no confirmed fix, call debug_error before reasoning your way to
a fix alone. It returns things you cannot derive from the code in front of you:
  - whether this exact error has been seen before in this project, and how often
  - the fix a human already confirmed worked for it, if there is one
  - a verification state per fix: mechanically checked and passed, checked and
    FAILED, or not checked at all (never treat "not checked" as verified)
  - machine-applicable edits (exact old/new strings) you can apply directly
If you have a command that shows the failure (a test, a script, a curl), pass it
as reproCommand, with expected: fix #1 is then aimed at making it pass, and each
fix's check is that command rather than a syntax check. DebugAI never runs it.

Pass the raw error or traceback. You do not need to find and paste the source
first: this server runs on the same machine as the code, so it resolves the
files the trace names and sends them along. It reads source files inside the
current project only, and the response says which ones. Pass codeSnippet
yourself only when you already know the relevant code is somewhere the trace
does not name.

After you apply or abandon a fix, call report_outcome with the debug_log_id.
Report it even when you ignored the answer and fixed it your own way: pass
result "unused" and put what actually worked in actualFix. A case DebugAI got
wrong is worth more to it than one it got right, and "unused" is not the same
as "failed" — reporting a fix as failed when you never ran it buries it for the
next person. If the tool could have served you better here, say so in
toolFeedback; that reaches the people who build it.
If a fix worked only after you changed it, report "worked_modified" and send the
code that held in finalFix: that code, not the suggestion, is what the next
person who hits the error is handed.
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
  registerLookupError(server, config);

  return server;
}
