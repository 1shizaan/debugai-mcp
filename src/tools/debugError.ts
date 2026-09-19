import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BackendConfig, DebugFix } from '../backend.js';
import { callDebugBackend } from '../backend.js';
import { mapBackendErrorToToolResult } from '../errors.js';
import { resolveAuth } from './authGate.js';
import { basename } from 'node:path';
import { getProjectId, getProjectRoot } from '../project.js';
import { explicitProject } from '../explicitProject.js';
import { memorySection } from '../memorySection.js';
import { resolveSourceContext } from '../sourceContext.js';
import { gatherWorkspaceFacts } from '../gatherWorkspaceFacts.js';

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
  // The diff repeats the code above it, so in prose it is shown only when
  // there is no code block. It stays whole in structuredContent (F12 of the
  // 2026-09-16 field report: each fix repeated its change three times).
  if (fix.unified_diff && !fix.code) {
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
        'Works for Python, JavaScript, TypeScript, Go, Rust, Java, C#, and more. ' +
        'Also takes a bug with NO error message: describe what you expected, what happened ' +
        'instead, and the code in between, and it is analysed like any other error. ' +
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
          .enum([
            // Widened 2026-09-13 from six values. The six were javascript,
            // typescript, python, go, rust and auto, and the omissions were not
            // theoretical: a production read of the ten highest-volume accounts
            // found FOUR of them debugging a language this enum refused.
            //
            //   java    16 debugs, one account, Spring Boot + Maven all week
            //   csharp  15 debugs, two accounts, .NET / MSBuild / YARP
            //   css     13 debugs, one account, @font-face
            //   lua      8 debugs, one account, FiveM
            //
            // One of them told us so in their own outcome report: "the tool's
            // Java language enum rejected 'java'; auto detection was required."
            // That is the failure being visible. The quiet half is worse - a
            // refused value means the agent retries with 'auto', so
            // debug_logs.language records `unknown` for every one of those
            // rows, and every language chart we have under-counts exactly the
            // languages we do not list.
            //
            // The engine already reads javac/Maven and MSBuild diagnostics in
            // error_location.py, so java and csharp were first-class on the
            // server and unsayable by the client.
            //
            // 'auto' stays the default and stays correct: the SERVER decides
            // language from the error text, this is a hint. The set is closed
            // so the column stays a closed set (same argument as
            // index_language.py), and widening it is a one-line change.
            'javascript', 'typescript', 'python', 'go', 'rust',
            'java', 'csharp', 'cpp', 'c', 'php', 'ruby', 'kotlin', 'swift',
            'lua', 'shell', 'powershell', 'sql', 'html', 'css', 'scala',
            'dart', 'elixir', 'r', 'perl',
            'auto',
          ])
          .default('auto')
          .describe(
            'Source language. Use "auto" to let DebugAI detect from the error — ' +
            'auto is correct for almost every case, because the server reads the ' +
            'error text and the client cannot see it more clearly than that.',
          ),
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
          .describe(
            'Absolute or relative path to the file that threw the error, if known. An ABSOLUTE ' +
            'path also tells DebugAI which repository the error belongs to.',
          ),
        projectRoot: z
          .string()
          .optional()
          .describe(
            'Absolute path of the repository this error came from. Pass it when you were ' +
            'started somewhere other than that repository: project memory and local file reads ' +
            'are scoped to it, and without it they are scoped to the folder this server started in.',
          ),
      },
      annotations: {
        readOnlyHint: true,
        title: 'Debug Error',
      },
    },
    async ({ errorText, language, codeSnippet, filePath, projectRoot }) => {
      const gate = await resolveAuth(config);
      if (!gate.ok) return gate.result;

      // Local source resolution. The agent's own snippet always wins — it knows
      // what it was looking at. This only fills the gap, and the gap was the
      // normal case: an agent that pastes a traceback and nothing else used to
      // get "Insufficient context for specific fix" at 20% confidence, because
      // the engine's only other source of code is a pgvector index that nothing
      // outside the VS Code extension ever populates. See ../sourceContext.ts.
      // Which project this error belongs to. Named by the caller when it can
      // be (projectRoot, or the repository an absolute filePath sits in), and
      // only otherwise the folder this process started in - which is where an
      // agent was launched, not necessarily what it is working on. See
      // ../explicitProject.ts for the 2026-09-16 session that proved it.
      const explicit = explicitProject({ projectRoot, filePath });
      const root = explicit?.root ?? getProjectRoot();
      const projectId = explicit?.id ?? getProjectId() ?? undefined;

      let resolved: ReturnType<typeof resolveSourceContext> = null;
      if (!codeSnippet) {
        resolved = resolveSourceContext({ errorText, filePath, root });
      }
      const snippet = codeSnippet ?? resolved?.snippet;
      const effectiveFilePath = filePath ?? resolved?.files[0]?.label;

      // What this repository declares - dependency names and the versions its
      // own manifests pin. The engine cannot read a disk and this process is
      // sitting on the one that matters.
      //
      // Unconditional, unlike the source resolution above: an agent's snippet
      // can replace what WE would have read, but no agent sends a .csproj, and
      // 24% of the wrong answers in the 2026-09-13 corpus needed exactly this.
      // Bounded and total - see ../gatherWorkspaceFacts.ts - so the worst case
      // is null and a prompt identical to today's.
      const workspaceFacts = gatherWorkspaceFacts(root);

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
            project_id:     projectId,
            workspace_facts: workspaceFacts ?? undefined,
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
        // be buried in a metadata footer. The wording lives in
        // ../memorySection.ts, byte-identical with the bundled server, because
        // inlined here it drifted out of that copy entirely.
        const memory = memorySection(result);
        if (memory) { sections.push(memory); }

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
        // Where memory goes, and which build answered: both invisible on
        // 2026-09-16, when a stale server ran a whole session with memory off.
        badges.push(`Project: ${basename(root) || root}${explicit ? ` (from ${explicit.source})` : ''}`);
        if (result.memory_enabled === false) {
          badges.push(`Memory: off${result.memory_disabled_reason ? ` (${result.memory_disabled_reason})` : ''}`);
        }
        badges.push(`DebugAI MCP ${config.version}`);
        if (badges.length) {
          sections.push(`\n---\n_${badges.join(' · ')}_`);
        }

        if (result.debug_log_id) {
          sections.push(
            `\nAfter applying a fix, call report_outcome with debugLogId "${result.debug_log_id}", ` +
            'the fixRank you applied, and result "worked", "worked_modified" (with the code that finally ' +
            'worked in finalFix), "failed" (with newError), or "unused" if you solved it another way.',
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
            project:              { root, source: explicit?.source ?? 'cwd' },
            memory_enabled:       result.memory_enabled ?? null,
            mcp_version:          config.version,
          },
        };
      } catch (err) {
        return mapBackendErrorToToolResult(err);
      }
    },
  );
}
