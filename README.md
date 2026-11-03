English | [Tiếng Việt](README.vi.md)

# ai-quota-bar (AI Quota Bar)

A VS Code extension that shows your remaining quota for **Claude Code**, **Codex**, and **Antigravity (`agy`)** in the status bar. Each enabled provider has its own status bar item with a distinct ID (`aiQuota.claude`, `aiQuota.codex`, `aiQuota.agy`), and none of the three requires keeping a separate IDE open or making a model call.

Text preview of the right side of the status bar (no screenshot image files have been captured yet):

```
+------------------+  +-----------------+  +-----------------------------------------+
| Claude 84% | 29% |  | Codex 76% | 96% |  | Gemini 91% | 60% · Claude/GPT 80% | 55% |
+------------------+  +-----------------+  +-----------------------------------------+
```

## 1. Purpose

The extension displays the remaining quota percentage for your AI coding tools in the VS Code status bar, warns you with background colors and notifications when a limit drops to the warning or critical threshold, and shows when each limit resets.

It combines three data sources in one extension:

| Provider | Data source | Groups shown | Typical windows |
|---|---|---|---|
| Claude Code (`claude`) | Anthropic OAuth usage API (`https://api.anthropic.com/api/oauth/usage`) using the token already saved by Claude Code | `Claude` | 5-hour (`session` / `five_hour`), Weekly (`weekly_all` / `seven_day`), plus model-scoped weekly windows from `limits` (with model labels from the API) or legacy `seven_day_opus` / `seven_day_sonnet` |
| Codex (`codex`) | ChatGPT backend usage API (`https://chatgpt.com/backend-api/wham/usage`) using the token already saved by Codex | `Codex` | 5-hour (`18000` s), Weekly (`604800` s), or other durations returned by the API |
| Antigravity (`agy`) | `agy --output-format json -p "/usage"` CLI command | `Gemini`, `Claude/GPT` | 5-hour, Weekly |

De-duplication with other quota extensions:

- **Replaces `XXLC.agy-quota-bar`**: `ai-quota-bar` is the multi-provider successor to `XXLC.agy-quota-bar` and preserves the Antigravity status bar item, Markdown table tooltip, QuickPick detail list, threshold notifications, and cross-window file locking. If you have `XXLC.agy-quota-bar` installed, uninstall or disable it so `agy` is not run twice per cycle. Like `agy-quota-bar`, it reads Antigravity quota via the `agy` CLI rather than the Antigravity IDE language server (unlike `clhome.antigravity-quota-yufeng`), so it keeps working when Antigravity IDE is closed.
- **Standalone Claude Code, Codex, and Antigravity quota extensions**: You should disable any separate Claude Code, Codex, or Antigravity quota extensions to avoid duplicate API requests or CLI runs and duplicate status bar items (uninstalling is optional because `ai-quota-bar` only reads credential files and never modifies them or refreshes tokens).

## 2. How it works

Each enabled provider refreshes independently on its own schedule and stores its state in a separate file. A failure in one provider does not block or delay the others.

### 2.1. Claude Code (`claude`)

Why this source: Claude Code stores an OAuth access token locally after you sign in. Querying Anthropic's OAuth usage endpoint directly with that token retrieves the 5-hour, weekly, and model-scoped utilization percentages without starting an interactive `claude` session or consuming model tokens.

On each refresh for Claude, the extension:

1. Reads `<CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json` (or the directory configured in `aiQuota.claudeConfigDir`), extracts `claudeAiOauth.accessToken`, and checks `claudeAiOauth.expiresAt` (as well as JWT `exp` if present). If the file or token is missing or already expired, it immediately reports an `auth` error without calling the network.
2. Sends `GET https://api.anthropic.com/api/oauth/usage` with headers `Authorization: Bearer <accessToken>`, `Accept: application/json`, `User-Agent: ai-quota-bar/0.1.1`, and `anthropic-beta: oauth-2025-04-20`.
3. Uses Node's built-in `fetch` first. Only when `fetch` receives HTTP `403` with a response body containing `"Request not allowed"` (Anthropic's edge rejecting Node's TLS ClientHello fingerprint), the extension falls back once to the system `curl` binary (`<%SystemRoot% or C:\Windows>\System32\curl.exe` on Windows, `curl` on macOS/Linux) with `-q --config -`, passing the URL and headers through `stdin` so the token never appears in process command-line arguments.
4. Parses the JSON response, preferring the `limits` array (introduced in 08/2026, which includes per-model limits) when it contains at least one valid entry, and falling back to the legacy top-level fields otherwise (the two formats are not mixed):
   - From `limits`: maps `kind === 'session'` (or unrecognized `kind` with `group === 'session'`) to 5-hour (`5h`); maps `kind === 'weekly_all'` to Weekly (`weekly`); maps `kind === 'weekly_scoped'` (or unrecognized `kind` with `group === 'weekly'`) to `other:<label>`, where `<label>` is taken from the API's `scope.model.display_name` (falling back to `scope.surface`, or `Weekly (<kind>)`), sanitized to at most 40 characters. If two entries share the same window key, the one with the lower unrounded remaining fraction is kept.
   - From legacy fields (fallback when `limits` has no valid entries): reads `five_hour` (`5h`), `seven_day` (`weekly`), `seven_day_opus` (`other:Opus`, label `Opus`), and `seven_day_sonnet` (`other:Sonnet`, label `Sonnet`).
5. Converts the used percentage (`percent` in `limits` or `utilization` in legacy fields) into the remaining percentage (`0-100`, rounded down via `Math.floor(100 - Math.min(100, used))`) under the group label `Claude`, and parses `resets_at` as the reset timestamp. Any used percentage `> 100` is clamped to `100` and treated as exhausted (`0%` remaining, `critical` level); negative or non-finite values are skipped.

### 2.2. Codex (`codex`)

Why this source: Codex CLI saves its OAuth tokens in `auth.json`. Calling the backend usage endpoint directly with that token returns the active rate-limit windows without spawning a `codex` process or using model quota.

On each refresh for Codex, the extension:

