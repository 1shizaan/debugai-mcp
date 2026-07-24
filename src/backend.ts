import type { AuthProvider } from './auth.js';

export interface DebugRequest {
  error_message: string;
  code_snippet?: string;
  language?: string;
  file_path?: string;
  project_id?: string;
  framework_hint?: string;
}

// v2 contract (schema_version 2.0): exact search/replace payload derived
// mechanically by the engine from the submitted snippet — see
// docs/plan-v2-contract-phase1.md §0. old_string is LF-normalized.
export interface DebugEdit {
  file: string;
  old_string: string;
  new_string: string;
}

export interface DebugFix {
  rank: number;
  title: string;
  description: string;
  confidence: number;
  code?: string;
  line_hint?: string;
  // Self-verification (T1.3): true = mechanically checked and passed,
  // false = checked and FAILED (confidence already capped by the engine),
  // null/absent = NOT CHECKED — confidence is the model's own estimate.
  // Never collapse null into false when rendering.
  verified?: boolean | null;
  verification_reason?: string;
  // v2 contract fields — present only when honestly derivable.
  edits?: DebugEdit[];
  unified_diff?: string;
  verify_with?: string;
}

export interface DebugResponse {
  root_cause: string;
  fixes: DebugFix[];
  framework_detected?: string;
  model_used?: string;
  cached?: boolean;
  has_project_context?: boolean;
  related_files_count?: number;
  confidence_level?: string;
  pattern_matched?: string;
  remaining_today?: number;
  mock?: boolean;
  schema_version?: string;
  // Attached by the API gateway — the handle report_outcome links back to.
  debug_log_id?: string | null;
  error_signature?: string;
  session_id?: string;
  memory_hit?: boolean;
  memory_fix_confirmed?: boolean;
}

// report_outcome → POST /user/debug-feedback (the unified outcome pipeline —
// same route, table, and Team Error Memory promotion path as human feedback
// from the extension; docs/plan-v2-contract-phase1.md §2).
export interface OutcomeRequest {
  debug_log_id: string;
  result: 'worked' | 'failed';
  fix_rank?: number;
  new_error?: string;
  source: 'agent';
}

export interface OutcomeResponse {
  success: boolean;
}

export interface BackendConfig {
  /** Key resolved at process start. Present for direct/test use; live calls prefer `auth`. */
  apiKey: string;
  apiBase: string;
  version: string;
  /** Whole-request deadline in ms. Claude analysis runs 30-90s; nginx cuts at 120s. */
  timeoutMs?: number;
  /**
   * Live auth. When set, tools resolve the key through it on every call (so a
   * key added while the client is running works without a restart) and can
   * start a browser sign-in mid-conversation. Absent in unit tests, which pass
   * a fixed apiKey.
   */
  auth?: AuthProvider;
}

export interface BackendError extends Error {
  status: number;
  retryAfterSeconds: number;
}

export const DEFAULT_TIMEOUT_MS = 150_000;
// Feedback writes are a fast DB insert, not an LLM call — fail fast so a
// stuck outcome report never holds an agent hostage for minutes.
export const OUTCOME_TIMEOUT_MS = 15_000;

function makeBackendError(message: string, status: number, retryAfterSeconds = 0): BackendError {
  return Object.assign(new Error(message), { status, retryAfterSeconds }) as BackendError;
}

async function postJson<T>(
  path: string,
  payload: unknown,
  config: BackendConfig,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${config.apiBase}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'user-agent': `debugai-mcp/${config.version}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw makeBackendError(
        `DebugAI request timed out after ${Math.round(timeoutMs / 1000)}s`,
        504,
      );
    }
    // DNS failure, refused connection, no network — status 0 marks "never reached the API"
    throw makeBackendError(
      `Could not reach the DebugAI API at ${config.apiBase}: ${(err as Error)?.message ?? String(err)}`,
      0,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const retryAfter = Number(res.headers.get('retry-after') ?? 0);
    throw makeBackendError(text || res.statusText, res.status, retryAfter);
  }

  return res.json() as Promise<T>;
}

export async function callDebugBackend(
  req: DebugRequest,
  config: BackendConfig,
): Promise<DebugResponse> {
  return postJson<DebugResponse>('/debug', req, config, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

export async function callOutcomeBackend(
  req: OutcomeRequest,
  config: BackendConfig,
): Promise<OutcomeResponse> {
  return postJson<OutcomeResponse>('/user/debug-feedback', req, config, OUTCOME_TIMEOUT_MS);
}
