import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BackendConfig } from '../backend.js';
import { callOutcomeBackend } from '../backend.js';
import { mapBackendErrorToToolResult } from '../errors.js';

export function registerReportOutcome(server: McpServer, config: BackendConfig): void {
  server.registerTool(
    'report_outcome',
    {
      title: 'Report Fix Outcome',
      description:
        'Report whether a DebugAI fix actually worked after you applied it. ' +
        'Call this ONCE after applying (or abandoning) a fix from debug_error, passing the ' +
        'debug_log_id from that response. If the fix failed, include the new error text — ' +
        'failed-fix follow-ups directly improve future answers for this codebase, and ' +
        'confirmed rank-1 fixes are remembered for the whole team.',
      inputSchema: {
        debugLogId: z
          .string()
          .min(1)
          .describe('The debug_log_id value from the debug_error response you are reporting on.'),
        result: z
          .enum(['worked', 'failed'])
          .describe('"worked" = the fix resolved the error; "failed" = it did not (or made things worse).'),
        fixRank: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .describe('Which ranked fix you applied (1-3). Rank 1 outcomes feed team error memory.'),
        newError: z
          .string()
          .max(4000)
          .optional()
          .describe('If result is "failed": the error observed AFTER applying the fix.'),
      },
      annotations: {
        title: 'Report Fix Outcome',
        // Deliberately NO readOnlyHint — this records telemetry server-side.
        idempotentHint: true,
      },
    },
    async ({ debugLogId, result, fixRank, newError }) => {
      try {
        await callOutcomeBackend(
          {
            debug_log_id: debugLogId,
            result,
            fix_rank: fixRank,
            new_error: newError,
            source: 'agent',
          },
          config,
        );
        const ack =
          result === 'worked'
            ? 'Outcome recorded: fix worked. Rank-1 confirmations are remembered for this project, so the next hit on this error starts from the confirmed fix.'
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
