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
 * The programs that open `url` in a browser here, in the order to try them, or
 * none when there is clearly no browser (headless Linux, CI) or `url` is not a
 * web address.
 *
 * Never a shell. Windows used `cmd /c start "" <url>`, which hands the address
 * to cmd.exe's parser, and there `&` ends a command: the sign-in address is
 * `...?code=ABCD-2345&src=mcp`, so the browser was sent `...?code=ABCD-2345`
 * and cmd then ran `src=mcp` as a program. Measured on Windows 2026-10-01:
 * `'src' is not recognized as an internal or external command`. The campaign
 * tag never reached the site from any Windows sign-in, and a string from a
 * network response was being executed as a command line. rundll32 is given
 * the address as one argument and no parser sits in between.
 */
export function browserCommands(
  url: string,
  os: NodeJS.Platform = platform(),
  env: NodeJS.ProcessEnv = process.env,
): Array<[string, string[]]> {
  if (!/^https?:\/\/\S+$/i.test(url)) return [];
  const headlessLinux = os === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.WSL_DISTRO_NAME;
  if (env.CI || headlessLinux) return [];

  if (os === 'darwin') return [['open', [url]]];
  if (os === 'win32') return [['rundll32', ['url.dll,FileProtocolHandler', url]]];
  // WSL has Windows' browser and usually no xdg-open of its own.
  if (env.WSL_DISTRO_NAME) {
    return [['rundll32.exe', ['url.dll,FileProtocolHandler', url]], ['xdg-open', [url]]];
  }
  return [['xdg-open', [url]]];
}

/**
 * Opens a URL in the user's browser, best effort. Returns false when there is
 * clearly no browser to open, so the caller prints the URL instead of
 * pretending something happened.
 */
export function openBrowser(url: string): boolean {
  const candidates = browserCommands(url);
  if (!candidates.length) return false;

  const launch = (i: number): boolean => {
    const [cmd, args] = candidates[i];
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      // Not there: try the next one. The URL is printed either way.
      child.on('error', () => { if (i + 1 < candidates.length) launch(i + 1); });
      child.unref();
      return true;
    } catch {
      return i + 1 < candidates.length ? launch(i + 1) : false;
    }
  };
  return launch(0);
}

/** Big enough to read across a room, small enough to fit a narrow terminal. */
export function codeBox(code: string): string {
  const inner = `  ${code}  `;
  const rule = '─'.repeat(inner.length);
  return [`┌${rule}┐`, `│${inner}│`, `└${rule}┘`].join('\n');
}
