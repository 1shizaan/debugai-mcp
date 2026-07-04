import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BackendConfig, DebugFix } from '../backend.js';
import { callDebugBackend } from '../backend.js';
import { mapBackendErrorToToolResult } from '../errors.js';

export function formatFix(fix: DebugFix, index: number): string {
  const lines: string[] = [
    `\n**Fix ${index} (${fix.confidence}% confidence)** — ${fix.title}`,
    fix.description,
  ];
  if (fix.code) {
    lines.push('```', fix.code, '```');
  }
  if (fix.line_hint) {
    lines.push(`_Location: ${fix.line_hint}_`);
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
        'Returns root cause explanation plus up to 3 ranked fixes with code patches.',
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
          config,
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

        const text = sections.join('\n');

        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            root_cause:          result.root_cause,
            fixes:               result.fixes,
            framework_detected:  result.framework_detected,
            model_used:          result.model_used,
            cached:              result.cached ?? false,
            has_project_context: result.has_project_context ?? false,
          },
        };
      } catch (err) {
        return mapBackendErrorToToolResult(err);
      }
    },
  );
}
