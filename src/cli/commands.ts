// The subcommands. Every one of these exists to delete a step a human used
// to do by hand:
//
//   setup      login + install, the only command the README leads with, then
//              the rule and the Claude Code hook — replaces "paste this into
//              CLAUDE.md" and "paste this into ~/.claude/settings.json"
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
import { DeviceLinkError, freeTierText, startDeviceLink, waitForDeviceLink } from '../deviceLink.js';
import { DEFAULT_API_BASE, NODE_FLOOR, nodeAtLeast } from '../constants.js';
import {
  detectedClients,
  findClient,
  isDetected,
  knownClients,
  type McpClient,
} from './clients.js';
import { DEBUGAI_RULE, applyRule, planRule, readsRules, ruleRoot, type RulePlan } from './agentRule.js';
import { applyHook, claudeSettingsPath, hookSites, type HookResult } from './claudeHook.js';
import { applyToClient, findInstall, installedSpec, isInstalled, plaintextKeySites, type InstallResult } from './install.js';
import { FAIL, INFO, OK, WARN, askYes, bold, canAsk, codeBox, dim, heading, openBrowser, say, yellow } from './ui.js';

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

function describeResult(r: InstallResult, removing = false): void {
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
      // The same word for two opposite states: on a removal it said "already
      // configured" about every client DebugAI had never been in.
      say(removing
        ? `  ${INFO()} ${name} — no DebugAI entry, nothing to remove`
        : `  ${OK()} ${name} — already configured, nothing to change`);
      break;
    case 'removed':
      say(`  ${OK()} ${name} — entry removed from ${dim(r.path ?? '')}`);
      for (const dir of r.removedProjects ?? []) say(`      ${dim(`also its entry for ${dir}`)}`);
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

/**
 * Writes the key and answers where, or says why it could not and answers null.
 * A sign-in is delivered once, so a home directory that cannot be written used
 * to end `login` in a stack trace with the key gone.
 */
function storeKey(apiKey: string, env: NodeJS.ProcessEnv): string | null {
  try {
    return writeFileConfig({ apiKey }, env);
  } catch (err) {
    say();
    say(`${FAIL()} Signed in, but the key could not be saved to ${configPath(env)}: ${(err as Error)?.message ?? String(err)}`);
    say(`  ${dim('Nothing was stored. Make that folder writable, or point DEBUGAI_CONFIG_PATH at a file')}`);
    say(`  ${dim('you can write, and run "debugai-mcp login" again.')}`);
    return null;
  }
}

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
    const path = storeKey(manualKey, env);
    if (!path) return 1;
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
    ? dim(`  (opening your browser. ${freeTierText(start.freeDailyLimit, 'account')})`)
    : dim(`  (open that link on any device. ${freeTierText(start.freeDailyLimit, 'account')})`));
  say();
  say(dim(`  Waiting… the code expires in ${Math.round(start.expiresIn / 60)} minutes. Ctrl-C to cancel.`));

  let result;
  try {
    result = await waitForDeviceLink(start, { apiBase });
  } catch (err) {
    const detail = err instanceof DeviceLinkError ? err.message : String(err);
    say();
    say(`${FAIL()} Lost contact with DebugAI while waiting: ${detail}`);
    say(`  ${dim('Nothing was stored. Run "debugai-mcp login" again once the connection is back.')}`);
    return 1;
  }

  if (result.status === 'linked') {
    const path = storeKey(result.apiKey, env);
    if (!path) return 1;
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

/**
 * Which clients a command acts on.
 *
 * `optIn` keeps `install` out of VS Code, where the extension registers the
 * server itself. It is a reason not to ADD an entry and no reason to leave one:
 * `uninstall` used to skip VS Code for it, so an entry added with
 * `--client=vscode` survived "remove DebugAI from every client config".
 */
function selectClients(argv: string[], env: NodeJS.ProcessEnv, removing = false): { clients: McpClient[]; explicit: boolean } {
  const wanted = (c: McpClient): boolean => removing || !c.optIn;
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
  if (flag(argv, 'all')) return { clients: knownClients(env).filter(wanted), explicit: false };
  return { clients: detectedClients(env).filter(wanted), explicit: false };
}

function listClients(env: NodeJS.ProcessEnv): void {
  heading('Known MCP clients');
  for (const c of knownClients(env)) {
    const mark = isDetected(c) ? OK() : INFO();
    const site = isDetected(c) ? findInstall(c) : null;
    const state = !isDetected(c)
      ? 'not found'
      : site?.scope === 'user'    ? 'detected · debugai configured'
      : site?.scope === 'project' ? 'detected · debugai configured (one directory only)'
      : 'detected';
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
  const { clients, explicit } = selectClients(argv, env, remove);

  if (!clients.length) {
    say(`${WARN()} No MCP clients detected on this machine.`);
    say();
    listClients(env);
    return 1;
  }

  heading(remove ? 'Removing DebugAI from MCP clients' : 'Installing DebugAI into MCP clients');
  const results = clients.map((c) => applyToClient(c, { dryRun, remove }));
  results.forEach((r) => describeResult(r, remove));

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

export async function cmdDoctor(_argv: string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Promise<number> {
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
  if (nodeAtLeast(process.versions.node)) pass(`Node ${process.versions.node}`);
  else fail(`Node ${process.versions.node} is too old`, `DebugAI MCP needs Node ${NODE_FLOOR} or newer (its HTTP server, @hono/node-server, requires it).`);

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
    const site = findInstall(c);
    // A client `install` deliberately stays out of is not one to be told to
    // install into. VS Code is on every machine doctor runs on, so this warned
    // nearly everybody to add an entry the extension already provides - and
    // `setup` ends by running doctor, so it was the last thing a new user read.
    if (c.optIn && !site) {
      say(`  ${INFO()} ${c.label} — no entry here, which is right with the DebugAI extension installed`);
      if (c.note) say(`      ${dim(c.note)}`);
      continue;
    }
    if (site?.scope === 'user') {
      pass(`${c.label} — debugai configured`, c.configPath ?? undefined);
    } else if (site?.scope === 'project') {
      // Working, but only in one directory, and somebody who does not know that
      // concludes DebugAI has to be set up per repo. That belief is what makes
      // an MCP server not worth installing, so this is a warning with the exact
      // command to widen it rather than a quiet pass.
      say(`  ${WARN()} ${yellow(`${c.label} — debugai configured for ONE directory only`)}`);
      say(`      ${dim(site.projectPath ?? '')}`);
      say(`      ${dim('`claude mcp add` defaults to --scope local. To use DebugAI in every repo:')}`);
      say(`      ${dim(`debugai-mcp install --client=${c.id}`)}`);
    } else {
      say(`  ${WARN()} ${yellow(`${c.label} — installed but DebugAI is not in its config`)}\n      ${dim(`fix: debugai-mcp install --client=${c.id}`)}`);
    }
    // Bare `@debugai/mcp` runs whatever copy npx finds first, and a global
    // install wins: the field report's whole session ran on a July 2.1.1.
    const spec = site ? installedSpec(c) : null;
    if (spec === '@debugai/mcp') {
      say(`  ${WARN()} ${yellow(`${c.label} — runs "@debugai/mcp" without a version`)}`);
      say(`      ${dim('npx then runs the first copy it finds, and an old global install wins over the newest release.')}`);
      say(`      ${dim(`fix: debugai-mcp install --client=${c.id}   (writes @debugai/mcp@latest)`)}`);
    } else if (spec && spec !== '@debugai/mcp@latest') {
      say(`  ${INFO()} ${c.label} — pinned to ${spec}; newer releases will not reach it until you change that.`);
    }
    // A warning, not a failure: it works. It is also a key in a file that gets
    // committed and pasted, and it outranks the stored one after a rotation.
    for (const site of plaintextKeySites(c)) {
      const where = site.scope === 'project' ? ` (entry for ${site.projectPath})` : '';
      say(`  ${WARN()} ${yellow(`${c.label} — an API key is written in plain text in its config`)}`);
      say(`      ${dim(`${c.configPath ?? ''}${where}`)}`);
      say(`      ${dim('It outranks the key `login` stores, so a rotated key keeps failing from there.')}`);
      say(`      ${dim('fix: debugai-mcp login, then delete the "env" block from that debugai entry')}`);
    }
  }

  // Warnings, never problems: without them DebugAI works, the agent just
  // decides for itself when to call it.
  const withDebugai = detected.filter((c) => isInstalled(c));
  const claudeCode = withDebugai.some((c) => c.id === 'claude-code');
  if (withDebugai.some(readsRules) || claudeCode) {
    heading('Rule and hook');
    const where = ruleRoot(cwd);
    if ('refused' in where) {
      say(`  ${INFO()} Rule — not checked: ${where.refused}.`);
    } else {
      const plan = planRule(where.root, withDebugai);
      for (const p of plan.present) pass(`Rule — in ${p.file}`, `read by ${p.clients.join(', ')}`);
      const without = plan.add.flatMap((a) => a.clients);
      if (without.length) {
        say(`  ${WARN()} ${yellow(`Rule — ${without.join(', ')} read${without.length === 1 ? 's' : ''} no DebugAI rule in ${where.root}`)}`);
        say(`      ${dim(`fix: ${RULE_CMD}`)}`);
      }
      // setup will not start these, so it is not the fix.
      for (const w of plan.withheld) {
        say(`  ${WARN()} ${yellow(`Rule — ${w.clients.join(', ')} read${w.clients.length === 1 ? 's' : ''} ${w.file}, which this project does not have`)}`);
        say(`      ${dim(`setup leaves it to you: ${w.client} would read it in place of ${w.hides}. Add the rule to ${w.file} if ${w.client} is not used here.`)}`);
      }
    }
    if (claudeCode) {
      const sites = hookSites('root' in where ? where.root : null);
      if (sites.found.length) {
        pass(`Claude Code hook — in ${sites.found[0]}`);
      } else {
        for (const p of sites.unreadable) say(`  ${WARN()} ${yellow(`Could not parse ${p}, so its hooks were not checked`)}`);
        say(`  ${WARN()} ${yellow(`Claude Code hook — not in ${claudeSettingsPath()}`)}`);
        say(`      ${dim(`fix: ${HOOK_CMD}`)}`);
      }
    }
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

const RULE_CMD = 'npx -y @debugai/mcp setup --rules';
const HOOK_CMD = 'npx -y @debugai/mcp setup --hook';

/** Who answers setup's questions. A seam, so a test can be the person at the terminal. */
export interface Asker {
  canAsk: () => boolean;
  ask: (question: string) => Promise<boolean>;
}

const TERMINAL: Asker = { canAsk, ask: (question) => askYes(question) };

/**
 * `--rules` / `--no-rules` and `--hook` / `--no-hook` answer without asking.
 * With neither, and nobody at a terminal to ask (CI, a script, an agent running
 * setup on someone's behalf), the answer is no and the command that would do it
 * is printed: a file written into a project nobody agreed to costs more than one
 * line to copy.
 */
async function decide(argv: string[], name: string, question: string, asker: Asker): Promise<boolean | undefined> {
  if (flag(argv, `no-${name}`)) return false;
  if (flag(argv, name)) return true;
  return asker.canAsk() ? asker.ask(question) : undefined;
}

/** The clients the rule and the hook are for: the ones `install` just acted on. */
function habitClients(argv: string[], env: NodeJS.ProcessEnv): McpClient[] {
  const named = flagValue(argv, 'client');
  if (named) return named.split(',').map((id) => findClient(id.trim(), env)).filter((c): c is McpClient => !!c);
  return detectedClients(env).filter((c) => !c.optIn || isInstalled(c));
}

async function offerRule(argv: string[], clients: McpClient[], cwd: string, dryRun: boolean, asker: Asker): Promise<void> {
  if (flag(argv, 'no-rules') || !clients.some(readsRules)) return;
  heading('The DebugAI rule');
  const where = ruleRoot(cwd);
  if ('refused' in where) {
    say(`  ${INFO()} Not added: ${where.refused}.`);
    say(`      ${dim(`To add it, run this inside your project: ${RULE_CMD}`)}`);
    return;
  }
  const plan = planRule(where.root, clients);
  for (const p of plan.present) say(`  ${OK()} ${p.file} — already has it (${p.clients.join(', ')})`);
  if (plan.add.length) await addRule(argv, plan, dryRun, asker);
  for (const w of plan.withheld) {
    say(`  ${WARN()} ${yellow(`${w.file} not started: ${w.client} reads ${w.hides} and would read ${w.file} in its place.`)}`);
    say(`      ${dim(`${w.clients.join(', ')} read${w.clients.length === 1 ? 's' : ''} ${w.file}. If this project does not use ${w.client}, add the rule there by hand.`)}`);
  }
}

async function addRule(argv: string[], plan: RulePlan, dryRun: boolean, asker: Asker): Promise<void> {
  say(dim('  Your agent can call DebugAI now. With this rule in the file it reads at the start'));
  say(dim('  of every session, it calls DebugAI when a command fails. The rule goes at the end'));
  say(dim('  of each file, and nothing else in it changes:'));
  const width = Math.max(...plan.add.map((a) => a.file.length + (a.exists ? 0 : 11)));
  for (const a of plan.add) say(`    ${`${a.file}${a.exists ? '' : ' (new file)'}`.padEnd(width)}  ${dim(`for ${a.clients.join(', ')}`)}`);
  say(dim(`  in ${plan.root}`));
  if (dryRun) {
    say();
    DEBUGAI_RULE.split('\n').forEach((l) => say(`    ${l}`));
    say(dim('  Dry run — not written.'));
    return;
  }

  const yes = await decide(argv, 'rules', 'Add the rule?', asker);
  if (yes === undefined) say(`  ${INFO()} Not added: no terminal to ask in. To add it, run this here: ${bold(RULE_CMD)}`);
  if (!yes) return;
  for (const r of applyRule(plan)) {
    say(r.action === 'failed'
      ? `  ${FAIL()} ${r.file} — ${r.error}`
      : `  ${OK()} ${r.file} — ${r.action === 'created' ? 'created, with the rule' : 'rule added at the end'}`);
  }
}

function describeHook(r: HookResult): void {
  if (r.action === 'failed') {
    say(`  ${FAIL()} ${r.path} — ${r.error}`);
    say(`      ${dim('merge this in by hand:')}`);
    r.snippet.split('\n').forEach((l) => say(`      ${dim(l)}`));
    return;
  }
  say(`  ${OK()} Claude Code hook — ${r.action === 'unchanged' ? 'already in' : 'added to'} ${dim(r.path)}`);
  if (r.backupPath) say(`      ${dim(`backup: ${r.backupPath}`)}`);
  if (r.warning) say(`      ${WARN()} ${yellow(r.warning)}`);
  if (r.action !== 'unchanged') say(`      ${dim('next: run /hooks in Claude Code to see it loaded')}`);
}

async function offerHook(argv: string[], clients: McpClient[], dryRun: boolean, asker: Asker): Promise<void> {
  if (flag(argv, 'no-hook') || !clients.some((c) => c.id === 'claude-code')) return;
  heading('The Claude Code hook');
  const path = claudeSettingsPath();
  const check = applyHook(path, { dryRun: true });
  if (check.action === 'unchanged' || check.action === 'failed') { describeHook(check); return; }

  say(dim('  After every Bash or PowerShell command that fails, the hook looks the output up in'));
  say(dim("  this project's DebugAI memory and tells Claude what it finds, before Claude reacts."));
  say(dim('  No model call, and it does not count against your limit.'));
  say(dim(`  It goes into ${path}, backed up first, every other setting kept.`));
  if (check.warning) say(`  ${WARN()} ${yellow(check.warning)}`);
  if (dryRun) {
    say();
    check.snippet.split('\n').forEach((l) => say(`    ${l}`));
    say(dim('  Dry run — not written.'));
    return;
  }

  const yes = await decide(argv, 'hook', 'Add the hook?', asker);
  if (yes === undefined) say(`  ${INFO()} Not added: no terminal to ask in. To add it: ${bold(HOOK_CMD)}`);
  if (!yes) return;
  describeHook(applyHook(path));
}

export async function cmdSetup(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  asker: Asker = TERMINAL,
  cwd: string = process.cwd(),
): Promise<number> {
  const { apiKey } = resolveSettings(DEFAULT_API_BASE, env, () => {});
  if (!apiKey || flag(argv, 'force')) {
    const code = await cmdLogin(argv, env);
    if (code !== 0) return code;
  } else {
    say(`${OK()} Already signed in — skipping login (use --force to re-link).`);
  }

  const installCode = cmdInstall(argv.filter((a) => a !== '--force'), env);
  if (installCode !== 0) return installCode;

  const dryRun = flag(argv, 'dry-run') || flag(argv, 'print');
  const clients = habitClients(argv, env);
  await offerRule(argv, clients, cwd, dryRun, asker);
  await offerHook(argv, clients, dryRun, asker);

  return cmdDoctor([], env, cwd);
}
