# @debugai/mcp

DebugAI as an MCP server. Your agent hands an error to `debug_error` and gets
back the root cause plus up to 3 ranked fixes with code patches. Works in
Claude Desktop, Claude Code, Cursor, Zed, Windsurf, and any other MCP client.

Until now this server only shipped inside the
[DebugAI VS Code extension](https://marketplace.visualstudio.com/items?itemName=debugai.debugai).
This package is the same server, standalone. No VS Code required.

## Setup

1. Create a free account at [debugai.io](https://debugai.io) (10 debugs/day, no card).
2. Copy your API key (`dbg_...`) from [debugai.io/dashboard](https://debugai.io/dashboard).
3. Add the server to your MCP client (snippets below). Node 18+ required.

### Set the key once for every client (optional)

Instead of repeating the key in each client's `env` block, write it to
`~/.debugai/config.json`:

```json
{ "api_key": "dbg_your_key_here" }
```

Every MCP client launching `npx -y @debugai/mcp` picks it up — you can then
drop the `env` block from the snippets below entirely. An explicit
`DEBUGAI_API_KEY` env var still wins over the file.

### Claude Code

```bash
claude mcp add debugai --env DEBUGAI_API_KEY=dbg_your_key_here -- npx -y @debugai/mcp
```

### Claude Desktop

`claude_desktop_config.json` (Settings, Developer, Edit Config):

```json
{
  "mcpServers": {
    "debugai": {
      "command": "npx",
      "args": ["-y", "@debugai/mcp"],
      "env": { "DEBUGAI_API_KEY": "dbg_your_key_here" }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` per project):

```json
{
  "mcpServers": {
    "debugai": {
      "command": "npx",
      "args": ["-y", "@debugai/mcp"],
      "env": { "DEBUGAI_API_KEY": "dbg_your_key_here" }
    }
  }
}
```

### Zed

`settings.json`:

```json
{
  "context_servers": {
    "debugai": {
      "command": {
        "path": "npx",
        "args": ["-y", "@debugai/mcp"],
        "env": { "DEBUGAI_API_KEY": "dbg_your_key_here" }
      }
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "debugai": {
      "command": "npx",
      "args": ["-y", "@debugai/mcp"],
      "env": { "DEBUGAI_API_KEY": "dbg_your_key_here" }
    }
  }
}
```

### VS Code

You don't need this package. The
[DebugAI extension](https://marketplace.visualstudio.com/items?itemName=debugai.debugai)
registers the MCP server automatically (VS Code 1.101+) and adds one-click
fix apply, proactive scan, and codebase indexing on top.

## The tools

### `debug_error`

Give it an error, get an analysis.

| Input | Required | Description |
|-------|----------|-------------|
| `errorText` | yes | Full error message, exception, or stack trace. |
| `language` | no | `javascript`, `typescript`, `python`, `go`, `rust`, or `auto` (default). |
| `codeSnippet` | no | Code around the failing line, if the agent has it. |
| `filePath` | no | Path to the file that threw. |

Returns the root cause, up to 3 fixes ranked by confidence, the detected
framework, and whether the answer came from cache. Since 2.0 each fix also
carries, where derivable: `edits` (exact old/new strings your agent's edit
tool can apply directly), `unified_diff`, and `verify_with` (a syntax-level
check command to run after applying). Read-only: it never touches your
files. Applying a fix is your agent's (and your) call.

Every fix is labeled with its verification state, and there are three of
them, not two: **verified** (a mechanical check passed — currently
parse/import classes), **failed check** (confidence capped hard), or **not
verified** (the confidence number is the model's own estimate — nothing
checked it). We label the third case instead of hiding it.

### `report_outcome`

Tell DebugAI whether an applied fix actually worked.

| Input | Required | Description |
|-------|----------|-------------|
| `debugLogId` | yes | The `debug_log_id` from the `debug_error` response. |
| `result` | yes | `worked` or `failed`. |
| `fixRank` | no | Which ranked fix was applied (1-3). |
| `newError` | no | If it failed: the error you saw after applying. |

Confirmed rank-1 fixes are remembered per project (the next hit on the same
error starts from the confirmed fix); failed-fix follow-ups are the
feedback that improves future answers. Agents are asked to call this once
per applied fix — same pipeline human feedback flows through in the VS Code
extension.

Example, in Claude Code:

> Paste a traceback and ask "why is this failing?". Claude calls
> `debug_error` and gets back something like:
>
> **Root cause:** `db.session` is used after the request context closed.
> **Fix 1 (94% confidence):** move the query inside the request handler...

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEBUGAI_API_KEY` | (none) | Your API key. Falls back to `api_key` in the config file. |
| `DEBUGAI_API_BASE` | DebugAI production | Override for self-hosted or staging setups. Falls back to `api_base` in the config file. |
| `DEBUGAI_TIMEOUT_MS` | `150000` | Per-request deadline. Deep analyses can take 30-90s. |
| `DEBUGAI_CONFIG_PATH` | `~/.debugai/config.json` | Alternate config file location. Rarely needed. |

## Limits and honesty

- Free tier: 10 debugs/day. Pro ($12/mo): 1,000/mo soft cap, never hard-blocked at it.
- When you hit the daily cap the tool says so and stops. It will not silently retry.
- Simple errors route to a fast model; ugly cross-file ones route to a
  stronger one on paid tiers. The `Model:` badge in each response tells you
  which one answered.
- Analyses run on DebugAI's servers. The error text and any snippet you pass
  are sent there. Privacy policy: [debugai.io/privacy](https://debugai.io/privacy).

## Troubleshooting

- **"authentication failed"**: key missing or wrong. Check the `env` block in
  your client config or `~/.debugai/config.json`, restart the client. Keys
  start with `dbg_`.
- **Nothing happens on `npx @debugai/mcp`**: correct. It's a stdio server that
  waits for an MCP client to speak first. Run `npx @debugai/mcp --help` to
  verify the install.
- **Timeouts**: deep analyses can take up to 90s. If your client has its own
  tool timeout, raise it above that.

## Development

```bash
npm install
npm test        # builds, then runs unit + spawned-process e2e tests
```

MIT © DebugAI
