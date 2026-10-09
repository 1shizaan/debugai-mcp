import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { basename } from 'node:path';
import type { BackendConfig } from '../backend.js';
import { callLookupBackend } from '../backend.js';
import { mapBackendErrorToToolResult } from '../errors.js';
import { explicitProject } from '../explicitProject.js';
import { renderLookup } from '../lookupAnswer.js';
import { fitErrorText } from '../fitErrorText.js';
import { getProjectId, getProjectRoot } from '../project.js';
import { resolveAuth } from './authGate.js';

/**
 * lookup_error: this project's memory of an error, in under a second, with no
 * model call and no charge against the debug quota.
 *
 * 2026-09-16 field report, R10. The agent skipped DebugAI on five errors, and
 * said why: the fix looked obvious and "a network round trip felt slower than
 * fixing it". Every skip is an error memory never saw. A lookup costs two
 * indexed reads, so the cost argument goes away, and the loop the report
 * proposed becomes possible: look up first; with a confirmed fix, apply it and
 * run what failed; otherwise call debug_error.
 *
 * The project is resolved exactly as debug_error resolves it, or a lookup and a
 * debug of one error would read two different memories.
 */
export function registerLookupError(server: McpServer, config: BackendConfig): void {
  server.registerTool(
    'lookup_error',
    {
      title: 'Look Up Error in Project Memory',
      description:
        'Check whether this project has seen an error before, instantly and for free: no model ' +
        'call, not counted against the debug limit. Returns how often it was seen, the fix that ' +
        'was confirmed for it (or one that stopped holding, so you do not repeat it), and fixes ' +
        'recently reported as failed in this project. Call it first on any failure, trivial ones ' +
        'included. With a confirmed fix, apply it and re-run what failed; otherwise call ' +
        'debug_error for a full analysis.',
      inputSchema: {
        errorText: z
          .string()
          .min(1)
          .describe('The error message or stack trace, as you would pass it to debug_error.'),
        filePath: z
          .string()
          .optional()
          .describe('An ABSOLUTE path inside the repository the error came from, if you have one.'),
        projectRoot: z
          .string()
          .optional()
          .describe(
            'Absolute path of the repository this error came from, when you were started ' +
            'somewhere else. Memory is scoped to it.',
          ),
      },
      annotations: {
        title: 'Look Up Error in Project Memory',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ errorText, filePath, projectRoot }) => {
      const gate = await resolveAuth(config);
      if (!gate.ok) return gate.result;

      const explicit = explicitProject({ projectRoot, filePath });
      const root = explicit?.root ?? getProjectRoot();
      const projectId = explicit?.id ?? getProjectId() ?? undefined;

      try {
        const result = await callLookupBackend(
          // The same cut debug_error makes, so a lookup and a debug of one
          // long failure send one text and read one memory row.
          { error_message: fitErrorText(errorText).text, project_id: projectId },
          gate.config,
        );
        const project = root ? basename(root) || root : 'no project root';
        return {
          content: [{ type: 'text' as const, text: renderLookup(result, project) }],
          structuredContent: {
            ...result,
            // 'cwd', as debug_error says for the same fallback: this server
            // was told no workspace, it started in a folder.
            project: { root, source: explicit?.source ?? 'cwd' },
            mcp_version: config.version,
          },
        };
      } catch (err) {
        // An API that has not deployed the route yet answers 404. That is not a
        // failure the agent can act on: its next step is debug_error either way.
        if ((err as { status?: number })?.status === 404) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Memory lookup is not available on this DebugAI server yet. Call debug_error for a full analysis.',
            }],
            structuredContent: { available: false },
          };
        }
        return mapBackendErrorToToolResult(err);
      }
    },
  );
}
