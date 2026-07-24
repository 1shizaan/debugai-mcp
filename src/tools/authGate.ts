// Runs before every backend call. Two jobs:
//
//  1. Resolve the CURRENT key (env or config file, re-read per call) so a user
//     who signs in while their editor is open does not have to restart it.
//  2. When there is no key, turn the dead end into a sign-in the agent can
//     walk the user through, and return the words to say.
//
// Returning a tool result rather than throwing is the point: the agent gets a
// readable instruction, not a stack trace it will paraphrase badly.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BackendConfig } from '../backend.js';

export type AuthGate =
  | { ok: true; config: BackendConfig }
  | { ok: false; result: CallToolResult };

export async function resolveAuth(config: BackendConfig): Promise<AuthGate> {
  if (!config.auth) {
    return { ok: true, config }; // tests and direct embedders pass a fixed key
  }

  const state = await config.auth.ensure();
  if (state.ok) {
    return {
      ok: true,
      config: state.apiKey === config.apiKey ? config : { ...config, apiKey: state.apiKey },
    };
  }

  return {
    ok: false,
    result: {
      isError: true,
      content: [{ type: 'text', text: state.text }],
      structuredContent: state.reason === 'link_pending'
        ? {
            error_type: 'not_linked',
            user_code: state.userCode,
            verification_uri: state.verificationUri,
            // Retryable on purpose: the SAME call succeeds once the human
            // confirms. Agents should retry after telling the user, not give up.
            retryable: true,
          }
        : { error_type: 'not_linked', retryable: true },
    },
  };
}
