export interface DebugRequest {
  error_message: string;
  code_snippet?: string;
  language?: string;
  file_path?: string;
  project_id?: string;
  framework_hint?: string;
}

export interface DebugFix {
  rank: number;
  title: string;
  description: string;
  confidence: number;
  code?: string;
  line_hint?: string;
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
}

export interface BackendConfig {
  apiKey: string;
  apiBase: string;
  version: string;
  /** Whole-request deadline in ms. Claude analysis runs 30-90s; nginx cuts at 120s. */
  timeoutMs?: number;
}

export interface BackendError extends Error {
  status: number;
  retryAfterSeconds: number;
}

export const DEFAULT_TIMEOUT_MS = 150_000;

function makeBackendError(message: string, status: number, retryAfterSeconds = 0): BackendError {
  return Object.assign(new Error(message), { status, retryAfterSeconds }) as BackendError;
}

export async function callDebugBackend(
  req: DebugRequest,
  config: BackendConfig,
): Promise<DebugResponse> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${config.apiBase}/debug`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'user-agent': `debugai-mcp/${config.version}`,
      },
      body: JSON.stringify(req),
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

  return res.json() as Promise<DebugResponse>;
}
