// How the sign-in address reaches a browser.
//
// Windows used `cmd /c start "" <url>`. The address the API hands out is
// `https://debugai.io/link?code=ABCD-2345&src=mcp`, and to cmd.exe `&` ends a
// command. Measured on Windows 2026-10-01: the browser was sent the address up
// to the `&`, and cmd then ran `src=mcp` as a program ("'src' is not recognized
// as an internal or external command"). So the tag was lost from every Windows
// sign-in, and a string from a network response was run as a command line.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { browserCommands } from '../src/cli/ui.js';

const URL_FROM_API = 'https://debugai.io/link?code=ABCD-2345&src=mcp';
const DESKTOP = { DISPLAY: ':0' };
const SHELLS = /^(cmd|cmd\.exe|sh|bash|powershell|powershell\.exe|pwsh)$/i;

describe('the sign-in address is an argument, never a command line', () => {
  it('the address the API hands out really does carry an `&`', () => {
    // Read as text (Rule 15b): this is why no shell may sit in between.
    const api = readFileSync(new URL('../../../apps/api/src/routes/deviceLink.ts', import.meta.url), 'utf8');
    expect(api).toMatch(/verification_uri_complete: `\$\{verificationUri\}\?code=\$\{encodeURIComponent\(userCode\)\}&src=mcp`/);
  });

  it.each(['win32', 'darwin', 'linux'] as const)('%s: no shell, and the whole address is one argument', (os) => {
    const commands = browserCommands(URL_FROM_API, os, DESKTOP);
    expect(commands.length).toBeGreaterThan(0);
    for (const [cmd, args] of commands) {
      expect(cmd, `${os} hands the address to a shell`).not.toMatch(SHELLS);
      expect(args[args.length - 1]).toBe(URL_FROM_API);
      expect(args.filter((a) => a.includes('debugai.io'))).toHaveLength(1);
    }
  });

  it('Windows opens it through the URL handler', () => {
    expect(browserCommands(URL_FROM_API, 'win32', {})).toEqual([['rundll32', ['url.dll,FileProtocolHandler', URL_FROM_API]]]);
  });

  it('WSL tries Windows\' browser first, then its own opener', () => {
    expect(browserCommands(URL_FROM_API, 'linux', { WSL_DISTRO_NAME: 'Ubuntu' }).map(([c]) => c)).toEqual(['rundll32.exe', 'xdg-open']);
  });

  it('macOS and a Linux desktop use their own opener', () => {
    expect(browserCommands(URL_FROM_API, 'darwin', {})).toEqual([['open', [URL_FROM_API]]]);
    expect(browserCommands(URL_FROM_API, 'linux', DESKTOP)).toEqual([['xdg-open', [URL_FROM_API]]]);
  });
});

describe('when nothing is opened', () => {
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'calc.exe', 'https://a b', ''])(
    '%p is not a web address', (bad) => {
      for (const os of ['win32', 'darwin', 'linux'] as const) expect(browserCommands(bad, os, DESKTOP)).toEqual([]);
    });

  it('CI and a Linux box with no display have no browser', () => {
    expect(browserCommands(URL_FROM_API, 'win32', { CI: '1' })).toEqual([]);
    expect(browserCommands(URL_FROM_API, 'linux', {})).toEqual([]);
  });
});
