import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BackendConfig, DebugFix } from '../backend.js';
import { callDebugBackend } from '../backend.js';
import { mapBackendErrorToToolResult } from '../errors.js';
import { resolveAuth } from './authGate.js';
import { getProjectId, getProjectRoot } from '../project.js';
import { resolveSourceContext } from '../sourceContext.js';

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
        'Pass the raw error text — this server runs locally and reads the source files the ' +
        'stack trace names, so you do not need to locate and paste the code first. ' +
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
          .describe(
            'Optional. Surrounding code near where the error was thrown. Usually unnecessary — ' +
            'the server reads the files the trace names off local disk. Supply it only when the ' +
            'relevant code is somewhere the trace does not name; it overrides the local read.',
          ),
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

      // Local source resolution. The agent's own snippet always wins — it knows
      // what it was looking at. This only fills the gap, and the gap was the
      // normal case: an agent that pastes a traceback and nothing else used to
      // get "Insufficient context for specific fix" at 20% confidence, because
      // the engine's only other source of code is a pgvector index that nothing
      // outside the VS Code extension ever populates. See ../sourceContext.ts.
      let resolved: ReturnType<typeof resolveSourceContext> = null;
      if (!codeSnippet) {
        resolved = resolveSourceContext({
          errorText,
          filePath,
          root: getProjectRoot(),
        });
      }
      const snippet = codeSnippet ?? resolved?.snippet;
      const effectiveFilePath = filePath ?? resolved?.files[0]?.label;

      try {
        const result = await callDebugBackend(
          {
            error_message:  errorText,
            language:       language !== 'auto' ? language : undefined,
            code_snippet:   snippet,
            file_path:      effectiveFilePath,
            // Project scope. Team Error Memory is project-scoped in the engine:
            // without this, recurrence is never recalled and never recorded, and
            // the confirmed-fix promotion in feedback.ts cannot match. Derived
            // from the git repo root so it agrees with the VS Code extension's
            // md5(workspaceFolder) for the same checkout. See ../project.ts.
            project_id:     getProjectId() ?? undefined,
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

        // Memory first, above the badges: "this project has hit this exact
        // error before, and a fix was confirmed" is the one thing here the
        // agent cannot derive from the code in front of it, so it should not
        // be buried in a metadata footer.
        if (result.memory_hit) {
          const seen = typeof result.memory_times_seen === 'number'
            ? `${result.memory_times_seen}x before in this project`
            : 'before in this project';
          // Four states, not two. Until 2026-08-21 this said "a fix was
          // confirmed working" on the strength of somebody clicking Apply,
          // and a fix that had been tried and FAILED was indistinguishable
          // from one nobody had ever tried — both fell into the else branch
          // and read "no fix has been confirmed yet". An agent reading that
          // will happily re-propose the fix that already did not work, which
          // is the loop this whole change exists to break.
          //
          // memory_fix_state is what the engine sends now. When it is absent
          // (older engine) the boolean still decides, exactly as before.
          const state = typeof result.memory_fix_state === 'string'
            ? result.memory_fix_state
            : (result.memory_fix_confirmed ? 'confirmed' : 'none');
          const verified = typeof result.memory_verified_count === 'number'
            ? result.memory_verified_count
            : 0;

          let memoryBody: string;
          if (state === 'confirmed' && verified > 0) {
            memoryBody =
              `This error has been seen ${seen}. A fix for it was VERIFIED BY ` +
              `OBSERVATION ${verified}x: a live session watched the error stop ` +
              `after that fix was applied. It led the analysis above.`;
          } else if (state === 'confirmed') {
            memoryBody =
              `This error has been seen ${seen}. A fix for it was applied and ` +
              `accepted by a developer, though nothing has observed it working. ` +
              `It led the analysis above. Treat it as a strong lead, not proof.`;
          } else if (state === 'unproven') {
            memoryBody =
              `This error has been seen ${seen}. A fix was applied for it and ` +
              `THE ERROR HAS RECURRED ONCE SINCE, so that fix is unproven. The ` +
              `analysis above was told not to lead with it.`;
          } else if (state === 'anti_pattern') {
            memoryBody =
              `This error has been seen ${seen}. A fix was applied for it and ` +
              `THE ERROR KEPT HAPPENING. That fix did not work and the analysis ` +
              `above was told not to propose it again. If you are about to ` +
              `suggest something equivalent, the cause is somewhere it does not ` +
              `touch.`;
          } else {
            memoryBody = `This error has been seen ${seen}. No fix has been confirmed for it yet.`;
          }
          sections.push(`\n## Seen before\n${memoryBody}`);
        }

        const badges: string[] = [];
        // Named, not counted. "Read 2 files" is unverifiable; "read src/api.ts,
        // src/db.ts" lets the agent notice DebugAI looked at the wrong thing —
        // which is the failure mode local resolution introduces and the one
        // worth making visible.
        if (resolved) {
          badges.push(`Read locally: ${resolved.files.map((f) => f.label).join(', ')}`);
        }
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
            // Advertised in the server instructions ("whether this exact error
            // has been seen before in this project, and how often"), so they
            // belong in the structured payload, not only in the prose.
            memory_hit:           result.memory_hit ?? false,
            memory_times_seen:    result.memory_times_seen ?? null,
            memory_fix_confirmed: result.memory_fix_confirmed ?? false,
            memory_fix_state:     result.memory_fix_state ?? null,
            // Which files this server read off disk, if any. Empty when the
            // agent supplied its own snippet or nothing resolved.
            local_files_read:     resolved?.files.map((f) => f.label) ?? [],
          },
        };
      } catch (err) {
        return mapBackendErrorToToolResult(err);
      }
    },
  );
}
