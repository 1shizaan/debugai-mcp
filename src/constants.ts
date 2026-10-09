// Shared endpoints. The API base is overridable per-user (DEBUGAI_API_BASE or
// api_base in the config file) for self-hosted and staging setups; these are
// only the defaults.
export const DEFAULT_API_BASE = 'https://debugai-mvp-production.up.railway.app/api';
export const WEB_BASE = 'https://debugai.io';

// The oldest Node this package runs on. @hono/node-server, which the MCP SDK pulls in, needs
// 18.14.1, so "Node 18" alone promised a patch release that cannot start. package.json "engines",
// the README (badge and text) and `doctor` all say this number; test/listing.test.ts reads them.
export const NODE_FLOOR = '18.14.1';

/** True when `version` ("22.3.0", with or without a leading v) is at least `floor`. */
export function nodeAtLeast(version: string, floor: string = NODE_FLOOR): boolean {
  const parts = (v: string): number[] => v.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const have = parts(version);
  const want = parts(floor);
  for (let i = 0; i < 3; i++) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}