1. Reads `<CODEX_HOME or ~/.codex>/auth.json` (or the directory configured in `aiQuota.codexHome`), extracts `tokens.access_token` (and `tokens.account_id` if present), and checks JWT `exp` locally.
2. Sends `GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer <access_token>`, `Accept: application/json`, `User-Agent: ai-quota-bar/0.1.1`, and, when `account_id` is available, `chatgpt-account-id: <account_id>`. On HTTP `401`, or HTTP `403` with a JSON `Content-Type` (`application/json` or `+json`), it reports an `auth` error; a non-JSON `403` (such as an HTML block page) is reported as `HTTP 403`.
3. Reads `rate_limit.primary_window` and `rate_limit.secondary_window` from the JSON response (accepting finite numbers or numeric strings for `used_percent`, `limit_window_seconds`, `reset_at`, and `reset_after_seconds`).
4. Maps `limit_window_seconds` to a language-independent window key and localized label: `18000` becomes `5h` (`5-hour`), `604800` becomes `weekly` (`Weekly`), any other positive duration becomes `other:<seconds>s` (labeled in whole days, whole hours, or rounded minutes), and a window without `limit_window_seconds` becomes `other:primary` or `other:secondary` (labeled `Limit`).
5. Converts `used_percent` into the remaining percentage (`0-100`, rounded down) under the group label `Codex`, clamping any `used_percent > 100` to `0%` remaining (`critical` level). Computes the reset time from `reset_at * 1000` when present, or `now + reset_after_seconds * 1000` otherwise.

### 2.3. Antigravity (`agy`)

Why this source: `/usage` is a built-in command of the `agy` CLI (not a prompt sent to a model) and does not start the Antigravity IDE language server, so it works in both VS Code and Antigravity IDE even when Antigravity IDE is closed.

On each refresh for Antigravity, the extension runs:

```
agy --output-format json -p "/usage"
```

The command is spawned directly (no shell), with the hidden-window option (`windowsHide`), the home directory as working directory, the environment variable `NO_COLOR=1`, a 256 KiB output limit, and `stdin` closed immediately. The extension reads the JSON result (field `command.data.groups`, which carries the remaining fraction as a floating-point number); if that field is missing, it falls back to the TAB-separated text table in the `response` field, but only when `conversation_id` is present and is exactly the empty string. In both JSON and TSV modes, a bucket is mapped to the 5-hour window (`5h`) when `window === '5h'` or its label (after stripping ` Limit Remaining`) matches `/five[\s-]*hour/i` (accepting `Five-Hour`, `Five Hour`, `FiveHour`, and similar spacing or hyphenation), mapped to the weekly window (`weekly`) when `window === 'weekly'` or its label matches `/weekly/i`, and mapped to `other:<label>` otherwise. `stdout` must contain one JSON object; surrounding whitespace or blank lines are accepted, but other content outside the JSON is treated as an error.

Measured on the author's machine, Windows 11, `agy` 1.4.12:

| Check | Measured result |
|---|---|
| Exit code, output stream | Always 0; result on `stdout`, `stderr` empty |
| Run time | About 4 seconds per run (3,907 ms when run from Node; 2.6-3.5 seconds over more than 15 other runs) |
| Model call | None: `num_turns` = 0, `conversation_id` empty, every token field in `usage` is 0 |
| Quota consumption | None: the Gemini group's `remaining_fraction` stayed identical to the 16th decimal place over 7 consecutive calls |
| Conversation created | None: the `conversations` directory and `last_conversations.json` did not change |
| Depends on working directory | No: running in `C:\Windows\Temp` gives the same result |

> [!WARNING]
> The extension never passes the `--disable-slash-commands` flag. With that flag, `agy` sends the string `/usage` to the model as an ordinary prompt: in a measurement on the author's machine, the run took 33.4 seconds, created a new conversation, consumed model tokens, and returned prose instead of the quota table. In case a future `agy` release drops the `/usage` command (which would also send that string to the model), the extension only accepts a result when `command.name` is `usage`, `num_turns` is 0, `conversation_id` has no truthy value (an empty string, an absent field, `null`, `false`, and `0` all pass this check), and `status` (if present) is `SUCCESS`. Otherwise it reports an "unexpected result" error and progressively lengthens the refresh interval (section 5) so it does not keep burning quota. If you run the command yourself in a terminal, do not add this flag.

## 3. Security model, guarantees, and known limits

### 3.1. Security model and guarantees

- **Read-only access to credential files**: For Claude Code and Codex, the extension ONLY reads `.credentials.json` and `auth.json`. It never writes to, modifies, or deletes those files, and it never refreshes OAuth tokens. For Antigravity, the extension does not read credential files at all.
- **No token refresh or retry loops on authentication errors**: If a token is expired locally or rejected (`401`, or `403` authentication failure), the extension reports an `auth` error instructing you to open `claude` or `codex` to sign in again, and does not retry in a tight loop.
- **Tokens stay only in request memory**: Access tokens exist only in memory during the HTTP request. They are never saved to `state-<id>.json`, written to the Output log, or shown in tooltips, notifications, the QuickPick list, or error messages. HTTP transport exception messages and error response bodies are never forwarded to the UI or log; all HTTP/auth errors use fixed localized messages, and every logged or displayed error string passes through `sanitize`, which strips ANSI and control characters, keeps only the first non-empty line (up to 120 or 200 characters), and masks email addresses, `Bearer`/`Basic` credentials, sensitive URL parameters (`token`, `access_token`, `refresh_token`, `id_token`, `key`, `secret`, `password`, `code`, and similar), token prefixes (`eyJ...`, `ya29.`), OAuth tokens (such as `sk-ant-oat01-...`), and any run of 24 or more consecutive letters, digits, and `_-./+=` characters with `[redacted]`.
- **Fixed HTTPS hosts and no redirects**: Direct HTTP requests go only to `https://api.anthropic.com` (Claude) and `https://chatgpt.com` (Codex) with `redirect: 'error'`, preventing bearer tokens from ever following a redirect to another host. Response bodies are streamed with a strict 256 KiB cap, and requests are bounded by `aiQuota.timeout` using `AbortController`.
- **`curl` fallback uses a fixed binary path on Windows and passes secrets via `stdin` only**: When Claude's `fetch` request fails with HTTP `403` `"Request not allowed"`, the extension spawns `<%SystemRoot% or C:\Windows>\System32\curl.exe` on Windows (so it never executes a `curl.exe` from the current directory or user profile) or `curl` on macOS/Linux with `['-q', '--config', '-']`, piping headers through `stdin` so the bearer token never appears in process command-line arguments (`argv`).
- **Rate-limit handling (`429` / `Retry-After`)**: On HTTP `429`, the extension parses `Retry-After` (seconds or HTTP-date), clamps the cooldown to between 60 seconds and 1 hour (defaulting to 60 seconds when `Retry-After` is absent), and saves the `retryAt` deadline in `state-<id>.json` so all VS Code windows respect the same cooldown. Even a manual refresh during the `retryAt` window does not call the API and only writes a log line (`Waiting for the rate limit until HH:MM.`).
- **User-only provider toggles (`scope: application`)**: The three `aiQuota.providers.<id>.enabled` settings use `scope: application`, so they apply only at the user (`Global`) level. Workspace or folder settings (`.vscode/settings.json` or `.code-workspace` in a repository) cannot override them, ensuring an untrusted or third-party repository cannot re-enable a provider you disabled (which would otherwise read your local credential files or run `agy`) or block `AI Quota Bar: Choose providers to show` from taking effect.
- **No telemetry and isolated storage**: The extension sends no telemetry and writes only to VS Code's extension storage directory (`globalStorageUri`): per-provider state files `state-<id>.json`, lock files `state-<id>.lock`, and temporary `.tmp` files during atomic writes (section 4.7).

