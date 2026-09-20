// "You are running a server five releases old" - said once, where it is read.
//
// WHY THIS IS NOT A LINE IN root_cause ANY MORE. On 2026-09-20 an outside agent
// spent a session on a July @debugai/mcp 2.1.1 while 2.6.0 was published. Three
// of the seven problems it reported had been fixed weeks earlier and never
// reached its machine. The API HAD been telling it: a note appended to the end
// of `root_cause` on every answer. It read as boilerplate, and it is hard to
// blame it - root_cause is the field an agent quotes to its user, so anything
// glued to the end arrives as part of the diagnosis rather than as a fact about
// the tooling.
//
// So the API now sends `client_update` as its own field to any server new
// enough to render it (services/mcpLatest.ts, RENDERS_UPDATE_FIELD), and keeps
// the prose only for servers that have no other field they are sure to print.
//
// ONCE PER PROCESS, not once per day. The API used to ration the note with a
// daily Redis claim per account, which is the wrong unit twice over: a busy day
// is many sessions, and an agent restarted five times sees it once. An MCP
// server is a long-lived process and a process IS the session, so the client is
// the only side that can throttle this correctly. Said at the top of the first
// answer that carries it, then never again.

export interface ClientUpdate {
  /** The version this server is running. */
  current: string;
  /** The newest release on npm, read by the API off the request path. */
  latest: string;
  /** What to run. Sent by the API so it is never a version written into code. */
  command: string;
}

let announced = false;

/** Test seam: a module-level latch that would otherwise leak between tests. */
export function __resetClientUpdate(): void {
  announced = false;
}

/**
 * The banner for this answer, or null - because there is no update, because the
 * payload is not the shape it claims, or because this process already said it.
 *
 * Never throws: it sits on the reply path of a tool that has already done the
 * expensive work, and losing an answer to a version notice would be absurd.
 */
export function clientUpdateBanner(update: unknown): string | null {
  if (announced) { return null; }
  if (!update || typeof update !== 'object') { return null; }
  const u = update as Partial<ClientUpdate>;
  if (typeof u.current !== 'string' || typeof u.latest !== 'string') { return null; }
  if (!u.current || !u.latest) { return null; }
  announced = true;
  const command = typeof u.command === 'string' && u.command
    ? u.command
    : 'npx -y @debugai/mcp@latest install';
  return (
    `> **This is DebugAI MCP ${u.current}. ${u.latest} is published.**\n` +
    '> Answers below still come from the current backend, but anything fixed in\n' +
    '> the client since then is missing here: the files it reads off disk, the\n' +
    '> project it reports, the fields it sends.\n' +
    `> Run \`${command}\`, then restart this agent. Shown once per session.\n`
  );
}
