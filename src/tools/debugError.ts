import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BackendConfig, DebugFix } from '../backend.js';
import { callDebugBackend } from '../backend.js';
import { mapBackendErrorToToolResult } from '../errors.js';
import { resolveAuth } from './authGate.js';
import { basename } from 'node:path';
import { getProjectId, getProjectRoot, NO_ROOT_BADGE } from '../project.js';
import { explicitProject } from '../explicitProject.js';
import { API_ERROR_MAX_CHARS, fitErrorText } from '../fitErrorText.js';
import { memorySection } from '../memorySection.js';
import { resolveSourceContext } from '../sourceContext.js';
import { gatherWorkspaceFacts } from '../gatherWorkspaceFacts.js';
import { clientUpdateBanner } from '../clientUpdate.js';

// `language` is a hint: the engine reads the language off the error text. A name
// outside this list is therefore never a reason to refuse the call, and it goes
// out as 'auto'. A closed zod enum here did refuse it, so an agent that passed
// "markdown" was told its input was invalid and had to retry (the list had
// already been widened once for "java"). Mapping, not the schema, is what keeps
// debug_logs.language a closed set. The bundled server holds an identical copy.
const LANGUAGE_HINTS = [
  'javascript', 'typescript', 'python', 'go', 'rust',
  'java', 'csharp', 'cpp', 'c', 'php', 'ruby', 'kotlin', 'swift',
  'lua', 'shell', 'powershell', 'sql', 'html', 'css', 'scala',
  'dart', 'elixir', 'r', 'perl',
] as const;

