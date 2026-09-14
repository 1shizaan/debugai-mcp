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
| `language` | no | `auto` (default), or name it: `javascript`, `typescript`, `python`, `java`, `csharp`, `go`, `rust`, `cpp`, `c`, `php`, `ruby`, `kotlin`, `swift`, `lua`, `shell`, `powershell`, `sql`, `html`, `css`, `scala`, `dart`, `elixir`, `r`, `perl`. Leave it on `auto` unless you have a reason: the server reads the error text and is right about it almost always. |
| `codeSnippet` | no | Usually unnecessary — see below. Overrides the local read when given. |
| `filePath` | no | Path to the file that threw. |

Returns the root cause, up to 3 fixes ranked by confidence, the detected framework, and whether the answer came from cache. Since 2.0 each fix also carries, where derivable: `edits` (exact old/new strings your agent's edit tool can apply directly), `unified_diff`, and `verify_with` (a syntax-level check command to run after applying). It never writes to your files. Applying a fix is your agent's call, and yours.

Every fix is labeled with its verification state, and there are three of them, not two: **verified** (a mechanical check passed, currently parse and import classes), **failed check** (confidence capped hard), or **not verified** (the confidence number is the model's own estimate, nothing checked it). We label the third case instead of hiding it.

#### It reads the source the trace names (2.2)

Paste a raw traceback and nothing else. This server runs on your machine, so it resolves the files in the stack trace and sends the relevant code along. Before 2.2 it could not, and an error pasted without code came back as *"Insufficient context for specific fix"* at 20% confidence — the common case, not the edge one.

The response names every file it read (`Read locally: src/api.ts, src/db.ts`, and `local_files_read` in the structured payload), so a wrong guess is visible rather than silent.

Exactly what it will and will not read:

- **Inside your project only.** The boundary is your git repo root, or the working directory when that is not a repo. It is checked *after* symlinks resolve, so a path in an error message cannot walk out of the project — `../../.ssh/id_rsa` and a symlink pointing outside both fail the same check.
- **Source files only**, by extension allowlist (`.ts .tsx .js .jsx .mjs .cjs .py .go .rs .rb .java .kt .php .cs .swift .vue .svelte`). `.env`, `.pem`, key files, dumps and images are not on it, so they are never candidates.
- **Bounded**: at most 3 files, 256 KB each, and a large file is sent as a ±40-line window around the failing line rather than whole. Windowed blocks say so.
- **Vendored code is skipped** — `node_modules`, `site-packages`, `dist`, `.venv` and friends. Your code is what needs explaining.
- **Your snippet always wins.** Pass `codeSnippet` and nothing is read from disk.

Whatever it reads is sent to DebugAI's API for analysis, same as the error text. If that is not acceptable for a given repo, pass `codeSnippet` explicitly and the local read never happens.

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

The two servers are the same protocol surface and are kept in step by a test that reads both copies as text, because a comment saying "keep these in sync" has failed here before. From extension 2.8.1 the bundled server also does local source resolution, which this package has had since 2.2.0. Until then, an agent on the bundled server that pasted a traceback into a workspace nobody had indexed still got "Insufficient context for specific fix" at 20% confidence, which is the exact answer this feature exists to remove.

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

> **On Claude Code, `--scope user` is the part that matters.** `claude mcp add`
> defaults to `--scope local`, which writes the server under
> `projects."/your/dir".mcpServers` — it then works in that one directory and
> nowhere else, which reads exactly like DebugAI needing to be set up per repo.
> `debugai-mcp install` always writes the user scope. If you already ran the
> local-scope version, `debugai-mcp doctor` now tells you which one you have.

| Client | File |
|--------|------|
| Claude Code | `~/.claude.json`, top-level `mcpServers` (or `claude mcp add --scope user debugai -- npx -y @debugai/mcp`) |
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
- Analyses run on DebugAI's servers. The error text, any snippet you pass, and — since 2.2 — the project source files the stack trace names are sent there, and Claude (Anthropic) does the analysis. The response lists every file that was read. Scope and limits are spelled out under [`debug_error`](#it-reads-the-source-the-trace-names-22). Privacy policy: [debugai.io/privacy](https://debugai.io/privacy?src=npm).
- Errors are remembered per project so a repeat hit starts from a fix that was already confirmed. The project identity is a hash of your repo root path; the path itself is never sent.
- The VS Code extension reads the project's `requirements.txt`, `pyproject.toml` and `package.json` and the interpreter the editor has selected, which is what lets it tell "not installed" apart from "installed under a different interpreter". This server sends none of that, so on a missing-module error you get the general answer and the check to run, not a verdict. You have a shell and it does not, so the honest division is that you run the check. Reporting those facts back through this server is planned.

## Troubleshooting

Run `npx -y @debugai/mcp doctor` first. It checks your Node version, whether a key is stored and where it came from, whether that key still authenticates against the API, the permissions on the config file, and which detected clients are missing the DebugAI entry. Most answers are in that output.

- **"authentication failed"**: the key was rotated or revoked. Run `npx -y @debugai/mcp login --force`.
- **Tools do not appear in the client**: the client was not restarted, or it reads a different config file. `install --list` shows which file was written.
- **Nothing happens on `npx @debugai/mcp`**: correct. It is a stdio server waiting for an MCP client to speak first. Use `--help` to verify the install.
- **Timeouts**: deep analyses can take up to 90s. If your client has its own tool timeout, raise it above that.

## Changelog

**Note on updates**: the analysis runs on DebugAI's servers, so improvements to
error parsing, retrieval and root-cause quality reach you without upgrading this
package. Client releases are only for things that change on your machine.

Recent server-side work, all of it live for agents already:

- `ModuleNotFoundError` no longer opens with an install command. A read of every
  one we had answered found five of eight rejected by the agent that received
  them, for three different causes needing three different fixes: the package
  was installed under another interpreter, the name was a local file, or the
  import line was malformed. Rank 1 is now the check that tells those apart.
- A Python `SyntaxError` is no longer diagnosed as a JavaScript one, and the
  framework is read from the error text rather than from what the repository
  contains.
- Operating-system errors (`Access is denied.`, `No space left on device`) are
  recognised as errors. Thirty were probed and twenty-eight had been refused.
- Credentials in the text you send are replaced before anything is stored or
  reaches a model.
- pytest, unittest, jest, vitest and mocha output yields real file paths, so a
  failing test gets cross-file context instead of none.

**2.5.1** - `language` accepts 24 languages instead of 6. It listed javascript,
typescript, python, go, rust and auto, so an agent naming anything else got its
call rejected and had to retry with `auto`. Four of the ten busiest accounts in
the September logs were in that position - java, csharp, css and lua, 52 debugs
between them. The quieter half was worse: the retry succeeds, so every one of
those rows recorded `language = unknown`, which made a Java stack trace look like
a detection failure and made every language count under-report exactly the
languages that were missing. `auto` is still the default and still the right
answer almost always.

**2.5.0** - The server now reads what your project declares and sends it with the
error: dependency names and the versions your own manifests pin, including
`.csproj` for .NET and nested manifests in a monorepo. The engine could never see
your disk, so it used to guess at third-party APIs - it now knows when a version
is pinned exactly, and says it does not know when nothing pins it. `.env` is
never opened; only its existence is reported.

**2.4.2**: the bundled server prints the memory it advertises. This package and
the copy bundled in the VS Code extension are the same server, and only this one
was rendering the recurrence count and confirmed fix that both of them promise an
agent at connect time. The section is now one module both copies call, so there
is nothing left to keep in step by hand.

**2.4.1**: two tool descriptions repaired. An em-dash strip had cut both of them
mid-sentence, which matters more here than it reads: a tool description is the
only thing an agent sees before deciding whether to call this server at all.

**2.4.0**: `report_outcome` gains `unused`. An agent that solved the problem its
own way had to report `failed`, which marks a fix as tried and beaten when
nothing of ours was ever run. Both tool surfaces, the npm server and the one
bundled in the VS Code extension, now take the same fields.

**2.3.0**: agents get the same four memory states the editor panel does.
`debug_error` had two branches, and a fix that had been tried and kept failing
read identically to one nobody had tried. To an agent those are the same
sentence, so the natural next move is to propose the fix that already did not
work. The four states now match the panel: confirmed and verified, confirmed,
unproven, and anti-pattern.

**2.2.0**: two things that were advertised but not delivered.

- **Local source resolution.** The server now reads the files a stack trace names and sends them with the request. Before this, an agent that pasted a traceback got "Insufficient context for specific fix" at 20% confidence, because the only other source of code was an index that nothing outside the VS Code extension populates. Bounded to your repo root, source extensions, 3 files. The response names what it read.
- **Project-scoped error memory.** Nothing in this package ever sent a `project_id`, and the engine gates recurrence counts and confirmed fixes on it — so every agent request got no recall and recorded none, while the server instructions told agents it did. Now derived from your git repo root, matching the VS Code extension's id for the same checkout, so both surfaces share one memory. `debug_error` surfaces "seen 3x before, fix confirmed" when it applies.

**2.1.1**: metadata only. Adds `mcpName` for official MCP registry ownership verification, fixes the npm package page's repository link.

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
