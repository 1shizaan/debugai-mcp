import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BackendConfig } from '../backend.js';
import { callOutcomeBackend } from '../backend.js';
import { mapBackendErrorToToolResult } from '../errors.js';
import { resolveAuth } from './authGate.js';
import { outcomeAck } from '../outcomeAck.js';

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
 * starts at zero and competes for the same attention. *
 * ## And on 2026-09-18, a fourth
 *
 *   'worked_modified' + finalFix — one of our fixes held only after the agent
 *                    changed it. 'worked, rank 1' was the closest report there
 *                    was, so memory kept our suggestion, which is not what
 *                    worked (field report 2026-09-16, T1). finalFix is what is
 *                    remembered now, and the API refuses the verdict without
 *                    it rather than fall back to promoting ours.
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
        'A right diagnosis whose fix did not apply is "unused" as well, never "failed" - ' +
        'nothing of ours ran, and those two need opposite repairs. ' +
        'If the tool could have helped you more here, say that in toolFeedback. ' +
        'A confirmed fix is remembered for this project and returned to whoever hits the same ' +
        'error next: the fix you name in fixRank, or with "worked_modified" the code you send ' +
        'in finalFix.',
      inputSchema: {
        debugLogId: z
          .string()
          .min(1)
          .describe('The debug_log_id value from the debug_error response you are reporting on.'),
        result: z
          .enum(['worked', 'worked_modified', 'failed', 'unused'])
          .describe(
            '"worked" = you applied a DebugAI fix and the error stopped. ' +
            '"worked_modified" = one of its fixes worked only after you changed it; finalFix is ' +
            'then required, and the code in it is what gets remembered. ' +
            '"failed" = you applied one and it did not help (or made things worse). ' +
            '"unused" = you did not apply any of them and resolved it another way. ' +
            'Use "unused" rather than "failed" when nothing of ours was actually run. ' +
            'They are different facts and reporting the wrong one buries a fix nobody tried. ' +
            '"unused" is also the answer for a repeat call: if you asked about an error again ' +
            'after already reporting a fix for it under an earlier debugLogId, report this one ' +
            'as "unused", so one fix is not counted twice.',
          ),
        fixRank: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .describe('Which ranked fix you applied (1-3). The fix you name is the one remembered for this project. Omit for "unused".'),
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
        finalFix: z
          .string()
          .max(4000)
          .optional()
          .describe(
            'Required with result "worked_modified", ignored otherwise: the code that actually ' +
            'worked, after your changes. It replaces DebugAI\'s suggestion in this project\'s ' +
            'memory, so the next person who hits this error is handed what worked, not what was ' +
            'first suggested.',
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
    async ({ debugLogId, result, fixRank, newError, actualFix, toolFeedback, finalFix }) => {
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
            final_fix: finalFix,
            source: 'agent',
          },
          gate.config,
        );
        const ack = outcomeAck({ result, fixRank, newError, actualFix, finalFix });
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
