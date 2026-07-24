import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BackendConfig, DebugFix } from '../backend.js';
import { callDebugBackend } from '../backend.js';
import { mapBackendErrorToToolResult } from '../errors.js';
import { resolveAuth } from './authGate.js';

// Tri-state verification labeling (docs/plan-v2-contract-phase1.md §1).
// The null case is rendered ON PURPOSE: a confidence number nothing checked
// must never look the same as one that was mechanically verified.
export function formatVerification(fix: DebugFix): string {
  if (fix.verified === true) {
    return `✓ Verified — ${fix.verification_reason ?? 'mechanical check passed'}`;
  }
  if (fix.verified === false) {
    return `✗ Failed mechanical check (confidence capped) — ${fix.verification_reason ?? 'check failed'}`;
  }
  return '· Not verified — confidence is the model\'s own estimate; nothing checked this fix.';
}

export function formatFix(fix: DebugFix, index: number): string {
  const lines: string[] = [
    `\n**Fix ${index} (${fix.confidence}% confidence)** — ${fix.title}`,
    formatVerification(fix),
    fix.description,
  ];
  if (fix.code) {
    lines.push('```', fix.code, '```');
  }
  if (fix.line_hint) {
    lines.push(`_Location: ${fix.line_hint}_`);
  }
  if (fix.edits?.length) {
    lines.push(
      '_Machine-applicable edit available: `edits` on this fix in structuredContent carries the exact old/new strings (apply with your Edit/replace tool)._',
    );
  }
  if (fix.unified_diff) {
    lines.push('```diff', fix.unified_diff.trimEnd(), '```');
  }
  if (fix.verify_with) {
    lines.push(`_Syntax-level check after applying: \`${fix.verify_with}\`_`);
  }
  return lines.join('\n');
}

export function registerDebugError(server: McpServer, config: BackendConfig): void {
  server.registerTool(
    'debug_error',
    {
      title: 'Debug Error',
      description:
        'Analyze a runtime error, exception, or stack trace and return root cause + ranked fixes. ' +
        'Use whenever the user pastes an error, asks "why is this failing", "what does this error mean", ' +
        '"debug this stack trace", "fix this exception", "analyze this traceback", or shows a ' +
        'Traceback / TypeError / ReferenceError / AttributeError. ' +
        'Works for Python, JavaScript, TypeScript, Go, Rust. ' +
        'Returns root cause explanation plus up to 3 ranked fixes with machine-applicable code edits. ' +
        'After applying a fix, report whether it worked via the report_outcome tool.',
      inputSchema: {
        errorText: z
          .string()
          .min(1)
          .describe('The full error message, exception, or stack trace text.'),
        language: z
          .enum(['javascript', 'typescript', 'python', 'go', 'rust', 'auto'])
          .default('auto')
          .describe('Source language. Use "auto" to let DebugAI detect from the error.'),
        codeSnippet: z
          .string()
          .optional()
          .describe('Surrounding code lines near where the error was thrown, if available.'),
        filePath: z
          .string()
          .optional()
          .describe('Absolute or relative path to the file that threw the error, if known.'),
      },
      annotations: {
        readOnlyHint: true,
        title: 'Debug Error',
      },
    },
    async ({ errorText, language, codeSnippet, filePath }) => {
      const gate = await resolveAuth(config);
      if (!gate.ok) return gate.result;

      try {
        const result = await callDebugBackend(
          {
            error_message:  errorText,
            language:       language !== 'auto' ? language : undefined,
            code_snippet:   codeSnippet,
            file_path:      filePath,
            // framework_hint deliberately omitted: a language ('python') is not a
            // framework ('fastapi'), and sending it bypasses the engine's
            // framework detection — FastAPI/React errors lose their expert hints.
          },
          gate.config,
        );

        const sections: string[] = ['## Root Cause', result.root_cause ?? '(no root cause returned)'];

        if (result.fixes?.length) {
          sections.push('\n## Fixes');
          result.fixes.forEach((fix, i) => {
            sections.push(formatFix(fix, i + 1));
          });
        }

        const badges: string[] = [];
        if (result.model_used)           { badges.push(`Model: ${result.model_used}`); }
        if (result.has_project_context)  { badges.push('Codebase-aware: yes'); }
        if (result.cached)               { badges.push('Cached: yes'); }
        if (result.framework_detected)   { badges.push(`Framework: ${result.framework_detected}`); }
        if (badges.length) {
          sections.push(`\n---\n_${badges.join(' · ')}_`);
        }

        if (result.debug_log_id) {
          sections.push(
            `\nAfter applying a fix, call report_outcome with debugLogId "${result.debug_log_id}", ` +
            'the fixRank you applied, and result "worked" or "failed" (include newError text if it failed).',
          );
        }

        const text = sections.join('\n');

        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            schema_version:      result.schema_version ?? '1.0',
            root_cause:          result.root_cause,
            fixes:               result.fixes,
            framework_detected:  result.framework_detected,
            model_used:          result.model_used,
            cached:              result.cached ?? false,
            has_project_context: result.has_project_context ?? false,
            debug_log_id:        result.debug_log_id ?? null,
            error_signature:     result.error_signature ?? null,
          },
        };
      } catch (err) {
        return mapBackendErrorToToolResult(err);
      }
    },
  );
}
