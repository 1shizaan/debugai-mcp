import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BackendConfig } from '../backend.js';
import { callOutcomeBackend } from '../backend.js';
import { mapBackendErrorToToolResult } from '../errors.js';
import { resolveAuth } from './authGate.js';

/**
 * The channel back.
 *
 * ## Why this tool grew on 2026-08-26
 *
 * An external user's agent reported an outcome and wrote this into `newError`,
 * a field described to it as "the error observed AFTER applying the fix":
 *
 *   "The first corrected node -e command was still rewritten by PowerShell
 *    quoting; a separate PowerShell HTTP verification was used successfully
 *    instead."
 *
 * That is not an error. It is a post-mortem: our answer was aimed at the wrong
 * layer, and here is what actually worked. It is the most useful thing anybody
 * has ever sent this system, and the agent had to force it through the wrong
 * slot because nothing here asked for it.
 *
 * So the schema now asks. Three changes, each closing a case an honest agent
 * could not previously report:
 *
 *   'unused'       — you read the fixes, used none of them, and solved it your
 *                    own way. Previously only 'worked' and 'failed' existed, so
 *                    this had to be misreported as a failure or not reported.
 *                    Reporting it as a failure is actively harmful: it marks a
 *                    fix as tried and beaten when nothing of ours was run.
 *   actualFix      — what actually resolved it. Ground truth on a case we got
 *                    wrong, which is worth more than a case we got right.
 *   toolFeedback   — what would have made this tool more useful here. About the
 *                    tool, not the bug, and kept separate for exactly that
 *                    reason: a complaint about DebugAI must never end up
 *                    promoted into somebody's project memory as a fix.
 *
 * A field on a tool agents already call beats a new tool they would have to be
 * told about. This one has a measured ~50% attach rate; a new `send_feedback`
 * starts at zero and competes for the same attention.
 */
export function registerReportOutcome(server: McpServer, config: BackendConfig): void {
  server.registerTool(
    'report_outcome',
    {
      title: 'Report Fix Outcome',
      description:
        'Report what happened after DebugAI answered, including when you did not use its fix. ' +
        'Call this ONCE per debug_error response, passing the debug_log_id from it. ' +
        'If you solved the problem another way, say so with result "unused" and put the real ' +
        'fix in actualFix: a case DebugAI got wrong is worth more to it than one it got right. ' +
        'If the tool could have helped you more here, say that in toolFeedback. ' +
        'Confirmed rank-1 fixes are remembered for this project and returned to whoever hits ' +
        'the same error next.',
      inputSchema: {
        debugLogId: z
          .string()
          .min(1)
          .describe('The debug_log_id value from the debug_error response you are reporting on.'),
        result: z
          .enum(['worked', 'failed', 'unused'])
          .describe(
            '"worked" = you applied a DebugAI fix and the error stopped. ' +
            '"failed" = you applied one and it did not help (or made things worse). ' +
            '"unused" = you did not apply any of them and resolved it another way. ' +
            'Use "unused" rather than "failed" when nothing of ours was actually run. ' +
            'They are different facts and reporting the wrong one buries a fix nobody tried.',
          ),
        fixRank: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .describe('Which ranked fix you applied (1-3). Rank 1 outcomes feed team error memory. Omit for "unused".'),
        newError: z
          .string()
          .max(4000)
          .optional()
          .describe('If result is "failed": the error observed AFTER applying the fix. An error message, not an explanation.'),
        actualFix: z
          .string()
          .max(4000)
          .optional()
          .describe(
            'What actually resolved the error, when it was not the fix DebugAI suggested. ' +
            'Free text. Say what the real cause turned out to be and what you changed, ' +
            'especially if the cause was in a different layer than the answer addressed ' +
            '(the shell, the runtime version, the environment, a missing package).',
          ),
        toolFeedback: z
          .string()
          .max(2000)
          .optional()
          .describe(
            'What would have made DebugAI more useful on THIS call. About the tool, not the bug: ' +
            'context it lacked, a question it should have asked, an input shape it rejected, ' +
            'a wrong assumption in its reasoning. This reaches the people who build it.',
          ),
      },
      annotations: {
        title: 'Report Fix Outcome',
        // Deliberately NO readOnlyHint — this records telemetry server-side.
        idempotentHint: true,
      },
    },
    async ({ debugLogId, result, fixRank, newError, actualFix, toolFeedback }) => {
      const gate = await resolveAuth(config);
      if (!gate.ok) return gate.result;

      try {
        await callOutcomeBackend(
          {
            debug_log_id: debugLogId,
            result,
            fix_rank: fixRank,
            new_error: newError,
            actual_fix: actualFix,
            tool_feedback: toolFeedback,
            source: 'agent',
          },
          gate.config,
        );
        // The acknowledgement is the only thing that tells an agent its report
        // landed somewhere real. An 'unused' report especially: an agent that
        // says "I ignored you and did it myself" and gets a generic thank-you
        // learns that the field is decorative, and stops filling it.
        const ack =
          result === 'worked'
            ? 'Outcome recorded: fix worked. Rank-1 confirmations are remembered for this project, so the next hit on this error starts from the confirmed fix.'
            : result === 'unused'
              ? 'Outcome recorded: our fix was not used.' +
                (actualFix
                  ? ' The fix that actually worked was logged — that is the most useful thing this tool receives, because it is a case we got wrong.'
                  : ' If you know what actually resolved it, send it in actualFix: a wrong answer we can see is worth more than a right one we cannot.')
              : 'Outcome recorded: fix failed. The follow-up error was logged and feeds directly into improving future answers. If you are still stuck, call debug_error again with the NEW error text.';
        return {
          content: [{ type: 'text' as const, text: ack }],
          structuredContent: { recorded: true, result },
        };
      } catch (err) {
        return mapBackendErrorToToolResult(err);
      }
    },
  );
}
