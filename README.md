# @debugai/mcp

<p align="center">
  <a href="https://www.npmjs.com/package/@debugai/mcp"><img src="https://img.shields.io/npm/v/@debugai/mcp?color=0A0A0F&label=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-0A0A0F" alt="Node 18+">
  <img src="https://img.shields.io/badge/license-MIT-0A0A0F" alt="MIT license">
</p>

Give your coding agent a debugger instead of a grep loop.

Your agent hands an error to `debug_error` and gets back the root cause, the exact file and line, and up to 3 ranked fixes as ready-to-apply edits. Each fix is labeled with whether a mechanical check actually passed, so the agent knows which ones were checked and which are the model's own estimate.

Auto-configures Claude Code, Claude Desktop, Cursor, Windsurf, Zed, Gemini CLI, and Cline. Works in any other MCP client with a manual entry. Node 18 or later.

## Setup

```bash
npx -y @debugai/mcp setup
```

That is the whole thing. It signs you in through your browser (no key to find or copy), writes the config for every MCP client it finds on this machine, then checks that all of it actually works.

Restart the clients it names and your agent has the tools.

Prefer to read first? [debugai.io/start?src=npm](https://debugai.io/start?src=npm) walks the same thing per client.

### What that command does to your machine

Worth knowing before you run something that edits your editor config:

- Signs you in with a short code you confirm in the browser. Free account, 10 debugs a day, no card.
- Stores your key in `~/.debugai/config.json` with `0600` permissions. That is the only file that ever holds it.
- Adds a `debugai` entry to the config of each MCP client it detects. Every file is backed up first (`<file>.debugai-backup-<timestamp>`), every other setting in the file is preserved, and a file it cannot parse is left alone and reported instead. One caveat stated plainly: if your config contains comments, the rewrite drops them, because JSON has nowhere to put them. You get a warning before it happens and the backup still has them.
- Skips VS Code by default, because the [DebugAI extension](https://marketplace.visualstudio.com/items?itemName=debugai.debugai) already registers this server there and a second entry would show every tool twice. `install --client=vscode` does it anyway if you want the server without the extension.
- Never writes your key into a client config. Client configs get committed to repos. Keys should not.

Preview it without writing anything:

```bash
npx -y @debugai/mcp install --dry-run
```

Undo all of it:

```bash
npx -y @debugai/mcp uninstall   # removes the entry from every client config
npx -y @debugai/mcp logout      # removes the stored key
```

### Commands

| Command | What it does |
|---------|--------------|
| `setup` | `login` then `install`, then verifies. The one you want. |
| `login` | Browser sign-in. `--key dbg_…` to paste a key instead (CI, air-gapped boxes). `--force` to re-link. |
| `logout` | Removes the stored key. |
| `status` | Which key and account are active right now. |
| `install` | Writes client configs. `--list`, `--client=cursor`, `--all`, `--dry-run`, `--remove`. |
| `uninstall` | Removes the entry from every client config. |
| `doctor` | Diagnoses a broken setup: key, API reachability, per-client wiring. |

`npx -y @debugai/mcp install --list` prints every supported client, where its config lives on your OS, and whether DebugAI is already in it.

### Signing in from inside a chat

If your agent calls a DebugAI tool before you have signed in, the tool answers with a short code and a URL instead of an error. Confirm it in the browser, tell the agent to try again, and the call goes through. No config editing, and no client restart, because the key is re-read on every call.

## The tools

### `debug_error`

Give it an error, get an analysis.

| Input | Required | Description |
|-------|----------|-------------|
| `errorText` | yes | Full error message, exception, or stack trace. |
| `language` | no | `javascript`, `typescript`, `python`, `go`, `rust`, or `auto` (default). |
| `codeSnippet` | no | Code around the failing line, if the agent has it. |
| `filePath` | no | Path to the file that threw. |

Returns the root cause, up to 3 fixes ranked by confidence, the detected framework, and whether the answer came from cache. Since 2.0 each fix also carries, where derivable: `edits` (exact old/new strings your agent's edit tool can apply directly), `unified_diff`, and `verify_with` (a syntax-level check command to run after applying). Read-only: it never touches your files. Applying a fix is your agent's call, and yours.

Every fix is labeled with its verification state, and there are three of them, not two: **verified** (a mechanical check passed, currently parse and import classes), **failed check** (confidence capped hard), or **not verified** (the confidence number is the model's own estimate, nothing checked it). We label the third case instead of hiding it.

### `report_outcome`

Tell DebugAI whether an applied fix actually worked.

| Input | Required | Description |
|-------|----------|-------------|
| `debugLogId` | yes | The `debug_log_id` from the `debug_error` response. |
| `result` | yes | `worked` or `failed`. |
| `fixRank` | no | Which ranked fix was applied (1-3). |
| `newError` | no | If it failed: the error you saw after applying. |

Confirmed rank-1 fixes are remembered per project, so the next hit on the same error starts from the confirmed fix. Failed-fix follow-ups are the feedback that improves future answers. Agents are asked to call this once per applied fix, through the same pipeline human feedback flows through in the VS Code extension.

Example, in Claude Code:

> Paste a traceback and ask "why is this failing?". Claude calls
> `debug_error` and gets back something like:
>
> **Root cause:** `db.session` is used after the request context closed.
> **Fix 1 (94% confidence):** move the query inside the request handler...

### Making your agent reach for it

The server tells connecting agents what it is for, but a rule in your project file is the deterministic version. Add this to `CLAUDE.md`, `.cursorrules`, or whatever your agent reads:

```
On any runtime error, exception, or failing test, call the debugai
debug_error tool before attempting your own fix. After applying a fix,
call report_outcome so the project's error memory stays accurate.
```

## VS Code

You do not need this package. The [DebugAI extension](https://marketplace.visualstudio.com/items?itemName=debugai.debugai) registers the MCP server automatically (VS Code 1.101+) and adds one-click fix apply, proactive scan, and codebase indexing on top. It is on [Open VSX](https://open-vsx.org/extension/debugai/debugai) too, for Cursor, Windsurf, and VSCodium.

## Manual setup

`setup` covers this, and `install --client=<id>` covers the case where a client is installed somewhere unusual. If you would still rather edit the file yourself, the entry is the same everywhere:

```json
{
  "mcpServers": {
    "debugai": {
      "command": "npx",
      "args": ["-y", "@debugai/mcp"]
    }
  }
}
```

Where it goes:

| Client | File |
|--------|------|
| Claude Code | `~/.claude.json` (or `claude mcp add debugai -- npx -y @debugai/mcp`) |
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `~/.gemini/settings.json` |
| Cline | VS Code globalStorage, `saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |

Zed uses a different key and a nested command:

```json
{
  "context_servers": {
    "debugai": {
      "source": "custom",
      "command": { "path": "npx", "args": ["-y", "@debugai/mcp"] }
    }
  }
}
```

Then run `npx -y @debugai/mcp login` once to store your key. If you would rather set the key per client, `DEBUGAI_API_KEY` in that client's `env` block still works and still wins over the stored one.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEBUGAI_API_KEY` | (none) | Your API key. Overrides `api_key` in the config file. |
| `DEBUGAI_API_BASE` | DebugAI production | Override for self-hosted or staging setups. Falls back to `api_base` in the config file. |
| `DEBUGAI_TIMEOUT_MS` | `150000` | Per-request deadline. Deep analyses can take 30-90s. |
| `DEBUGAI_CONFIG_PATH` | `~/.debugai/config.json` | Alternate config file location. Rarely needed. |

## Limits and honesty

- Free tier: 10 debugs/day. Pro ($12/mo): 1,000/mo soft cap, never hard-blocked at it.
- When you hit the daily cap the tool says so and stops. It will not silently retry.
- Simple errors route to a fast model. Ugly cross-file ones route to a stronger one on paid tiers. The `Model:` badge in each response tells you which one answered.
- Analyses run on DebugAI's servers. The error text and any snippet you pass are sent there, and Claude (Anthropic) does the analysis. Privacy policy: [debugai.io/privacy](https://debugai.io/privacy?src=npm).

## Troubleshooting

Run `npx -y @debugai/mcp doctor` first. It checks your Node version, whether a key is stored and where it came from, whether that key still authenticates against the API, the permissions on the config file, and which detected clients are missing the DebugAI entry. Most answers are in that output.

- **"authentication failed"**: the key was rotated or revoked. Run `npx -y @debugai/mcp login --force`.
- **Tools do not appear in the client**: the client was not restarted, or it reads a different config file. `install --list` shows which file was written.
- **Nothing happens on `npx @debugai/mcp`**: correct. It is a stdio server waiting for an MCP client to speak first. Use `--help` to verify the install.
- **Timeouts**: deep analyses can take up to 90s. If your client has its own tool timeout, raise it above that.

## Changelog

**2.1.0**: one-command setup. Browser sign-in over a device link (no key pasting), automatic client config writing with backups, `doctor` for diagnosing a broken setup, and in-conversation sign-in when an agent calls a tool before you have an account.

**2.0.0**: `report_outcome` tool, ready-to-apply `edits` per fix, and the three-state verification label.

## Development

```bash
npm install
npm test        # builds, then runs unit + spawned-process e2e tests
```

## Source

[github.com/1shizaan/debugai-mcp](https://github.com/1shizaan/debugai-mcp) is the source for this package, mirrored from the directory it is developed in. It carries the full commit history for these files, so `git log` and `git blame` work normally.

The client is MIT and complete: the stdio server, the device-link sign-in, the config writer, and the tests are all here. The analysis itself runs on DebugAI's servers and is not part of this package.

Issues and pull requests are welcome on that repository.

MIT © DebugAI
