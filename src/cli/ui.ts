// Terminal output helpers.
//
// Everything the CLI prints goes to STDOUT here — but note the MCP server
// itself prints only to stderr (stdout carries the protocol). The two never
// run at the same time: a subcommand exits before any transport is created.
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

const useColor =
  process.stdout.isTTY === true &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb';

const wrap = (code: string) => (s: string): string => (useColor ? `[${code}m${s}[0m` : s);

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');

export const OK   = (): string => green('✓');
export const FAIL = (): string => red('✗');
export const WARN = (): string => yellow('!');
export const INFO = (): string => dim('·');

export function say(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function heading(text: string): void {
  say();
  say(bold(text));
}

/**
 * Opens a URL in the user's browser, best effort. Returns false when there is
 * clearly no browser to open (headless Linux, CI) so the caller prints the URL
 * instead of pretending something happened.
 */
export function openBrowser(url: string): boolean {
  const os = platform();
  const headlessLinux =
    os === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.WSL_DISTRO_NAME;
  if (process.env.CI || headlessLinux) return false;

  const [cmd, args] =
    os === 'darwin' ? ['open', [url]] :
    os === 'win32'  ? ['cmd', ['/c', 'start', '', url]] :
                      ['xdg-open', [url]];

  try {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no browser handler — the URL is printed anyway */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Big enough to read across a room, small enough to fit a narrow terminal. */
export function codeBox(code: string): string {
  const inner = `  ${code}  `;
  const rule = '─'.repeat(inner.length);
  return [`┌${rule}┐`, `│${inner}│`, `└${rule}┘`].join('\n');
}
