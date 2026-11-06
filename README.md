# @debugai/mcp

<p align="center">
  <a href="https://www.npmjs.com/package/@debugai/mcp"><img src="https://img.shields.io/npm/v/@debugai/mcp?color=0A0A0F&label=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18.14.1-0A0A0F" alt="Node 18.14.1+">
  <img src="https://img.shields.io/badge/license-MIT-0A0A0F" alt="MIT license">
</p>

Give your coding agent a debugger instead of a grep loop.

Your agent hands an error to `debug_error` and gets back the root cause, the exact file and line, and up to 3 ranked fixes as ready-to-apply edits. Each fix is labeled with whether a mechanical check actually passed, so the agent knows which ones were checked and which are the model's own estimate.

Before any of that, `lookup_error` asks your project's memory whether this error has happened here before and which fix held. It makes no model call and does not count against your limit, so an agent can afford it on every failure. In Claude Code a [hook](#claude-code-hook) runs it for every failed command without the agent having to remember.

Auto-configures Claude Code, Claude Desktop, Cursor, Windsurf, Zed, Gemini CLI, and Cline. Works in any other MCP client with a manual entry. Node 18.14.1 or later.

**New in 2.7.0:** machine-applicable edits now name the file their code is
actually in, the tools say to call them the moment something fails rather than
waiting for you to paste an error, and a server that has fallen behind says so
once per session instead of in the middle of every diagnosis. A server started
in your home folder, a folder above it or the filesystem root no longer treats
that as a project: it reads no local files until the agent names a `projectRoot`.
See the [changelog](https://debugai.io/changelog?src=npm-readme).

**If a fix does not work, tell me and I will fix it.** The fixes that did not
work are how most of this release got written.
**[Dashboard → Messages](https://debugai.io/dashboard?tab=messages&src=npm-readme)**,
with the error you sent and what the fix did instead. It reaches the person who
builds this.

## Setup

```bash
npx -y @debugai/mcp setup
```

That is the whole thing. It signs you in through your browser (no key to find or copy), writes the config for every MCP client it finds on this machine, offers to add the [rule](#making-your-agent-reach-for-it) and the [Claude Code hook](#claude-code-hook) that make your agent call DebugAI when a command fails, then checks that all of it actually works. Run it inside your project, where the rule goes.

Restart the clients it names and your agent has the tools.

Prefer to read first? [debugai.io/start?src=npm](https://debugai.io/start?src=npm) walks the same thing per client.

### What that command does to your machine

Worth knowing before you run something that edits your editor config:

- Signs you in with a short code you confirm in the browser. Free account, 10 debugs a day, no card.
- Stores your key in `~/.debugai/config.json` with `0600` permissions. That is the only file that ever holds it.
- Adds a `debugai` entry to the config of each MCP client it detects. Every file is backed up first (`<file>.debugai-backup-<timestamp>`), every other setting in the file is preserved, and a file it cannot parse is left alone and reported instead. One caveat stated plainly: if your config contains comments, the rewrite drops them, because JSON has nowhere to put them. `install` writes first and tells you afterwards, and the backup still has them. `install --dry-run` tells you before anything is written.
- Skips VS Code by default, because the [DebugAI extension](https://marketplace.visualstudio.com/items?itemName=debugai.debugai) already registers this server there and a second entry would show every tool twice. `install --client=vscode` does it anyway if you want the server without the extension.
- Never writes your key into a client config. Client configs get committed to repos. Keys should not.
- Asks before adding the rule to the end of the instruction file each of your agents reads in this project (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, or the first file on Zed's list), and before adding the hook to `~/.claude/settings.json`, backed up first. Enter alone is yes. With no terminal to ask in it adds neither and prints the command that would; `--rules`, `--no-rules`, `--hook` and `--no-hook` answer without asking. It never adds either twice.

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
| `setup` | `login` then `install`, then offers the rule and the Claude Code hook, then verifies. The one you want. `--rules`, `--no-rules`, `--hook`, `--no-hook`, `--dry-run`. |
| `login` | Browser sign-in. `--key dbg_…` to paste a key instead (CI, air-gapped boxes). `--force` to re-link. |
| `logout` | Removes the stored key. |
| `status` | Which key and account are active right now. |
| `install` | Writes client configs. `--list`, `--client=cursor`, `--all`, `--dry-run`, `--remove`. |
| `uninstall` | Removes the entry from every client config. |
| `doctor` | Diagnoses a broken setup: key, API reachability, per-client wiring, a config entry with no version, a key sitting in plain text in a client config. |
| `hook` | The Claude Code hook. Reads a failed command from stdin and prints what project memory knows. See [Claude Code hook](#claude-code-hook). |
| `try` | Makes the planted-bug project from [Your first debug](https://docs.debugai.io/first-debug) in a new folder, `debugai-first-bug` unless you name one, and says what to do with it. `--lang python` (the default) or `--lang js`. Never writes into a folder that exists. |

`npx -y @debugai/mcp install --list` prints every supported client, where its config lives on your OS, and whether DebugAI is already in it.

### Signing in from inside a chat

If your agent calls a DebugAI tool before you have signed in, the tool answers with a short code and a URL instead of an error. Confirm it in the browser, tell the agent to try again, and the call goes through. No config editing, and no client restart, because the key is re-read on every call.

## The tools

The loop they are built for: a command fails, `lookup_error` answers from memory in under a second, a confirmed fix is applied and the command re-run. When memory has nothing, `debug_error` does the analysis. Either way `report_outcome` says what happened, which is what the next lookup reads.

### `lookup_error`

Has this project seen the error before, and what held? (2.6)

| Input | Required | Description |
|-------|----------|-------------|
| `errorText` | yes | The error or stack trace, as you would pass it to `debug_error`. |
| `projectRoot` | no | Absolute path of the repository the error came from, when the agent was started somewhere else. |
| `filePath` | no | An absolute path inside that repository. Its git root names the project. |

It is two small database reads and no model call, so it is free: it does not count against the debug limit (a separate, generous rate limit keeps it honest). It returns how many times the error was seen in this project and when, the stored fix and what state it is in, and fixes this project recently reported as failed:

- **confirmed**: somebody applied it and said it worked. The answer says whether a live session watched the error stop or it was only accepted, because those are different amounts of evidence.
- **unproven**: it was applied and the error has come back once since. Check it against the code as it is now.
- **anti-pattern**: the error came back two or more times after it. The answer names it as the thing not to do.

A miss says so and points at `debug_error`. The text of the error is prepared exactly as a debug prepares it, credentials redacted first, so a lookup and a debug of one failure read the same memory row. A lookup writes nothing: it is not a debug and not a sighting.

### `debug_error`

Give it an error, get an analysis.

| Input | Required | Description |
|-------|----------|-------------|
| `errorText` | yes | Full error message, exception, or stack trace. A bug with no error text works too: say what you expected, what happened instead, and include the code in between. |
| `language` | no | `auto` (default), or name it: `javascript`, `typescript`, `python`, `java`, `csharp`, `go`, `rust`, `cpp`, `c`, `php`, `ruby`, `kotlin`, `swift`, `lua`, `shell`, `powershell`, `sql`, `html`, `css`, `scala`, `dart`, `elixir`, `r`, `perl`. Leave it on `auto` unless you have a reason: the server reads the error text and is right about it almost always. A name that is not on this list (`markdown`, `cobol`) is not an error: it is treated as `auto`. |
| `codeSnippet` | no | Usually unnecessary, see below. Overrides the local read when given. |
| `snippetStartLine` | no | With `codeSnippet`: the line of the file that the first line of the snippet is. Pass it when the snippet is a window from the middle of a file. Without it the lines are counted from 1, and an error that says `Line 44` cannot be matched to a 15-line snippet. (2.7) |
| `filePath` | no | Path to the file that threw. An absolute path also names the repository the error belongs to. |
| `projectRoot` | no | Absolute path of the repository, when the agent was started somewhere else. Project memory and local reads are scoped to it. (2.6) |
| `cwd` | no | The folder the failing command ran in, when it was not the project root: absolute, or relative to the project root, and inside it. A relative path in the error is looked for there first, and the dependencies are read from the nearest manifest folder at or above it. Outside the project it is ignored, and the footer says so. |
| `reproCommand` | no | The command that shows the failure: a test, a script, a curl. Fix #1 is aimed at making it pass, and each fix's check becomes this command instead of a syntax check. DebugAI never runs it. Up to 500 characters. (2.6) |
| `expected` | no | What `reproCommand` should print or do once the bug is fixed. Up to 500 characters. (2.6) |

Returns the root cause, up to 3 fixes ranked by confidence, the detected framework, and whether the answer came from cache. Each fix also carries, where derivable: `edits` (exact old/new strings your agent's edit tool can apply directly), `unified_diff`, and `verify_with`, the check to run after applying. With `reproCommand` that check is your command and the result you said to expect; without it, a syntax-level check. It never writes to your files and never runs your reproduction. Applying a fix is your agent's call, and yours.

An error longer than the 3,000 characters the API accepts is cut rather than refused: the start (where JavaScript, Java and .NET print the error) and the end (where Python prints it) are kept, the middle goes, and the answer says so. The same cut is made by `lookup_error` and the hook, so all three read one memory row for one failure. (2.6)

A footer on every answer names the project it was filed under, says when memory was off for it and why, and gives the version of this server and the engine build that answered. A session running on an old copy can see that it is, and an answer can be traced to the code that produced it. (2.6)

Every fix is labeled with its verification state, and there are three of them, not two: **verified** (a mechanical check passed, currently parse and import classes), **failed check** (confidence capped hard), or **not verified** (the confidence number is the model's own estimate, nothing checked it). We label the third case instead of hiding it.

#### It reads the source the trace names (2.2)

Paste a raw traceback and nothing else. This server runs on your machine, so it resolves the files in the stack trace and sends the relevant code along. Before 2.2 it could not, and an error pasted without code came back as *"Insufficient context for specific fix"* at 20% confidence. That was the common case, not the edge one.

The response names every file it read (`Read locally: src/api.ts, src/db.ts`, and `local_files_read` in the structured payload), so a wrong guess is visible rather than silent.

Exactly what it will and will not read:

- **Inside your project only.** The boundary is your git repo root, or the working directory when that is not a repo. When that is your home directory, a folder above it or the filesystem root there is no boundary to read inside, so nothing local is read and the reply says so; pass `projectRoot` to name the project. It is checked *after* symlinks resolve, so a path in an error message cannot walk out of the project: `../../.ssh/id_rsa` and a symlink pointing outside both fail the same check.
- **Source files only**, by extension allowlist (`.ts .tsx .js .jsx .mjs .cjs .py .pyi .go .rs .rb .java .kt .kts .scala .groovy .gradle .php .cs .swift .dart .c .cc .cpp .h .hpp .ps1 .psm1 .psd1 .vue .svelte`). `.env`, `.pem`, key files, dumps and images are not on it, so they are never candidates.
- **Bounded**: at most 3 files, none over 2 MB, and 50,000 characters in all. A large file is sent as a ±40-line window around the failing line rather than whole. Windowed blocks say so.
- **Vendored code is skipped**: `node_modules`, `site-packages`, `dist`, `.venv` and friends. Your code is what needs explaining.
- **Your snippet always wins.** Pass `codeSnippet` and no source file is read. Your manifests still are (see [Limits and honesty](#limits-and-honesty)).

Whatever it reads is sent to DebugAI's API for analysis, same as the error text. If you do not want a given source file sent, pass `codeSnippet` explicitly and no source file is read. The project manifests described under [Limits and honesty](#limits-and-honesty) are read on every `debug_error` call that has a project root.

### `report_outcome`

Tell DebugAI what happened after it answered, including when its fix was not used.

| Input | Required | Description |
|-------|----------|-------------|
| `debugLogId` | yes | The `debug_log_id` from the `debug_error` response. |
| `result` | yes | `worked`, `worked_modified`, `failed`, `unused`, or `diagnosis_wrong`. |
| `fixRank` | no | Which ranked fix was applied (1-3). Whichever rank it was is the fix remembered. |
| `finalFix` | with `worked_modified` | The code that actually held, after your changes. It is what gets remembered, not the suggestion. Up to 4,000 characters. (2.6) |
| `newError` | no | With `failed`: the error seen after applying. An error message, not an explanation. Up to 4,000 characters. |
| `actualFix` | no | What really fixed it, when it was not DebugAI's answer. With `diagnosis_wrong`, the real cause. Up to 4,000 characters. |
| `toolFeedback` | no | What would have made the tool more useful on this call. Up to 2,000 characters. |

What each verdict means, because they are different facts:

- `worked`: a fix was applied and the error stopped. That fix becomes this project's confirmed fix.
- `worked_modified`: a fix held only after you changed it. `finalFix` is required, and it replaces the suggestion in memory, so the next person is handed what worked. (2.6)
- `failed`: a fix was applied and did not help. Later analyses and lookups in this project are shown it as advice not to repeat. A stored fix is demoted only when the error is seen coming back after it, never on a report alone.
- `unused`: nothing of ours was run, and the diagnosis was right or you cannot say. Also the right answer for a repeat call about an error you already reported under an earlier `debugLogId`, so one fix is not counted twice.
- `diagnosis_wrong`: you read the answer and its root cause is not the cause. Put the real cause in `actualFix`. It counts as a wrong answer, marks no fix as tried (so it is not `failed`) and changes nothing in memory.

It goes through the same pipeline as feedback from the VS Code extension. Agents are asked to call it once per `debug_error` answer.

Example, in Claude Code:

> Paste a traceback and ask "why is this failing?". Claude calls
> `debug_error` and gets back something like:
>
> **Root cause:** `db.session` is used after the request context closed.
> **Fix 1 (94% confidence):** move the query inside the request handler...

### Making your agent reach for it

The server tells connecting agents what it is for, but a rule in your project file is the deterministic version. `setup`, run inside your project, offers to add it to the end of the file each of your agents reads there: `CLAUDE.md` for Claude Code (or `AGENTS.md`, when that is what it reads), `AGENTS.md` for Cursor, Windsurf and Cline, `GEMINI.md` for Gemini CLI, and for Zed the first file on its list, since Zed reads only that one. It will not start a file that would make an agent stop reading the one it reads now. `setup --rules` adds it without asking. By hand, it is:

```
When a command fails, call the debugai lookup_error tool first: it is
instant and free. If it has no confirmed fix, call debug_error before
attempting your own, and pass the command that reproduces the failure
as reproCommand. After applying a fix, call report_outcome so the
project's error memory stays accurate.
```

## Claude Code hook

A rule still depends on the agent deciding a failure is worth a call, and agents skip the ones that look obvious. One agent's own account of the errors it fixed without asking: *"The fix was obvious from the message; a network round trip felt slower than fixing it."* Those are the errors that repeat.

`debugai-mcp hook` takes that decision away. Wired as a Claude Code `PostToolUseFailure` hook, it runs after every Bash or PowerShell command that exits non-zero, looks the output up in this project's memory, and puts the answer beside the failure before the agent reacts to it. (2.6)

It speaks only when memory has something to act on: a stored fix (confirmed, unproven or anti-pattern) or advice this project reported as failed. A miss, a timeout, no network, no key, an interrupted command or a command that printed nothing all produce no output, and every path exits 0, so it never blocks a tool call. It uses the key `login` stored and never starts a sign-in, because a hook cannot answer one.

`setup` offers to add it to `~/.claude/settings.json`, for every project: merged in beside your other settings and hooks, the file backed up first, nothing added on a second run, and a file that does not parse left alone with this block printed to paste. `setup --hook` adds it without asking. For one repository only, put the same block in its `.claude/settings.json` yourself:

```json
{
  "hooks": {
    "PostToolUseFailure": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          { "type": "command", "command": "npx -y @debugai/mcp@latest hook", "timeout": 20 }
        ]
      }
    ]
  }
}
```

Then `/hooks` inside Claude Code shows it loaded.

- **Cost per failed command.** `npx` resolves `@latest` each time, which measured 1.5 to 1.9 seconds warm and 6.7 seconds cold on one Linux machine, before the lookup itself. For about a third of a second instead, install it once with `npm i -g @debugai/mcp@latest` and use `"command": "debugai-mcp hook"`. A global install does not update itself: rerun that command when a new version ships.
- **The timeout.** Claude Code's default for a command hook is 600 seconds. The hook bounds itself (5 seconds to read its input, 8 for the lookup), and `20` makes sure a stuck network can never hold the agent longer than that.
- **What leaves your machine.** The failed command's output, up to 3,000 characters (its start and end when it is longer), and the project id, which is a hash of the repository path. The output is sent as printed: this package does not redact it. The API redacts credentials when it arrives, before the lookup reads it, and nothing is stored. The command line itself is not sent.
- **Which project.** The git repository the command ran in, resolved the same way `debug_error` resolves `projectRoot`, so the hook and a debug of the same failure read one memory. Outside a repository the folder itself becomes the project, and its output is sent. Only your home directory, the folders above it and the filesystem root are refused (and, under WSL, the Windows profile such as `/mnt/c/Users/<name>`), and there the hook stays silent.

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
      "args": ["-y", "@debugai/mcp@latest"]
    }
  }
}
```

Keep the `@latest`. Without a version, npx runs the first copy it finds, and an old global install wins over the newest release: one agent ran a whole session on a July 2.1.1 that sends no project, so project memory was off for every call. `debugai-mcp doctor` warns when an entry has no version.

Where it goes:

> **On Claude Code, `--scope user` is the part that matters.** `claude mcp add`
> defaults to `--scope local`, which writes the server under
> `projects."/your/dir".mcpServers`. It then works in that one directory and
> nowhere else, which reads exactly like DebugAI needing to be set up per repo.
> `debugai-mcp install` always writes the user scope. If you already ran the
> local-scope version, `debugai-mcp doctor` now tells you which one you have.

| Client | File |
|--------|------|
| Claude Code | `~/.claude.json`, top-level `mcpServers` (or `claude mcp add --scope user debugai -- npx -y @debugai/mcp@latest`) |
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Zed | macOS and Linux `~/.config/zed/settings.json` (`$XDG_CONFIG_HOME` when set), Windows `%APPDATA%\Zed\settings.json`. A different key, see below |
| Gemini CLI | `~/.gemini/settings.json` |
| Cline | VS Code globalStorage, `saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |

Zed uses a different key and a nested command:

```json
{
  "context_servers": {
    "debugai": {
      "source": "custom",
      "command": { "path": "npx", "args": ["-y", "@debugai/mcp@latest"] }
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
| `DEBUGAI_TIMEOUT_MS` | `150000` | Deadline for `debug_error` only. Deep analyses can take 30-90s. `lookup_error` waits 8 seconds, `report_outcome` 15, and the hook ignores this variable. |
| `DEBUGAI_CONFIG_PATH` | `~/.debugai/config.json` | Alternate config file location. Rarely needed. |

## Limits and honesty

- Free tier: 10 debugs/day. Pro ($12/mo): 1,000 debugs a month included, then fair use; the 1,000 is a soft cap, so you are told at it and not stopped. `lookup_error` and the hook do not count against either.
- When you hit the daily cap the tool says so and stops. It will not silently retry.
- Simple errors route to a fast model. Ugly cross-file ones route to a stronger one on paid tiers. The `Model:` badge in each response tells you which one answered.
- Analyses run on DebugAI's servers. The error text, any snippet you pass, (since 2.2) the project source files the stack trace names, and (since 2.5) the project facts described below are sent there, and Claude (Anthropic) does the analysis, or OpenAI's GPT-4o-mini when Claude is unavailable. The error text is also embedded by Voyage AI to search your project's index. The response lists every file that was read. Scope and limits are spelled out under [`debug_error`](#it-reads-the-source-the-trace-names-22). Privacy policy: [debugai.io/privacy](https://debugai.io/privacy?src=npm).
- Errors are remembered per project so a repeat hit starts from a fix that was already confirmed. The project identity is a hash of your repo root path. The project id carries no path, but an absolute `filePath` is sent as written, as is any path in the error text.
- Every `debug_error` call that has a project root also reads what the project declares and sends it: `package.json`, `requirements.txt`, `pyproject.toml` and any `.csproj`, `.fsproj` or `.vbproj` (found by walking down from the project root, to a bounded depth and count). What is sent is the dependency names and the versions as the manifests spell them, which kinds of manifest were found (such as `package.json` or `*.csproj`, not where they are), the names of Python modules in the project, the names of any virtual-environment folders, and whether a `node_modules` folder and a `.env` file exist. The contents of `.env` are never opened. This happens even when you pass `codeSnippet`. It lets the engine tell a package that is declared from one that is not. When you pass a `cwd` inside the project (since 2.9), the facts are read from the nearest folder at or above it that holds a manifest, and that folder and `cwd` are sent too, both relative to the project root.
- The one fact it does not send is which Python interpreter is selected. The VS Code extension can read that from the editor, which is what lets it tell "not installed" apart from "installed under a different interpreter". This server has no equivalent, so on a missing-module error you get the general answer and the check to run, not a verdict. You have a shell and it does not, so the honest division is that you run the check.

## Troubleshooting

Run `npx -y @debugai/mcp doctor` first. It checks your Node version, whether a key is stored and where it came from, whether that key still authenticates against the API, the permissions on the config file, and which detected clients are missing the DebugAI entry. Most answers are in that output.

- **"authentication failed"**: the key was rotated or revoked. Run `npx -y @debugai/mcp login --force`.
- **Tools do not appear in the client**: the client was not restarted, or it reads a different config file. `install --list` shows which file was written.
- **Nothing happens on `npx @debugai/mcp`**: correct. It is a stdio server waiting for an MCP client to speak first. Use `--help` to verify the install.
- **Timeouts**: deep analyses can take up to 90s. If your client has its own tool timeout, raise it above that.
- **The hook never says anything**: that is what it does on a miss, which is most failures. `/hooks` in Claude Code shows whether it is loaded, and `claude --debug` logs each run. It also needs a stored key (`npx -y @debugai/mcp login`), because it never asks for one.

## Changelog

**Note on updates**: the analysis runs on DebugAI's servers, so improvements to
error parsing, retrieval and root-cause quality reach you without upgrading this
package. Client releases are only for things that change on your machine.

Recent server-side work. Each item reaches agents with no upgrade once the engine release that carries it is deployed:

- **The same error sent again gets a new answer, not the cached one.** An error that names
  no file and line kept no record of what was suggested for it, so sending it again
  returned the cached answer and charged a debug for it. It now keeps one: a repeat gets a
  fresh analysis that is shown the answer before it.
- **A double send is answered once.** The same error sent again while the first is still
  being answered, or within two seconds of its answer, gets that answer, marked cached, and
  is not charged again.
- **A failed request line from a browser console is answered with where its reason is.**
  `POST https://example.com/api/checkout 500 (Internal Server Error)` on its own was refused
  as no error. It is accepted now, and when it is all that was sent, the answer says the
  reason is on the server: the response in the Network tab, or the server's log. Like a
  refusal, that answer is not counted against the limit.
- **A `python -c` one-liner that did not parse gets a short answer with no model call.**
  `File "<string>", line 1` with a SyntaxError means the code string never ran, often
  because the shell rewrote its quotes. The answer says so and ranks the moves that settle
  it: save the code to a file, pipe it in as a literal block, or give each statement its
  own line. It counts as a debug, like every answer from the pattern library.
- **A constructor called another way is an unverified claim too.** A fix that calls a
  constructor with an argument list the request never showed (C# CS1729) is capped like
  any other claim about an API the engine cannot see, and when that cap fires, the
  answer's label is lowered with the number instead of staying high.
- **An answer DebugAI could not read is never counted as a fix.** A report on it is stored
  with no verdict and never promoted into project memory, and it is not written down as
  something DebugAI suggested.
- **DebugAI's own messages and its own setup command are answered as what they are.** A
  line starting "DebugAI:" is not analysed as an error, and a setup command pasted into
  the debug box gets back `npx -y @debugai/mcp setup` (`npx.cmd` where PowerShell blocks
  scripts), with no change to a security setting.
- **A failure reported by an agent is no longer refused as "not an error"** because
  its wording was not on the engine's list of error phrases. `No module named`,
  Ubuntu's `Command 'x' not found`, a browser's `net::ERR_*`, and compilers that
  print `Line 44: Undefined symbol` without the word "error" were all turned away.
  A prompt, a bare path or a stub is still refused.
- **The answer says when it never saw the line the error names.** An error that
  reports `Line 528` against a 19-line snippet used to be explained from lines
  1-19. It is now answered at low confidence, with a sentence saying which lines
  were supplied and which were reported, and it is not cached, so sending the
  lines it asks for gets a fresh analysis.
- **A missing command is no longer assumed to be a script in your project.**
  `curl`, `winget` and `powershell` that a stripped PATH could not find are called
  by full path (they ship with Windows) instead of being installed; PowerShell
  handed to Command Prompt (`$ws`, `Get-ChildItem`) is called a wrong shell, not
  a missing tool; an unknown name is looked for before it is run.
- **A Playwright timeout is no longer blamed on your app.** "Waiting for visible,
  enabled and stable" is the driver reporting it could not act. The answer leads
  with the check that tells "not on the page" from "on the page and covered or
  moving", and offers `force: true` only as a labelled test workaround.
- npm's `ENOENT ... package.json` is answered with `npm --prefix`, not a `cd` into
  the folder the error already names. A path that points at nothing is walked up
  to the folder that exists before anything is reinstalled. A browser's
  `ERR_CONNECTION_REFUSED` on localhost gets the same reasoning as Node's, and the
  advice to run the server where its first lines can be read.
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

**2.9.0** - Agents use DebugAI on their own: `setup` offers the rule and the Claude Code
hook, and `try` builds a first bug to debug. A file named with no line is read around
what the error names, and an answer DebugAI could not read is a failure, not a fix.
`report_outcome` takes `diagnosis_wrong` for a root cause that was not the cause, and
`debug_error` takes the folder the command ran in.

- **`setup` offers the rule and the Claude Code hook.** The docs told you to paste a rule into `CLAUDE.md` and a hook into `~/.claude/settings.json`, and said no command did either, so an agent that could call DebugAI was still left to decide when. After the clients are configured, `setup` now asks to add both: the rule to the end of the file each of your agents reads in the current project, and the hook into `~/.claude/settings.json`, merged in and backed up first. Enter alone is yes. `--rules`, `--no-rules`, `--hook` and `--no-hook` answer without asking, and with no terminal and no flag it adds neither and prints the command that would. A second run adds nothing, a settings file that does not parse is left alone, and your home folder is never a project.
- **The file is the one each agent reads, checked against its docs.** A new `CLAUDE.md` stops Claude Code reading an `AGENTS.md`, and Zed reads only the first file on its list, so `setup` will not start a file that hides the one an agent reads now. It names that file for you instead.
- **`doctor` reports the rule and the hook**, including a hook kept in a project's own `.claude/settings.json`.
- **`try`** makes the project from the docs' "Your first debug" in a new folder: three files with a planted bug whose traceback never names the file that is wrong. `--lang js` for the JavaScript one. It used to be three files copied off the page by hand. It never writes into a folder that exists, and it prints how to run the program and what to ask your agent or the VS Code extension. The files are the page's, byte for byte, and a test reads the page and fails if the two drift.
- **An answer DebugAI could not read is a failure, not a fix.** When the engine could not
  read its own model's reply, `debug_error` returned a fix called "Nothing was analysed -
  please run it again" at 0% confidence, with a `debugLogId` to report an outcome on. Two
  of five such answers were reported as a fix that worked after changes, because the agent
  then solved the error another way. It now comes back as an error: DebugAI could not read
  its own analysis, the attempt was not counted, one more try is worth it, and there is no
  `debugLogId`.
- **A file named with no line is read around what the error names.** When an agent
  named a file and the error gave no line in it, the server sent lines 1 to 81 whatever
  the error said; about 18 answers said only the top of the file was visible. It now
  centres on the test a pytest node id names, a line the error states, or where a name
  the error quotes is defined, and sends the top only when none of those is there.
- **A wrong root cause has its own verdict.** `report_outcome` takes `diagnosis_wrong`: you read
  the answer and its root cause is not the cause, with the real one in `actualFix`. Until now that
  was reported as `unused`, which says nothing about whether the answer was right, so none of it
  could be counted. It counts as a wrong answer, marks no fix as tried and changes nothing in
  memory.
- **`debug_error` takes the folder the command ran in.** About twenty answers in one audit went wrong because the failing command ran in a different folder than `projectRoot`: a local module answered with `pip install`, a venv that existed in the subfolder reported missing, a build run from the parent folder, the same wrong root folder twice. An agent can now pass `cwd`, absolute or relative to the project root. A relative path in the error is looked for there first, the dependencies are read from the nearest `package.json`, `requirements.txt`, `pyproject.toml` or .NET project file between that folder and the project root, and the engine is told where the command ran. It has to be a folder inside the project, after symlinks resolve; anything else is ignored and the footer says `cwd ignored` and why. Nothing else it reads changes, and a `.env` is still never opened. The bundled server in the VS Code extension takes it too.

**2.7.0** - Built from a second agent's field report, this time from a greenfield
project on libraries newer than any model's training data (report of 2026-09-20).

- **Your home directory is not a project.** A server started in `~`, or in the filesystem root, outside any repository used to make that its project root: a stack trace naming a file under it was read and sent, and the manifests under it were walked. It now has no project root, reads nothing local, gathers no project facts and says so in the reply. Pass `projectRoot` to name the project. The same refusal covers the folders above your home directory, under WSL the Windows profile (`/mnt/c/Users/<name>`), and from Windows a network share or a WSL distribution (`\\server\share`, `\\wsl.localhost\Ubuntu`). A dotfiles checkout no longer defeats `projectRoot`: the folder you name is used even when the repository above it is your home directory.
- **`snippetStartLine`** on `debug_error`. A snippet you pass has no header, so it
  was always counted from line 1 and a window from the middle of a file could not
  be matched to the line the error names. Say where it starts. A file this server
  reads itself already says so in its own header.
- **`language` takes any string.** A name outside the list used to fail the call
  and send the agent back to retry with `auto`; it is now treated as `auto`.
  `markdown` was the one that kept happening. `lua`, `dart`, `elixir`, `r` and `perl` were also being collapsed to
  `unknown` by the gateway, which hid them in the language counts; they are kept.

- **An edit names the file its code is in.** This server resolves every file a
  stack trace names and sends them together; each fix's `edits[].file` used to
  carry the first of them whatever the fix was for, along with the diff headers,
  the check command and the line number. Applying one blind wrote one file's code
  into another, or - more often - failed to match and cost you a re-read. The
  line number now comes back in that file's own numbering, and a fix that spans
  two files gets no edit rather than a confident wrong path.
- **The tools describe the moment you are actually in.** Every trigger used to be
  the user doing something: "use whenever the user pastes an error". In an agent
  session nobody pastes anything - the agent ran the build. `debug_error` now
  says to call it the moment something fails, including when the agent caused the
  failure itself, and names the moments: a typecheck exiting non-zero, a linter
  reporting errors, a test suite going red.
- **`report_outcome` separates a wrong patch from a wrong diagnosis.** A correct
  root cause whose fix did not apply is `unused`, never `failed`. Filing it as
  failed blames the diagnosis for the patch, and those need opposite repairs.
- **A stale client says so once, at the top, and not again.** The notice used to
  be appended to `root_cause`, the field an agent quotes to its user, on every
  answer. One agent read it as boilerplate for a whole session while running a
  version five releases old. It is now its own field, rendered above the
  diagnosis, once per process.
- **The bundled VS Code server gets the same instructions as this one.** The two
  had drifted, and the bundled copy had lost the paragraph saying it reads the
  source files a stack trace names.
- **Source files are read for more toolchains.** MSBuild and tsc `file(line,col)`,
  javac and Maven `[line,col]`, .NET `in path:line N`, PowerShell `At path:N`,
  Gradle build files, `file://` paths and JVM frames now name a file. New file
  types: `.c .cc .cpp .h .hpp .pyi .kts .scala .dart .groovy .ps1 .psm1 .psd1 .gradle`.
- **What is read from disk fits the API.** Three files with long lines used to go
  out over the 50,000-character limit and come back refused, to an agent that had
  passed no code. Each file is now cut to the characters left, in whole lines
  around the failing one. A file up to 2 MB is read as a window; the old 256 KB
  limit cut it mid-line.
- **An empty `codeSnippet` or `filePath` counts as not given.** An agent that fills
  an optional parameter with `""` was told a file had been read and sent no code.
- **A manifest that was not read is not one that declares nothing.** A UTF-16
  `requirements.txt`, one over 512 KB, a `package.json` with a byte-order mark or
  that does not parse, and a walk that stopped early used to send a list that
  called itself complete, and the engine answered "not declared". Each now marks
  the list possibly short. A `pyproject.toml` is read table by table, so
  `testpaths` and author names are no longer sent as dependencies.
- **Error messages say what to do.** A monthly limit, or a `debugLogId` the API
  does not know, is reported as not worth retrying. A short rate limit says how
  long to wait. An outage passes on the engine's own sentence. A proxy or sign-in
  page answering in the API's place is named as such, instead of as invalid JSON.
  A request's deadline now covers the whole answer, not only the wait for headers.
- **Sign-in is sturdier.** It survives a brief API outage, keeps the key it was
  given when the config file cannot be written, opens only http(s) addresses and
  no longer goes through `cmd` on Windows, and shows the free limit the server
  reports instead of a fixed number.
- **`install` leaves a config as it found it.** It keeps the file's permissions,
  writes through a symlink instead of replacing it, and reads files that start
  with a byte-order mark. `uninstall` also removes the VS Code entry and Claude
  Code's per-directory entries.
- **On Windows the home folder is refused as a project** however its path is
  spelled.

**2.6.0** - Built from one agent's field report on a week of real use (2026-09-16), finding by finding.

- **`lookup_error`**, a new tool: this project's memory of an error with no model call and no charge. The agent in that report skipped DebugAI on five errors because a full analysis felt slower than fixing them, and every skip was an error memory never saw.
- **`debugai-mcp hook`** runs that lookup on every failed shell command in Claude Code, so calling it is not left to the agent's judgement. See [Claude Code hook](#claude-code-hook).
- **`reproCommand` and `expected`** on `debug_error`. All six answers in the report offered `python -m py_compile` or `node --check` as the way to confirm fixes for a QR code that would not scan and a model that looped. The agent had a real check each time. Fix #1 is now aimed at it, and it becomes each fix's check. DebugAI still never runs it.
- **`worked_modified` and `finalFix`** on `report_outcome`. A fix that held only after the agent changed it could only be reported as `worked, rank 1`, so memory kept the suggestion rather than what worked. Ranks 2 and 3 are remembered when they are the one that worked, too.
- **`projectRoot`**, and an absolute `filePath` names its repository. An agent started in one folder and working in another had every error filed under the wrong project, and every local file read refused. The footer of each answer now names the project, and says when memory was off and why.
- **Every answer names this server's version and the engine build.** The report's agent spent a session on a July 2.1.1 without knowing, because nothing it received carried a version. The installer writes `@debugai/mcp@latest`, `doctor` flags an entry with no version and a key left in plain text in a client config, and an older server is told once a day that a newer one exists.
- A code window from a large file is numbered with its real line numbers, so an answer about line 539 does not come back as line 4.
- Each fix's change is shown once in prose. The diff stays whole in the structured result.
- An error longer than 3,000 characters is cut to fit, start and end kept, instead of refused with a 400 the agent had to work around.

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
- **Project-scoped error memory.** Nothing in this package ever sent a `project_id`, and the engine gates recurrence counts and confirmed fixes on it, so every agent request got no recall and recorded none, while the server instructions told agents it did. Now derived from your git repo root, matching the VS Code extension's id for the same checkout, so both surfaces share one memory. `debug_error` surfaces "seen 3x before, fix confirmed" when it applies.

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
