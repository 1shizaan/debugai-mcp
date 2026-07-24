// The subcommands. Every one of these exists to delete a step a human used
// to do by hand:
//
//   setup      login + install, the only command the README leads with
//   login      device link — replaces "copy your key out of the dashboard"
//   install    writes client configs — replaces "paste this JSON blob"
//   doctor     one command that answers "why isn't it working"
//   status     what account/key is active right now
//   logout     removes the stored key
//   uninstall  removes the server entry from client configs
//
// Each returns a process exit code. Nothing here ever writes to stdout while
// the MCP transport is live — subcommands exit before a server is created.
import { statSync } from 'node:fs';
import { hostname, platform } from 'node:os';
import {
  clearStoredKey,
  configPath,
  loadFileConfig,
  maskKey,
  resolveSettings,
  writeFileConfig,
} from '../config.js';
import { DeviceLinkError, startDeviceLink, waitForDeviceLink } from '../deviceLink.js';
import { DEFAULT_API_BASE } from '../constants.js';
import {
  detectedClients,
  findClient,
  isDetected,
  knownClients,
  type McpClient,
} from './clients.js';
import { applyToClient, isInstalled, type InstallResult } from './install.js';
import { FAIL, INFO, OK, WARN, bold, codeBox, dim, heading, openBrowser, say, yellow } from './ui.js';

// ── shared helpers ───────────────────────────────────────────────────────────

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function flagValue(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('-')) return argv[idx + 1];
  return undefined;
}

interface AccountInfo {
  email?: string;
  tier?: string;
  usedToday?: number;
  dailyLimit?: number;
}