### 3.2. Known limits

- **No token refresh (`claude` tokens expire after a few hours, `codex` after a few days)**: By design, `ai-quota-bar` never refreshes OAuth tokens. Claude Code OAuth access tokens typically expire after a few hours and Codex tokens after a few days; if you have not opened `claude` or `codex` for a while, that provider's status bar item will show `Claude: not signed in` or `Codex: not signed in` until you run `claude` or `codex` so the CLI refreshes its token.
- **macOS Keychain is not supported yet**: On macOS, Claude Code may store its OAuth credentials in the macOS Keychain instead of `~/.claude/.credentials.json`. `ai-quota-bar` currently reads only `.credentials.json` and `auth.json` on disk; if the file is absent on macOS, the provider reports `not signed in`.
- **No custom proxy configuration; older VS Code (`1.90`-`1.93`) may not route `fetch` through `http.proxy`**: The extension has no dedicated proxy setting and uses Node's global `fetch` (and `curl` on fallback). On older VS Code versions (`1.90`-`1.93`), global `fetch` in the extension host may not automatically use VS Code's `http.proxy` setting.
- **Unofficial usage APIs may change**: Anthropic's `/api/oauth/usage` endpoint and ChatGPT's `/backend-api/wham/usage` endpoint are internal endpoints used by their respective CLIs rather than public, versioned APIs, and their request or response format may change without notice. Likewise, future versions of `agy` may change the output of `/usage`.
- **`curl` fallback triggers only when Claude returns HTTP `403` `"Request not allowed"`**: The `curl` fallback is used only for Claude Code and only when `fetch` returns HTTP `403` with `"Request not allowed"` in the response body. Other `403` responses on Claude are treated as `auth` errors, and Codex does not use `curl` fallback.
- **Not tested on macOS or Linux**: The extension has been developed and verified on Windows 11; runtime behavior on macOS and Linux has not been tested on real machines yet.
- **Not published on Visual Studio Marketplace or Open VSX**: The extension is not published on the Visual Studio Marketplace or Open VSX, and the GitHub repository (`https://github.com/XXLC/ai-quota-bar`, placeholder URL) has not been created yet.
- **`agy` starts configured MCP servers on every refresh**: As measured on Windows 11, each `agy -p "/usage"` run takes about 4 seconds and spawns every MCP server configured for `agy` (all child processes exit when `agy` exits). `agy` rejects `--settings '{"mcpServers":{}}'` (`unknown setting "mcpServers"`, exit code 1), so there is no CLI flag to disable MCP for a single `/usage` call. `agy` may also write logs or cache files under `~\.gemini`.
- **Runs on the UI machine (`extensionKind: ["ui"]`)**: When using Remote SSH, WSL, or Dev Containers, the extension runs on the local UI machine (where VS Code's UI runs) so it can read your local credential files and run your local `agy` binary. If your Claude Code, Codex, or `agy` login exists only inside the remote machine or container, the local UI extension will not see those remote files.
- **Account switching**: The numbers shown belong to whichever account is currently logged in for each tool. Switching accounts updates the quota on the next refresh.

## 4. Usage

### 4.1. Requirements

- VS Code 1.90 or later (1.94+ recommended if you rely on VS Code's `http.proxy` for `fetch`), or Antigravity IDE.
- At least one of the three tools logged in on the machine running VS Code (you can disable any provider you do not use):
  - **Claude Code**: logged in so `<CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json` exists and contains an unexpired `claudeAiOauth.accessToken` (and `C:\Windows\System32\curl.exe` on Windows or `curl` on `PATH` on macOS/Linux if Anthropic's edge blocks Node's TLS fingerprint).
  - **Codex**: logged in so `<CODEX_HOME or ~/.codex>/auth.json` exists and contains `tokens.access_token`.
  - **Antigravity (`agy`)**: `agy` CLI installed and logged in (`agy.exe` on Windows, see section 5.4).

Quick check for `agy` in a terminal:

```powershell
agy --version
agy --output-format json -p "/usage"
```

The second command must print a single JSON line containing `"status":"SUCCESS"` and `"num_turns":0`.

### 4.2. Packaging and installation

The extension is not published on the Visual Studio Marketplace or Open VSX, and the GitHub repository (`https://github.com/XXLC/ai-quota-bar`, placeholder URL) has not been published yet.

To build the `.vsix` package from source (requires Node.js and network access if `@vscode/vsce@3.6.0` is not cached locally):

```powershell
# Placeholder URL (repository not published yet):
# git clone https://github.com/XXLC/ai-quota-bar.git
cd ai-quota-bar
npx @vscode/vsce@3.6.0 package
```

This produces `ai-quota-bar-0.1.1.vsix`. The project has no runtime npm dependencies (`fetch` and Node built-in modules only), so `npm install` is not required before packaging.

If you obtain a prebuilt `ai-quota-bar-0.1.1.vsix` from a future release, verify its SHA-256 hash before installing:

```powershell
Get-FileHash ai-quota-bar-0.1.1.vsix -Algorithm SHA256
```

Install into VS Code:

```powershell
code --install-extension ai-quota-bar-0.1.1.vsix
```

Install into Antigravity IDE (the command script is at `%LOCALAPPDATA%\Programs\Antigravity IDE\bin\antigravity-ide.cmd`; if that `bin` directory is not on your `PATH`, call it by its full path):

```powershell
antigravity-ide --install-extension ai-quota-bar-0.1.1.vsix
```

Or in either application's UI: Extensions view, `...` menu, "Install from VSIX...", then pick `ai-quota-bar-0.1.1.vsix`.

After installing `ai-quota-bar`, disable or uninstall `XXLC.agy-quota-bar` and disable any standalone Claude Code, Codex, or Antigravity quota extensions so they do not make duplicate API calls or show duplicate status bar items.

The extension activates after the window has finished starting up (`onStartupFinished`), so it does not slow down startup. It also runs in Restricted Mode (untrusted workspaces).

### 4.3. Configuration

Open Settings and search for `aiQuota` (or `aiQuota.providers` to filter to the three provider toggles). Old settings from `XXLC.agy-quota-bar` are not migrated. The settings are ordered in the VS Code Settings UI by `order` (`1` to `11`), with the three provider enable/disable switches placed first (`order` `1`-`3`):

| Key | Default | Range / Type | Meaning |
|---|---|---|---|
| `aiQuota.providers.claude.enabled` | `true` | `true`/`false` (`scope: application`, `order: 1`) | Show Claude Code quota in the status bar. Turn off if you no longer use it; when disabled, the extension does not read Claude Code credentials or call its API. `scope: application` restricts this toggle to user settings so workspace/repository settings cannot override it. |
| `aiQuota.providers.codex.enabled` | `true` | `true`/`false` (`scope: application`, `order: 2`) | Show Codex quota in the status bar. Turn off if you no longer use it; when disabled, the extension does not read Codex credentials or call its API. `scope: application` restricts this toggle to user settings so workspace/repository settings cannot override it. |
| `aiQuota.providers.agy.enabled` | `true` | `true`/`false` (`scope: application`, `order: 3`) | Show Antigravity quota in the status bar. Turn off if you no longer use it; when disabled, the extension does not run `agy`. `scope: application` restricts this toggle to user settings so workspace/repository settings cannot override it. |
| `aiQuota.agyPath` | empty | File path (`scope: machine`, `order: 4`) | Absolute path to `agy` (leave empty to auto-detect on `PATH` and `%LOCALAPPDATA%\agy\bin\agy.exe`, section 5.3); Windows supports only `.exe` files. `scope: machine` prevents untrusted workspace/folder settings from overriding it. |
| `aiQuota.refreshInterval` | `300` | `60`-`3600` (seconds, `order: 5`) | Interval between two automatic refreshes for each enabled provider. |
| `aiQuota.timeout` | `45` | `5`-`300` (seconds, `order: 6`) | Maximum time for one provider refresh (HTTP request or `agy` run). On timeout, the HTTP request is aborted via `AbortController` or `agy` and its child process tree are killed. |
| `aiQuota.warningThreshold` | `30` | `0`-`100` (%, `order: 7`) | Remaining percentage at or below this value is the warning level. |
| `aiQuota.criticalThreshold` | `10` | `0`-`100` (%, `order: 8`) | Remaining percentage at or below this value is the critical level. If set higher than `warningThreshold`, `warningThreshold` is used instead. |
| `aiQuota.notificationEnabled` | `true` | `true`/`false` (`order: 9`) | Notify when quota decreases to a worse level or recovers (section 4.6). When off, the extension still tracks and stores levels without showing popups; turning it back on does not replay old notifications. |
| `aiQuota.claudeConfigDir` | empty | Directory path (`scope: machine`, `order: 10`) | Claude configuration directory containing `.credentials.json` (empty: `CLAUDE_CONFIG_DIR` or `~/.claude`). |
| `aiQuota.codexHome` | empty | Directory path (`scope: machine`, `order: 11`) | Codex configuration directory containing `auth.json` (empty: `CODEX_HOME` or `~/.codex`). |

Numeric values outside the allowed range are clamped to the nearest bound; non-numeric values fall back to the default. Changing `aiQuota.claudeConfigDir`, `aiQuota.codexHome`, or `aiQuota.agyPath` immediately triggers a manual refresh for that provider (if enabled).

**How to turn off a provider you no longer use (and behavior when disabled):**

- Run `AI Quota Bar: Choose providers to show` (`aiQuota.selectProviders` — also available inside the `AI Quota Bar: Show details` QuickPick) to check or uncheck `Claude Code`, `Codex`, and `Antigravity`, or toggle `aiQuota.providers.<id>.enabled` directly at the top of the Settings page (`aiQuota.providers`). Because all three switches have `scope: application`, they are stored only in user (`Global`) settings; a workspace or repository (`.vscode/settings.json` or `.code-workspace`) cannot override them to re-enable credential reading or API/CLI calls behind your back.
- When a provider is turned off (`false`), its status bar item is immediately disposed. If a refresh is currently running for that provider, its in-flight HTTP request is aborted (`AbortController`) or its `agy` process tree is killed, its `runningSince` lock lease is released, and any late completion log or notification from a finishing state write is suppressed. While disabled, the extension never reads that provider's credential file (`.credentials.json` or `auth.json`), never calls its usage API, and never runs `agy` (on automatic timer ticks, manual refreshes, or path setting changes).
- The provider's shared state file (`state-<id>.json`, including cached buckets, timestamps, notified levels, consecutive error counts, and any `retryAt` cooldown) is kept intact on disk. When you re-enable the provider (`true`), each open window creates the status bar item and runs a lease-coordinated refresh check (`refresh(false)`): if cached data in `state-<id>.json` is still fresh or the provider is in error backoff / `retryAt` cooldown, it displays the shared state without reading credentials, calling the API, or running `agy` (and without resetting `consecutiveErrors`); if a refresh is due across multiple open windows, the `runningSince` lease ensures that only one window calls the API or runs `agy` rather than every window at once, while the other windows read the updated shared state. You can run `AI Quota Bar: Refresh quota` at any time to force an immediate manual refresh.
- If all three providers are disabled, the status bar is empty (no dummy status bar item is added). You can re-enable providers at any time from the Command Palette via `AI Quota Bar: Choose providers to show` (`aiQuota.selectProviders`) or `AI Quota Bar: Show details` (`aiQuota.showDetails`), or in Settings (`aiQuota.providers`).

### 4.4. Commands

Open the Command Palette (`Ctrl+Shift+P`) and search for `AI Quota Bar` (command IDs start with `aiQuota.`):

| Command ID | Title | Effect |
|---|---|---|
| `aiQuota.refresh` | AI Quota Bar: Refresh quota | Refreshes all enabled providers immediately, even if cached results are still fresh or another window is running, and resets consecutive error counts to 0 (ending exponential error backoff). If a provider is in a `429` (`Retry-After`) cooldown, it is not called early and instead logs `Waiting for the rate limit until HH:MM.`. If this window is already refreshing a provider, it waits for that run. If a provider's state lock cannot be acquired after 5 attempts, that provider is skipped and a warning is logged. |
| `aiQuota.showDetails` | AI Quota Bar: Show details | Opens a combined QuickPick list (titled `AI Quota Bar`) showing every limit across all enabled providers, grouped by provider separator (`Claude Code`, `Codex`, `Antigravity`) with a `last updated: HH:MM` line under each provider header (or `No providers enabled.` when all three are disabled), ending with `$(refresh) Refresh now` (refreshes all enabled providers), `$(output) Open log`, `Choose providers to show` (runs `aiQuota.selectProviders`), and `Open settings` (opens Settings filtered to `aiQuota.providers`). Clicking any of the status bar items opens this same combined list. |
| `aiQuota.showLog` | AI Quota Bar: Open log | Opens the shared "AI Quota Bar" Output channel. |
| `aiQuota.selectProviders` | AI Quota Bar: Choose providers to show | Opens a multi-select QuickPick (`canPickMany`, titled `Choose providers to show`, placeholder `Select providers to show in the status bar`) listing `Claude Code` (`Claude Code API`), `Codex` (`Codex API`), and `Antigravity` (`agy /usage`), pre-checked according to which providers are currently enabled. Confirming writes `aiQuota.providers.<id>.enabled` to user (`Global`) settings only for providers whose state changed; pressing `Esc` or keeping the same selection writes nothing. If writing user settings fails (for example, when `settings.json` has a syntax error), the extension keeps any keys already saved before the failure, logs the sanitized error to the Output channel, and shows an error notification (`Could not update provider settings. Keys saved: <keys or none>. Error: <error>`). After the write loop finishes, it re-reads the effective configuration and, if all three providers are effectively disabled, shows a one-time information notification explaining that the status bar will be empty and how to re-enable them via `AI Quota Bar: Choose providers to show` or Settings (`aiQuota.providers`). |

### 4.5. Reading the status bar, tooltips, and combined detail list

Each enabled provider has its own `StatusBarItem` on the right side of the status bar with a distinct ID and display name, ordered from left to right by priority (`100`, `99`, `98`):

1. **Claude Code** (`id: "aiQuota.claude"`, `name: "Claude Code"`, priority `100`, leftmost): `Claude 84% | 29%`
2. **Codex** (`id: "aiQuota.codex"`, `name: "Codex"`, priority `99`, middle): `Codex 76% | 96%`
3. **Antigravity** (`id: "aiQuota.agy"`, `name: "Antigravity"`, priority `98`, rightmost): `Gemini 91% | 60% · Claude/GPT 80% | 55%`

Because each item has its own `StatusBarItem` ID, you can right-click the VS Code status bar to hide or show `Claude Code`, `Codex`, or `Antigravity` individually. Hiding an item from the status bar context menu only hides its UI element; to completely disable a provider you no longer use (so its status bar item is disposed and the extension stops reading credentials, calling its API, or running `agy`), use `AI Quota Bar: Choose providers to show` (`aiQuota.selectProviders`) or set `aiQuota.providers.<id>.enabled` to `false` in Settings (section 4.3).

How each status bar item is formatted:

- Each group within a provider is formatted as `<group label> <5h>% | <weekly>%`, where the first number is the 5-hour window (`windowKey === '5h'`) and the second number is the weekly window (`windowKey === 'weekly'`), for example `Claude 84% | 29%` or `Codex 76% | 96%`. When multiple buckets in a group share the same window key (`5h` or `weekly`), the status bar displays the one with the lowest remaining percentage (`percent`), while all buckets remain visible in the tooltip and QuickPick list.
- When a provider has multiple groups (Antigravity has `Gemini` and `Claude/GPT`), groups are separated by ` · ` (middle dot, `U+00B7`) so the group separator is distinct from the `|` between 5-hour and weekly, for example `Gemini 91% | 60% · Claude/GPT 80% | 55%`.
- If either the 5-hour or the weekly window is missing, `--` is shown in its place (for example `Codex 76% | --` or `Codex -- | 96%`).
- Secondary (`other:*`) limits (such as model-scoped weekly windows on Claude, custom durations like 3-day windows on Codex, or windows without `limit_window_seconds`) are handled as follows on the status bar:
  - When a group has **both** `5h` and `weekly` windows, `other:*` limits are omitted from the status bar when normal (`ok`) or past reset (`unknown`), and are appended only when at least one `other:*` limit is at the `warning` or `critical` level.
  - When a group is **missing** either `5h` or `weekly`, `other:*` limits are appended even when normal (`ok`) or past reset (`?%`), as ` | <label> <value>` (for example `Codex 80% | -- | 3 days 60%`), so secondary limits are never hidden behind `--`.
  - When a group has **neither** `5h` nor `weekly` (only `other:*` limits), the group is shown with its window label as `<group label> <label> <value>` (for example `Codex Limit 60%`).
  - In all cases on the status bar, **at most one** `other:*` limit is shown per group: the one with the lowest remaining percentage among non-expired candidate `other:*` limits (or `?%` if all candidate `other:*` limits have passed their reset time). Its window label on the status bar is truncated to at most **16 Unicode code points** (if longer than 16 code points, the first 15 code points plus `…`, `U+2026`). If the group has more than one `other:*` limit in total, ` +N` (where `N` is the number of additional `other:*` limits in that group) is appended after the percentage (for example `Claude 90% | 50% | Claude Opus 4.5… 5% +2` or `Codex Limit 60% +1`). The hover tooltip and QuickPick list always show all limits with their full, untruncated labels.
- Each status bar item sets `accessibilityInformation.label` on every render for screen readers (such as NVDA or Narrator): each group is announced as `<group label>: 5-hour <5h>, Weekly <weekly>` in English or `<nhãn nhóm>: 5 giờ <5h>, Tuần <weekly>` in Vietnamese (for example `Claude: 5-hour 84%, Weekly 29%`), followed by any `other:*` limits with their full labels (`, <window label> <value>`), with multiple groups separated by `; `. Missing windows are read as `not available` (`không có` in Vietnamese), limits past their reset time (`?%`) are read as `unknown` (`chưa rõ` in Vietnamese), and codicon tokens (`$(...)`) are stripped when announcing error or loading states.
- Percentages are always rounded down (`9.9%` shows as `9%`), any used percentage `> 100` is clamped to `0%` remaining (`critical` level), and thresholds are compared against the exact integer shown.
- A limit whose reset time has already passed (level `unknown`) shows `?%` in its slot on the status bar until the next refresh (and if all limits in an `other:*`-only group have passed their reset time, `?%` is shown with the window label for that group). Limits past their reset time do not affect the background color.
- Background color (`severity`) is calculated independently for each status bar item from the worst level across all non-expired limits of its groups (including `other:*` limits): yellow (`statusBarItem.warningBackground`) at the warning level, red (`statusBarItem.errorBackground`) at the critical level.
- If a provider is not signed in or its token has expired (`auth` error), that provider's item shows `Claude: not signed in` or `Codex: not signed in` (prefixed with `$(error)` when there is no cached data, or `$(history)` when stale cached buckets still exist in the tooltip) and clears the warning/error background color to normal (`ok`), while the other provider items continue working normally.

Examples of status bar text on a single item:

| Situation | Status bar text (example) |
|---|---|
| Standard `5h \| weekly` display (Claude / Codex / Antigravity) | `Claude 84% \| 29%` / `Codex 76% \| 96%` / `Gemini 91% \| 60% · Claude/GPT 80% \| 55%` |
| Missing 5-hour or weekly window (no `other:*` / with `other:*` limit) | `Codex 76% \| --` / `Codex 80% \| -- \| 3 days 60%` |
| Only `other:*` limits (no `5h` or `weekly`) | `Codex Limit 60%` / `Codex Limit 60% +1` |
| Weekly limit at critical level | `Claude 72% \| 8%` (red background with default thresholds) |
| Model-scoped or custom (`other:*`) limit at warning/critical level (with truncation and `+N`) | `Claude 84% \| 55% \| Sonnet 4.5 20%` / `Claude 90% \| 50% \| Claude Opus 4.5… 5% +2` |
| Used percentage >= 100% (exhausted) | `Codex 0% \| 96%` (red background with default thresholds) |
| Limit past its reset time, waiting for refresh | `Gemini ?% \| 60% · Claude/GPT 80% \| 55%` (`?%` is not colored) |
| Manual refresh in progress | `$(sync~spin)` added at the start |
| Stale data | `$(history) Claude 84% \| 29%` |
| Not signed in / expired token (no cached data / with cached data) | `$(error) Claude: not signed in` / `$(history) Claude: not signed in` |
| `agy` binary not found | `$(error) Antigravity: agy not found` |
| Other provider error (no cached data) | `$(error) Claude: error` / `$(error) Codex: error` / `$(error) Antigravity: error` |

(`$(...)` is a VS Code codicon; `\|` in the table is the `|` character on the bar, and `·` is the middle dot `U+00B7` separating groups.)

Hover over any of the status bar items to see that provider's tooltip. Each provider renders its own Markdown table tooltip with the provider's heading (`**Claude Code Quota**`, `**Codex Quota**`, or `**Antigravity Quota**`), columns `Group | Limit | Remaining | Resets at | Time left`, the last update time, and active thresholds:

```
Claude Code Quota

| Group  | Limit      | Remaining     | Resets at        | Time left  |
|--------|------------|---------------|------------------|------------|
| Claude | 5-hour     | 72%           | Tue 03 Nov 04:00 | 3 h 39 min |
| Claude | Weekly     | 8% (critical) | Mon 09 Nov 00:00 | 5 d 23 h   |
| Claude | Sonnet 4.5 | 45%           | Mon 09 Nov 00:00 | 5 d 23 h   |

Updated at 00:21 (just now). Thresholds: warning <= 30%, critical <= 10%.

Click for details.
```

- A cell at the warning level gets the suffix `(warning)`; a cell at the critical level gets `(critical)` and is bold.
- "Resets at" is local time in the form `weekday day month hour:minute`, for example `Tue 03 Nov 04:00` (section 4.10).
- "Time left" is the countdown until reset: `X d Y h`, `X h Y min`, `Y min`, `under 1 min`, or `reset time reached`. Without a reset time, both columns show `unknown`.
- With stale data, a line under the heading starts with `$(history)` and the bold text `Stale data.`, followed by the reason (`Refresh at HH:MM failed: <error>` or `Refresh is overdue.`).
- Markdown special characters and bare URLs (`://`, `www.`) in labels are escaped so untrusted strings cannot inject links or formatting into the hover tooltip.
- All items and tooltips are redrawn every 60 seconds so countdowns stay accurate between refreshes.

Clicking any of the three status bar items (or running `AI Quota Bar: Show details`) opens the **combined QuickPick list**:

- Under each enabled provider's separator (`Claude Code`, `Codex`, `Antigravity`), the first item is a non-action informational line showing `last updated: HH:MM` (or `last updated: never`, with `(stale data)` appended when stale).
- Below that line are the provider's limits (with `$(warning)` or `$(error)` icons when low; for multi-group providers such as Antigravity, each row prefixes the group name, e.g. `Gemini 5-hour: 91%`), or the provider's `$(error)` line if no cached limits exist.
- If all three providers are disabled, the list displays `No providers enabled.` above the action separator.
- At the bottom of the list (after a separator) are four actions, always shown even when no providers are enabled: `$(refresh) Refresh now` (which refreshes all enabled providers), `$(output) Open log`, `Choose providers to show` (runs `aiQuota.selectProviders`), and `Open settings` (opens Settings with the query `aiQuota.providers`).

### 4.6. Notifications

Each provider remembers the level (`ok`, `warning`, `critical`) of every limit in its `state-<id>.json` file across VS Code restarts (keyed as `<provider>|<groupName>|<windowKey>` so group names never collide across providers), and only notifies you when a level transitions:

| Previous level | New level | Notification |
|---|---|---|
| (none) | normal | No |
| (none) | warning or critical | Yes, once |
| normal | warning | Yes (warning) |
| normal or warning | critical | Yes (error) |
| critical | warning | No |
| warning or critical | normal | Yes (recovered) |
| unchanged | unchanged | No |

- Changes within a refresh are merged with the provider prefix (`Claude Code: ...`, `Codex: ...`, `Antigravity: ...`) and shown using the most severe message type.
- Only the window that actually executed the refresh for that provider shows the notification, after saving the new levels to the provider's shared state file; other windows only update their status bar.
- A limit past its reset time (`?%`) does not change level. A limit that disappears from the response is forgotten without a notification.
- When `agy` is not found (and `aiQuota.providers.agy.enabled` is `true`), the extension shows at most one error notification per activation with an "Open settings" button that jumps to `aiQuota.agyPath`.
- Other errors (including missing Claude/Codex login, expired tokens, rate limits, or network timeouts) are shown on the status bar, tooltip, QuickPick, and log, without popup notifications.

### 4.7. Multiple windows

All windows of the same application share the extension's `globalStorageUri` directory, with separate files per provider (`<id>` is `claude`, `codex`, or `agy`):

- `state-<id>.json`: latest refresh result, timestamps of the latest attempt and latest success, latest error, consecutive error count, `retryAt` rate-limit deadline (after HTTP `429`), notified levels, and the `runningSince` lease marker for that provider.
- `state-<id>.lock`: exclusive lock file held for only a few milliseconds while reading and writing `state-<id>.json` (never held while an HTTP request or `agy` process is running). If the lock is busy, the extension retries up to 5 times (waiting 50, 100, 200, 400 ms). A lock older than 30 seconds is treated as orphaned, renamed to a unique `.old` name, and deleted.
- `state-<id>.json.<pid>.<uuid>.tmp`: temporary file written and atomically renamed to `state-<id>.json`.

Because `state-<id>.json` uses provider-specific filenames rather than `state.json`, `ai-quota-bar` never collides with `agy-quota-bar`'s state file even if both were ever present.

Every 60 seconds (as well as when a provider is enabled or re-enabled), each window checks each enabled provider under its lock (with a 5-second tolerance on `refreshInterval` so 60-second timer ticks do not add an extra minute to each cycle). Because the refresh decision, `retryAt` check, and `runningSince` lease are evaluated and written in the same lock transaction, opening multiple VS Code windows—or re-enabling a provider while multiple windows are open—produces only one API call or `agy` run per provider per cycle and shares any `429` `Retry-After` cooldown across all windows. If a window could not persist a `429` result because the lock was busy after 5 attempts, it still enforces the cooldown locally while continuing to read `state-<id>.json` and adopt newer shared results written by another window. Closing a window while a refresh is in flight cancels the request (or kills the `agy` process tree within 2.5 seconds), releases the lease, and restores the previous attempt timestamp so another window can take over when due.

### 4.8. After sleep or hibernation

- Every 60 seconds the extension checks whether each enabled provider is due for a refresh, so within about 60 seconds after the machine wakes an overdue provider refreshes automatically.
- Passing a limit's reset timestamp also triggers a single refresh attempt for that provider (once any `retryAt` cooldown has elapsed), even during error backoff.
- Data older than `2 * refreshInterval` (or accompanied by a refresh error) is marked with `$(history)` as stale data and kept visible until a refresh succeeds.
- Moving the system clock backward before `lastAttemptAt` triggers a refresh, and any `retryAt` timestamp more than 1 hour in the future is discarded as invalid so backward clock adjustments cannot lock out a provider.

### 4.9. Log

The shared **AI Quota Bar** Output channel records every refresh across all enabled providers, with each line prefixed by `[Claude Code]`, `[Codex]`, or `[Antigravity]`:

- Successful refresh:
  - Claude Code / Codex: `Refresh: success, <N> valid limits.`
  - Antigravity (`agy`): `Refresh: success, <ms> ms, <N> valid limits, exit code <code>, source: agy`
  - Cache hit from another window: `Refresh: source: cache (another window, <age> seconds ago).`
- Failed refresh: `Refresh: error <type>, <message>` where `<type>` is `auth`, `network`, `http`, `not-found`, `timeout`, `exit`, `spawn`, or `unexpected`, and `<message>` is sanitized.
- Rate-limit cooldown skip on manual refresh: `Waiting for the rate limit until HH:MM.`
- Lock contention warnings, state write failures, or process tree termination warnings.

Successful log lines never include raw HTTP response bodies or `agy` output. Error messages are always passed through `sanitize` (section 3.1) before logging.

### 4.10. Language

The interface is in English by default, and in Vietnamese when VS Code's display language is Vietnamese (`vi` or `vi-*` in `vscode.env.language`, chosen on activation). Restart VS Code after changing VS Code's display language.

Reset time format: English `Tue 03 Nov 02:48`, Vietnamese `02:48 T3 03/11`.

## 5. Troubleshooting

First step for any issue: run `AI Quota Bar: Open log` (`aiQuota.showLog`) to inspect the `[Claude Code]`, `[Codex]`, and `[Antigravity]` log entries.

Exponential backoff and `429` (`Retry-After`) cooldown:

- Starting from the 3rd consecutive error for a given provider, that provider's refresh interval doubles after each error (for example, with the default 300 seconds: 600, 1,200, 2,400 seconds), capped at 3,600 seconds. One successful refresh, or running `AI Quota Bar: Refresh quota`, resets consecutive error counts to 0.
- On HTTP `429` from Claude or Codex, the extension enforces the server's `Retry-After` header clamped to between 60 seconds and 1 hour (or 60 seconds when `Retry-After` is absent) and stores `retryAt` in `state-<id>.json` across all windows. During this `retryAt` window, manual refreshes do not call the API and only log `Waiting for the rate limit until HH:MM.`.

### 5.1. Claude Code or Codex: not signed in or token expired (`auth` error)

Symptoms: the Claude or Codex status bar item shows `Claude: not signed in` or `Codex: not signed in`, and the tooltip, QuickPick, or log shows `Not signed in or credentials expired. Open claude/codex to sign in again.`.

Causes:

- The credential file (`~/.claude/.credentials.json` or `~/.codex/auth.json`, or the path in `aiQuota.claudeConfigDir` / `aiQuota.codexHome`) does not exist or does not contain an access token.
- The saved OAuth access token has expired locally (`claudeAiOauth.expiresAt` or JWT `exp`) or been rejected by the server (`401`, or `403` authentication failure). Because Claude Code tokens expire after a few hours and Codex tokens after a few days—and `ai-quota-bar` never refreshes tokens—this occurs whenever you have not opened `claude` or `codex` recently.
- On macOS, Claude Code stored its credentials in the macOS Keychain instead of `~/.claude/.credentials.json` (Keychain is not supported yet).

How to fix:

1. Open a terminal and run `claude` (for Claude Code) or `codex` (for Codex) so the CLI refreshes its token or prompts you to sign in.
2. If you use a custom configuration directory, set `aiQuota.claudeConfigDir` or `aiQuota.codexHome` in user settings to match your CLI's directory.
3. Run `AI Quota Bar: Refresh quota`.
4. If you no longer use Claude Code or Codex on this machine, disable it via `AI Quota Bar: Choose providers to show` (`aiQuota.selectProviders`) or by setting `aiQuota.providers.claude.enabled` or `aiQuota.providers.codex.enabled` to `false` in Settings so the extension disposes its status bar item and stops reading its credentials or calling its API.

### 5.2. Claude Code: HTTP 403 TLS fingerprint block and `curl` fallback

Anthropic's edge servers may reject Node's built-in `fetch` TLS handshake with HTTP `403` and body `"Request not allowed"`. Only in that specific case, `ai-quota-bar` automatically falls back to running `<%SystemRoot% or C:\Windows>\System32\curl.exe` on Windows (or `curl` on macOS/Linux) with `-q --config -` via `stdin`. If `curl` is missing or blocked by firewall/endpoint security software, the fallback will fail with a network error; ensure the system `curl` binary is available and can reach `https://api.anthropic.com`.

### 5.3. Antigravity: `agy` not found

Symptoms: the Antigravity item shows `$(error) Antigravity: agy not found`, and a notification with an "Open settings" button appears once per session.

- If `aiQuota.agyPath` is set, the extension checks only that exact path (must be an existing absolute file path, ending in `.exe` on Windows).
- If `aiQuota.agyPath` is empty, the extension searches `PATH` (`agy.exe` on Windows, `agy` on macOS/Linux) and then `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows.

How to fix: verify `agy --version` in a terminal, set `aiQuota.agyPath` to the full path of `agy.exe` if needed, or disable Antigravity via `AI Quota Bar: Choose providers to show` (`aiQuota.selectProviders`) or by setting `aiQuota.providers.agy.enabled` to `false` in Settings if you no longer use it (so the extension stops running `agy`).

### 5.4. Windows `.cmd` and `.bat` files are not supported for `agyPath`

`aiQuota.agyPath` on Windows only accepts `.exe` files because `agy` is spawned directly without a shell (avoiding command injection and console windows). Point `aiQuota.agyPath` to `agy.exe` itself (typically `%LOCALAPPDATA%\agy\bin\agy.exe`), not a `.cmd` wrapper.

## 6. Verification status

This extension generalizes `XXLC.agy-quota-bar` (which had 174 passing automated tests and real `agy` CLI measurements on Windows 11 with `agy` 1.4.12) to add the Claude Code and Codex providers. The test suite now has 330 passing automated tests across `test/*.test.js`.

Automated tests:

```powershell
npm test
```

Runs `node --test test/*.test.js` offline (330 tests) using injected `fetch`, `fs`, and `execFile` mocks (never reading real `~/.claude/.credentials.json` or `~/.codex/auth.json` files and never calling the network or the real `agy` binary).

NOT yet verified at the time of writing this README:

1. Live end-to-end requests from `ai-quota-bar` against the real Anthropic (`/api/oauth/usage`, including live `limits` array responses and TLS `curl` fallback) and ChatGPT (`/backend-api/wham/usage`) servers: the request headers, `curl` fallback, and response parsing for Claude and Codex were implemented from reference code inspection and tested with offline fixtures rather than live network runs.
2. Visual and screen-reader observation of the three side-by-side status bar items (including the status bar right-click context menu to hide/show individual items, and NVDA/Narrator reading `accessibilityInformation`), the Settings UI (`order` and `scope: application`), tooltips, notifications, and the combined QuickPick in a running VS Code or Antigravity IDE window in English and Vietnamese.
3. macOS and Linux runtime behavior (and macOS Keychain storage for Claude Code, which is not supported).
4. Multi-process lock contention across separate OS processes for the per-provider `state-<id>.lock` files.
5. Behavior behind an HTTP proxy across VS Code versions (`1.90`-`1.93` vs. newer versions) and in Remote SSH, WSL, and Dev Containers.

## 7. License

MIT. See the `LICENSE` file.