function languageHint(raw: string): string {
  const name = raw.trim().toLowerCase();
  return (LANGUAGE_HINTS as readonly string[]).includes(name) ? name : 'auto';
}

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
  // Field report R8: advice this project reported as failed is not handed
  // back at full confidence. The engine caps it; this says why.
  if (fix.previously_failed) {
    lines.push(
      `_This change was reported as FAILED in this project on ${fix.previously_failed.at} ` +
      `(fix #${fix.previously_failed.rank} then), so its confidence is capped. ` +
      'Apply it only if you can say what is different now._',
    );
  }
  if (fix.code) {
    lines.push('```', fix.code, '```');
  }
  // A fix names the file it edits when that is not the file the request
  // named (engine debug-v12). It then carries no line_hint, which has only
  // ever meant a line of the request's file, and its edit names this file.
  if (fix.file) {
    lines.push(`_File: ${fix.file}_`);
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
  if (fix.verify_with && fix.verify_kind === 'reproduction') {
    // The caller's own reproduction (reproCommand), which DebugAI did not run.
    // Field report 2026-09-16, R11: a syntax check was offered as the way to
    // confirm fixes for bugs no syntax check could see.
    const expect = fix.verify_expect ? `; expected: ${fix.verify_expect}` : '';
    lines.push(`_Check after applying: run \`${fix.verify_with}\`${expect}. Then call report_outcome with what happened._`);
    if (fix.syntax_check) {
      lines.push(`_Quick syntax check first, if you like: \`${fix.syntax_check}\`_`);
    }
  } else if (fix.verify_with) {
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
        'Diagnose a failing command, error, exception, stack trace or failing test, and return ' +
        'a root cause plus ranked fixes. ' +
        'Call it the moment something fails, INCLUDING when you caused the failure yourself: ' +
        'a build or typecheck exiting non-zero (tsc, cargo, go build, mvn, dotnet), a linter ' +
        'reporting errors, a test suite going red, a script exiting non-zero, a runtime ' +
        'throwing, or the user pasting a traceback. Do not wait to be asked and do not skip it ' +
        'because you think you already know the fix: it answers from this project history, ' +
        'which is not derivable from the code in front of you, and a reported outcome on a ' +
        'known error is what makes the next answer better. ' +
        'Works for Python, JavaScript, TypeScript, Go, Rust, Java, C#, and more. ' +
        'Also takes a bug with NO error message: describe what you expected, what happened ' +
        'instead, and the code in between, and it is analysed like any other error. ' +
        'Pass the raw error text — this server runs locally and reads the source files the ' +
        'stack trace names, so you do not need to locate and paste the code first. ' +
        'Returns root cause plus up to 3 ranked fixes. Where an edit can be derived honestly ' +
        'a fix carries one, naming the file it belongs to; a fix that cannot be expressed as ' +
        'an exact replacement carries none rather than a guess, so read the root cause and ' +
        'write it yourself. Then call report_outcome.',
      inputSchema: {
        errorText: z
          .string()
          .min(1)
          .describe('The full error message, exception, or stack trace text.'),
        language: z
          .string()
          .default('auto')
          .describe(
            'Source language hint, one of: ' + LANGUAGE_HINTS.join(', ') + '. Leave it at ' +
            '"auto" (the default) unless you have a reason: the server reads the error text ' +
            'and the client cannot see it more clearly than that. A name outside the list is ' +
            'not an error, it is treated as "auto".',
          ),
        codeSnippet: z
          .string()
          .optional()
          .describe(
            'Optional. Surrounding code near where the error was thrown. Usually unnecessary — ' +
            'the server reads the files the trace names off local disk. Supply it only when the ' +
            'relevant code is somewhere the trace does not name; it overrides the local read.',
          ),
        snippetStartLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            'Optional, with codeSnippet. The line of the file that the FIRST line of codeSnippet ' +
            'is. Pass it when the snippet is a window from the middle of a file: without it the ' +
            'lines are counted from 1, and a line number in the error will not match them.',
          ),
        filePath: z
          .string()
          .optional()
          .describe(
            'Absolute or relative path to the file that threw the error, if known. An ABSOLUTE ' +
            'path also tells DebugAI which repository the error belongs to.',
          ),
        reproCommand: z
          .string()
          .max(500)
          .optional()
          .describe(
            'The command that reproduces the failure, if you have one: a test, a script, a curl. ' +
            'DebugAI does not run it. Fix #1 is aimed at making it pass, and every fix\'s check ' +
            'becomes "run this, expect that" instead of a syntax check. Pass it whenever you can.',
          ),
        expected: z
          .string()
          .max(500)
          .optional()
          .describe('What reproCommand should print or do once the bug is fixed. Used with reproCommand.'),
        projectRoot: z
          .string()
          .optional()
          .describe(
            'Absolute path of the repository this error came from. Pass it when you were ' +
            'started somewhere other than that repository: project memory and local file reads ' +
            'are scoped to it (never your home directory, a folder above it or the filesystem root), and without it they are ' +
            'scoped to the folder this server started in.',
          ),
      },
      annotations: {
        readOnlyHint: true,
        title: 'Debug Error',
      },
    },
    async ({ errorText, language, codeSnippet, snippetStartLine, filePath, projectRoot, reproCommand, expected }) => {
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

      // Blank is absent. An agent fills an optional string with "" as readily
      // as it leaves it out, and `??` took an empty codeSnippet for a snippet:
      // the files the trace names were read, the reply said "Read locally:",
      // and what went to the engine was no code and no file path (2026-10-01).
      const ownSnippet = codeSnippet?.trim() ? codeSnippet : undefined;
      const namedFile = filePath?.trim() ? filePath : undefined;

      // No root means no reads: getProjectRoot() is null when this server started in
      // the home directory or the filesystem root and nobody named a project.
      let resolved: ReturnType<typeof resolveSourceContext> = null;
      if (!ownSnippet && root) {
        resolved = resolveSourceContext({ errorText, filePath: namedFile, root });
      }
      const snippet = ownSnippet ?? resolved?.snippet;
      const effectiveFilePath = namedFile ?? resolved?.files[0]?.label;

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
      const fitted = fitErrorText(errorText);
      const hint = languageHint(language);

      try {
        const result = await callDebugBackend(
          {
            // Cut to what the API accepts, both ends kept, rather than sent
            // whole and refused with a 400. Source resolution above read the
            // full text, so no path it names is lost to the cut.
            error_message:  fitted.text,
            language:       hint !== 'auto' ? hint : undefined,
            code_snippet:   snippet,
            // Where the agent's own window begins. A snippet this server read
            // itself says so in its section headers, so it is sent only for the
            // agent's: the engine counted every agent snippet from line 1 until
            // this existed, and answered "Line 44" about lines 1-15.
            code_snippet_start_line: ownSnippet ? snippetStartLine : undefined,
            file_path:      effectiveFilePath,
            // Project scope. Team Error Memory is project-scoped in the engine:
            // without this, recurrence is never recalled and never recorded, and
            // the confirmed-fix promotion in feedback.ts cannot match. Derived
            // from the git repo root so it agrees with the VS Code extension's
            // md5(workspaceFolder) for the same checkout. See ../project.ts.
            project_id:     projectId,
            workspace_facts: workspaceFacts ?? undefined,
            repro_command:  reproCommand,
            repro_expected: expected,
            // framework_hint deliberately omitted: a language ('python') is not a
            // framework ('fastapi'), and sending it bypasses the engine's
            // framework detection — FastAPI/React errors lose their expert hints.
          },
          gate.config,
        );

        const sections: string[] = [];
        // Above the diagnosis, not glued to the end of it. A server this old
        // may be missing client-side fixes the answer below assumes.
        const update = clientUpdateBanner(result.client_update);
        if (update) { sections.push(update); }
        sections.push('## Root Cause', result.root_cause ?? '(no root cause returned)');

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
        if (root) {
          badges.push(`Project: ${basename(root) || root}${explicit ? ` (from ${explicit.source})` : ''}`);
        } else {
          // Said, not silent: an agent that sees this knows to pass projectRoot.
          badges.push(NO_ROOT_BADGE);
        }
        if (result.memory_enabled === false) {
          badges.push(`Memory: off${result.memory_disabled_reason ? ` (${result.memory_disabled_reason})` : ''}`);
        }
        if (fitted.cut > 0) {
          badges.push(`Error text cut to ${API_ERROR_MAX_CHARS.toLocaleString('en-US')} characters, start and end kept`);
        }
        badges.push(`DebugAI MCP ${config.version}`);
        if (result.engine_version) { badges.push(`Engine ${result.engine_version}`); }
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
            error_text_cut:       fitted.cut,
            engine_version:       result.engine_version ?? null,
          },
        };
      } catch (err) {
        return mapBackendErrorToToolResult(err);
      }
    },
  );
}