/** Confirms a key actually works against the live API. Null = could not verify. */
async function verifyKey(apiBase: string, apiKey: string): Promise<AccountInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`${apiBase}/user/me`, {
      headers: { 'x-api-key': apiKey },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const user = body?.user ?? body ?? {};
    return {
      email: user.email,
      tier: user.tier,
      usedToday: user.usage_today ?? user.used_today ?? user.daily_usage,
      dailyLimit: user.daily_limit ?? user.limit,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function clientLabel(): string {
  return `${hostname()} (${platform()})`;
}

function describeResult(r: InstallResult): void {
  const name = bold(r.client.label);
  switch (r.action) {
    case 'wrote':
    case 'updated':
      say(`  ${OK()} ${name} — ${r.action === 'wrote' ? 'added to' : 'updated in'} ${dim(r.path ?? '')}`);
      if (r.backupPath) say(`      ${dim(`backup: ${r.backupPath}`)}`);
      if (r.warning)    say(`      ${WARN()} ${yellow(r.warning)}`);
      say(`      ${dim(`next: ${r.client.afterInstall}`)}`);
      break;
    case 'unchanged':
      say(`  ${OK()} ${name} — already configured, nothing to change`);
      break;
    case 'removed':
      say(`  ${OK()} ${name} — entry removed from ${dim(r.path ?? '')}`);
      if (r.backupPath) say(`      ${dim(`backup: ${r.backupPath}`)}`);
      break;
    case 'skipped':
      say(`  ${INFO()} ${name} — skipped${r.warning ? `: ${r.warning}` : ''}`);
      break;
    case 'failed':
      say(`  ${FAIL()} ${name} — ${r.error ?? 'failed'}`);
      say(`      ${dim(`file: ${r.path ?? '(unknown)'}`)}`);
      if (r.preview) {
        say(`      ${dim('merge this in by hand:')}`);
        r.preview.split('\n').forEach((l) => say(`      ${dim(l)}`));
      }
      break;
  }
}

// ── login ────────────────────────────────────────────────────────────────────

export async function cmdLogin(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { apiBase } = resolveSettings(DEFAULT_API_BASE, env, () => {});
  const manualKey = flagValue(argv, 'key');

  // Escape hatch for CI, air-gapped machines, and anyone who would rather
  // paste. Same storage path, so everything downstream behaves identically.
  if (manualKey) {
    if (!manualKey.startsWith('dbg_')) {
      say(`${FAIL()} That does not look like a DebugAI key. They start with ${bold('dbg_')}.`);
      return 1;
    }
    const path = writeFileConfig({ apiKey: manualKey }, env);
    const info = await verifyKey(apiBase, manualKey);
    say(`${OK()} Key stored in ${path}${info?.email ? ` for ${bold(info.email)}` : ''}.`);
    if (!info) say(`${WARN()} ${yellow('Could not verify it against the API just now. Run "debugai-mcp doctor" later.')}`);
    return 0;
  }

  const existing = loadFileConfig(env, () => {}).apiKey;
  if (existing && !flag(argv, 'force')) {
    const info = await verifyKey(apiBase, existing);
    if (info) {
      say(`${OK()} Already signed in as ${bold(info.email ?? 'this account')} (${info.tier ?? 'free'} tier).`);
      say(`  ${dim(`Key ${maskKey(existing)} in ${configPath(env)}. Re-link with "debugai-mcp login --force".`)}`);
      return 0;
    }
    say(`${WARN()} A stored key exists but the API rejected it. Re-linking.`);
  }

  let start;
  try {
    start = await startDeviceLink({ apiBase, clientLabel: clientLabel() });
  } catch (err) {
    const detail = err instanceof DeviceLinkError ? err.message : String(err);
    say(`${FAIL()} Could not start the sign-in link: ${detail}`);
    say(`  ${dim('Fallback: grab a key at https://debugai.io/dashboard and run')}`);
    say(`  ${dim('debugai-mcp login --key dbg_your_key')}`);
    return 1;
  }

  say();
  say(bold('Sign in to DebugAI'));
  say(codeBox(start.userCode));
  say(`  Confirm that code at ${bold(start.verificationUriComplete)}`);
  const opened = openBrowser(start.verificationUriComplete);
  say(opened
    ? dim('  (opening your browser. free account, 10 debugs/day, no card)')
    : dim('  (open that link on any device. free account, 10 debugs/day, no card)'));
  say();
  say(dim(`  Waiting… the code expires in ${Math.round(start.expiresIn / 60)} minutes. Ctrl-C to cancel.`));

  const result = await waitForDeviceLink(start, { apiBase });

  if (result.status === 'linked') {
    const path = writeFileConfig({ apiKey: result.apiKey }, env);
    say();
    say(`${OK()} Signed in${result.email ? ` as ${bold(result.email)}` : ''}${result.tier ? ` (${result.tier} tier)` : ''}.`);
    say(`  ${dim(`Key saved to ${path}. Every MCP client on this machine reads it.`)}`);
    say();
    say(`  Next: ${bold('npx -y @debugai/mcp install')} ${dim('(wires up the MCP clients you have)')}`);
    return 0;
  }

  say();
  if (result.status === 'denied') say(`${FAIL()} Sign-in was declined in the browser.`);
  else if (result.status === 'expired') say(`${FAIL()} The code expired. Run "debugai-mcp login" again.`);
  else say(`${FAIL()} Sign-in did not complete.`);
  return 1;
}

// ── logout / status ──────────────────────────────────────────────────────────

export function cmdLogout(_argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const removed = clearStoredKey(env);
  say(removed
    ? `${OK()} Stored key removed from ${configPath(env)}.`
    : `${INFO()} No stored key to remove (${configPath(env)}).`);
  if ((env.DEBUGAI_API_KEY ?? '').trim()) {
    say(`${WARN()} ${yellow('DEBUGAI_API_KEY is still set in this environment and takes priority over the file.')}`);
  }
  return 0;
}

export async function cmdStatus(_argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { apiKey, apiBase, keySource } = resolveSettings(DEFAULT_API_BASE, env, () => {});
  say(`${bold('DebugAI MCP status')}`);
  say(`  API base   ${apiBase}`);
  say(`  Key        ${apiKey ? `${maskKey(apiKey)} (from ${keySource === 'env' ? 'DEBUGAI_API_KEY' : configPath(env)})` : dim('none')}`);
  if (!apiKey) {
    say();
    say(`  Run ${bold('npx -y @debugai/mcp login')} to sign in.`);
    return 1;
  }
  const info = await verifyKey(apiBase, apiKey);
  if (!info) {
    say(`  Account    ${FAIL()} key rejected or API unreachable`);
    return 1;
  }
  say(`  Account    ${info.email ?? '(unknown)'} · ${info.tier ?? 'free'} tier`);
  return 0;
}

// ── install / uninstall ──────────────────────────────────────────────────────

function selectClients(argv: string[], env: NodeJS.ProcessEnv): { clients: McpClient[]; explicit: boolean } {
  const raw = flagValue(argv, 'client');
  if (raw) {
    const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const clients: McpClient[] = [];
    for (const id of ids) {
      const found = findClient(id, env);
      if (found) clients.push(found);
      else say(`${WARN()} Unknown client "${id}". Run "debugai-mcp install --list" to see the names.`);
    }
    return { clients, explicit: true };
  }
  if (flag(argv, 'all')) return { clients: knownClients(env).filter((c) => !c.optIn), explicit: false };
  return { clients: detectedClients(env).filter((c) => !c.optIn), explicit: false };
}

function listClients(env: NodeJS.ProcessEnv): void {
  heading('Known MCP clients');
  for (const c of knownClients(env)) {
    const mark = isDetected(c) ? OK() : INFO();
    const state = isDetected(c) ? (isInstalled(c) ? 'detected · debugai configured' : 'detected') : 'not found';
    say(`  ${mark} ${bold(c.id.padEnd(15))} ${c.label.padEnd(22)} ${dim(state)}`);
    say(`      ${dim(c.configPath ?? 'no config path on this OS')}`);
    if (c.note) say(`      ${dim(c.note)}`);
  }
  say();
  say(dim('  Install one explicitly: debugai-mcp install --client=cursor'));
}

export function cmdInstall(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  if (flag(argv, 'list')) { listClients(env); return 0; }

  const dryRun = flag(argv, 'dry-run') || flag(argv, 'print');
  const remove = flag(argv, 'remove');
  const { clients, explicit } = selectClients(argv, env);

  if (!clients.length) {
    say(`${WARN()} No MCP clients detected on this machine.`);
    say();
    listClients(env);
    return 1;
  }

  heading(remove ? 'Removing DebugAI from MCP clients' : 'Installing DebugAI into MCP clients');
  const results = clients.map((c) => applyToClient(c, { dryRun, remove }));
  results.forEach(describeResult);

  if (dryRun) {
    for (const r of results.filter((x) => x.preview)) {
      heading(`${r.client.label} — ${r.path}`);
      say(r.preview!.trimEnd());
    }
    say();
    say(dim('  Dry run — nothing was written.'));
    return 0;
  }

  const failed = results.filter((r) => r.action === 'failed').length;
  const changed = results.filter((r) => r.action === 'wrote' || r.action === 'updated' || r.action === 'removed').length;

  say();
  if (!remove) {
    const { apiKey } = resolveSettings(DEFAULT_API_BASE, env, () => {});
    if (!apiKey) {
      say(`${WARN()} ${yellow('No API key stored yet — run')} ${bold('npx -y @debugai/mcp login')} ${yellow('to finish.')}`);
    } else {
      say(`${OK()} Key already stored — ${changed ? 'restart the clients above and you are done.' : 'nothing left to do.'}`);
    }
    if (!explicit) say(dim('  Missing a client? "debugai-mcp install --list" shows every name.'));
  }
  return failed ? 1 : 0;
}

export function cmdUninstall(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  return cmdInstall([...argv, '--remove', '--all'], env);
}

// ── doctor ───────────────────────────────────────────────────────────────────

export async function cmdDoctor(_argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let hardFailures = 0;
  const fail = (msg: string, hint?: string): void => {
    hardFailures++;
    say(`  ${FAIL()} ${msg}`);
    if (hint) say(`      ${dim(hint)}`);
  };
  const pass = (msg: string, detail?: string): void => {
    say(`  ${OK()} ${msg}`);
    if (detail) say(`      ${dim(detail)}`);
  };

  heading('Runtime');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) pass(`Node ${process.versions.node}`);
  else fail(`Node ${process.versions.node} is too old`, 'DebugAI MCP needs Node 18 or newer (it uses global fetch).');

  heading('Account');
  const { apiKey, apiBase, keySource } = resolveSettings(DEFAULT_API_BASE, env, () => {});
  if (!apiKey) {
    fail('No API key found', 'Run: npx -y @debugai/mcp login');
  } else if (!apiKey.startsWith('dbg_')) {
    fail(`Key does not look like a DebugAI key (${maskKey(apiKey)})`, 'DebugAI keys start with dbg_.');
  } else {
    pass(`Key ${maskKey(apiKey)}`, `source: ${keySource === 'env' ? 'DEBUGAI_API_KEY env var' : configPath(env)}`);
  }

  if (keySource === 'file') {
    try {
      const mode = statSync(configPath(env)).mode & 0o777;
      if (platform() !== 'win32' && (mode & 0o077) !== 0) {
        say(`  ${WARN()} ${yellow(`Config file is readable by other users (mode ${mode.toString(8)})`)}`);
        say(`      ${dim(`fix: chmod 600 ${configPath(env)}`)}`);
      }
    } catch { /* file vanished between calls — the key check above already covered it */ }
  }

  heading('API');
  if (!apiKey) {
    say(`  ${INFO()} Skipped — no key to test with.`);
  } else {
    const info = await verifyKey(apiBase, apiKey);
    if (info) {
      pass(`${apiBase} reachable`, `${info.email ?? 'account'} · ${info.tier ?? 'free'} tier`);
    } else {
      fail(`Could not authenticate against ${apiBase}`,
        'Either the key was rotated (run: debugai-mcp login --force) or the API is unreachable from here.');
    }
  }

  heading('MCP clients');
  const detected = detectedClients(env);
  if (!detected.length) {
    say(`  ${INFO()} None detected. "debugai-mcp install --list" shows every supported client.`);
  }
  for (const c of detected) {
    if (isInstalled(c)) pass(`${c.label} — debugai configured`, c.configPath ?? undefined);
    else say(`  ${WARN()} ${yellow(`${c.label} — installed but DebugAI is not in its config`)}\n      ${dim(`fix: debugai-mcp install --client=${c.id}`)}`);
  }

  say();
  if (hardFailures) {
    say(`${FAIL()} ${hardFailures} problem${hardFailures === 1 ? '' : 's'} to fix.`);
    return 1;
  }
  say(`${OK()} Everything checks out.`);
  return 0;
}

// ── setup (the headline command) ─────────────────────────────────────────────

export async function cmdSetup(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { apiKey } = resolveSettings(DEFAULT_API_BASE, env, () => {});
  if (!apiKey || flag(argv, 'force')) {
    const code = await cmdLogin(argv, env);
    if (code !== 0) return code;
  } else {
    say(`${OK()} Already signed in — skipping login (use --force to re-link).`);
  }

  const installCode = cmdInstall(argv.filter((a) => a !== '--force'), env);
  if (installCode !== 0) return installCode;

  return cmdDoctor([], env);
}
